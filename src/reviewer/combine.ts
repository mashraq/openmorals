import type { Decision, Verdict } from '../types.js';
import { strictest } from '../types.js';
import type { Review } from './types.js';

/**
 * Folds a review into a guard verdict. The result's decision is
 * strictest(input, ...) so it can never be looser than the input:
 * - no-objection keeps the decision and notes the reviewer's reason;
 * - escalate raises the decision to at least `onEscalate` ('ask' by default).
 */
export function applyReview(decision: Verdict, review: Review, onEscalate: 'ask' | 'deny' = 'ask'): Verdict {
  const floor: Decision = review.verdict === 'escalate' ? onEscalate : decision.decision;
  const next = strictest(decision.decision, floor);
  const note = review.verdict === 'escalate' ? `reviewer escalated (${review.source}): ${review.reason}` : `reviewer had no objection: ${review.reason}`;
  return {
    decision: next,
    rule: next === decision.decision ? decision.rule : `${decision.rule}+reviewer.escalate`,
    reason: decision.reason === '' ? note : `${decision.reason}; ${note}`,
  };
}
