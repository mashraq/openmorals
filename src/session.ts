import type { ChainHead } from './audit.js';
import { redact } from './audit.js';
import type { Finding, WroteWhole } from './guard.js';
import type { HistoryEntry, Outcome } from './loop/index.js';
import { actionKey, detectLoop } from './loop/index.js';
import type { TaintContext, TaintMark, TaintSource, TaintState } from './taint/index.js';
import { CLEAN_TAINT, judge, reduceTaint } from './taint/index.js';
import { maskAction } from './engine.js';
import type { DetectorName } from './rules/detectors.js';
import type { Action, Bylaws, Verdict } from './types.js';
import { decisionRank } from './types.js';
import type { OutboundMemory, OutboundView } from './outbound/memory.js';
import { newOutboundMemory, parseOutboundMemory } from './outbound/memory.js';
import type { TrashNote } from './undo/notice.js';
import { parseTrashNote } from './undo/notice.js';

export const HISTORY_KEEP = 20;
const MAX_ERROR = 400;
const MAX_ID = 128;

export interface StoredHistoryEntry extends HistoryEntry {
  id?: string;
  /** The rule of an `ask` verdict for this call, so the post-tool event can record that the ask was approved (0.8.0). */
  asked?: string;
}

export interface SessionMemory {
  history: readonly StoredHistoryEntry[];
  taint: TaintState;
  /** Why the saved state could not be read, until a judged call has asked about it (0.6.2). */
  unreadable?: string;
  /** Where this session's audit chain stands (0.8.0); absent before its first chained record. */
  chain?: ChainHead;
  /** What the outbound guard remembers (0.20.0): the page a browser is on, hashes of hosts, addresses and codes, approvals. */
  outbound?: OutboundMemory;
  /** The trash notice (0.21.0): since the session's first message, how many moves into the project trash the person was told about. */
  trashNote?: TrashNote;
  /**
   * Files this session put content in whole (0.24.0, kept only with `guards.replace.steer: keep`): each path with the
   * sha256 it held after the call ran, newest last, at most `WROTE_KEEP`. The replace guard lets a whole replacement of
   * exactly that content through: it is the session's own output, with nothing of the person's left in it.
   */
  wrote?: readonly WroteWhole[];
}

/** The most files the session remembers having written whole (0.24.0). */
export const WROTE_KEEP = 64;

/** The list with one file's entry replaced by its new hash (or dropped when `h` is null), newest last, capped. */
export function noteWrote(list: readonly WroteWhole[] | undefined, p: string, h: string | null): WroteWhole[] {
  const rest = (list ?? []).filter((w) => w.p !== p);
  return (h === null ? rest : [...rest, { p, h }]).slice(-WROTE_KEEP);
}

function parseWrote(v: unknown): WroteWhole[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: WroteWhole[] = [];
  for (const x of v.slice(-WROTE_KEEP)) {
    if (!isObj(x)) continue;
    const p = str(x, 'p');
    const h = str(x, 'h');
    if (p !== null && p.length <= 4096 && h !== null && /^[0-9a-f]{64}$/.test(h)) out.push({ p, h });
  }
  return out;
}

export const EMPTY_MEMORY: SessionMemory = Object.freeze({ history: Object.freeze([]), taint: CLEAN_TAINT });

export function taintContext(projectRoot: string, bylaws: Bylaws, platform: NodeJS.Platform = process.platform): TaintContext {
  return { projectRoot, platform: platform === 'win32' ? 'win32' : 'posix', trustedHosts: bylaws.guards.taint.trusted_hosts, privatePaths: bylaws.guards.taint.private_paths ?? [] };
}

export function sessionFindings(action: Action, memory: SessionMemory, bylaws: Bylaws, ctx: TaintContext): Finding[] {
  const out: Finding[] = [];
  const loopCfg = bylaws.guards.loop.decision;
  if (loopCfg !== 'allow') {
    try {
      const v = detectLoop(memory.history, action);
      if (v.decision !== 'allow') out.push({ decision: loopCfg, rule: v.rule, reason: v.reason });
    } catch (err: unknown) {
      out.push({ decision: 'ask', rule: 'loop.error', reason: `the loop detector failed (${err instanceof Error ? err.message : String(err)}), so it fails closed` });
    }
  }
  const taintCfg = bylaws.guards.taint.decision;
  if (taintCfg !== 'allow') {
    try {
      const v = judge(action, memory.taint, ctx);
      if (v.decision !== 'allow') out.push({ decision: taintCfg, rule: v.rule, reason: v.reason });
    } catch (err: unknown) {
      out.push({ decision: 'ask', rule: 'taint.error', reason: `the taint judge failed (${err instanceof Error ? err.message : String(err)}), so it fails closed` });
    }
  }
  return out;
}

