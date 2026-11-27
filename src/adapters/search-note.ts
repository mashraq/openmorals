import { maskDetected } from '../rules/detectors.js';
import type { DetectorName } from '../rules/detectors.js';

const MAX_PATTERN = 200;

/** The words the audit text of a search with no folder ends with: `audit touched` reads them. */
export const WORKING_FOLDER = 'in the working folder';

/**
 * What a content search looked for, for its audit text only (0.40.0): ` [search "<pattern>"]`, or
 * ` [search "<pattern>" in the working folder]` when the call named no folder. Null when the call is not a search or
 * carries no pattern. It never changes how the call is judged.
 */
export function searchNote(pattern: unknown, folder: unknown, mask: readonly DetectorName[] = []): string | null {
  if (typeof pattern !== 'string' || pattern === '') return null;
  const p = maskDetected(pattern.length > MAX_PATTERN ? `${pattern.slice(0, MAX_PATTERN)}…` : pattern, mask);
  const noFolder = typeof folder !== 'string' || folder.trim() === '';
  return `[search ${JSON.stringify(p)}${noFolder ? ` ${WORKING_FOLDER}` : ''}]`;
}

/** The audit text of a call with its search note, if any. */
export function withSearchNote(describe: string, note: string | null): string {
  return note === null ? describe : `${describe.trimEnd()} ${note}`;
}
