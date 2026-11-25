import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditFields, AuditMeta } from './audit.js';
import { appendAuditText, chainAudit } from './audit.js';
import { auditLogPath, configDir, sessionStatePath } from './paths.js';
import type { SessionMemory } from './session.js';
import { EMPTY_MEMORY, HISTORY_KEEP, WROTE_KEEP, parseMemory } from './session.js';
import { mergeTaint } from './taint/index.js';
import type { SessionState } from './types.js';
import { EMPTY_STATE } from './types.js';

export interface StoredSession extends SessionState, SessionMemory {
  session: string;
  updated: string;
  /** How many saves the file has had (0.32.1); a writer that finds it moved since it loaded merges instead of overwriting. */
  rev?: number;
}

export interface LoadedSession {
  state: SessionState;
  memory: SessionMemory;
  /** The file's save count when it was read (0.32.1): 0 for a new or pre-0.32.1 file, -1 for one that could not be read. */
  rev?: number;
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
  return { state: { ...EMPTY_STATE }, memory: { ...parseMemory({ taint: 'unreadable' }), unreadable: why }, rev: -1 };
}

function revOf(o: Record<string, unknown>): number {
  const r = o['rev'];
  return typeof r === 'number' && Number.isInteger(r) && r >= 0 ? r : 0;
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
    if (code === 'ENOENT') return { state: { ...EMPTY_STATE }, memory: EMPTY_MEMORY, rev: 0 };
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
  return { state: counters(o), memory: parseMemory(o), rev: revOf(o) };
}

export function loadSessionState(sessionId: string, dir: string = configDir()): SessionState {
  return loadSession(sessionId, dir).state;
}

/** How long a writer waits for another writer of the same session (0.32.1), and when a left-over lock counts as stale. */
export const SESSION_LOCK_WAIT_MS = 2000;
export const SESSION_LOCK_STALE_MS = 10000;

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs `fn` while holding the session file's lock (`<file>.lock`, made with an exclusive create and holding a token
 * that only this call knows). The lock covers only the read and write of the file, never a judgement or a model call,
 * so a wait is short. A lock older than `SESSION_LOCK_STALE_MS` was left by a process that died: a waiter renames it
 * away first (so two waiters cannot both reclaim it), then removes it. Every retry checks the deadline: when the lock
 * cannot be taken in `SESSION_LOCK_WAIT_MS` it throws, and every caller already treats a failed save as "ask". On
 * release the lock is removed only if it still holds this call's token.
 */
export function withSessionLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  const token = `${process.pid}.${randomBytes(8).toString('hex')}`;
  const start = Date.now();
  const late = (): boolean => Date.now() - start > SESSION_LOCK_WAIT_MS;
  const fail = (): never => {
    throw new Error('another call of this session held its saved state for too long');
  };
  for (;;) {
    try {
      writeFileSync(lock, token, { flag: 'wx', mode: 0o600 });
      break;
    } catch (err: unknown) {
      const code = errCode(err);
      // EPERM, EACCES and EBUSY are what Windows reports while another process is creating or removing the lock.
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw err;
      if (late()) fail();
      if (code === 'EEXIST') reclaimIfStale(lock);
      if (late()) fail();
      pause(5 + Math.floor(Math.random() * 10));
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (readFileSync(lock, 'utf8') === token) rmSync(lock, { force: true });
    } catch {
      // Already gone, or replaced by a lock that is not ours: leave it.
    }
  }
}

function errCode(err: unknown): string | null {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : null;
}

/** Moves a stale lock aside and removes it. A lock that turns out to be fresh is put back without replacing another. */
function reclaimIfStale(lock: string): void {
  try {
    if (Date.now() - statSync(lock).mtimeMs <= SESSION_LOCK_STALE_MS) return;
  } catch {
    return; // Gone already: the next try takes it.
  }
  const claimed = `${lock}.${process.pid}.${randomBytes(4).toString('hex')}.stale`;
  try {
    renameSync(lock, claimed);
  } catch {
    return; // Another waiter moved it first.
  }
  try {
    if (Date.now() - statSync(claimed).mtimeMs <= SESSION_LOCK_STALE_MS) {
      // A live lock was made between our check and the rename: put it back unless a newer one already exists.
      try {
        linkSync(claimed, lock);
      } catch {
        // A newer lock exists; the one we moved belongs to a call that will find it gone and leave it.
      }
    }
  } catch {
    // Fall through and remove what we moved.
  }
  rmSync(claimed, { force: true, recursive: true });
}

function delta(b: number, d: number, o: number): number {
  return Math.max(0, d + (o - b));
}

/** What `ours` added to `base`, counting repeats: base [a] and ours [a, a] added one a. */
function addedSince<T>(base: readonly T[], ours: readonly T[]): T[] {
  const left = new Map<string, number>();
  for (const x of base) {
    const k = JSON.stringify(x);
    left.set(k, (left.get(k) ?? 0) + 1);
  }
  const out: T[] = [];
  for (const x of ours) {
    const k = JSON.stringify(x);
    const n = left.get(k) ?? 0;
    if (n > 0) left.set(k, n - 1);
    else out.push(x);
  }
  return out;
}

