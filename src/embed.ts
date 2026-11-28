import { isAbsolute } from 'node:path';
import { toActions } from './adapters/claude-code.js';
import { judge, mcpDeleteVerdict } from './adapters/codex/pipeline.js';
import { writeContent } from './inbound/outbound.js';
import { isUnattended, unattendedVerdict } from './session.js';
import type { Action, ShellKind, Verdict } from './types.js';
import { isDecision } from './types.js';

/**
 * One call of a program's agent, as `guardCall` reads it (Preview, 0.43.0). `session` names the run whose memory the
 * call joins; `tool` and `input` are read the way the Claude Code hook reads a call; `actions` adds what the program
 * says the call does. There is no field for guards, rules or a policy: the user's file, the project file over it and
 * the built-in guards always apply.
 */
export interface GuardCallRequest {
  session: string;
  cwd?: string;
  tool: string;
  input?: Record<string, unknown>;
  actions?: readonly GuardCallAction[];
}

/** What a program may declare a call does. Each is judged in addition to what `tool` and `input` show, never instead. */
export type GuardCallAction =
  | { kind: 'exec'; command: string; shell?: ShellKind }
  | { kind: 'read'; path: string }
  | { kind: 'write'; path: string; content?: string }
  | { kind: 'fetch'; url: string };

export interface GuardCallOptions {
  /** No person can answer: every ask becomes deny (also set by OPENMORALS_UNATTENDED). */
  unattended?: boolean;
  /** The environment read for the config folder and OPENMORALS_UNATTENDED (default `process.env`). */
  env?: Record<string, string | undefined>;
  /** The time the call is judged and logged at (default now). */
  now?: Date;
}

/** The rule of every answer to a request `guardCall` cannot read as given. */
export const EMBED_BAD_REQUEST = 'embed.bad-request';
/** The rule of the answer when the check itself fails. */
export const EMBED_ERROR = 'embed.error';

const REQUEST_KEYS: readonly string[] = ['session', 'cwd', 'tool', 'input', 'actions'];
const OPTION_KEYS: readonly string[] = ['unattended', 'env', 'now'];
const ACTION_KEYS: Readonly<Record<string, readonly string[]>> = { exec: ['kind', 'command', 'shell'], read: ['kind', 'path'], write: ['kind', 'path', 'content'], fetch: ['kind', 'url'] };
const ACTION_FIELD: Readonly<Record<string, string>> = { exec: 'command', read: 'path', write: 'path', fetch: 'url' };
const SHELLS: readonly string[] = ['posix', 'powershell', 'cmd'];

/** Limits on what one request may hold. Past any of them the call asks. */
export const EMBED_LIMITS = Object.freeze({ depth: 64, values: 200_000, chars: 16 * 1024 * 1024, actions: 32 });

type Data = string | number | boolean | null | Data[] | { [k: string]: Data };

class BadRequest extends Error {}

interface Copy {
  values: number;
  chars: number;
  seen: Set<object>;
}

/**
 * A plain copy of the caller's value, read once: strings, finite numbers, booleans, null, arrays and plain objects only.
 * A getter is refused unread; a cycle, another kind of value or a value past the limits is refused. The pipeline then
 * judges and records this copy, so nothing the caller holds can change between the check and the record.
 */
function copyData(v: unknown, depth: number, c: Copy, where: string): Data {
  if (++c.values > EMBED_LIMITS.values) throw new BadRequest(`the request holds more than ${EMBED_LIMITS.values} values`);
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    c.chars += v.length;
    if (c.chars > EMBED_LIMITS.chars) throw new BadRequest(`the request holds more than ${EMBED_LIMITS.chars} characters of text`);
    return v;
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new BadRequest(`${where} is not a finite number`);
    return v;
  }
  if (typeof v !== 'object') throw new BadRequest(`${where} is a ${typeof v}, which a request cannot hold`);
  if (depth >= EMBED_LIMITS.depth) throw new BadRequest(`the request is nested deeper than ${EMBED_LIMITS.depth} levels`);
  if (c.seen.has(v)) throw new BadRequest(`${where} refers back to itself`);
  c.seen.add(v);
  try {
    if (Array.isArray(v)) {
      const len = v.length;
      const out: Data[] = [];
      for (let i = 0; i < len; i++) out.push(copyData(own(v, String(i), `${where}[${i}]`), depth + 1, c, `${where}[${i}]`));
      return out;
    }
    const proto: unknown = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new BadRequest(`${where} is not a plain object`);
    const out: { [k: string]: Data } = {};
    for (const k of Object.keys(v)) {
      const item = own(v, k, `${where}.${k}`);
      if (item === undefined) continue;
      Object.defineProperty(out, k, { value: copyData(item, depth + 1, c, `${where}.${k}`), enumerable: true, writable: true, configurable: true });
    }
    return out;
  } finally {
    c.seen.delete(v);
  }
}

