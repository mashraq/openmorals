// Content-bearing actions (0.14.0): the arguments of a tool call without its own mapping, and the text one agent hands to
// another (a child agent's prompt, a message to another agent or session), carried on the `other` action redacted and
// capped. The outbound leg is scanned here with the inbound rules: a finding is recorded and marks the session the hook
// runs in, exactly as a finding in a tool result does. Nothing here changes the decision on the call that carries it.
import type { AuditFields } from '../audit.js';
import { makeAuditRecord, redact } from '../audit.js';
import type { TaintEvent } from '../taint/index.js';
import type { Action, ActionText, Bylaws } from '../types.js';
import type { InboundOutcome } from './policy.js';
import { judgeAgentMessage, safeToolName } from './policy.js';

/** One cap for argument and message text, in UTF-8 bytes (the content cap the ruling names for U8). */
export const ACTION_TEXT_MAX_BYTES = 262144;
/** Deepest nesting of an argument object that is walked; deeper values are replaced by a marker. */
export const ACTION_TEXT_MAX_DEPTH = 8;
/** Most values walked in one call's arguments; past it the walk stops and the text counts as cut. */
export const ACTION_TEXT_MAX_VALUES = 2000;

const CUT_MARK = '\n[... cut by openmorals ...]\n';
const EDGE_BACKOFF = 256;
const SEPARATOR = /[\s"',;:{}[\]()<>]/;

/** A value under a key named like a secret is replaced whole: `redact()` only knows `NAME=value` with a prefix before the secret word. */
export const SECRET_KEY = /(secret|token|passw(or)?d|passwd|pwd|api[_-]?key|private[_-]?key|access[_-]?key|credential|authorization|cookie)/i;

/** The hosts whose tool calls carry content, by the name each adapter writes in the audit log. */
export type ContentHost = 'claude-code' | 'codex' | 'gemini-cli' | 'opencode' | 'openclaw';

/**
 * The tools whose input is text handed to another agent, per host, and the documented input field that holds it.
 * `null`: the host documents the tool but not the field, so every string value of the input is the message.
 * Sources are listed in docs/adapters.md ("Content-bearing actions"); nothing here was observed in a live run.
 */
export const MESSAGE_TOOLS: Readonly<Record<ContentHost, Readonly<Record<string, string | null>>>> = Object.freeze({
  'claude-code': Object.freeze({ Agent: 'prompt', Task: 'prompt', SubagentHandback: 'message', SendMessage: null }),
  codex: Object.freeze({ spawn_agent: null }),
  'gemini-cli': Object.freeze({ codebase_investigator: null, cli_help: null, generalist: null, browser_agent: null }),
  opencode: Object.freeze({ task: 'prompt', subagent: 'prompt' }),
  openclaw: Object.freeze({ sessions_spawn: 'task', sessions_send: 'message' }),
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** The first `n` bytes of `s`, never splitting a character, backed off to a separator near the edge. */
function head(s: string, n: number): string {
  let out = Buffer.from(s, 'utf8').subarray(0, n).toString('utf8').replace(/�+$/, '');
  const from = Math.max(0, out.length - EDGE_BACKOFF);
  for (let i = out.length - 1; i >= from; i--) {
    if (SEPARATOR.test(out[i] ?? '')) {
      out = out.slice(0, i + 1);
      break;
    }
  }
  return out;
}

/** The last `n` bytes of `s`, never splitting a character, moved forward to a separator near the edge. */
function tail(s: string, n: number): string {
  const buf = Buffer.from(s, 'utf8');
  let out = buf.subarray(Math.max(0, buf.length - n)).toString('utf8').replace(/^�+/, '');
  const to = Math.min(out.length, EDGE_BACKOFF);
  for (let i = 0; i < to; i++) {
    if (SEPARATOR.test(out[i] ?? '')) {
      out = out.slice(i);
      break;
    }
  }
  return out;
}

/** Redacts, then caps: over `max` bytes the first and last halves are kept around a marker. */
export function capText(raw: string, max: number = ACTION_TEXT_MAX_BYTES, cutAlready = false): ActionText {
  const bytes = byteLength(raw);
  const text = redact(raw);
  if (byteLength(text) <= max) return { text, bytes, cut: cutAlready };
  const half = Math.max(0, Math.floor((max - byteLength(CUT_MARK)) / 2));
  return { text: `${head(text, half)}${CUT_MARK}${tail(text, half)}`, bytes, cut: true };
}

interface Walk {
  values: number;
  stopped: boolean;
}

function redactValue(v: unknown, key: string, depth: number, w: Walk): unknown {
  if (w.values >= ACTION_TEXT_MAX_VALUES) {
    w.stopped = true;
    return undefined;
  }
  w.values++;
  if (typeof v === 'string') return SECRET_KEY.test(key) && v !== '' ? '[REDACTED]' : redact(v);
  if (typeof v !== 'object' || v === null) return v;
  if (depth >= ACTION_TEXT_MAX_DEPTH) return '[nested too deep]';
  if (Array.isArray(v)) {
    const out: unknown[] = [];
    for (const x of v) {
      const r = redactValue(x, key, depth + 1, w);
      if (w.stopped) break;
      out.push(r);
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    const r = redactValue(x, k, depth + 1, w);
    if (w.stopped) break;
    out[k] = r;
  }
  return out;
}

/**
 * A call's arguments as compact JSON with every string value redacted (and a value under a secret-named key replaced
 * whole), capped. Undefined when the input is not an object or has no keys.
 */
export function argsText(input: unknown): ActionText | undefined {
  if (!isRecord(input) || Object.keys(input).length === 0) return undefined;
  let rawBytes: number;
  try {
    rawBytes = byteLength(JSON.stringify(input));
  } catch {
    rawBytes = 0;
  }
  const w: Walk = { values: 0, stopped: false };
  const red = redactValue(input, '', 0, w);
  const json = JSON.stringify(red) ?? '{}';
  const capped = capText(json, ACTION_TEXT_MAX_BYTES, w.stopped);
  return { ...capped, bytes: Math.max(rawBytes, capped.bytes) };
}

function strings(v: unknown, depth: number, out: string[], w: Walk): void {
  if (w.values >= ACTION_TEXT_MAX_VALUES) {
    w.stopped = true;
    return;
  }
  w.values++;
  if (typeof v === 'string') {
    if (v !== '') out.push(v);
    return;
  }
  if (typeof v !== 'object' || v === null || depth >= ACTION_TEXT_MAX_DEPTH) return;
  for (const x of Array.isArray(v) ? v : Object.values(v)) {
    strings(x, depth + 1, out, w);
    if (w.stopped) return;
  }
}

/**
 * The text a call hands to another agent: the named field when it holds a string, else every string value of the input
 * (one per line). Undefined when there is no text.
 */
export function messageText(input: unknown, field: string | null): ActionText | undefined {
  if (!isRecord(input)) return undefined;
  const named = field !== null ? input[field] : undefined;
  if (typeof named === 'string') return named === '' ? undefined : capText(named);
  const parts: string[] = [];
  const w: Walk = { values: 0, stopped: false };
  strings(input, 0, parts, w);
  if (parts.length === 0) return undefined;
  return capText(parts.join('\n'), ACTION_TEXT_MAX_BYTES, w.stopped);
}

/** The `other` action for a call, with its arguments and, for a tool in the host's message list, its message text. */
export function contentAction(host: ContentHost, tool: string, input: unknown): Extract<Action, { kind: 'other' }> {
  const out: Extract<Action, { kind: 'other' }> = { kind: 'other', tool };
  const args = argsText(input);
  if (args !== undefined) out.args = args;
  const table = MESSAGE_TOOLS[host];
  if (Object.prototype.hasOwnProperty.call(table, tool)) {
    const message = messageText(input, table[tool] ?? null);
    if (message !== undefined) out.message = message;
  }
  return out;
}

/** The action without the text it carries: what the session history and the pre-0.14 judgement saw. */
export function withoutContent(a: Action): Action {
  return a.kind === 'other' ? { kind: 'other', tool: a.tool } : a;
}

export interface OutboundScan {
  /** One outcome per message that held a finding (or could not be scanned). */
  outcomes: InboundOutcome[];
  /** The session marks to add, in order. */
  taint: TaintEvent[];
  /** The audit lines to write after the call's own line: rule, kinds, lines and sizes, never the text. */
  records: AuditFields[];
}

export interface OutboundOrigin {
  source: string;
  session: string | null;
  cwd: string | null;
}

/**
 * The outbound leg: every message the call's actions carry, scanned with the inbound rules. A finding marks the session
 * (hidden content: injected; a visible phrase: untrusted) and is recorded; nothing is said to the model and the call's
 * own decision is not changed. Inbound scanning switched off scans nothing.
 */
export function scanOutbound(actions: readonly Action[], bylaws: Bylaws, from: OutboundOrigin, now?: Date): OutboundScan {
  const res: OutboundScan = { outcomes: [], taint: [], records: [] };
  for (const a of actions) {
    if (a.kind !== 'other' || a.message === undefined) continue;
    const o = judgeAgentMessage(a.tool, a.message, bylaws.guards.inbound, { taintDecision: bylaws.guards.taint.decision });
    if (!o.record) continue;
    res.outcomes.push(o);
    if (o.taint !== null) res.taint.push(o.taint);
    const tool = safeToolName(a.tool);
    res.records.push(makeAuditRecord({ source: from.source, session: from.session, tool, action: `outbound agent-message: ${tool}`, decision: o.verdict.decision, rule: o.verdict.rule, reason: o.verdict.reason, cwd: from.cwd, budget: null }, now));
  }
  return res;
}