/**
 * What a writer saves when another writer of the same session saved after it loaded (0.32.1): sub-agents of one session
 * run hooks at the same time, and without this the later save erased the earlier one's taint marks, history and counts.
 * Counts add both writers' increases; taint keeps both writers' marks; history keeps both writers' new entries; the
 * other fields keep this writer's value when it changed them and the file's otherwise. Nothing either writer added is
 * dropped, so a merge can only make the next judgement stricter.
 */
export function mergeSession(base: LoadedSession, disk: LoadedSession, ours: LoadedSession): LoadedSession {
  const b = base.state;
  const d = disk.state;
  const o = ours.state;
  const state: SessionState = { toolCalls: delta(b.toolCalls, d.toolCalls, o.toolCalls), tokens: delta(b.tokens, d.tokens, o.tokens), prevTokens: delta(b.prevTokens, d.prevTokens, o.prevTokens) };
  if (o.cost !== undefined || d.cost !== undefined) state.cost = delta(b.cost ?? 0, d.cost ?? 0, o.cost ?? 0);
  if (o.prevCost !== undefined || d.prevCost !== undefined) state.prevCost = delta(b.prevCost ?? 0, d.prevCost ?? 0, o.prevCost ?? 0);
  const bm = base.memory;
  const dm = disk.memory;
  const om = ours.memory;
  const changed = (x: unknown, y: unknown): boolean => JSON.stringify(x) !== JSON.stringify(y);
  const pick = <K extends 'outbound' | 'trashNote'>(k: K): SessionMemory[K] => (changed(bm[k], om[k]) ? om[k] : dm[k]);
  const memory: SessionMemory = {
    history: [...dm.history, ...addedSince(bm.history, om.history)].slice(-HISTORY_KEEP),
    taint: mergeTaint(bm.taint, dm.taint, om.taint),
  };
  const unreadable = om.unreadable ?? dm.unreadable;
  if (unreadable !== undefined) memory.unreadable = unreadable;
  const chain = om.chain === undefined ? dm.chain : dm.chain === undefined || om.chain.seq >= dm.chain.seq ? om.chain : dm.chain;
  if (chain !== undefined) memory.chain = chain;
  const outbound = pick('outbound');
  if (outbound !== undefined) memory.outbound = outbound;
  const trashNote = pick('trashNote');
  if (trashNote !== undefined) memory.trashNote = trashNote;
  if (om.wrote !== undefined || dm.wrote !== undefined) {
    let wrote = [...(dm.wrote ?? [])];
    for (const w of addedSince(bm.wrote ?? [], om.wrote ?? [])) wrote = [...wrote.filter((x) => x.p !== w.p), w];
    memory.wrote = wrote.slice(-WROTE_KEEP);
  }
  if (om.guided !== undefined || dm.guided !== undefined) memory.guided = [...new Set([...(dm.guided ?? []), ...(om.guided ?? [])])];
  return { state, memory };
}

/**
 * Saves a session's state. With `base` (what this writer loaded), the file is re-read under the session lock and, when
 * another writer saved since `base`, the two are merged (`mergeSession`) instead of this save erasing that one.
 */
export function saveSession(sessionId: string, state: SessionState, memory: SessionMemory, dir: string = configDir(), now: Date = new Date(), base?: LoadedSession): void {
  const file = sessionStatePath(sessionId, dir);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  withSessionLock(file, () => {
    const disk = loadSession(sessionId, dir);
    let s = state;
    let m = memory;
    if (base !== undefined && disk.rev !== undefined && disk.rev >= 0 && disk.rev !== base.rev) {
      const merged = mergeSession(base, disk, { state, memory });
      s = merged.state;
      m = merged.memory;
    }
    const body: StoredSession = {
      session: sessionId,
      ...s,
      history: m.history,
      taint: m.taint,
      ...(m.unreadable !== undefined ? { unreadable: m.unreadable } : {}),
      ...(m.chain !== undefined ? { chain: m.chain } : {}),
      ...(m.outbound !== undefined ? { outbound: m.outbound } : {}),
      ...(m.trashNote !== undefined ? { trashNote: m.trashNote } : {}),
      ...(m.wrote !== undefined ? { wrote: m.wrote } : {}),
      ...(m.guided !== undefined ? { guided: m.guided } : {}),
      updated: now.toISOString(),
      rev: Math.max(disk.rev ?? 0, 0) + 1,
    };
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  });
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
      saveSession(id, loaded.state, { ...loaded.memory, chain: chained.head }, dir, now, loaded);
    } catch {
      // The line is still written; see above.
    }
  }
  appendAuditText(chained.text, auditLogPath(dir));
}

export function saveSessionState(sessionId: string, state: SessionState, dir: string = configDir(), now: Date = new Date()): void {
  const loaded = loadSession(sessionId, dir);
  saveSession(sessionId, state, loaded.memory, dir, now, loaded);
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
