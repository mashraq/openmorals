import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../paths.js';
import { loadSession } from '../state.js';
import { MAIN_AGENT } from './agents.js';
import type { AuditFields } from '../audit.js';
import { appendAuditForSession } from '../state.js';
import { clearStop, readStop, STOP_CLEAR_RULE, STOP_SESSION, STOP_SET_RULE, stopPath, stopSessions } from './stop.js';
import { transcriptTotals } from './transcript.js';

export const STOP_USAGE = `  openmorals stop <session-id>
  openmorals stop --all
      Stop a session (or every session): from the next tool call on, the hook
      refuses every call of it, in the main conversation and every sub-agent,
      and tells the agent to finish. Nothing already done is undone.
  openmorals stop --clear [<session-id>]
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
    } else flags.set(a, true);
  }
  return { flags, positional, problem: null };
}

/** The audit record of a stop or a clear: a person's act, so `allow` under session `stop`, never an agent's call. */
export function stopRecord(kind: 'set' | 'clear', id: string | null, terminal: boolean, now: Date): AuditFields {
  const action = kind === 'set' ? `stop ${id ?? '--all'}` : `stop --clear${id === null ? '' : ` ${id}`}`;
  const what = kind === 'set' ? (id === null ? 'stopped every session' : `stopped session ${id}`) : id === null ? 'cleared every stop' : `cleared the stop of ${id}`;
  return { ts: now.toISOString(), source: 'openmorals', session: STOP_SESSION, tool: 'stop', action, decision: 'allow', rule: kind === 'set' ? STOP_SET_RULE : STOP_CLEAR_RULE, reason: `openmorals stop ${what}, run ${terminal ? 'from a terminal' : 'without a terminal (a script, a pipe or an agent)'}`, cwd: null, budget: null };
}

/** Writes the record; the stop itself has already taken effect, so a failure is only reported. */
function recordStop(dir: string, rec: AuditFields, now: Date): string {
  try {
    appendAuditForSession(STOP_SESSION, [rec], {}, dir, now);
    return '';
  } catch (err: unknown) {
    return `openmorals stop: done, but it could not be written to the audit log: ${err instanceof Error ? err.message : String(err)}\n`;
  }
}

export function stopCommand(rest: readonly string[], o: { env: NodeJS.ProcessEnv; now?: Date; terminal?: boolean }): CommandResult {
  const p = split(rest, ['--all', '--clear']);
  const bad = (why: string): CommandResult => ({ stdout: '', stderr: `openmorals stop: ${why}; nothing was done\n`, exitCode: 64 });
  if (p.problem !== null) return bad(p.problem);
  if (p.positional.length > 1) return bad('name one session');
  const dir = configDir(o.env);
  const id = p.positional[0] ?? null;
  if (id !== null && !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return bad('a session id is letters, digits, - and _');
  if (p.flags.has('--clear')) {
    if (p.flags.has('--all')) return bad('--clear with no session clears every stop; --all is not needed');
    const f = clearStop(dir, id);
    const now = o.now ?? new Date();
    const stderr = recordStop(dir, stopRecord('clear', id, o.terminal === true, now), now);
    const left = Object.keys(f.sessions).length + (f.all !== undefined ? 1 : 0);
    return { stdout: `${id === null ? 'Cleared every stop.' : `Cleared the stop of ${id}.`}${left > 0 ? ` ${left} stop${left === 1 ? '' : 's'} still in place (${stopPath(dir)}).` : ''}\n`, stderr, exitCode: 0 };
  }
  if (p.flags.has('--all') === (id !== null)) return bad('give a session id or --all');
  stopSessions(dir, id, o.now);
  const now = o.now ?? new Date();
  const stderr = recordStop(dir, stopRecord('set', id, o.terminal === true, now), now);
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
