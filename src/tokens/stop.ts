import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeSessionId } from '../paths.js';
import type { Verdict } from '../types.js';

/**
 * The stop command (0.36.0): `openmorals stop <session>` or `--all` writes `stop.json` in the config folder, and the
 * hook refuses every tool call of a stopped session, in the main conversation and in every sub-agent, until the person
 * clears it (`openmorals stop --clear`, which an agent cannot run). Work already done is kept; nothing is undone.
 */
export interface StopFile {
  /** When every session was stopped, or absent. */
  all?: string;
  /** Stopped sessions by id, with when. */
  sessions: Record<string, string>;
  /**
   * Scopes this version does not know, kept as they are. Each scope is one key of the file (today `all` and `sessions`);
   * a later scope, such as one kind of agent, adds a key, and an older openmorals writes it back unchanged.
   */
  other?: Record<string, unknown>;
}

export function stopPath(dir: string): string {
  return join(dir, 'stop.json');
}

/** The stop file, `null` when there is none, or `{ error }` when it is there but cannot be read (every session then stops). */
export function readStop(dir: string): StopFile | null | { error: string } {
  let text: string;
  try {
    text = readFileSync(stopPath(dir), 'utf8');
  } catch (err: unknown) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
    if (code === 'ENOENT') return null;
    return { error: `the stop file could not be read (${code !== '' ? code : err instanceof Error ? err.message : String(err)})` };
  }
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: 'the stop file is not a JSON object' };
    const o = raw as Record<string, unknown>;
    const sessions: Record<string, string> = {};
    const s = o['sessions'];
    if (typeof s === 'object' && s !== null && !Array.isArray(s)) for (const [k, v] of Object.entries(s as Record<string, unknown>)) sessions[k] = typeof v === 'string' ? v : '';
    const other: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) if (k !== 'all' && k !== 'sessions') other[k] = v;
    const keep = Object.keys(other).length > 0 ? { other } : {};
    return typeof o['all'] === 'string' ? { all: o['all'], sessions, ...keep } : { sessions, ...keep };
  } catch {
    return { error: 'the stop file could not be parsed' };
  }
}

function writeStop(dir: string, f: StopFile): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = stopPath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  const { other, ...known } = f;
  writeFileSync(tmp, `${JSON.stringify({ ...other, ...known }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

function current(dir: string): StopFile {
  const f = readStop(dir);
  return f === null || 'error' in f ? { sessions: {} } : f;
}

/** Stops one session, or every session with `null`. */
export function stopSessions(dir: string, session: string | null, now: Date = new Date()): StopFile {
  const f = current(dir);
  const next: StopFile = session === null ? { ...f, all: now.toISOString() } : { ...f, sessions: { ...f.sessions, [safeSessionId(session)]: now.toISOString() } };
  writeStop(dir, next);
  return next;
}

/** Clears the stop of one session, or every stop with `null`. Person-only: the self-protect guard refuses it to an agent. */
export function clearStop(dir: string, session: string | null): StopFile {
  if (session === null) {
    writeStop(dir, { sessions: {} });
    return { sessions: {} };
  }
  const f = current(dir);
  const sessions = { ...f.sessions };
  delete sessions[safeSessionId(session)];
  const next: StopFile = { ...f, sessions };
  writeStop(dir, next);
  return next;
}

export const STOPPED_RULE = 'budget.stopped';
/** `openmorals stop` records its own acts in the audit log (0.37.0) under this session, with these rules. */
export const STOP_SESSION = 'stop';
export const STOP_SET_RULE = 'stop.set';
export const STOP_CLEAR_RULE = 'stop.clear';

/** The refusal for a call of a stopped session, or null. */
export function stopVerdict(dir: string, session: string | null): Verdict | null {
  const f = readStop(dir);
  if (f === null) return null;
  if ('error' in f) return { decision: 'deny', rule: STOPPED_RULE, reason: `${f.error}, so every session is held as stopped; the person can run openmorals stop --clear` };
  const id = safeSessionId(session ?? 'unknown');
  const when = f.sessions[id] ?? f.all;
  if (when === undefined) return null;
  return { decision: 'deny', rule: STOPPED_RULE, reason: `the person stopped ${f.sessions[id] !== undefined ? 'this session' : 'every session'} with openmorals stop${when !== '' ? ` (${when})` : ''}; finish now without calling more tools. Nothing already done is undone, and only the person can clear the stop` };
}
