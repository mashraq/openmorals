import { randomBytes } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../paths.js';
import { loadSession } from '../state.js';
import { MAIN_AGENT } from './agents.js';
import type { AuditFields } from '../audit.js';
import { appendAuditForSession } from '../state.js';
import { clearRunStop, clearStop, readStop, STOP_CLEAR_RULE, STOP_SESSION, STOP_SET_RULE, stopPath, stopRun, stopSessions } from './stop.js';
import { transcriptTotals } from './transcript.js';
import { RUN_ID, RUN_UNITS, listRuns, runStatus, startRun, type RunLimits, type RunUnit } from './run.js';
import type { Limit } from '../types.js';

export const STOP_USAGE = `  openmorals stop <session-id>
  openmorals stop --all
      Stop a session (or every session): from the next tool call on, the hook
      refuses every call of it, in the main conversation and every sub-agent,
      and tells the agent to finish. Nothing already done is undone.
  openmorals stop --run <run-id>
      Stop a whole run: every session started with OPENMORALS_RUN=<run-id>, in
      every process and on every restart, is refused from its next tool call.
  openmorals stop --clear [<session-id> | --run <run-id>]
      Clear one stop, or every stop. Only you can: an agent running it is asked
      or refused by the hook. openmorals sessions lists the session ids.`;

export const SESSIONS_USAGE = `  openmorals sessions [--limit N] [--json]
      List the recent sessions, newest first: tool calls, tokens (for Claude
      Code, read from its own logs; cache reads shown apart), runs of sub-agents,
      the busiest sub-agents, and whether the session is stopped. Read only.`;

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function split(rest: readonly string[], allowed: readonly string[]): { flags: Map<string, string | true>; positional: string[]; problem: string | null } {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (!a.startsWith('-')) {
      positional.push(a);
      continue;
    }
    if (!allowed.includes(a)) return { flags, positional, problem: `unknown option ${a}` };
    if (a === '--limit') {
      const v = rest[i + 1];
      if (v === undefined || !/^\d{1,4}$/.test(v)) return { flags, positional, problem: '--limit needs a whole number' };
      flags.set(a, v);
      i++;
    } else if (a === '--run') {
      const v = rest[i + 1];
      if (v === undefined || !RUN_ID.test(v)) return { flags, positional, problem: '--run needs a run id (letters, digits, ., - and _)' };
      flags.set(a, v);
      i++;
    } else flags.set(a, true);
  }
  return { flags, positional, problem: null };
}

/** What a stop record names: a session id, every session (null), or a run. */
export type StopTarget = { session: string | null } | { run: string };

/** The audit record of a stop or a clear: a person's act, so `allow` under session `stop`, never an agent's call. */
export function stopRecord(kind: 'set' | 'clear', target: StopTarget, terminal: boolean, now: Date): AuditFields {
  const run = 'run' in target ? target.run : null;
  const id = 'session' in target ? target.session : null;
  const named = run !== null ? `--run ${run}` : (id ?? (kind === 'set' ? '--all' : null));
  const action = kind === 'set' ? `stop ${named}` : `stop --clear${named === null ? '' : ` ${named}`}`;
  const what = run !== null ? (kind === 'set' ? `stopped run ${run}` : `cleared the stop of run ${run}`) : kind === 'set' ? (id === null ? 'stopped every session' : `stopped session ${id}`) : id === null ? 'cleared every stop' : `cleared the stop of ${id}`;
  return { ts: now.toISOString(), source: 'openmorals', session: STOP_SESSION, tool: 'stop', action, decision: 'allow', rule: kind === 'set' ? STOP_SET_RULE : STOP_CLEAR_RULE, reason: `openmorals stop ${what}, run ${terminal ? 'from a terminal' : 'without a terminal (a script, a pipe or an agent)'}`, cwd: null, budget: null };
}

