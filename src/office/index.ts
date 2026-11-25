// The office before-after checks (Q8, 0.30.0). CLI only: `openmorals order check` and `openmorals eval` load this
// folder; no hook module imports it (ruling R3), which test/office/hook-graph.test.ts proves on the built files.
import type { CheckLine, OfficeComparison } from './compare.js';
import { compareDocuments, compareWorkbooks } from './compare.js';
import { readDocument } from './docx.js';
import { readWorkbook } from './xlsx.js';

export type OfficeFormat = 'xlsx' | 'docx';
export const OFFICE_FORMATS: readonly OfficeFormat[] = ['xlsx', 'docx'];

export interface OfficeOptions {
  /** Workbooks: ranges (`Sheet!A1:B9`) or defined names whose cells must not change. */
  inputs?: readonly string[];
  /** Documents: every change from the baseline must be a tracked change. */
  redline?: boolean;
}

/**
 * Compares a file with its baseline copy. A file that does not read gives one failed line, "could not read", never a
 * pass: a malformed, truncated, oversized or hostile file fails the check.
 */
export function compareOffice(format: OfficeFormat, before: Buffer, after: Buffer, opts: OfficeOptions = {}, labels: { before: string; after: string } = { before: 'the baseline', after: 'the file' }): OfficeComparison {
  const unread = (which: string, error: string): OfficeComparison => ({ status: 'fail', lines: [{ check: 'read', outcome: 'fail', text: `could not read ${which}: it ${error}` }] });
  try {
    if (format === 'xlsx') {
      const b = readWorkbook(before);
      if (!b.ok) return unread(labels.before, b.error);
      const a = readWorkbook(after);
      if (!a.ok) return unread(labels.after, a.error);
      return compareWorkbooks(b.value, a.value, { inputs: opts.inputs ?? [] });
    }
    const b = readDocument(before);
    if (!b.ok) return unread(labels.before, b.error);
    const a = readDocument(after);
    if (!a.ok) return unread(labels.after, a.error);
    return compareDocuments(b.value, a.value, { redline: opts.redline === true });
  } catch (e: unknown) {
    return unread(`${labels.before} or ${labels.after}`, `stopped the reader (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** Whether a file reads as the format, for `order baseline` (a baseline that would not read later is refused now). */
export function readsAs(format: OfficeFormat, buf: Buffer): { ok: true } | { ok: false; error: string } {
  try {
    const r = format === 'xlsx' ? readWorkbook(buf) : readDocument(buf);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch (e: unknown) {
    return { ok: false, error: `stopped the reader (${e instanceof Error ? e.message : String(e)})` };
  }
}

export type { CheckLine, CheckOutcome, OfficeComparison } from './compare.js';
export { DOCUMENT_CHECKS, WORKBOOK_CHECKS, alignRows, compareDocuments, compareWorkbooks, definedTerms, similarity } from './compare.js';
export type { DocParagraph, WordDocument } from './docx.js';
export { readDocument } from './docx.js';
export type { Cell, DefinedName, Sheet, Validation, Workbook } from './xlsx.js';
export { MAX_CELLS, MAX_PART_BYTES, readWorkbook } from './xlsx.js';
export { MAX_ENTRIES, MAX_ENTRY_BYTES, MAX_TOTAL_INFLATE, crc32, zipEntries } from './zip.js';
export { aggregateOf, parseArea, shiftFormula } from './refs.js';
