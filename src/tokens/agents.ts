import type { Finding } from '../guard.js';
import { budgetFindings } from '../guards/budget.js';
import { quoteForReason } from '../guard.js';
import type { Bylaws, Limit } from '../types.js';

/**
 * Per-agent counts and the sub-agent limit (0.36.0). Hooks run in a sub-agent with its `agent_id`, so each sub-agent's
 * tool calls are counted apart from the session's, and every call of the tool that starts a sub-agent is counted.
 *
 * Planned fan-out counts as one run: sub-agents an agent starts one after another with no other tool call of its own in
 * between (one batch of parallel calls) are one run of `spawns`, and the batch's size is held to `fanout` instead. Any
 * other tool call by that agent closes its batch.
 */
export interface AgentsMemory {
  /** Tool calls by sub-agent id (the main conversation is not listed: it is the session count less these). */
  calls: Readonly<Record<string, number>>;
  /** Runs of sub-agents started (a batch counts once). */
  spawns: number;
  /** Sub-agents started in all (every call of the spawn tool). */
  started: number;
  /** Open batches: by agent (`main` for the main conversation), how many sub-agents the current batch started. */
  open: Readonly<Record<string, number>>;
  /** The kind of each sub-agent by id (the host's agent type, such as `Explore`), when the host passed one; absent when none was seen. */
  names?: Readonly<Record<string, string>>;
}

/** The tool names that start a sub-agent: Claude Code's `Agent`, called `Task` before v2.1.63. */
export const SPAWN_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task']);
export const MAX_AGENTS = 512;
export const MAIN_AGENT = 'main';

export const EMPTY_AGENTS: AgentsMemory = Object.freeze({ calls: Object.freeze({}), spawns: 0, started: 0, open: Object.freeze({}) });

export function defaultSpawns(): Limit {
  return { soft: 25, hard: 0, step: 25 };
}
export const DEFAULT_FANOUT = 10;

export function agentLimits(b: Bylaws): { agentCalls: Limit; spawns: Limit; fanout: number } {
  const g = b.guards.budget;
  return { agentCalls: g.agent_tool_calls ?? { soft: 0, hard: 0, step: 100 }, spawns: g.spawns ?? defaultSpawns(), fanout: g.fanout ?? DEFAULT_FANOUT };
}

function capped(r: Record<string, number>): Record<string, number> {
  const keys = Object.keys(r);
  if (keys.length <= MAX_AGENTS) return r;
  const out: Record<string, number> = {};
  for (const k of keys.slice(-MAX_AGENTS)) out[k] = r[k] as number;
  return out;
}

function cappedNames(r: Record<string, string>): Record<string, string> {
  const keys = Object.keys(r);
  if (keys.length <= MAX_AGENTS) return r;
  const out: Record<string, string> = {};
  for (const k of keys.slice(-MAX_AGENTS)) out[k] = r[k] as string;
  return out;
}

/** The counts after one judged call by `agent` (null for the main conversation), of the kind `agentType` when the host passed one. */
export function countAgentCall(m: AgentsMemory | undefined, agent: string | null, tool: string, agentType: string | null = null): AgentsMemory {
  const cur = m ?? EMPTY_AGENTS;
  const key = agent ?? MAIN_AGENT;
  const calls = agent === null ? { ...cur.calls } : capped({ ...cur.calls, [key]: (cur.calls[key] ?? 0) + 1 });
  const named = agent !== null && agentType !== null && agentType !== '' && cur.names?.[key] !== agentType;
  const names = named ? { names: cappedNames({ ...cur.names, [key]: agentType.slice(0, 64) }) } : cur.names !== undefined ? { names: cur.names } : {};
  const open = { ...cur.open };
  if (!SPAWN_TOOLS.has(tool)) {
    delete open[key];
    return { calls, spawns: cur.spawns, started: cur.started, open, ...names };
  }
  const inBatch = open[key] !== undefined;
  open[key] = (open[key] ?? 0) + 1;
  return { calls, spawns: cur.spawns + (inBatch ? 0 : 1), started: cur.started + 1, open: capped(open), ...names };
}

