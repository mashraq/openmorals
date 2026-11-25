import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The deferred-ask queue (0.19.0). One folder, `deferred/` in the openmorals config directory, holds one file per
 * request, `<id>.json`, written once and never rewritten, and beside it empty-or-small marker files written once with
 * an exclusive create: `<id>.approved` (the person approved it), `<id>.used` (the one call it allowed has run),
 * `<id>.refused` (the person said no), `<id>.void` (a file it names changed after approval) and `<id>.reminded` (the
 * waiting line was shown once). An exclusive create is what
 * makes a grant single use: two calls racing for one grant cannot both create `<id>.used`.
 *
 * Nothing in these files is a secret or file content: the action is the redacted one-line text the audit record keeps,
 * the arguments are kept only as a salted SHA-256, and the approval code only as its SHA-256. A program running as the
 * person can still write these files (the same-user limit; the OS sandbox's read-only paths are the answer there).
 */

export const DEFER_DIR = 'deferred';
/** A request lapses this long after it was queued, approved or not. */
export const DEFER_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** Request files whose lapse is older than this are removed when a new request is queued. */
export const DEFER_PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many request files are read; more are reported, never trusted. */
export const DEFER_MAX_ITEMS = 500;
export const MAX_FILE_STATES = 64;
const MAX_TEXT = 300;
const MAX_ID_TEXT = 128;

/** Crockford's base 32: no I, L, O or U, so a code read aloud or copied by hand is not misread. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ID_RE = /^D-[0-9A-HJKMNP-TV-Z]{4}$/;
export const CODE_RE = /^D-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{6}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;

export interface FileState {
  path: string;
  kind: 'file' | 'folder' | 'other';
  size: number;
  mtime_ms: number;
}

/** What one request is bound to: the session, the project folder, the tool, the exact arguments (salted hash) and the files. */
export interface Binding {
  session: string;
  cwd: string;
  tool: string;
  salt: string;
  action_sha256: string;
  files: FileState[];
}

export interface DeferItem extends Binding {
  v: 1;
  id: string;
  code_sha256: string;
  /** The redacted one-line action, as the audit record keeps it. */
  shown: string;
  rule: string;
  reason: string;
  queued: string;
  expires: string;
}

export type ItemState = 'waiting' | 'approved' | 'used' | 'refused' | 'void' | 'lapsed';

export interface ItemView {
  item: DeferItem;
  state: ItemState;
  approvedVia?: string;
  reminded: boolean;
}

export interface Unreadable {
  file: string;
  why: string;
}

export interface QueueRead {
  items: ItemView[];
  unreadable: Unreadable[];
  /** Set when the folder itself could not be read: then nothing in it grants anything. */
  error?: string;
}

export function deferDir(configDir: string): string {
  return join(configDir, DEFER_DIR);
}

function randomText(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}

export function newSalt(): string {
  return randomBytes(16).toString('hex');
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function codeHash(code: string): string {
  return sha256(`openmorals-defer-code-1\0${code.toUpperCase()}`);
}

/** True when `code` is the one whose hash the request holds; compared in constant time. */
export function codeMatches(item: DeferItem, code: string): boolean {
  const a = Buffer.from(codeHash(code), 'hex');
  const b = Buffer.from(item.code_sha256, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function errCode(err: unknown): string {
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : null;
  return code ?? (err instanceof Error ? err.message : String(err));
}

function cap(s: string, n = MAX_TEXT): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export interface NewRequest {
  binding: Binding;
  shown: string;
  rule: string;
  reason: string;
}

export interface Queued {
  item: DeferItem;
  /** The approval code: shown once, on a channel only the person sees; never stored. */
  code: string;
}

/** Queues a request: writes `<id>.json` with an exclusive create (a new id on a clash). Throws when it cannot be written. */
export function queueRequest(configDir: string, req: NewRequest, now: Date = new Date()): Queued {
  const dir = deferDir(configDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  pruneOld(dir, now);
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = `D-${randomText(4)}`;
    const code = `${id}-${randomText(6)}`;
    const item: DeferItem = {
      v: 1,
      id,
      code_sha256: codeHash(code),
      session: cap(req.binding.session, MAX_ID_TEXT),
      cwd: req.binding.cwd,
      tool: cap(req.binding.tool, MAX_ID_TEXT),
      salt: req.binding.salt,
      action_sha256: req.binding.action_sha256,
      files: req.binding.files.slice(0, MAX_FILE_STATES),
      shown: cap(req.shown),
      rule: cap(req.rule, MAX_ID_TEXT),
      reason: cap(req.reason),
      queued: now.toISOString(),
      expires: new Date(now.getTime() + DEFER_LIFETIME_MS).toISOString(),
    };
    try {
      writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(item)}\n`, { flag: 'wx', mode: 0o600 });
      return { item, code };
    } catch (err: unknown) {
      if (errCode(err) !== 'EEXIST') throw err;
    }
  }
  throw new Error('no free request id after 8 tries');
}

export type MarkerKind = 'approved' | 'used' | 'refused' | 'void' | 'reminded';

/** Creates a marker once. False when it already exists; throws on any other error. */
export function writeMarker(configDir: string, id: string, kind: MarkerKind, body: Record<string, string>): boolean {
  if (!ID_RE.test(id)) throw new Error(`not a request id: ${id}`);
  const dir = deferDir(configDir);
  try {
    writeFileSync(join(dir, `${id}.${kind}`), `${JSON.stringify({ v: 1, ...body })}\n`, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (err: unknown) {
    if (errCode(err) === 'EEXIST') return false;
    throw err;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isTime(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/.test(v) && Number.isFinite(Date.parse(v));
}

function parseFileState(v: unknown): FileState | null {
  if (!isObj(v)) return null;
  const { path, kind, size, mtime_ms } = v;
  if (typeof path !== 'string' || path === '' || path.length > 4096) return null;
  if (kind !== 'file' && kind !== 'folder' && kind !== 'other') return null;
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return null;
  if (typeof mtime_ms !== 'number' || !Number.isFinite(mtime_ms)) return null;
  return { path, kind, size, mtime_ms };
}

/** A request file's content, or why it cannot be trusted. Every field is checked; a request may not outlive DEFER_LIFETIME_MS. */
export function parseItem(text: string, id: string): DeferItem | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return 'not valid JSON';
  }
  if (!isObj(raw)) return 'not a JSON object';
  if (raw['v'] !== 1) return 'unknown version';
  if (raw['id'] !== id) return 'its id does not match its file name';
  const str = (k: string, max: number): string | null => {
    const s = raw[k];
    return typeof s === 'string' && s.length <= max ? s : null;
  };
  const code = str('code_sha256', 64);
  const salt = str('salt', 32);
  const hash = str('action_sha256', 64);
  if (code === null || !HEX64.test(code) || salt === null || !HEX32.test(salt) || hash === null || !HEX64.test(hash)) return 'a hash field is malformed';
  const session = str('session', MAX_ID_TEXT);
  const tool = str('tool', MAX_ID_TEXT);
  const cwd = str('cwd', 4096);
  const shown = str('shown', MAX_TEXT);
  const rule = str('rule', MAX_ID_TEXT);
  const reason = str('reason', MAX_TEXT);
  if (session === null || session === '' || tool === null || tool === '' || cwd === null || cwd === '' || shown === null || rule === null || reason === null) return 'a text field is missing or too long';
  const files = raw['files'];
  if (!Array.isArray(files) || files.length > MAX_FILE_STATES) return 'its file list is malformed';
  const states: FileState[] = [];
  for (const f of files) {
    const s = parseFileState(f);
    if (s === null) return 'its file list is malformed';
    states.push(s);
  }
  const queued = raw['queued'];
  const expires = raw['expires'];
  if (!isTime(queued) || !isTime(expires)) return 'a time field is malformed';
  const span = Date.parse(expires) - Date.parse(queued);
  if (span <= 0 || span > DEFER_LIFETIME_MS) return 'its lifetime is longer than openmorals gives a request';
  return { v: 1, id, code_sha256: code, session, cwd, tool, salt, action_sha256: hash, files: states, shown, rule, reason, queued, expires };
}

function readMarker(dir: string, id: string, kind: MarkerKind): { exists: boolean; body: Record<string, unknown> | null; error?: string } {
  let text: string;
  try {
    text = readFileSync(join(dir, `${id}.${kind}`), 'utf8');
  } catch (err: unknown) {
    const code = errCode(err);
    if (code === 'ENOENT') return { exists: false, body: null };
    return { exists: true, body: null, error: code };
  }
  try {
    const raw: unknown = JSON.parse(text);
    return { exists: true, body: isObj(raw) ? raw : null };
  } catch {
    return { exists: true, body: null };
  }
}

/**
 * Every request in the folder with its state. A request file that cannot be read or parsed, or an approval marker that is
 * malformed, is listed in `unreadable` and grants nothing. A `used` or `refused` marker counts whatever it holds (fail
 * closed: it can only stop a grant).
 */
export function readQueue(configDir: string, now: Date = new Date()): QueueRead {
  const dir = deferDir(configDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err: unknown) {
    const code = errCode(err);
    if (code === 'ENOENT') return { items: [], unreadable: [] };
    return { items: [], unreadable: [], error: `the deferred-request folder ${dir} could not be read (${code})` };
  }
  const items: ItemView[] = [];
  const unreadable: Unreadable[] = [];
  const ids = names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -'.json'.length)).sort();
  if (ids.length > DEFER_MAX_ITEMS) return { items: [], unreadable: [], error: `the deferred-request folder ${dir} holds ${ids.length} requests, more than the ${DEFER_MAX_ITEMS} openmorals reads` };
  for (const id of ids) {
    if (!ID_RE.test(id)) {
      unreadable.push({ file: `${id}.json`, why: 'not a request file name' });
      continue;
    }
    let text: string;
    try {
      text = readFileSync(join(dir, `${id}.json`), 'utf8');
    } catch (err: unknown) {
      unreadable.push({ file: `${id}.json`, why: `cannot be read (${errCode(err)})` });
      continue;
    }
    const item = parseItem(text, id);
    if (typeof item === 'string') {
      unreadable.push({ file: `${id}.json`, why: item });
      continue;
    }
    const approved = readMarker(dir, id, 'approved');
    const used = readMarker(dir, id, 'used');
    const refused = readMarker(dir, id, 'refused');
    const voided = readMarker(dir, id, 'void');
    const reminded = readMarker(dir, id, 'reminded');
    let approvedOk = false;
    let via: string | undefined;
    if (approved.exists) {
      const b = approved.body;
      if (b !== null && b['v'] === 1 && isTime(b['approved']) && typeof b['via'] === 'string' && b['via'].length <= 32) {
        approvedOk = true;
        via = b['via'];
      } else unreadable.push({ file: `${id}.approved`, why: approved.error !== undefined ? `cannot be read (${approved.error})` : 'malformed, so the approval is not used' });
    }
    const lapsed = now.getTime() >= Date.parse(item.expires);
    const state: ItemState = used.exists ? 'used' : refused.exists ? 'refused' : voided.exists ? 'void' : lapsed ? 'lapsed' : approvedOk ? 'approved' : 'waiting';
    items.push({ item, state, ...(via !== undefined ? { approvedVia: via } : {}), reminded: reminded.exists });
  }
  return { items, unreadable };
}

/** Removes the files of requests that lapsed more than DEFER_PRUNE_AFTER_MS ago. Best effort: a failure leaves them. */
function pruneOld(dir: string, now: Date): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const id = n.slice(0, -'.json'.length);
    if (!ID_RE.test(id)) continue;
    try {
      const item = parseItem(readFileSync(join(dir, n), 'utf8'), id);
      if (typeof item === 'string') continue;
      if (now.getTime() - Date.parse(item.expires) < DEFER_PRUNE_AFTER_MS) continue;
      for (const kind of ['approved', 'used', 'refused', 'void', 'reminded'] as const) rmSync(join(dir, `${id}.${kind}`), { force: true });
      rmSync(join(dir, n), { force: true });
    } catch {
      // left for the next prune
    }
  }
}
