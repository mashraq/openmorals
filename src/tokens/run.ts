import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding } from '../guard.js';
import { quoteForReason } from '../guard.js';
import { safeSessionId } from '../paths.js';
import type { Limit } from '../types.js';

/**
 * The run budget (0.37.0): one budget for a whole run of agents, across processes, sessions and restarts.
 *
 * A run is everything started under one `OPENMORALS_RUN` id: a launcher (a factory's dispatcher, a CI job, a script, the
 * person) runs `openmorals budget start`, which writes the run's limits once, and exports the id to every agent it starts.
 * Every hook call in a session of the run then writes that session's own counts (tool calls, tokens, runs of sub-agents)
 * to its own node file under the run's folder, and judges the sum of every node of the run against the run's limits.
 *
 * - No shared lock on the hot path: each session writes only its own node file, and a reader sums them. Counts only grow
 *   (two writers of one session keep the larger figure), so a restarted process cannot lower what the run has spent.
 * - Keyed by the run, not the process: a session that resumes, or a worker re-dispatched under the same id, keeps
 *   counting against the same budget, and every new session counts against `sessions`.
 * - One ask per run: a soft limit asks in the session that crosses it first; its siblings see the claim and do not ask
 *   again, so twenty parallel agents do not turn one limit into twenty asks.
 * - Hard limits refuse every later call of every session of the run, so a run past its limit stops everywhere, orphans
 *   included, on their next tool call.
 * - Fails closed: a run whose limits cannot be read asks (refuses when unattended), it is never treated as unlimited.
 *
 * Known limits (said in the docs): a hook sees a model turn only when it calls a tool, so a run can overshoot by the turns
 * in flight; an agent that runs as the same OS user and drops the variable leaves the run (it then counts as a fresh
 * session under the person's own limits, not an unlimited one); and only hosts whose adapter calls it count (Claude Code
 * in 0.37.0).
 */

export interface RunLimits {
  tool_calls?: Limit;
  tokens?: Limit;
  /** Runs of sub-agents, summed over the run's sessions (a batch of parallel sub-agents counts once, as per session). */
  spawns?: Limit;
  /** Sessions in the run: each new session, resumed process or re-dispatched worker under the id is one more. */
  sessions?: Limit;
}

export const RUN_UNITS = ['tool_calls', 'tokens', 'spawns', 'sessions'] as const;
export type RunUnit = (typeof RUN_UNITS)[number];

export interface RunFile {
  version: 1;
  run: string;
  created: string;
  limits: RunLimits;
}

export interface RunNode {
  session: string;
  tool_calls: number;
  tokens: number;
  spawns: number;
  updated: string;
  /** Units whose 90% line this session already gave the agent, so it is given once. */
  told?: RunUnit[];
}

export interface RunTotals {
  tool_calls: number;
  tokens: number;
  spawns: number;
  sessions: number;
}

export const RUN_ID = /^[A-Za-z0-9_.-]{1,128}$/;

/** The folder name of a run: the id itself when it is a plain name, else a cleaned name with a hash, so two ids never share one. */
export function runFolderName(run: string): string {
  if (RUN_ID.test(run) && run !== '.' && run !== '..') return run;
  const clean = run.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
  return `${clean === '' ? 'run' : clean}-${createHash('sha256').update(run).digest('hex').slice(0, 12)}`;
}

export function runDir(dir: string, run: string): string {
  return join(dir, 'runs', runFolderName(run));
}

function nat(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
}

function parseLimit(v: unknown): Limit | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const soft = o['soft'];
  const hard = o['hard'];
  const step = o['step'];
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;
  if (!ok(soft) || !ok(hard) || (step !== undefined && !ok(step))) return null;
  if (hard > 0 && soft > hard) return null;
  return { soft, hard, step: typeof step === 'number' && step > 0 ? step : Math.max(1, hard > 0 ? hard : soft) };
}

/** The run's file, `null` when the run has none (counted, no limits), or `{ error }` when it is there but unusable. */
export function readRunFile(dir: string, run: string): RunFile | null | { error: string } {
  let text: string;
  try {
    text = readFileSync(join(runDir(dir, run), 'run.json'), 'utf8');
  } catch (err: unknown) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
    if (code === 'ENOENT') return null;
    return { error: `the run's limits could not be read (${code !== '' ? code : err instanceof Error ? err.message : String(err)})` };
  }
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: "the run's limits are not a JSON object" };
    const o = raw as Record<string, unknown>;
    if (o['version'] !== 1) return { error: `the run's limits have version ${JSON.stringify(o['version'])}, which this openmorals does not know` };
    const l = o['limits'];
    if (typeof l !== 'object' || l === null || Array.isArray(l)) return { error: "the run's limits have no limits mapping" };
    const limits: RunLimits = {};
    for (const [k, v] of Object.entries(l as Record<string, unknown>)) {
      if (!(RUN_UNITS as readonly string[]).includes(k)) return { error: `the run's limits name an unknown unit ${quoteForReason(k, 30)}` };
      const p = parseLimit(v);
      if (p === null) return { error: `the run's ${k} limit is not a soft, hard and step of whole numbers with soft no higher than hard` };
      limits[k as RunUnit] = p;
    }
    return { version: 1, run: typeof o['run'] === 'string' ? o['run'] : run, created: typeof o['created'] === 'string' ? o['created'] : '', limits };
  } catch {
    return { error: "the run's limits could not be parsed" };
  }
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