/** Writes the record; the stop itself has already taken effect, so a failure is only reported. */
function recordStop(dir: string, kind: 'set' | 'clear', target: StopTarget, terminal: boolean, now: Date): string {
  try {
    appendAuditForSession(STOP_SESSION, [stopRecord(kind, target, terminal, now)], {}, dir, now);
    return '';
  } catch (err: unknown) {
    return `openmorals stop: done, but it could not be written to the audit log: ${err instanceof Error ? err.message : String(err)}\n`;
  }
}

export function stopCommand(rest: readonly string[], o: { env: NodeJS.ProcessEnv; now?: Date; terminal?: boolean }): CommandResult {
  const p = split(rest, ['--all', '--clear', '--run']);
  const bad = (why: string): CommandResult => ({ stdout: '', stderr: `openmorals stop: ${why}; nothing was done\n`, exitCode: 64 });
  if (p.problem !== null) return bad(p.problem);
  if (p.positional.length > 1) return bad('name one session');
  const dir = configDir(o.env);
  const now = o.now ?? new Date();
  const terminal = o.terminal === true;
  const run = p.flags.get('--run');
  if (typeof run === 'string') {
    if (p.positional.length > 0 || p.flags.has('--all')) return bad('--run names a run; give no session id or --all with it');
    if (p.flags.has('--clear')) {
      clearRunStop(dir, run);
      return { stdout: `Cleared the stop of run ${run}.\n`, stderr: recordStop(dir, 'clear', { run }, terminal, now), exitCode: 0 };
    }
    stopRun(dir, run, o.now);
    return { stdout: `Stopped run ${run}: the next tool call of every session started under it, in every process, is refused and the agent is told to finish. Clear it with openmorals stop --clear --run ${run}.\n`, stderr: recordStop(dir, 'set', { run }, terminal, now), exitCode: 0 };
  }
  const id = p.positional[0] ?? null;
  if (id !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return bad('a session id is letters, digits, - and _');
  if (p.flags.has('--clear')) {
    if (p.flags.has('--all')) return bad('--clear with no session clears every stop; --all is not needed');
    const f = clearStop(dir, id);
    const stderr = recordStop(dir, 'clear', { session: id }, terminal, now);
    const left = Object.keys(f.sessions).length + Object.keys(f.runs ?? {}).length + (f.all !== undefined ? 1 : 0);
    return { stdout: `${id === null ? 'Cleared every stop.' : `Cleared the stop of ${id}.`}${left > 0 ? ` ${left} stop${left === 1 ? '' : 's'} still in place (${stopPath(dir)}).` : ''}\n`, stderr, exitCode: 0 };
  }
  if (p.flags.has('--all') === (id !== null)) return bad('give a session id or --all');
  stopSessions(dir, id, o.now);
  const stderr = recordStop(dir, 'set', { session: id }, terminal, now);
  return { stdout: `${id === null ? 'Stopped every session' : `Stopped session ${id}`}: its next tool call is refused and the agent is told to finish. Clear it with openmorals stop --clear${id === null ? '' : ` ${id}`}.\n`, stderr, exitCode: 0 };
}

export interface SessionRow {
  session: string;
  updated: string | null;
  tool_calls: number;
  tokens: number;
  cache_read: number;
  subagent_runs: number;
  subagents_started: number;
  busiest: { agent: string; kind: string | null; calls: number }[];
  stopped: boolean;
}

export function sessionRows(dir: string, limit: number): SessionRow[] {
  let names: string[] = [];
  try {
    names = readdirSync(join(dir, 'sessions')).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const stop = readStop(dir);
  const rows: SessionRow[] = [];
  for (const n of names) {
    const id = n.slice(0, -'.json'.length);
    const l = loadSession(id, dir);
    if (l.rev === -1) continue;
    const t = transcriptTotals(l.memory.usage);
    const a = l.memory.agents;
    const busiest = Object.entries(a?.calls ?? {})
      .filter(([k]) => k !== MAIN_AGENT)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 3)
      .map(([agent, calls]) => ({ agent, kind: a?.names?.[agent] ?? null, calls }));
    const stopped = stop !== null && ('error' in stop || stop.all !== undefined || stop.sessions[id] !== undefined);
    let updated: string | null = null;
    try {
      updated = statSync(join(dir, 'sessions', n)).mtime.toISOString();
    } catch {
      updated = null;
    }
    rows.push({ session: id, updated, tool_calls: l.state.toolCalls, tokens: l.state.tokens + t.tokens, cache_read: t.cacheRead, subagent_runs: a?.spawns ?? 0, subagents_started: a?.started ?? 0, busiest, stopped });
  }
  return rows.sort((x, y) => (y.updated ?? '').localeCompare(x.updated ?? '')).slice(0, limit);
}

export function sessionsCommand(rest: readonly string[], o: { env: NodeJS.ProcessEnv }): CommandResult {
  const p = split(rest, ['--json', '--limit']);
  if (p.problem !== null || p.positional.length > 0) return { stdout: '', stderr: `openmorals sessions: ${p.problem ?? `unexpected argument ${JSON.stringify(p.positional[0])}`}; nothing was done\n`, exitCode: 64 };
  const lim = p.flags.get('--limit');
  const rows = sessionRows(configDir(o.env), typeof lim === 'string' ? Number(lim) : 20);
  if (p.flags.has('--json')) return { stdout: `${JSON.stringify({ sessions: rows })}\n`, stderr: '', exitCode: 0 };
  if (rows.length === 0) return { stdout: 'No sessions recorded yet.\n', stderr: '', exitCode: 0 };
  const fmt = (n: number): string => n.toLocaleString('en-US');
  const lines = rows.map((r) => {
    const subs = r.subagents_started > 0 ? `, ${r.subagent_runs} sub-agent run${r.subagent_runs === 1 ? '' : 's'} (${r.subagents_started} started)` : '';
    const busy = r.busiest.length > 0 ? `\n    busiest: ${r.busiest.map((b) => `${b.agent}${b.kind !== null ? ` (${b.kind})` : ''} ${b.calls}`).join(', ')}` : '';
    return `${r.session}${r.stopped ? '  STOPPED' : ''}${r.updated !== null ? `  (last call ${r.updated})` : ''}\n    ${fmt(r.tool_calls)} tool calls, ${fmt(r.tokens)} tokens${r.cache_read > 0 ? ` (+${fmt(r.cache_read)} cache reads)` : ''}${subs}${busy}`;
  });
  return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: 0 };
}