export function combineVerdict(verdict: Verdict, findings: readonly Finding[]): Verdict {
  let best: Verdict = verdict;
  for (const f of findings) if (decisionRank(f.decision) > decisionRank(best.decision)) best = { decision: f.decision, rule: f.rule, reason: f.reason };
  if (best === verdict) {
    const extra = findings.filter((f) => f.decision !== 'allow').length;
    return extra === 0 || verdict.decision === 'allow' ? best : { ...best, reason: `${best.reason} (+${extra} more)` };
  }
  const extra = findings.filter((f) => f.decision !== 'allow' && f.rule !== best.rule).length + (verdict.decision !== 'allow' ? 1 : 0);
  return extra === 0 ? best : { ...best, reason: `${best.reason} (+${extra} more)` };
}

/** The action as the session history keeps it: redacted, and without the argument or message text an `other` action carries (0.14.0) or the content a write carries (0.15.0). */
export function storedAction(input: Action, mask: readonly DetectorName[] = []): Action {
  const action = maskAction(input, mask);
  switch (action.kind) {
    case 'exec':
      return { ...action, command: redact(action.command) };
    case 'read':
      return { ...action, path: redact(action.path) };
    case 'write':
      return { kind: 'write', path: redact(action.path), tool: action.tool };
    case 'fetch':
      return { ...action, url: redact(action.url) };
    default:
      return { kind: 'other', tool: action.tool };
  }
}

/** `mask`: the detectors the bylaws name, whose hits are masked in the stored command, path or URL (0.16.0). */
export function recordAction(memory: SessionMemory, action: Action, verdict: Verdict, ctx: TaintContext, id: string | null, mask: readonly DetectorName[] = []): SessionMemory {
  const entry: StoredHistoryEntry = { action: storedAction(action, mask) };
  if (id !== null && id !== '') entry.id = id.slice(0, MAX_ID);
  if (verdict.decision === 'ask') entry.asked = verdict.rule.slice(0, MAX_ID);
  const history = [...memory.history, entry].slice(-HISTORY_KEEP);
  const taint = verdict.decision === 'deny' ? memory.taint : reduceTaint(memory.taint, { type: 'action', action }, ctx);
  const next: SessionMemory = memory.chain !== undefined ? { history, taint, chain: memory.chain } : { history, taint };
  if (memory.outbound !== undefined) next.outbound = memory.outbound;
  if (memory.trashNote !== undefined) next.trashNote = memory.trashNote;
  if (memory.wrote !== undefined) next.wrote = memory.wrote;
  return next;
}

/** The history entry a post-tool event belongs to: by the host's call id, else the newest entry for the same action with no outcome yet. -1 when none. */
export function findCallEntry(history: readonly StoredHistoryEntry[], action: Action, id: string | null, mask: readonly DetectorName[] = []): number {
  if (id !== null && id !== '') {
    const byId = history.findIndex((e) => e.id === id.slice(0, MAX_ID));
    if (byId !== -1) return byId;
  }
  const key = actionKey(storedAction(action, mask));
  if (key === null) return -1;
  for (let i = history.length - 1; i >= 0; i--) {
    const e = history[i];
    if (e !== undefined && e.outcome === undefined && actionKey(e.action) === key) return i;
  }
  return -1;
}

