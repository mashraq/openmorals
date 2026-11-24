import { redact } from './audit.js';
import type { Finding } from './guard.js';
import type { HistoryEntry, Outcome } from './loop/index.js';
import { actionKey, detectLoop } from './loop/index.js';
import type { TaintContext, TaintMark, TaintSource, TaintState } from './taint/index.js';
import { CLEAN_TAINT, judge, reduceTaint } from './taint/index.js';
import type { Action, Bylaws, Verdict } from './types.js';
import { decisionRank } from './types.js';

export const HISTORY_KEEP = 20;
const MAX_ERROR = 400;
const MAX_ID = 128;

export interface StoredHistoryEntry extends HistoryEntry {
  id?: string;
}

export interface SessionMemory {
  history: readonly StoredHistoryEntry[];
  taint: TaintState;
}

export const EMPTY_MEMORY: SessionMemory = Object.freeze({ history: Object.freeze([]), taint: CLEAN_TAINT });

export function taintContext(projectRoot: string, bylaws: Bylaws, platform: NodeJS.Platform = process.platform): TaintContext {
  return { projectRoot, platform: platform === 'win32' ? 'win32' : 'posix', trustedHosts: bylaws.guards.taint.trusted_hosts };
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

export function storedAction(action: Action): Action {
  switch (action.kind) {
    case 'exec':
      return { ...action, command: redact(action.command) };
    case 'read':
    case 'write':
      return { ...action, path: redact(action.path) };
    case 'fetch':
      return { ...action, url: redact(action.url) };
    default:
      return { ...action };
  }
}

export function recordAction(memory: SessionMemory, action: Action, verdict: Verdict, ctx: TaintContext, id: string | null): SessionMemory {
  const entry: StoredHistoryEntry = { action: storedAction(action) };
  if (id !== null && id !== '') entry.id = id.slice(0, MAX_ID);
  const history = [...memory.history, entry].slice(-HISTORY_KEEP);
  const taint = verdict.decision === 'deny' ? memory.taint : reduceTaint(memory.taint, { type: 'action', action }, ctx);
  return { history, taint };
}

export function recordOutcome(memory: SessionMemory, action: Action, outcome: Outcome, id: string | null): SessionMemory {
  const history = memory.history.slice();
  let idx = -1;
  if (id !== null && id !== '') idx = history.findIndex((e) => e.id === id.slice(0, MAX_ID));
  if (idx === -1) {
    const key = actionKey(storedAction(action));
    for (let i = history.length - 1; i >= 0; i--) {
      const e = history[i];
      if (e !== undefined && e.outcome === undefined && key !== null && actionKey(e.action) === key) {
        idx = i;
        break;
      }
    }
  }
  if (idx === -1) return memory;
  const e = history[idx];
  if (e === undefined) return memory;
  const clean: Outcome = outcome.ok ? { ok: true } : { ok: false, error: redact(outcome.error ?? '').slice(0, MAX_ERROR) };
  history[idx] = { ...e, outcome: clean };
  return { history, taint: memory.taint };
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
  return { history, taint: parseTaint(raw['taint']) };
}

export function isUnattended(env: NodeJS.ProcessEnv): boolean {
  const v = env['OPENMORALS_UNATTENDED'];
  return v !== undefined && v !== '' && v !== '0' && v.toLowerCase() !== 'false';
}

export function unattendedVerdict(v: Verdict): Verdict {
  if (v.decision !== 'ask') return v;
  return { decision: 'deny', rule: v.rule, reason: `${v.reason} [unattended: nobody can answer, so ask becomes deny]` };
}

