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

export type ReviewerProviderName = 'anthropic' | 'fake';

export interface ReviewerBylaws {
  enabled: boolean;
  provider: ReviewerProviderName;
  model: string;
  api_key_env: string;
  timeout_ms: number;
  on_escalate: RuleDecision;
}

export interface SandboxBylaws {
  network: { allow_hosts: string[] };
  write: { allow: string[] };
  read: { deny: string[] };
}

/** Scanning of inbound content (tool results, fetched pages, submitted prompts) for hidden instructions. */
export interface InboundBylaws {
  enabled: boolean;
  /** For a prompt with hidden characters: allow records only, ask warns the user, deny blocks the prompt. A tool result is never blocked; with notify on, allow keeps it silent. */
  decision: Decision;
  /** Send the model (and the user) a short notice for each finding in a tool result. Off by default: a notice is re-sent with every later model call, so it costs tokens; the default is to taint and audit silently and speak only when a later action is stopped. */
  notify: boolean;
  /** Most bytes of one result or prompt that are scanned (the first and last half); the rest is not scanned. */
  max_bytes: number;
}

export interface Bylaws {
  version: 1;
  guards: {
    destructive: { decision: Decision; allow_targets: string[] };
    'online-delete': { decision: Decision };
    secrets: { read: Decision; write: Decision; send: Decision; hard: boolean };
    'self-protect': { decision: Decision };
    budget: { tool_calls: Limit; tokens: Limit };
    loop: { decision: Decision };
    taint: { decision: Decision; trusted_hosts: string[] };
    inbound: InboundBylaws;
  };
  rules: Rule[];
  audit: { enabled: boolean };
  reviewer: ReviewerBylaws;
  sandbox: SandboxBylaws;
}

/** One setting in which a candidate policy is looser than its baseline. */
export interface Loosening {
  field: string;
  candidate: string;
  baseline: string;
}

/**
 * A resolved policy. With a project file, `source` is that file, `floorSource` is the user-level
 * file (or `<defaults>`) it may only tighten, and `ignored` lists the project settings that would
 * have loosened the floor and were dropped. An invalid file still carries the strictest valid
 * policy that could be read as `floor`, so failing closed never falls below the user's settings.
 */
export type BylawsLoad =
  | { ok: true; bylaws: Bylaws; source: string; floorSource?: string; ignored?: Loosening[] }
  | { ok: false; error: string; source: string; floor?: Bylaws };