export const BUDGET_USAGE = `  openmorals budget start [--id ID] [--tool-calls N] [--tokens N] [--spawns N] [--sessions N]
      Start a run with one budget for every agent in it, across processes and
      restarts, and print the line that exports its id (OPENMORALS_RUN). Each limit
      is a hard limit (refused at it), or SOFT:HARD to ask once for the whole run at
      SOFT; --sessions counts sessions, so each restart or re-dispatch is one more.
      A run's limits are set once: starting the same id again is refused. Only you
      can start one: an agent running it is asked or refused by the hook.
  openmorals budget status [ID] [--json]
      A run's limits and what its sessions have spent, or every run with no ID.
      Read only.`;

function limitOf(v: string): Limit | null {
  const m = /^(?:(\d{1,12}):)?(\d{1,12})$/.exec(v);
  if (m === null) return null;
  const hard = Number(m[2]);
  const soft = m[1] !== undefined ? Number(m[1]) : 0;
  if (hard <= 0 || soft > hard) return null;
  return { soft, hard, step: Math.max(1, hard) };
}

const BUDGET_FLAGS: Readonly<Record<string, RunUnit>> = { '--tool-calls': 'tool_calls', '--tokens': 'tokens', '--spawns': 'spawns', '--sessions': 'sessions' };

function newRunId(now: Date): string {
  return `run-${now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')}-${randomBytes(3).toString('hex')}`;
}

function showLimit(l: Limit | undefined): string {
  if (l === undefined) return 'no limit';
  return l.soft > 0 ? `asks once at ${l.soft}, refused at ${l.hard}` : `refused at ${l.hard}`;
}

