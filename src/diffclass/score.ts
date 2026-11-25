import { memoryReader } from './apply.js';
import type { ClassifyResult } from './classify.js';
import { classifyDiff } from './classify.js';
import type { Exclusion } from './rules.js';
import type { DiffClassCase } from './rows.js';

/** What one diff-class row got: review-free, review (with the reason rules) or unreadable. */
export interface RowOutcome {
  got: 'review' | 'review-free' | 'unreadable';
  rules: string[];
  basis: string | null;
}

/** Classifies one row's diff with the row's own settings, base files and record. */
export function classifyRow(c: DiffClassCase, exclusions?: readonly Exclusion[]): ClassifyResult {
  return classifyDiff({
    diff: c.diff,
    merge: { review_free: [...c.reviewFree], always_review: [...c.alwaysReview] },
    base: memoryReader(c.base, '<row base>'),
    reproduced: c.reproduced,
    record: c.record,
    declaredRun: c.run,
    ...(exclusions !== undefined ? { exclusions } : {}),
  });
}

export function rowOutcome(r: ClassifyResult): RowOutcome {
  if (!r.ok) return { got: 'unreadable', rules: [], basis: null };
  return { got: r.verdict.verdict, rules: r.verdict.reasons.map((x) => x.rule), basis: r.verdict.basis };
}

/**
 * Why a row is wrong, or null when it matches. `missed`: a row that must need review (or be unreadable) came out
 * review-free, or an unreadable row was read. `false-alarm`: a review-free row needed review. `rule`: the right verdict
 * for another reason.
 */
export function rowWrong(c: DiffClassCase, o: RowOutcome): 'missed' | 'false-alarm' | 'rule' | null {
  if (c.expect === 'review-free') {
    if (o.got !== 'review-free') return 'false-alarm';
    return c.rule !== null && o.basis !== c.rule ? 'rule' : null;
  }
  if (o.got === 'review-free') return 'missed';
  if (c.expect === 'unreadable' && o.got !== 'unreadable') return 'missed';
  if (c.rule !== null && !o.rules.includes(c.rule)) return 'rule';
  return null;
}
