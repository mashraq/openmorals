import type { ParsedCommand } from './shell.js';
import type { Action, Bylaws, Decision, SessionState } from './types.js';

export interface Finding {
  decision: Decision;
  rule: string;
  reason: string;
}

export interface GuardContext {
  action: Action;
  parsed: ParsedCommand | null;
  bylaws: Bylaws;
  state: SessionState;
}

export interface Guard {
  id: string;
  isHard(bylaws: Bylaws): boolean;
  evaluate(ctx: GuardContext): Finding[];
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
}

export function isOption(w: string): boolean {
  return w.startsWith('-') && w !== '-' && w !== '--';
}

export function quoteForReason(s: string, max = 80): string {
  const t = s.length > max ? `${s.slice(0, max - 1)}…` : s;
  return `'${t}'`;
}
