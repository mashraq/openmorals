import type { Action, Decision } from '../types.js';
import { parseCommand, type SimpleCommand } from '../shell.js';

export interface Outcome {
  ok: boolean;
  error?: string;
}

export interface HistoryEntry {
  action: Action;
  outcome?: Outcome;
}

export interface LoopOptions {
  window: number;
  repeatLimit: number;
  nearLimit: number;
  pollLimit: number;
  failureLimit: number;
}

export const DEFAULT_LOOP_OPTIONS: Readonly<LoopOptions> = Object.freeze({
  window: 20,
  repeatLimit: 4,
  nearLimit: 5,
  pollLimit: 6,
  failureLimit: 3,
});

export type LoopKind = 'none' | 'repeated-failure' | 'repeat' | 'polling' | 'near-repeat';

export interface LoopVerdict {
  decision: Extract<Decision, 'allow' | 'ask'>;
  rule: string;
  reason: string;
  kind: LoopKind;
  count: number;
}

const MAX_KEY = 400;

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, MAX_KEY);
}

export function actionKey(a: Action): string | null {
  switch (a.kind) {
    case 'exec':
      return `exec:${collapse(a.command)}`;
    case 'read':
      return `read:${collapse(a.path)}`;
    case 'fetch':
      return `fetch:${collapse(a.url)}`;
    case 'write':
    case 'other':
      return null;
  }
}

export function shapeOf(key: string): string {
  return key
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '#')
    .replace(/\b[0-9a-f]{7,64}\b/g, '#')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/(["'])(?:(?!\1).)*\1/g, '"_"')
    .replace(/\s+/g, ' ');
}

function failureSignature(e: HistoryEntry): string | null {
  if (e.outcome === undefined || e.outcome.ok) return null;
  const key = actionKey(e.action);
  if (key === null) return null;
  return `${key}\u0000${shapeOf(collapse(e.outcome.error ?? ''))}`;
}

const SLEEP_NAMES = new Set(['sleep', 'start-sleep']);
const POLL_NAMES = new Set(['tail', 'ps', 'pgrep', 'pidof', 'jobs', 'top', 'uptime', 'watch', 'lsof', 'get-process', 'gps', 'get-job', 'tasklist']);
const FILTER_NAMES = new Set(['cat', 'grep', 'egrep', 'fgrep', 'rg', 'head', 'wc', 'awk', 'sort', 'uniq', 'cut', 'tr', 'jq', 'echo', 'true', 'select-string', 'select-object', 'where-object', 'findstr', 'measure-object']);

function isSleep(c: SimpleCommand): boolean {
  return SLEEP_NAMES.has(c.name) || (c.shell === 'cmd' && (c.name === 'timeout' || c.via.includes('timeout')));
}

function isPollCommand(c: SimpleCommand): boolean {
  if (isSleep(c) || POLL_NAMES.has(c.name)) return true;
  const a0 = c.args[0];
  const a1 = c.args[1];
  if (c.name === 'gh' && a0 === 'run' && (a1 === 'view' || a1 === 'list')) return true;
  if (c.name === 'gh' && a0 === 'pr' && a1 === 'checks') return true;
  if (c.name === 'kubectl' && (a0 === 'get' || a0 === 'logs' || a0 === 'describe')) return true;
  if (c.name === 'docker' && (a0 === 'ps' || a0 === 'logs' || a0 === 'stats')) return true;
  if (c.name === 'systemctl' && a0 === 'status') return true;
  if (c.name === 'get-content' && c.args.some((x) => x.toLowerCase() === '-tail')) return true;
  return false;
}

export function isPolling(a: Action): boolean {
  if (a.kind !== 'exec') return false;
  const cmds = parseCommand(a.command, a.shell).commands;
  if (cmds.some(isSleep)) return true;
  return cmds.some(isPollCommand) && cmds.every((c) => isPollCommand(c) || FILTER_NAMES.has(c.name));
}

function segmentSinceProgress(history: readonly HistoryEntry[]): HistoryEntry[] {
  let start = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.action.kind === 'write') {
      start = i + 1;
      break;
    }
  }
  return history.slice(start);
}

function quote(key: string): string {
  const body = key.slice(key.indexOf(':') + 1);
  return body.length > 80 ? body.slice(0, 77) + '...' : body;
}

const ALLOW: LoopVerdict = { decision: 'allow', rule: 'loop', reason: 'no loop detected', kind: 'none', count: 0 };

function sane(o: Partial<LoopOptions> | undefined): LoopOptions {
  const merged = { ...DEFAULT_LOOP_OPTIONS, ...o };
  const pos = (n: number, d: number): number => (Number.isFinite(n) && n >= 1 ? Math.floor(n) : d);
  return {
    window: pos(merged.window, DEFAULT_LOOP_OPTIONS.window),
    repeatLimit: pos(merged.repeatLimit, DEFAULT_LOOP_OPTIONS.repeatLimit),
    nearLimit: pos(merged.nearLimit, DEFAULT_LOOP_OPTIONS.nearLimit),
    pollLimit: pos(merged.pollLimit, DEFAULT_LOOP_OPTIONS.pollLimit),
    failureLimit: pos(merged.failureLimit, DEFAULT_LOOP_OPTIONS.failureLimit),
  };
}

export function detectLoop(history: readonly HistoryEntry[], next: Action, options?: Partial<LoopOptions>): LoopVerdict {
  const o = sane(options);
  const nextKey = actionKey(next);
  if (nextKey === null) return ALLOW;
  const recent = history.slice(-o.window);

  const failures = new Map<string, number>();
  let lastFailSig: string | null = null;
  for (const e of recent) {
    const sig = failureSignature(e);
    if (sig === null) continue;
    if (actionKey(e.action) !== nextKey) continue;
    failures.set(sig, (failures.get(sig) ?? 0) + 1);
    lastFailSig = sig;
  }
  if (lastFailSig !== null) {
    const n = failures.get(lastFailSig) ?? 0;
    if (n >= o.failureLimit) {
      return {
        decision: 'ask',
        rule: 'loop.repeated-failure',
        reason: `'${quote(nextKey)}' has already failed ${n} times with the same error in the last ${recent.length} steps; stop and report the error instead of retrying`,
        kind: 'repeated-failure',
        count: n,
      };
    }
  }

  const segment = segmentSinceProgress(recent);
  const exact = segment.filter((e) => actionKey(e.action) === nextKey).length + 1;
  if (exact >= o.repeatLimit) {
    return {
      decision: 'ask',
      rule: 'loop.repeat',
      reason: `'${quote(nextKey)}' would run for the ${exact}th time with no file written in between; the result is unlikely to change`,
      kind: 'repeat',
      count: exact,
    };
  }

  if (isPolling(next)) {
    const polls = segment.filter((e) => isPolling(e.action)).length + 1;
    if (polls >= o.pollLimit) {
      return {
        decision: 'ask',
        rule: 'loop.polling',
        reason: `${polls} polling steps (sleep, tail, ps and similar) with no progress in between; wait with one blocking command instead of a polling loop`,
        kind: 'polling',
        count: polls,
      };
    }
  }

  const nextShape = shapeOf(nextKey);
  const near = segment.filter((e) => {
    const k = actionKey(e.action);
    return k !== null && shapeOf(k) === nextShape;
  }).length + 1;
  if (near >= o.nearLimit) {
    return {
      decision: 'ask',
      rule: 'loop.near-repeat',
      reason: `${near} near-identical steps like '${quote(nextKey)}' (differing only in numbers, ids or quoted text) with no file written in between`,
      kind: 'near-repeat',
      count: near,
    };
  }
  return ALLOW;
}
