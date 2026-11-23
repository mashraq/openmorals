export type Decision = 'allow' | 'ask' | 'deny';

export const DECISIONS: readonly Decision[] = ['allow', 'ask', 'deny'];

export function decisionRank(d: Decision): number {
  return d === 'deny' ? 2 : d === 'ask' ? 1 : 0;
}

export function strictest(a: Decision, b: Decision): Decision {
  return decisionRank(b) > decisionRank(a) ? b : a;
}

export function isDecision(v: unknown): v is Decision {
  return v === 'allow' || v === 'ask' || v === 'deny';
}

export type ShellKind = 'posix' | 'powershell' | 'cmd';

export type Action =
  | { kind: 'exec'; command: string; shell: ShellKind; tool: string }
  | { kind: 'read'; path: string; tool: string }
  | { kind: 'write'; path: string; tool: string }
  | { kind: 'fetch'; url: string; tool: string }
  | { kind: 'other'; tool: string };

export interface Verdict {
  decision: Decision;
  rule: string;
  reason: string;
}

export interface SessionState {
  toolCalls: number;
  tokens: number;
  prevTokens: number;
}

export const EMPTY_STATE: SessionState = Object.freeze({ toolCalls: 0, tokens: 0, prevTokens: 0 });

export interface Limit {
  soft: number;
  hard: number;
  step: number;
}

export type RuleDecision = 'ask' | 'deny';

export interface RuleMatch {
  tool?: string;
  command?: string;
  path?: string;
}

export interface Rule {
  id: string;
  match: RuleMatch;
  decision: RuleDecision;
  reason: string;
  hard: boolean;
}

export interface Bylaws {
  version: 1;
  guards: {
    destructive: { decision: Decision; allow_targets: string[] };
    'online-delete': { decision: Decision };
    secrets: { read: Decision; write: Decision; send: Decision; hard: boolean };
    'self-protect': { decision: Decision };
    budget: { tool_calls: Limit; tokens: Limit };
  };
  rules: Rule[];
  audit: { enabled: boolean };
}

export type BylawsLoad =
  | { ok: true; bylaws: Bylaws; source: string }
  | { ok: false; error: string; source: string };