/** Writes a new run's limits. Refuses to overwrite: a run's budget is set once, so starting it again cannot refill it. */
export function startRun(dir: string, run: string, limits: RunLimits, now: Date = new Date()): { ok: true; file: RunFile } | { ok: false; error: string } {
  const d = runDir(dir, run);
  mkdirSync(join(d, 'nodes'), { recursive: true, mode: 0o700 });
  const file: RunFile = { version: 1, run, created: now.toISOString(), limits };
  try {
    writeFileSync(join(d, 'run.json'), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  } catch (err: unknown) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
    if (code === 'EEXIST') return { ok: false, error: `run ${run} already has limits; a run's budget is set once (start a new run with another id)` };
    return { ok: false, error: `the run's limits could not be written (${code !== '' ? code : err instanceof Error ? err.message : String(err)})` };
  }
  return { ok: true, file };
}

function parseNode(v: unknown, fallback: string): RunNode | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const told = Array.isArray(o['told']) ? (o['told'] as unknown[]).filter((u): u is RunUnit => typeof u === 'string' && (RUN_UNITS as readonly string[]).includes(u)) : [];
  return {
    session: typeof o['session'] === 'string' ? o['session'] : fallback,
    tool_calls: nat(o['tool_calls']),
    tokens: nat(o['tokens']),
    spawns: nat(o['spawns']),
    updated: typeof o['updated'] === 'string' ? o['updated'] : '',
    ...(told.length > 0 ? { told } : {}),
  };
}

/** Every node of the run, by session file name. An unreadable node is reported, so the run's sum is never quietly low. */
export function readNodes(dir: string, run: string): { nodes: Map<string, RunNode>; unreadable: string[] } {
  const nodes = new Map<string, RunNode>();
  const unreadable: string[] = [];
  const nd = join(runDir(dir, run), 'nodes');
  let names: string[] = [];
  try {
    names = readdirSync(nd).filter((n) => n.endsWith('.json'));
  } catch {
    return { nodes, unreadable };
  }
  for (const n of names) {
    const key = n.slice(0, -'.json'.length);
    try {
      const p = parseNode(JSON.parse(readFileSync(join(nd, n), 'utf8')), key);
      if (p === null) unreadable.push(key);
      else nodes.set(key, p);
    } catch {
      unreadable.push(key);
    }
  }
  return { nodes, unreadable };
}

export function sumNodes(nodes: Iterable<RunNode>): RunTotals {
  const t: RunTotals = { tool_calls: 0, tokens: 0, spawns: 0, sessions: 0 };
  for (const n of nodes) {
    t.tool_calls += n.tool_calls;
    t.tokens += n.tokens;
    t.spawns += n.spawns;
    t.sessions += 1;
  }
  return t;
}

function band(value: number, limit: Limit): number {
  if (limit.soft <= 0 || value < limit.soft) return -1;
  return Math.floor((value - limit.soft) / Math.max(1, limit.step));
}

