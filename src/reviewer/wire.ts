import type { Action, ReviewerBylaws, Verdict } from '../types.js';
import { REVIEWER_TIMEOUT_MAX_MS } from '../bylaws.js';
import { createAnthropicProvider } from './anthropic.js';
import { applyReview } from './combine.js';
import { createFakeProvider } from './fake.js';
import { reviewAction } from './review.js';
import type { ReviewOutcome, ReviewProvider } from './types.js';

/** What `provider: fake` answers: a dry run that sends nothing anywhere. */
export const DRY_RUN_REPLY = JSON.stringify({ verdict: 'no-objection', reason: 'fake provider (dry run): nothing was sent to a model' });

/** The provider the bylaws name. The API key is read from `cfg.api_key_env` only when a review is sent. */
export function reviewerProvider(cfg: ReviewerBylaws, env: Readonly<Record<string, string | undefined>> = process.env): ReviewProvider {
  if (cfg.provider === 'fake') return createFakeProvider({ reply: DRY_RUN_REPLY });
  return createAnthropicProvider({ apiKeyEnv: cfg.api_key_env, env });
}

export interface ReviewVerdictOptions {
  env?: Readonly<Record<string, string | undefined>>;
  /** Overrides the provider named in the bylaws. */
  provider?: ReviewProvider;
  context?: string;
  nonce?: string;
}

export interface ReviewVerdictResult {
  verdict: Verdict;
  /** null when nothing was reviewed (not an ask) or the review itself crashed. */
  outcome: ReviewOutcome | null;
}

/**
 * Runs the reviewer on one guard verdict, as the bylaws configure it. Only `ask` is sent.
 * The result is never looser than the input. A model's `escalate` honours `on_escalate`;
 * a failure (timeout, HTTP or network error, missing key, unparseable reply, a crash) keeps
 * the `ask` and says why, so a flaky network never turns into a hard deny while a person can answer.
 */
export async function reviewVerdict(action: Action, verdict: Verdict, cfg: ReviewerBylaws, opts: ReviewVerdictOptions = {}): Promise<ReviewVerdictResult> {
  if (verdict.decision !== 'ask') return { verdict, outcome: null };
  try {
    const provider = opts.provider ?? reviewerProvider(cfg, opts.env ?? process.env);
    const outcome = await reviewAction(
      { action, verdict, ...(opts.context !== undefined ? { context: opts.context } : {}) },
      provider,
      { model: cfg.model, timeoutMs: Math.min(cfg.timeout_ms, REVIEWER_TIMEOUT_MAX_MS), onEscalate: 'ask', ...(opts.nonce !== undefined ? { nonce: opts.nonce } : {}) },
    );
    const review = outcome.review;
    const final = review !== null && review.source === 'model' ? applyReview(verdict, review, cfg.on_escalate) : outcome.final;
    return { verdict: final, outcome };
  } catch (err: unknown) {
    return { verdict: { ...verdict, reason: `${verdict.reason}; the reviewer failed (${err instanceof Error ? err.message : String(err)}), so you are asked as before` }, outcome: null };
  }
}
