import type { Action, Decision, Verdict } from '../types.js';

/**
 * What the independent reviewer may say. There is deliberately no 'allow':
 * a reviewer can only add friction, never remove it.
 */
export type ReviewVerdict = 'escalate' | 'no-objection';

export const REVIEW_VERDICTS: readonly ReviewVerdict[] = ['escalate', 'no-objection'];

/** Why a review ended the way it did. Everything except 'model' is a fail-closed escalate. */
export type ReviewSource =
  | 'model'
  | 'timeout'
  | 'http-error'
  | 'network-error'
  | 'missing-key'
  | 'refusal'
  | 'unparseable'
  | 'incomplete'
  | 'too-large'
  | 'provider-error'
  | 'bad-config';

export interface Review {
  verdict: ReviewVerdict;
  reason: string;
  source: ReviewSource;
}

export interface ReviewRequest {
  action: Action;
  verdict: Verdict;
  /** A short description of what the agent was asked to do and recent steps. Untrusted. */
  context?: string;
}

export interface ProviderRequest {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
}

export type ProviderFailureKind = 'http' | 'network' | 'missing-key' | 'refusal' | 'bad-response' | 'incomplete';

export type ProviderResult =
  | { ok: true; text: string }
  | { ok: false; kind: ProviderFailureKind; error: string };

export interface ReviewProvider {
  readonly name: string;
  complete(request: ProviderRequest, signal: AbortSignal): Promise<ProviderResult>;
}

export interface ReviewLimits {
  /** The action text must fit whole, or it is not sent (escalate). */
  maxActionChars: number;
  /** Context is cut to this many characters (the most recent end is kept). */
  maxContextChars: number;
  /** Hard cap on the user message after framing. */
  maxPromptChars: number;
  /** Hard cap on the reviewer's reply text that is parsed. */
  maxReplyChars: number;
}

export const DEFAULT_REVIEW_LIMITS: Readonly<ReviewLimits> = Object.freeze({
  maxActionChars: 4000,
  maxContextChars: 2000,
  maxPromptChars: 12000,
  maxReplyChars: 2000,
});

export interface ReviewOptions {
  timeoutMs?: number;
  model?: string;
  maxTokens?: number;
  limits?: Partial<ReviewLimits>;
  /** What an escalate does to the decision: keep 'ask' (default) or harden to 'deny' for unattended runs. */
  onEscalate?: 'ask' | 'deny';
  /** Fixed boundary nonce for tests; random otherwise. */
  nonce?: string;
}

export interface ReviewOutcome {
  /** True only when the provider was actually called. */
  sent: boolean;
  /** null when nothing was sent (the decision was not 'ask'). */
  review: Review | null;
  /** The decision after review. Never looser than the input decision. */
  final: Verdict;
  /** The redacted, framed text that was (or would have been) sent; null when not sent. */
  prompt: { system: string; user: string } | null;
}

export type { Action, Decision, Verdict };