export function recordOutcome(memory: SessionMemory, action: Action, outcome: Outcome, id: string | null, mask: readonly DetectorName[] = []): SessionMemory {
  const history = memory.history.slice();
  const idx = findCallEntry(history, action, id, mask);
  if (idx === -1) return memory;
  const e = history[idx];
  if (e === undefined) return memory;
  const clean: Outcome = outcome.ok ? { ok: true } : { ok: false, error: redact(outcome.error ?? '').slice(0, MAX_ERROR) };
  history[idx] = { ...e, outcome: clean };
  return { ...memory, history };
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(o: Obj, k: string): string | null {
  const v = o[k];
  return typeof v === 'string' ? v : null;
}

function parseAction(v: unknown): Action | null {
  if (!isObj(v)) return null;
  const tool = str(v, 'tool');
  if (tool === null) return null;
  switch (v['kind']) {
    case 'exec': {
      const command = str(v, 'command');
      const shell = v['shell'];
      if (command === null || (shell !== 'posix' && shell !== 'powershell' && shell !== 'cmd')) return null;
      return { kind: 'exec', command, shell, tool };
    }
    case 'read':
    case 'write': {
      const path = str(v, 'path');
      return path === null ? null : { kind: v['kind'], path, tool };
    }
    case 'fetch': {
      const url = str(v, 'url');
      return url === null ? null : { kind: 'fetch', url, tool };
    }
    case 'other':
      return { kind: 'other', tool };
    default:
      return null;
  }
}

function parseEntry(v: unknown): StoredHistoryEntry | null {
  if (!isObj(v)) return null;
  const action = parseAction(v['action']);
  if (action === null) return null;
  const entry: StoredHistoryEntry = { action };
  const id = str(v, 'id');
  if (id !== null) entry.id = id.slice(0, MAX_ID);
  const asked = str(v, 'asked');
  if (asked !== null && asked !== '') entry.asked = asked.slice(0, MAX_ID);
  const o = v['outcome'];
  if (isObj(o) && typeof o['ok'] === 'boolean') {
    const err = str(o, 'error');
    entry.outcome = o['ok'] ? { ok: true } : { ok: false, error: (err ?? '').slice(0, MAX_ERROR) };
  }
  return entry;
}

const SOURCES: readonly string[] = ['web-fetch', 'web-search', 'mcp-output', 'network-output', 'outside-file', 'user-marked', 'inbound-content'];

function parseMarks(v: unknown, privateList: boolean): TaintMark[] | null {
  if (!Array.isArray(v)) return null;
  const out: TaintMark[] = [];
  for (const m of v) {
    if (!isObj(m)) return null;
    const source = str(m, 'source');
    const detail = str(m, 'detail');
    if (source === null || detail === null) return null;
    if (privateList ? source !== 'private' : !SOURCES.includes(source)) return null;
    out.push({ source: source as TaintSource | 'private', detail: detail.slice(0, 200) });
  }
  return out;
}

function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

const UNREADABLE: TaintState = Object.freeze({
  untrusted: Object.freeze([{ source: 'user-marked', detail: 'the saved taint state of this session could not be read' }]) as readonly TaintMark[],
  privateData: Object.freeze([]) as readonly TaintMark[],
  untrustedCount: 1,
  privateCount: 0,
});

export function parseTaint(v: unknown): TaintState {
  if (v === undefined) return CLEAN_TAINT;
  if (!isObj(v)) return UNREADABLE;
  const untrusted = parseMarks(v['untrusted'], false);
  const privateData = parseMarks(v['privateData'], true);
  const uc = count(v['untrustedCount']);
  const pc = count(v['privateCount']);
  const ic = v['injectedCount'] === undefined ? 0 : count(v['injectedCount']);
  if (untrusted === null || privateData === null || uc === null || pc === null || ic === null) return UNREADABLE;
  const base: TaintState = { untrusted, privateData, untrustedCount: Math.max(uc, untrusted.length), privateCount: Math.max(pc, privateData.length) };
  return ic > 0 ? { ...base, injectedCount: ic } : base;
}

export function parseMemory(raw: unknown): SessionMemory {
  if (!isObj(raw)) return { history: [], taint: CLEAN_TAINT };
  const h = raw['history'];
  const history: StoredHistoryEntry[] = [];
  if (Array.isArray(h)) {
    for (const item of h.slice(-HISTORY_KEEP)) {
      const e = parseEntry(item);
      if (e !== null) history.push(e);
    }
  }
  const why = raw['unreadable'];
  const memory: SessionMemory = { history, taint: parseTaint(raw['taint']) };
  const chain = parseChain(raw['chain']);
  if (chain !== undefined) memory.chain = chain;
  const outbound = parseOutboundMemory(raw['outbound']);
  if (outbound !== undefined) memory.outbound = outbound;
  const trashNote = parseTrashNote(raw['trashNote']);
  if (trashNote !== undefined) memory.trashNote = trashNote;
  const wrote = parseWrote(raw['wrote']);
  if (wrote !== undefined) memory.wrote = wrote;
  return typeof why === 'string' && why !== '' ? { ...memory, unreadable: why.slice(0, MAX_ERROR) } : memory;
}

/** A session file's chain head, or undefined when absent or malformed (the next record then starts a new chain, which `audit verify` reports). */
export function parseChain(v: unknown): ChainHead | undefined {
  if (!isObj(v)) return undefined;
  const seq = v['seq'];
  const head = v['head'];
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1 || typeof head !== 'string' || !/^[0-9a-f]{64}$/.test(head)) return undefined;
  return { seq, head };
}

/**
 * A judged call on a session whose saved state could not be read asks once: the budget count restarted and
 * the taint reads as untrusted. Recording the call (`recordAction`) clears the mark.
 */
export function unreadableFindings(memory: SessionMemory): Finding[] {
  if (memory.unreadable === undefined) return [];
  return [{ decision: 'ask', rule: 'budget.unmeasured', reason: `${memory.unreadable}, so the budget count restarts here and the session is treated as having read untrusted content` }];
}

/** The session's outbound memory as the guard reads it (0.20.0): a fresh one when there is none, marked unreadable when the session file was lost. */
export function outboundView(memory: SessionMemory, now: Date | undefined): OutboundView {
  const m = memory.outbound ?? (memory.unreadable !== undefined ? { ...newOutboundMemory(), unreadable: true } : newOutboundMemory());
  return { memory: m, now: (now ?? new Date()).getTime() };
}

export function isUnattended(env: NodeJS.ProcessEnv): boolean {
  const v = env['OPENMORALS_UNATTENDED'];
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

export function unattendedVerdict(v: Verdict): Verdict {
  if (v.decision !== 'ask') return v;
  return { decision: 'deny', rule: v.rule, reason: `${v.reason} [unattended: nobody can answer, so ask becomes deny]` };
}

