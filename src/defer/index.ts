import { resolve } from 'node:path';
import type { Finding, Guard } from '../guard.js';
import type { Verdict } from '../types.js';
import type { BindingInput } from './binding.js';
import { bindCall, sameFiles } from './binding.js';
import type { ItemView } from './store.js';
import { DEFER_LIFETIME_MS, codeMatches, newSalt, queueRequest, readQueue, writeMarker } from './store.js';

export { actionHash, bindCall, boundPaths, fileStates, sameFiles } from './binding.js';
export type { BindingInput } from './binding.js';
export { CODE_RE, DEFER_DIR, DEFER_LIFETIME_MS, ID_RE, codeHash, codeMatches, deferDir, parseItem, queueRequest, readQueue, writeMarker } from './store.js';
export type { Binding, DeferItem, FileState, ItemState, ItemView, QueueRead, Queued, Unreadable } from './store.js';

/**
 * The asks a deferred ask may hold for the person (0.19.0): deletions (the destructive and online-delete guards, an MCP
 * tool whose name says it deletes), the document guard's removals, the delete guard's ask (0.21.0), the replace guard's ask (0.24.0) and the release hold (0.28.0). Not `document.unreadable`:
 * with the file unreadable there is no file state to bind a grant to. `delete.trash` and `delete.blind` are refusals, never held.
 */
export function isDeferrableRule(rule: string): boolean {
  if (rule.startsWith('destructive.') || rule.startsWith('online-delete.')) return !rule.endsWith('.error');
  if (rule === 'adapter.mcp-delete' || rule === 'delete.ask' || rule === 'replace.ask') return true;
  if (rule === 'hold.order' || rule === 'hold.failed' || rule === 'hold.missing' || rule === 'hold.changed') return true;
  return rule === 'document.delete' || rule === 'document.empty' || rule === 'document.shrink' || rule === 'document.heading' || rule === 'document.unknown';
}

/** The guards with every deferrable finding dropped: what a call would get if none of its objections were a deletion. */
export function withoutDeferrable(guards: readonly Guard[]): Guard[] {
  return guards.map((g) => ({ id: g.id, isHard: (b) => g.isHard(b), evaluate: (ctx) => g.evaluate(ctx).filter((f: Finding) => !isDeferrableRule(f.rule)) }));
}

/** The text the agent reads when its call is held (in the host's deny reason, after `openmorals deny [rule]: `). */
export function heldReason(id: string): string {
  return `not run; queued as ${id} for the user's approval. Carry on with other work; do not retry it or get the same result another way. You will be told if it is approved.`;
}

function hours(ms: number): string {
  return `${Math.round(ms / 3600000)} h`;
}