function own(o: object, k: string, where: string): unknown {
  const d = Object.getOwnPropertyDescriptor(o, k);
  if (d === undefined) return undefined;
  if (d.get !== undefined || d.set !== undefined) throw new BadRequest(`${where} is a getter, which a request cannot hold`);
  return d.value;
}

function isPlain(v: Data | undefined): v is { [k: string]: Data } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function unknownKey(o: { [k: string]: Data }, allowed: readonly string[], what: string): void {
  for (const k of Object.keys(o)) {
    if (allowed.includes(k)) continue;
    if (what === 'the request' && (k === 'guards' || k === 'bylaws')) throw new BadRequest(`the request carries '${k}', which guardCall does not take: your user file, the project file and the built-in guards always apply`);
    throw new BadRequest(`${what} has an unknown key '${k}', which guardCall does not take`);
  }
}

function declared(raw: Data, i: number, tool: string): Action {
  const where = `actions[${i}]`;
  if (!isPlain(raw)) throw new BadRequest(`${where} is not an object`);
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(ACTION_KEYS, kind)) throw new BadRequest(`${where}.kind must be exec, read, write or fetch`);
  unknownKey(raw, ACTION_KEYS[kind] ?? [], where);
  const field = ACTION_FIELD[kind] ?? '';
  const value = raw[field];
  if (typeof value !== 'string' || value === '') throw new BadRequest(`${where}.${field} must be a non-empty string`);
  if (kind === 'exec') {
    const shell = raw['shell'] ?? (process.platform === 'win32' ? 'powershell' : 'posix');
    if (typeof shell !== 'string' || !SHELLS.includes(shell)) throw new BadRequest(`${where}.shell must be posix, powershell or cmd`);
    return { kind: 'exec', command: value, shell: shell as ShellKind, tool };
  }
  if (kind === 'read') return { kind: 'read', path: value, tool };
  if (kind === 'fetch') return { kind: 'fetch', url: value, tool };
  const out: Extract<Action, { kind: 'write' }> = { kind: 'write', path: value, tool };
  const content = raw['content'];
  if (content !== undefined) {
    if (typeof content !== 'string') throw new BadRequest(`${where}.content must be a string`);
    const text = writeContent(content);
    if (text !== undefined) out.content = text;
  }
  return out;
}

interface Read {
  session: string;
  cwd: string | null;
  tool: string;
  input: Record<string, unknown>;
  declared: Action[];
  env: NodeJS.ProcessEnv;
  unattended: boolean;
  now: Date | undefined;
}

function readOptions(options: unknown): { env: NodeJS.ProcessEnv; unattended: boolean; now: Date | undefined } {
  if (options === undefined) return { env: process.env, unattended: false, now: undefined };
  let now: Date | undefined;
  let rest: unknown = options;
  if (typeof options === 'object' && options !== null && !Array.isArray(options) && Object.getPrototypeOf(options) === Object.prototype) {
    const d = own(options, 'now', 'options.now');
    if (d instanceof Date) {
      const t = Date.prototype.getTime.call(d);
      if (!Number.isFinite(t)) throw new BadRequest('options.now is not a valid date');
      now = new Date(t);
      const copy: Record<string, unknown> = {};
      for (const k of Object.keys(options)) if (k !== 'now') copy[k] = own(options, k, `options.${k}`);
      rest = copy;
    }
  }
  const o = copyData(rest, 0, { values: 0, chars: 0, seen: new Set() }, 'options');
  if (!isPlain(o)) throw new BadRequest('options is not an object');
  unknownKey(o, OPTION_KEYS, 'options');
  if (o['now'] !== undefined) throw new BadRequest('options.now must be a Date');
  const u = o['unattended'];
  if (u !== undefined && typeof u !== 'boolean') throw new BadRequest('options.unattended must be true or false');
  let env: NodeJS.ProcessEnv = process.env;
  const e = o['env'];
  if (e !== undefined) {
    if (!isPlain(e)) throw new BadRequest('options.env must be an object of strings');
    const copy: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(e)) {
      if (typeof v !== 'string') throw new BadRequest(`options.env.${k} must be a string`);
      copy[k] = v;
    }
    env = copy;
  }
  return { env, unattended: u === true || isUnattended(env), now };
}