/** Claims the ask for one band of one unit for the whole run: true for the first session to claim it, false for the others. */
function claimAsk(dir: string, run: string, unit: RunUnit, b: number): boolean {
  const d = join(runDir(dir, run), 'asked');
  mkdirSync(d, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(join(d, `${unit}-${b}`), `${new Date().toISOString()}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (err: unknown) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
    if (code === 'EEXIST') return false;
    throw err;
  }
}

const UNIT_TEXT: Readonly<Record<RunUnit, string>> = {
  tool_calls: 'tool calls',
  tokens: 'tokens',
  spawns: 'runs of sub-agents',
  sessions: 'sessions',
};

export interface RunControlInput {
  dir: string;
  run: string;
  session: string;
  /** This session's counts with this call counted. */
  counts: { tool_calls: number; tokens: number; spawns: number };
  now?: Date;
}

export interface RunControlResult {
  findings: Finding[];
  /** One line for the agent the first time this session sees the run at 90% of a hard limit, or null. */
  notice: string | null;
  totals: RunTotals;
}

export const RUN_RULE = 'budget.run';

/**
 * The run budget at one judged call: writes this session's node (counts only grow), sums the run, and returns its
 * findings. Throws on a failure it cannot judge; the caller turns that into an ask.
 */
export function runControl(i: RunControlInput): RunControlResult {
  const limits = readRunFile(i.dir, i.run);
  const { nodes, unreadable } = readNodes(i.dir, i.run);
  const key = safeSessionId(i.session);
  const before = nodes.get(key);
  const mine: RunNode = {
    session: i.session.slice(0, 128),
    tool_calls: Math.max(before?.tool_calls ?? 0, i.counts.tool_calls),
    tokens: Math.max(before?.tokens ?? 0, i.counts.tokens),
    spawns: Math.max(before?.spawns ?? 0, i.counts.spawns),
    updated: (i.now ?? new Date()).toISOString(),
    ...(before?.told !== undefined ? { told: before.told } : {}),
  };
  const prevTotals = sumNodes(nodes.values());
  const after = new Map(nodes);
  after.set(key, mine);
  const totals = sumNodes(after.values());
  const findings: Finding[] = [];
  const name = quoteForReason(i.run, 40);
  if (limits !== null && 'error' in limits) findings.push({ decision: 'ask', rule: `${RUN_RULE}.unreadable`, reason: `${limits.error} for run ${name}, so this call is held; the person can check it with openmorals budget status` });
  if (unreadable.length > 0) findings.push({ decision: 'ask', rule: `${RUN_RULE}.unreadable`, reason: `${unreadable.length} session file${unreadable.length === 1 ? '' : 's'} of run ${name} could not be read, so the run's spend is not known; continue?` });
  let notice: string | null = null;
  let joinRefused = false;
  const told = new Set(mine.told ?? []);
  if (limits !== null && !('error' in limits)) {
    for (const unit of RUN_UNITS) {
      const lim = limits.limits[unit];
      if (lim === undefined) continue;
      const cur = totals[unit];
      // Sessions are judged when a session joins: a new session past the hard limit is refused and not counted, and the
      // sessions already in the run go on. Every other unit refuses every session once the run reaches it.
      if (unit === 'sessions') {
        if (before !== undefined) continue;
        if (lim.hard > 0 && cur > lim.hard) {
          joinRefused = true;
          findings.push({ decision: 'deny', rule: `${RUN_RULE}.sessions.hard`, reason: `run ${name} already has its limit of ${lim.hard} sessions, and this would be session ${cur}; a restarted or re-dispatched worker counts as a new session. Finish without calling tools; only the person can give the run more (a new run with openmorals budget start)` });
          continue;
        }
      } else if (lim.hard > 0 && cur >= lim.hard) {
        findings.push({ decision: 'deny', rule: `${RUN_RULE}.${unit}.hard`, reason: `run ${name} reached its hard limit of ${lim.hard} ${UNIT_TEXT[unit]} (${cur} across its sessions); finish now and report what is done. Only the person can give the run more (a new run with openmorals budget start)` });
        continue;
      }
      const prev = prevTotals[unit];
      if (lim.soft > 0 && band(cur, lim) > band(prev, lim) && claimAsk(i.dir, i.run, unit, band(cur, lim))) {
        findings.push({ decision: 'ask', rule: `${RUN_RULE}.${unit}.soft`, reason: `run ${name} passed its soft limit of ${lim.soft} ${UNIT_TEXT[unit]} (${cur} across ${totals.sessions} session${totals.sessions === 1 ? '' : 's'}; hard limit ${lim.hard > 0 ? lim.hard : 'none'}); asked once for the whole run; continue?` });
      }
      if (unit !== 'sessions' && notice === null && lim.hard > 0 && cur * 10 >= lim.hard * 9 && !told.has(unit)) {
        told.add(unit);
        notice = `openmorals: this run has used ${cur} of its ${lim.hard} ${UNIT_TEXT[unit]} (90%). Finish the current step and report rather than start new work.`;
      }
    }
  }
  if (joinRefused) return { findings, notice: null, totals: prevTotals };
  const node: RunNode = { ...mine, ...(told.size > 0 ? { told: [...told] } : {}) };
  mkdirSync(join(runDir(i.dir, i.run), 'nodes'), { recursive: true, mode: 0o700 });
  writeAtomic(join(runDir(i.dir, i.run), 'nodes', `${key}.json`), `${JSON.stringify(node)}\n`);
  return { findings, notice, totals };
}

export interface RunStatus {
  run: string;
  limits: RunLimits | null;
  error: string | null;
  totals: RunTotals;
  sessions: RunNode[];
  unreadable: string[];
}

export function runStatus(dir: string, run: string): RunStatus {
  const f = readRunFile(dir, run);
  const { nodes, unreadable } = readNodes(dir, run);
  const sessions = [...nodes.values()].sort((a, b) => b.updated.localeCompare(a.updated));
  return { run, limits: f === null || 'error' in f ? null : f.limits, error: f !== null && 'error' in f ? f.error : null, totals: sumNodes(nodes.values()), sessions, unreadable };
}

/** Runs with a folder, newest first by their limits file or latest node. */
export function listRuns(dir: string): string[] {
  try {
    return readdirSync(join(dir, 'runs')).sort();
  } catch {
    return [];
  }
}