export function budgetCommand(rest: readonly string[], o: { env: NodeJS.ProcessEnv; now?: Date }): CommandResult {
  const bad = (why: string): CommandResult => ({ stdout: '', stderr: `openmorals budget: ${why}; nothing was done\n`, exitCode: 64 });
  const sub = rest[0];
  const dir = configDir(o.env);
  if (sub === 'start') {
    const limits: RunLimits = {};
    let id: string | null = null;
    for (let i = 1; i < rest.length; i++) {
      const a = rest[i] as string;
      const v = rest[i + 1];
      if (a === '--id') {
        if (v === undefined || !RUN_ID.test(v) || v === '.' || v === '..') return bad('--id needs a run id (letters, digits, ., - and _, not starting or ending with .)');
        id = v;
      } else if (BUDGET_FLAGS[a] !== undefined) {
        const l = v !== undefined ? limitOf(v) : null;
        if (l === null) return bad(`${a} needs a whole number above 0, or SOFT:HARD with SOFT no higher than HARD`);
        limits[BUDGET_FLAGS[a] as RunUnit] = l;
      } else return bad(`unknown option ${a}`);
      i++;
    }
    if (Object.keys(limits).length === 0) return bad('give at least one limit (--tool-calls, --tokens, --spawns or --sessions)');
    const now = o.now ?? new Date();
    const run = id ?? newRunId(now);
    const r = startRun(dir, run, limits, now);
    if (!r.ok) return bad(r.error);
    const lines = RUN_UNITS.filter((u) => limits[u] !== undefined).map((u) => `  ${u}: ${showLimit(limits[u])}`);
    return { stdout: `export OPENMORALS_RUN=${run}\n`, stderr: `Started run ${run}:\n${lines.join('\n')}\nStart every agent of the run with OPENMORALS_RUN=${run} in its environment (eval "$(openmorals budget start ...)" sets it in this shell). openmorals stop --run ${run} stops all of them.\n`, exitCode: 0 };
  }
  if (sub === 'status') {
    const args = rest.slice(1);
    const json = args.includes('--json');
    const pos = args.filter((a) => a !== '--json');
    if (pos.some((a) => a.startsWith('-'))) return bad(`unknown option ${pos.find((a) => a.startsWith('-')) as string}`);
    if (pos.length > 1) return bad('name one run');
    const ids = pos.length === 1 ? [pos[0] as string] : listRuns(dir);
    const stop = readStop(dir);
    const rows = ids.map((id) => ({ ...runStatus(dir, id), stopped: stop !== null && ('error' in stop || stop.all !== undefined || stop.runs?.[id] !== undefined) }));
    if (json) return { stdout: `${JSON.stringify({ runs: rows })}\n`, stderr: '', exitCode: 0 };
    if (rows.length === 0) return { stdout: 'No runs recorded yet.\n', stderr: '', exitCode: 0 };
    const fmt = (n: number): string => n.toLocaleString('en-US');
    const out = rows.map((r) => {
      const head = `${r.run}${r.stopped ? '  STOPPED' : ''}${r.error !== null ? `  LIMITS UNREADABLE: ${r.error}` : r.limits === null ? '  (no limits: counted only)' : ''}`;
      const used = RUN_UNITS.map((u) => `${u.replace('_', ' ')} ${fmt(r.totals[u])}${r.limits?.[u] !== undefined ? ` (${showLimit(r.limits[u])})` : ''}`).join(', ');
      const bad2 = r.unreadable.length > 0 ? `\n    ${r.unreadable.length} session file(s) could not be read` : '';
      return `${head}\n    ${used}${bad2}`;
    });
    return { stdout: `${out.join('\n')}\n`, stderr: '', exitCode: 0 };
  }
  return bad(sub === undefined ? 'name a subcommand: start or status' : `unknown subcommand ${JSON.stringify(sub)} (start or status)`);
}
