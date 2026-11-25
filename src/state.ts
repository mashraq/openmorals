import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditFields, AuditMeta } from './audit.js';
import { appendAuditText, chainAudit } from './audit.js';
import { auditLogPath, configDir, sessionStatePath } from './paths.js';
import type { SessionMemory } from './session.js';
import { EMPTY_MEMORY, parseMemory } from './session.js';
import type { SessionState } from './types.js';
import { EMPTY_STATE } from './types.js';

export interface StoredSession extends SessionState, SessionMemory {
  session: string;
  updated: string;
}

export interface LoadedSession {
  state: SessionState;
  memory: SessionMemory;
}

function nonNegInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function nonNegNum(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function counters(o: Record<string, unknown>): SessionState {
  const s: SessionState = { toolCalls: nonNegInt(o['toolCalls']), tokens: nonNegInt(o['tokens']), prevTokens: nonNegInt(o['prevTokens']) };
  const cost = nonNegNum(o['cost']);
  const prevCost = nonNegNum(o['prevCost']);
  if (cost !== undefined) s.cost = cost;
  if (prevCost !== undefined) s.prevCost = prevCost;
  return s;
}

function lost(why: string): LoadedSession {
  return { state: { ...EMPTY_STATE }, memory: { ...parseMemory({ taint: 'unreadable' }), unreadable: why } };
}

/**
 * Reads a session's saved state. Only a missing file is a new, clean session. Any other read error (permission,
 * a folder in its place) and unparsable content fail toward caution: the taint reads as untrusted, the counts
 * restart, and `memory.unreadable` says why, so the next judged call asks instead of starting clean in silence.
 */
export function loadSession(sessionId: string, dir: string = configDir()): LoadedSession {
  let text: string;
  try {
    text = readFileSync(sessionStatePath(sessionId, dir), 'utf8');
  } catch (err: unknown) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : null;
    if (code === 'ENOENT') return { state: { ...EMPTY_STATE }, memory: EMPTY_MEMORY };
    return lost(`the saved session state could not be read (${code ?? (err instanceof Error ? err.message : String(err))})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return lost('the saved session state could not be parsed');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return lost('the saved session state is not a JSON object');
  const o = raw as Record<string, unknown>;
  return { state: counters(o), memory: parseMemory(o) };
}

export function loadSessionState(sessionId: string, dir: string = configDir()): SessionState {
  return loadSession(sessionId, dir).state;
}

export function saveSession(sessionId: string, state: SessionState, memory: SessionMemory, dir: string = configDir(), now: Date = new Date()): void {
  const file = sessionStatePath(sessionId, dir);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const body: StoredSession = {
    session: sessionId,
    ...state,
    history: memory.history,
    taint: memory.taint,
    ...(memory.unreadable !== undefined ? { unreadable: memory.unreadable } : {}),
    ...(memory.chain !== undefined ? { chain: memory.chain } : {}),
    ...(memory.outbound !== undefined ? { outbound: memory.outbound } : {}),
    ...(memory.trashNote !== undefined ? { trashNote: memory.trashNote } : {}),
    ...(memory.wrote !== undefined ? { wrote: memory.wrote } : {}),
    ...(memory.guided !== undefined ? { guided: memory.guided } : {}),
    updated: now.toISOString(),
  };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * For a writer that holds no loaded session (the `check` command, an event that could not be read): chains the records
 * after the session file's head (`unknown` when there is no session id), saves the new head, then appends. A failed save
 * still appends; the next record then repeats this seq, which `audit verify` reports as a fork. A failed append throws.
 */
export function appendAuditForSession(sessionId: string | null, records: readonly AuditFields[], meta: AuditMeta, dir: string = configDir(), now: Date = new Date()): void {
  if (records.length === 0) return;
  const id = sessionId ?? 'unknown';
  const loaded = loadSession(id, dir);
  const chained = chainAudit(records, meta, loaded.memory.chain);
  if (chained.head !== undefined) {
    try {
      saveSession(id, loaded.state, { ...loaded.memory, chain: chained.head }, dir, now);
    } catch {
      // The line is still written; see above.
    }
  }
  appendAuditText(chained.text, auditLogPath(dir));
}

export function saveSessionState(sessionId: string, state: SessionState, dir: string = configDir(), now: Date = new Date()): void {
  saveSession(sessionId, state, loadSession(sessionId, dir).memory, dir, now);
}

/** Counts the call being judged. The token and cost counts are compared with their values at the last judged call. */
export function countToolCall(state: SessionState): SessionState {
  return { ...state, toolCalls: state.toolCalls + 1 };
}

/** Adds tokens a host reported (between judged calls); the next judged call sees the rise. */
export function addTokens(state: SessionState, tokens: number): SessionState {
  const t = Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0;
  return { ...state, tokens: state.tokens + t };
}

/** Adds priced spend, in hundredths of the price table's currency. */
export function addCost(state: SessionState, cost: number): SessionState {
  const c = Number.isFinite(cost) && cost > 0 ? cost : 0;
  return { ...state, cost: (state.cost ?? 0) + c };
}

/** After a judged call: the counts it saw become the baseline for the next one. */
export function settleBudget(state: SessionState): SessionState {
  return { ...state, prevTokens: state.tokens, ...(state.cost !== undefined ? { prevCost: state.cost } : {}) };
}