function readRequest(request: unknown, options: unknown): Read {
  const opts = readOptions(options);
  const r = copyData(request, 0, { values: 0, chars: 0, seen: new Set() }, 'request');
  if (!isPlain(r)) throw new BadRequest('the request is not an object');
  unknownKey(r, REQUEST_KEYS, 'the request');
  const session = r['session'];
  if (typeof session !== 'string' || session.trim() === '') throw new BadRequest('the request has no session: give the id of the run this call belongs to, so its history is kept');
  const tool = r['tool'];
  if (typeof tool !== 'string' || tool.trim() === '') throw new BadRequest('the request has no tool name');
  const cwd = r['cwd'];
  if (cwd !== undefined && (typeof cwd !== 'string' || !isAbsolute(cwd))) throw new BadRequest('cwd must be an absolute path');
  const input = r['input'] ?? {};
  if (!isPlain(input)) throw new BadRequest('input must be an object');
  const list = r['actions'] ?? [];
  if (!Array.isArray(list)) throw new BadRequest('actions must be a list');
  if (list.length > EMBED_LIMITS.actions) throw new BadRequest(`actions has more than ${EMBED_LIMITS.actions} entries`);
  return { session, cwd: typeof cwd === 'string' ? cwd : null, tool, input, declared: list.map((a, i) => declared(a, i, tool)), ...opts };
}

/** Reads `unattended` for an answer given before the request could be read, without throwing. */
function unattendedOf(options: unknown): boolean {
  try {
    if (typeof options !== 'object' || options === null) return isUnattended(process.env);
    const u = own(options, 'unattended', 'options.unattended');
    if (u === true) return true;
    const e = own(options, 'env', 'options.env');
    if (typeof e === 'object' && e !== null) {
      const v = own(e, 'OPENMORALS_UNATTENDED', 'options.env');
      return typeof v === 'string' && isUnattended({ OPENMORALS_UNATTENDED: v });
    }
    return isUnattended(process.env);
  } catch {
    return false;
  }
}

function refuse(rule: string, reason: string, unattended: boolean): Verdict {
  const v: Verdict = { decision: 'ask', rule, reason };
  return unattended ? unattendedVerdict(v) : v;
}

/**
 * The session-aware check for a program that is not one of the agent hosts openmorals hooks into (Preview, 0.43.0).
 * The same check the Codex, Gemini CLI, opencode and OpenClaw hooks run: the user's file, the project file over it, the
 * built-in guards, the session's history and taint, the tool-call budget and one chained audit line. It returns advice:
 * the program decides whether to obey, and must never treat `ask` as `allow`. It never throws, calls no model and
 * opens no connection. A request it cannot read as given asks (rule `embed.bad-request`); with `unattended`, every ask
 * is a deny.
 */
export function guardCall(request: GuardCallRequest, options?: GuardCallOptions): Verdict {
  let read: Read;
  try {
    read = readRequest(request, options);
  } catch (err: unknown) {
    const reason = err instanceof BadRequest ? err.message : 'the request could not be read';
    return refuse(EMBED_BAD_REQUEST, `${reason}; openmorals asks instead of guessing`, unattendedOf(options));
  }
  try {
    const actions = [...toActions(read.tool, read.input), ...read.declared];
    const unmapped = actions[0]?.kind === 'other';
    const v = judge(
      {
        source: 'embed',
        session: read.session,
        cwd: read.cwd,
        tool: read.tool,
        actions,
        countCall: true,
        event: 'guardCall',
        extra: (bylaws) => {
          const d = unmapped ? mcpDeleteVerdict(read.tool, bylaws) : null;
          if (d === null) return [];
          // An MCP tool's name keeps the Claude Code hook's rule; any other tool of the program gets its own.
          return [read.tool.startsWith('mcp__') ? d : { ...d, rule: 'embed.delete-name', reason: d.reason.replace(/^the MCP tool/, 'the tool') }];
        },
      },
      { env: read.env, unattended: read.unattended, ...(read.now !== undefined ? { now: read.now } : {}) },
    );
    if (!isDecision(v.decision) || typeof v.rule !== 'string' || typeof v.reason !== 'string') return refuse(EMBED_ERROR, 'the check gave an answer it cannot stand behind', read.unattended);
    return { decision: v.decision, rule: v.rule, reason: v.reason };
  } catch (err: unknown) {
    return refuse(EMBED_ERROR, `openmorals hit an internal error (${err instanceof Error ? err.message : 'unknown'}) and asks instead`, read.unattended);
  }
}