function short(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** The line only the person sees when a call is held: what, why, and the code that approves it. */
export function heldNotice(id: string, code: string, shown: string, rule: string, reason: string): string {
  return `openmorals: held for your approval, not run: ${short(shown, 160)} [${rule}: ${short(reason, 160)}]. To let it run once in this session, type: approve ${code} (or run openmorals pending in a terminal). It lapses in ${hours(DEFER_LIFETIME_MS)}; ${id} is the agent's name for it.`;
}

export interface DeferStepInput {
  /** The call's verdict before `--unattended` turns an ask into a deny. */
  verdict: Verdict;
  /** The call's verdict with every deferrable objection dropped (see `withoutDeferrable`). */
  residual: () => Verdict;
  /** False for an invalid bylaws file: then nothing is held and no approval is used (fail closed). */
  bylawsOk: boolean;
  /** Hold the call (deny and queue) rather than ask: `--unattended`, or `defer: true` in the bylaws. */
  queueOn: boolean;
  session: string | null;
  call: Omit<BindingInput, 'session'>;
  configDir: string;
  /** The redacted one-line action, as the audit record keeps it. */
  shown: string;
  now?: Date;
}

export type DeferStep =
  | { kind: 'none'; verdict: Verdict }
  | { kind: 'granted'; verdict: Verdict; id: string }
  | { kind: 'held'; verdict: Verdict; id: string; userNotice: string };

function noted(v: Verdict, notes: readonly string[]): Verdict {
  return notes.length === 0 ? v : { ...v, reason: `${v.reason}; ${notes.join('; ')}` };
}

/**
 * The deferred ask at one call. Only an `ask` whose every objection is deferrable is touched, and only with valid bylaws
 * and a session id; anything else keeps its verdict. Such a call runs when the person approved exactly this call (same
 * session, project folder, tool, arguments, and the files it names unchanged) and the approval was not used: the approval
 * is used up by this call. Otherwise, with `queueOn`, the call is denied and queued, and the person is shown the code;
 * without it the call keeps its ask. Any failure to read or write the queue keeps the normal verdict, never allows.
 */
export function deferStep(s: DeferStepInput): DeferStep {
  const v = s.verdict;
  if (v.decision !== 'ask' || !s.bylawsOk || s.session === null || s.session === '' || s.session === 'unknown') return { kind: 'none', verdict: v };
  let residual: Verdict;
  try {
    residual = s.residual();
  } catch {
    return { kind: 'none', verdict: v };
  }
  if (residual.decision !== 'allow') return { kind: 'none', verdict: v };
  const now = s.now ?? new Date();
  const call: BindingInput = { ...s.call, cwd: resolve(s.call.cwd), session: s.session };
  const notes: string[] = [];
  const q = readQueue(s.configDir, now);
  if (q.error !== undefined) notes.push(`${q.error}, so no approval is used`);
  else {
    const granted = findGrant(q.items, call, s.configDir, now, notes);
    if (granted !== null) return { kind: 'granted', id: granted.item.id, verdict: { decision: 'allow', rule: 'defer.granted', reason: `the user approved this exact call as ${granted.item.id}${granted.approvedVia !== undefined ? ` (${granted.approvedVia})` : ''}; the approval is now used` } };
    if (q.unreadable.length > 0) notes.push(`${q.unreadable.length} deferred-request file${q.unreadable.length === 1 ? '' : 's'} could not be read and grant nothing (openmorals pending lists them)`);
  }
  if (!s.queueOn) return { kind: 'none', verdict: noted(v, notes) };
  const same = q.error === undefined ? findWaiting(q.items, call) : null;
  if (same !== null) {
    const id = same.item.id;
    return { kind: 'held', id, verdict: { decision: 'deny', rule: v.rule, reason: heldReason(id) }, userNotice: `openmorals: still held for your approval, not run: ${short(s.shown, 160)} as ${id}. Approve it with the code from the line that first held it, or run openmorals pending in a terminal.` };
  }
  const binding = bindCall(call, newSalt());
  if (typeof binding === 'string') return { kind: 'none', verdict: noted(v, [...notes, `not queued for approval: ${binding}`]) };
  let queued;
  try {
    queued = queueRequest(s.configDir, { binding, shown: s.shown, rule: v.rule, reason: v.reason }, now);
  } catch (err: unknown) {
    return { kind: 'none', verdict: noted(v, [...notes, `it could not be queued for approval (${err instanceof Error ? err.message : String(err)})`]) };
  }
  const id = queued.item.id;
  return {
    kind: 'held',
    id,
    verdict: { decision: 'deny', rule: v.rule, reason: heldReason(id) },
    userNotice: `${heldNotice(id, queued.code, s.shown, v.rule, v.reason)}${notes.length > 0 ? ` Note: ${notes.join('; ')}.` : ''}`,
  };
}

type Match = 'same' | 'files-changed' | 'other';

/** Whether a request is for this exact call: same session, folder, tool and arguments, and the files it names unchanged. */
function matchOf(view: ItemView, call: BindingInput): Match {
  const it = view.item;
  if (it.session !== call.session || it.cwd !== call.cwd || it.tool !== call.tool) return 'other';
  const b = bindCall(call, it.salt);
  if (typeof b === 'string' || b.action_sha256 !== it.action_sha256) return 'other';
  return sameFiles(b.files, it.files) ? 'same' : 'files-changed';
}

function findGrant(items: readonly ItemView[], call: BindingInput, configDir: string, now: Date, notes: string[]): ItemView | null {
  for (const view of items) {
    if (view.state !== 'approved') continue;
    const m = matchOf(view, call);
    if (m === 'other') continue;
    if (m === 'files-changed') {
      notes.push(`${view.item.id} was approved, but a file it names changed since, so that approval is void`);
      try {
        writeMarker(configDir, view.item.id, 'void', { void: now.toISOString() });
      } catch {
        // it grants nothing either way: the files still differ
      }
      continue;
    }
    try {
      if (writeMarker(configDir, view.item.id, 'used', { used: now.toISOString() })) return view;
      notes.push(`${view.item.id} was approved, but its approval was already used`);
    } catch (err: unknown) {
      notes.push(`${view.item.id} was approved, but its use could not be recorded (${err instanceof Error ? err.message : String(err)}), so it is not used`);
    }
  }
  return null;
}

/** A request already waiting for this exact call, so a retry is held under the same id instead of queued again. */
function findWaiting(items: readonly ItemView[], call: BindingInput): ItemView | null {
  return items.find((v) => v.state === 'waiting' && matchOf(v, call) === 'same') ?? null;
}

const PROMPT_CODE = /\bapprove\s+(D-[0-9A-Z]{4}-[0-9A-Z]{6})\b/gi;
const MAX_PROMPT_CODES = 10;

export interface PromptApprovals {
  /** Lines for the person only (the host's user-only channel). */
  user: string[];
  /** Lines for the agent: one per approval, so it knows it may retry. */
  model: string[];
}

/**
 * The person's prompt as an approval channel: each `approve D-XXXX-YYYYYY` whose code matches a waiting request records
 * the approval. Also, once per request, a line telling the person what waits in this session. Nothing here can allow a
 * call by itself: the call must still come again, unchanged, from the same session.
 */
export function promptApprovals(prompt: string, session: string | null, configDir: string, now: Date = new Date()): PromptApprovals {
  const out: PromptApprovals = { user: [], model: [] };
  const codes = [...new Set([...prompt.matchAll(PROMPT_CODE)].map((m) => (m[1] ?? '').toUpperCase()))].slice(0, MAX_PROMPT_CODES);
  const q = readQueue(configDir, now);
  if (q.error !== undefined) {
    if (codes.length > 0) out.user.push(`openmorals: nothing was approved: ${q.error}`);
    return out;
  }
  const approvedNow = new Set<string>();
  for (const code of codes) {
    const id = code.slice(0, 6);
    const view = q.items.find((x) => x.item.id === id);
    if (view === undefined || !codeMatches(view.item, code)) {
      out.user.push(`openmorals: ${code} matches no request; nothing was approved`);
      continue;
    }
    if (view.state !== 'waiting') {
      out.user.push(`openmorals: ${id} is ${view.state}; nothing was approved`);
      continue;
    }
    try {
      if (!writeMarker(configDir, id, 'approved', { approved: now.toISOString(), via: 'prompt' })) {
        out.user.push(`openmorals: ${id} was already approved`);
        continue;
      }
    } catch (err: unknown) {
      out.user.push(`openmorals: ${id} could not be approved (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    approvedNow.add(id);
    out.user.push(`openmorals: approved ${id} (${short(view.item.shown, 120)}) to run once, unchanged, in its session`);
    out.model.push(`openmorals: the user approved ${id}; you may retry that exact call once, unchanged.`);
  }
  if (session !== null && session !== '') {
    const waiting = q.items.filter((x) => x.state === 'waiting' && x.item.session === session && !x.reminded && !approvedNow.has(x.item.id));
    if (waiting.length > 0) {
      const list = waiting.slice(0, 3).map((x) => `${x.item.id} (${short(x.item.shown, 60)})`).join(', ');
      out.user.push(`openmorals: ${waiting.length} request${waiting.length === 1 ? '' : 's'} wait${waiting.length === 1 ? 's' : ''} for your approval: ${list}${waiting.length > 3 ? ', …' : ''}. Type approve with the code from the line that held it, or run openmorals pending in a terminal.`);
      for (const x of waiting) {
        try {
          writeMarker(configDir, x.item.id, 'reminded', { reminded: now.toISOString() });
        } catch {
          // shown again next time
        }
      }
    }
  }
  return out;
}
