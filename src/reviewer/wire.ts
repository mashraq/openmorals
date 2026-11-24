import type { Action, ReviewerBylaws, Verdict } from '../types.js';
import { REVIEWER_TIMEOUT_MAX_MS } from '../bylaws.js';
import { createAnthropicProvider } from './anthropic.js';
import { applyReview } from './combine.js';
import { createFakeProvider } from './fake.js';
import { createGeminiProvider } from './gemini.js';
import type { FetchLike } from './http.js';
import { createOpenAIChatProvider } from './openai-chat.js';
import { reviewAction } from './review.js';
import type { ReviewOutcome, ReviewProvider } from './types.js';

/** What `provider: fake` answers: a dry run that sends nothing anywhere. */
export const DRY_RUN_REPLY = JSON.stringify({ verdict: 'no-objection', reason: 'fake provider (dry run): nothing was sent to a model' });

/**
 * The client for the protocol the bylaws name. The API key is read from `cfg.api_key_env` only
 * when a review is sent, and only ever sent to `cfg.base_url` (or the protocol's public endpoint).
 */
export function reviewerProvider(cfg: ReviewerBylaws, env: Readonly<Record<string, string | undefined>> = process.env, fetchImpl?: FetchLike): ReviewProvider {
  const keyEnv = cfg.auth === 'none' ? null : cfg.api_key_env;
  const common = { env, ...(cfg.base_url !== undefined ? { baseUrl: cfg.base_url } : {}), ...(fetchImpl !== undefined ? { fetch: fetchImpl } : {}) };
  switch (cfg.provider) {
    case 'fake':
      return createFakeProvider({ reply: DRY_RUN_REPLY });
    case 'openai-chat':
      return createOpenAIChatProvider({ ...common, apiKeyEnv: keyEnv, ...(cfg.compat?.token_param !== undefined ? { tokenParam: cfg.compat.token_param } : {}), ...(cfg.compat?.system_role !== undefined ? { systemRole: cfg.compat.system_role } : {}) });
    case 'gemini':
      return createGeminiProvider({ ...common, apiKeyEnv: keyEnv });
    case 'anthropic':
    case 'anthropic-messages':
      if (keyEnv === null) return { name: 'anthropic-messages', complete: async () => ({ ok: false, kind: 'missing-key', error: 'the Anthropic Messages API needs a key (auth: none is for local servers)' }) };
      return createAnthropicProvider({ ...common, apiKeyEnv: keyEnv });
  }
}

export interface ReviewVerdictOptions {
  env?: Readonly<Record<string, string | undefined>>;
  /** Overrides the provider named in the bylaws. */
  provider?: ReviewProvider;
  /** Injected for tests: the fetch the configured provider uses. */
  fetch?: FetchLike;
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
    const provider = opts.provider ?? reviewerProvider(cfg, opts.env ?? process.env, opts.fetch);
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
