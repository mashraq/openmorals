import type { MergeClass } from '../types.js';
import { MERGE_CLASSES } from '../types.js';
import type { RecordFacts } from './record.js';

/** The header that marks a `*.cases.yaml` file as merge-verdict rows rather than guard rows. */
export const DIFF_CLASS_TABLE = 'diff-class';

export const DIFF_CLASS_KEYS: readonly string[] = ['name', 'diff', 'base', 'review_free', 'always_review', 'reproduced', 'record', 'run', 'expect', 'rule', 'note', 'paths', 'boundary_paths', 'max_lines', 'max_files', 'not_rule'];
const RECORD_KEYS: readonly string[] = ['run', 'status', 'records', 'denies', 'asks', 'approved_asks', 'taint_marks', 'loosening_notes', 'ok', 'problems'];

export type DiffClassExpect = 'review' | 'review-free' | 'unreadable';

export interface DiffClassCase {
  name: string;
  diff: string;
  base: Record<string, string>;
  reviewFree: MergeClass[];
  alwaysReview: string[];
  /** Declared paths (`--paths`), or null when the row declares none. */
  paths: string[] | null;
  boundaryPaths: string[];
  maxLines: number | null;
  maxFiles: number | null;
  /** The reproduced diff: the row's own diff when the file says `same`. */
  reproduced: string | null;
  record: RecordFacts | null;
  run: string | null;
  expect: DiffClassExpect;
  /** A reason rule that must be among the reasons (review rows), or the class that must be the basis (review-free rows). */
  rule: string | null;
  /** A reason rule that must not be among the reasons (a near miss the rule must stay silent on), or null. */
  notRule: string | null;
  line: number | null;
}

export interface DiffClassFile {
  file: string;
  cases: DiffClassCase[];
}

type Row = { ok: true; value: DiffClassCase } | { ok: false; error: string };

function err(file: string, idx: number, msg: string): { ok: false; error: string } {
  return { ok: false, error: `${file}[${idx}] ${msg}` };
}

function strList(v: unknown): string[] | null {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
}

/** One row of a diff-class table. Unknown keys or wrong types make the whole file unreadable. */
export function toDiffClassCase(raw: unknown, idx: number, file: string, line: number | null): Row {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return err(file, idx, 'is not a mapping');
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!DIFF_CLASS_KEYS.includes(k)) return err(file, idx, `has unknown key ${k}`);
  const { name, diff, expect } = o;
  if (typeof name !== 'string' || name === '') return err(file, idx, 'needs a name');
  if (typeof diff !== 'string') return err(file, idx, 'needs diff (a string)');
  if (expect !== 'review' && expect !== 'review-free' && expect !== 'unreadable') return err(file, idx, 'expect must be review, review-free or unreadable');
  const baseRaw = o['base'] ?? {};
  if (typeof baseRaw !== 'object' || baseRaw === null || Array.isArray(baseRaw) || !Object.values(baseRaw).every((x) => typeof x === 'string')) return err(file, idx, 'base must map paths to file text');
  const rf = strList(o['review_free']);
  if (rf === null || !rf.every((x) => MERGE_CLASSES.some((c) => c === x))) return err(file, idx, `review_free must list ${MERGE_CLASSES.join(', ')}`);
  const ar = strList(o['always_review']);
  if (ar === null) return err(file, idx, 'always_review must be a list of globs');
  const dp = o['paths'] === undefined ? null : strList(o['paths']);
  if (o['paths'] !== undefined && dp === null) return err(file, idx, 'paths must be a list of globs');
  const bp = strList(o['boundary_paths']);
  if (bp === null) return err(file, idx, 'boundary_paths must be a list of globs');
  for (const k of ['max_lines', 'max_files']) if (o[k] !== undefined && !(typeof o[k] === 'number' && Number.isInteger(o[k]) && (o[k] as number) >= 1)) return err(file, idx, `${k} must be a whole number from 1`);
  const rp = o['reproduced'];
  if (rp !== undefined && typeof rp !== 'string') return err(file, idx, 'reproduced must be a string (or same)');
  for (const k of ['run', 'rule', 'note', 'not_rule']) if (o[k] !== undefined && typeof o[k] !== 'string') return err(file, idx, `${k} must be a string`);
  let record: RecordFacts | null = null;
  const rr = o['record'];
  if (rr !== undefined) {
    if (typeof rr !== 'object' || rr === null || Array.isArray(rr)) return err(file, idx, 'record must be a mapping');
    const r = rr as Record<string, unknown>;
    for (const k of Object.keys(r)) if (!RECORD_KEYS.includes(k)) return err(file, idx, `record has unknown key ${k}`);
    const num = (k: string): number | null => (r[k] === undefined ? 0 : typeof r[k] === 'number' && Number.isInteger(r[k]) && (r[k] as number) >= 0 ? (r[k] as number) : null);
    const counts = ['records', 'denies', 'asks', 'approved_asks', 'taint_marks', 'loosening_notes', 'problems'].map(num);
    if (counts.some((c) => c === null) || (r['ok'] !== undefined && typeof r['ok'] !== 'boolean') || (r['run'] !== undefined && typeof r['run'] !== 'string') || (r['status'] !== undefined && typeof r['status'] !== 'string')) return err(file, idx, 'record fields must be counts, ok a boolean, run and status strings');
    const [records, denies, asks, approvedAsks, taintMarks, looseningNotes, problems] = counts.map((c) => c ?? 0);
    record = {
      run: typeof r['run'] === 'string' ? r['run'] : typeof o['run'] === 'string' ? o['run'] : 'run-1',
      status: typeof r['status'] === 'string' ? r['status'] : 'ok',
      records: records ?? 0,
      denies: denies ?? 0,
      asks: asks ?? 0,
      approvedAsks: approvedAsks ?? 0,
      taintMarks: taintMarks ?? 0,
      looseningNotes: looseningNotes ?? 0,
      recordOk: r['ok'] !== false,
      problems: problems ?? 0,
    };
  }
  const str = (k: string): string | null => (typeof o[k] === 'string' ? (o[k] as string) : null);
  return {
    ok: true,
    value: {
      name,
      diff,
      base: baseRaw as Record<string, string>,
      reviewFree: rf as MergeClass[],
      alwaysReview: ar,
      paths: dp,
      boundaryPaths: bp,
      maxLines: typeof o['max_lines'] === 'number' ? o['max_lines'] : null,
      maxFiles: typeof o['max_files'] === 'number' ? o['max_files'] : null,
      reproduced: rp === undefined ? null : rp === 'same' ? diff : rp,
      record,
      run: str('run'),
      expect,
      rule: str('rule'),
      notRule: str('not_rule'),
      line,
    },
  };
}
