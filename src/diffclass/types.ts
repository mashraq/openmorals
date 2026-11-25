import type { MergeClass } from '../types.js';

/**
 * One fact that puts a change in class B. `rule` is a stable id (`doubt.*`, `exclude.*`, `record.*`, `tighten.*`,
 * `class.*`, `settings.*`, `reproduced.*`, `integrity.*`); `path` names the file when there is one.
 */
export interface Reason {
  rule: string;
  path: string | null;
  text: string;
}

export interface FileVerdict {
  path: string;
  oldPath: string | null;
  status: string;
  /** The class this file alone falls in: a review-free class it meets, or `review`. */
  class: MergeClass | 'review';
  /** What qualified it (for example "3 added rows, each expecting ask or deny"), or null. */
  note: string | null;
  reasons: Reason[];
}

export type VerdictWord = 'review' | 'review-free';

export interface DiffVerdict {
  verdict: VerdictWord;
  class: 'A' | 'B';
  /** The switched-on class that made it review-free, or null. */
  basis: MergeClass | null;
  /** The class the diff meets whether or not it is switched on (for measuring), or null. */
  qualifies: MergeClass | null;
  exitCode: 0 | 1;
  /** Every fact behind a review verdict, most important first. Empty for review-free. */
  reasons: Reason[];
  files: FileVerdict[];
  /** The review-free classes switched on in the settings that were read. */
  switchedOn: MergeClass[];
  /** Notes about the settings (for example a project file that tried to switch a class on). */
  notes: string[];
  cannotSee: string[];
  /** Test-integrity rules that had no input for this diff (no declared paths, no boundary paths), one line each. */
  notChecked: string[];
}

/**
 * A source of extra reasons over the whole diff. Every source can only add reasons, and any reason makes the change need
 * review: the type has no way to make a change review-free.
 */
export type ReasonSource = (files: readonly import('./parse.js').FileDiff[], ctx: import('./integrity.js').IntegrityContext) => readonly Reason[];