/** The findings for one judged call, from the counts before and after it. */
export function agentFindings(before: AgentsMemory | undefined, after: AgentsMemory, agent: string | null, agentType: string | null, tool: string, bylaws: Bylaws): Finding[] {
  const lim = agentLimits(bylaws);
  const b = before ?? EMPTY_AGENTS;
  const out: Finding[] = [];
  if (agent !== null) {
    const who = `the sub-agent ${agentType !== null ? `${quoteForReason(agentType, 40)} ` : ''}(${quoteForReason(agent, 24)})`;
    for (const f of budgetFindings('agent_tool_calls', `tool calls by ${who}`, after.calls[agent] ?? 0, b.calls[agent] ?? 0, lim.agentCalls)) out.push(f);
  }
  if (SPAWN_TOOLS.has(tool)) {
    // The hard limit holds on every spawn call, in a batch too: a refused spawn still opens its batch, and a retry in the
    // same batch would otherwise go through. The soft ask comes once per new run.
    if (lim.spawns.hard > 0 && after.spawns >= lim.spawns.hard) out.push(...budgetFindings('spawns', 'runs of sub-agents in this session', after.spawns, b.spawns, lim.spawns));
    else if (after.spawns > b.spawns) out.push(...budgetFindings('spawns', 'runs of sub-agents in this session', after.spawns, b.spawns, lim.spawns));
    const key = agent ?? MAIN_AGENT;
    const size = after.open[key] ?? 0;
    // Asked once, when the batch passes the limit; parallel hooks can merge a batch past the exact count, so this is a crossing test.
    if (lim.fanout > 0 && size > lim.fanout && (b.open[key] ?? 0) <= lim.fanout) {
      out.push({ decision: 'ask', rule: 'budget.fanout', reason: `this starts sub-agent ${size} of one batch, past the fan-out limit of ${lim.fanout} (guards.budget.fanout); each one runs and spends tokens on its own; continue?` });
    }
  }
  return out;
}

function counts(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return out;
  for (const [k, n] of Object.entries(v as Record<string, unknown>).slice(-MAX_AGENTS)) if (typeof n === 'number' && Number.isInteger(n) && n > 0) out[k.slice(0, 128)] = n;
  return out;
}

function nat(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
}

export function parseAgentsMemory(v: unknown): AgentsMemory | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const names: Record<string, string> = {};
  const n = o['names'];
  if (typeof n === 'object' && n !== null && !Array.isArray(n)) for (const [k, t] of Object.entries(n as Record<string, unknown>).slice(-MAX_AGENTS)) if (typeof t === 'string' && t !== '') names[k.slice(0, 128)] = t.slice(0, 64);
  const base = { calls: counts(o['calls']), spawns: nat(o['spawns']), started: nat(o['started']), open: counts(o['open']) };
  return Object.keys(names).length > 0 ? { ...base, names } : base;
}

/**
 * Two writers of one session: counts add both writers' increases. An open batch adds both writers' increases too, so
 * sub-agents started in parallel hooks add up; a batch this writer closed stays closed.
 */
export function mergeAgentsMemory(base: AgentsMemory | undefined, disk: AgentsMemory | undefined, ours: AgentsMemory | undefined): AgentsMemory | undefined {
  if (ours === undefined) return disk;
  if (disk === undefined) return ours;
  const b = base ?? EMPTY_AGENTS;
  const calls: Record<string, number> = { ...disk.calls };
  for (const [k, n] of Object.entries(ours.calls)) calls[k] = Math.max(0, (disk.calls[k] ?? 0) + n - (b.calls[k] ?? 0));
  const d = (x: number, y: number, z: number): number => Math.max(0, y + z - x);
  const open: Record<string, number> = { ...disk.open };
  for (const k of Object.keys(b.open)) if (ours.open[k] === undefined) delete open[k];
  for (const [k, n] of Object.entries(ours.open)) open[k] = Math.max(n, (disk.open[k] ?? 0) + n - (b.open[k] ?? 0));
  const names = disk.names !== undefined || ours.names !== undefined ? { names: cappedNames({ ...disk.names, ...ours.names }) } : {};
  return { calls: capped(calls), spawns: d(b.spawns, disk.spawns, ours.spawns), started: d(b.started, disk.started, ours.started), open: capped(open), ...names };
}
