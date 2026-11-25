import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { summarizeRun } from '../audit-verify.js';
import { resolveBylaws } from '../bylaws.js';
import { auditLogPath, configDir } from '../paths.js';
import type { MergeBylaws } from '../types.js';
import type { DiffVerdict, Reason } from './types.js';
import { folderReader } from './apply.js';
import { classifyDiff, formatVerdictJson, formatVerdictText } from './classify.js';
import { globProblem } from './glob.js';
import { MAX_DIFF_BYTES, decodeDiff, parseDiff } from './parse.js';
import type { FileDiff } from './parse.js';
import { MAX_NOTES, MAX_NOTE_BYTES, approvalNote, readNote } from '../review/notes.js';
import type { ReviewMap, SplitSuggestion } from '../review/map.js';
import { formatMapText, reviewMap, suggestSplit } from '../review/map.js';
import type { RecordFacts } from './record.js';
import { factsOf, parseSummary } from './record.js';

/** Exit codes of `openmorals diff-class`. `unreadable` is also review: nothing was judged (ADR 0005). */
export const DIFF_CLASS_EXIT = { reviewFree: 0, review: 1, unreadable: 2, usage: 64 } as const;

export const DIFF_CLASS_USAGE = `  openmorals diff-class <DIFF | -> [--json] [--base DIR] [--reproduced FILE]
                  [--run ID [--audit FILE]] [--summary FILE] [--paths GLOB]...
                  [--max-lines N] [--max-files N] [--note FILE]... [--map]
      Read a diff made by git diff (a file, or - for standard input) and say whether
      it may merge without a person reading it (class A) or needs review (class B),
      with the facts behind a review verdict. Nothing is review-free unless the
      user-level file switches a class on (merge.review_free: tighten-only,
      reproduced); a project file can only narrow that. Anything it does not fully
      understand needs review. --base: the folder holding the base tree (default
      the current folder), read for the base branch's merge settings and to rebuild
      the files a tighten-only check needs. --reproduced: the diff a pinned tool
      produced on the base tree; byte-equal means class reproduced. --run: also read
      that run's audit record (from the config directory, or --audit FILE); --summary:
      a saved "openmorals audit --run ID --json". The record can only add review.
      Test-integrity reason lines (docs/test-integrity.md) point at removed
      assertions, added skips, changed snapshots, runner config or scripts, new
      dependencies, suppressions and more; they only add review. --paths: a glob
      the work was declared to touch (repeat it); a file outside them gets a reason.
      --max-lines, --max-files: a size line; a bigger change gets a reason (none
      is set by default). --note (0.33.0): a note a bot or an AI summary wrote
      about the change (repeat it); a "review: <path> <why>" line or a line with
      a concern word adds review, and an approval line changes nothing: a note
      can only add review. --map (0.33.0): after the verdict, the files riskiest
      first, and over the size line (--max-lines, --max-files, else 400 lines or
      25 files) a suggested split into smaller changes; it never changes the verdict.
      Calls no model, holds no credential, merges and writes nothing. Exit code: 0
      review-free, 1 review, 2 the diff or another input cannot be read (review),
      64 usage error.`;

export interface DiffClassResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface Parsed {
  diff: string;
  json: boolean;
  paths: string[] | null;
  maxLines: number | undefined;
  maxFiles: number | undefined;
  base: string | undefined;
  reproduced: string | undefined;
  run: string | undefined;
  audit: string | undefined;
  summary: string | undefined;
  notes: string[];
  map: boolean;
}

const VALUE_OPTS = new Set(['--base', '--reproduced', '--run', '--audit', '--summary', '--paths', '--max-lines', '--max-files', '--note']);
const MAX_PATH_GLOBS = 200;

function parse(argv: readonly string[]): { ok: true; p: Parsed } | { ok: false; error: string } {
  const pos: string[] = [];
  const p: Parsed = { diff: '', json: false, paths: null, maxLines: undefined, maxFiles: undefined, base: undefined, reproduced: undefined, run: undefined, audit: undefined, summary: undefined, notes: [], map: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a === '--json') {
      p.json = true;
      continue;
    }
    if (a === '--map') {
      p.map = true;
      continue;
    }
    if (a.startsWith('-') && a !== '-') {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      if (!VALUE_OPTS.has(name)) return { ok: false, error: `unknown option ${name}` };
      const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (value === undefined || value === '') return { ok: false, error: `${name} needs a value` };
      if (name === '--paths') {
        const why = globProblem(value);
        if (why !== null) return { ok: false, error: `--paths ${JSON.stringify(value)} ${why}` };
        p.paths = [...(p.paths ?? []), value];
        if (p.paths.length > MAX_PATH_GLOBS) return { ok: false, error: `at most ${MAX_PATH_GLOBS} --paths globs` };
        continue;
      }
      if (name === '--note') {
        p.notes.push(value);
        if (p.notes.length > MAX_NOTES) return { ok: false, error: `at most ${MAX_NOTES} --note files` };
        continue;
      }
      if (name === '--max-lines' || name === '--max-files') {
        if (!/^[1-9][0-9]{0,8}$/.test(value)) return { ok: false, error: `${name} needs a whole number from 1` };
        const key = name === '--max-lines' ? 'maxLines' : 'maxFiles';
        if (p[key] !== undefined) return { ok: false, error: `${name} given twice` };
        p[key] = Number(value);
        continue;
      }
      const key = name.slice(2) as 'base' | 'reproduced' | 'run' | 'audit' | 'summary';
      if (p[key] !== undefined) return { ok: false, error: `${name} given twice` };
      p[key] = value;
      continue;
    }
    pos.push(a);
  }
  if (pos.length !== 1) return { ok: false, error: pos.length === 0 ? 'needs the diff: a file, or - for standard input' : `unexpected argument ${JSON.stringify(pos[1])}` };
  if (p.audit !== undefined && p.run === undefined) return { ok: false, error: '--audit needs --run' };
  if (p.run !== undefined && p.summary !== undefined) return { ok: false, error: 'give --run or --summary, not both' };
  if (pos[0] === '-' && p.notes.includes('-')) return { ok: false, error: 'the diff and a note cannot both come from standard input' };
  p.diff = pos[0] ?? '';
  return { ok: true, p };
}

function readBytes(file: string, readStdin: () => Uint8Array): { ok: true; bytes: Uint8Array } | { ok: false; error: string } {
  try {
    if (file === '-') return { ok: true, bytes: readStdin() };
    const st = statSync(file);
    if (!st.isFile()) return { ok: false, error: `${file} is not a file` };
    if (st.size > MAX_DIFF_BYTES) return { ok: false, error: `${file} is larger than ${MAX_DIFF_BYTES} bytes` };
    return { ok: true, bytes: readFileSync(file) };
  } catch (e: unknown) {
    return { ok: false, error: `cannot read ${file}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function unreadable(error: string, line: number | null, json: boolean): DiffClassResult {
  const where = line !== null ? ` (line ${line})` : '';
  const msg = `openmorals diff-class: REVIEW (unreadable input): ${error}${where}. Nothing was judged; read this as "needs review".`;
  return { exitCode: DIFF_CLASS_EXIT.unreadable, stdout: json ? `${JSON.stringify({ verdict: 'review', class: 'B', exitCode: DIFF_CLASS_EXIT.unreadable, error, line })}\n` : '', stderr: `${msg}\n` };
}

export interface DiffClassEnv {
  env: NodeJS.ProcessEnv;
  cwd: string;
  readStdin: () => Uint8Array;
}

/**
 * Merge settings a caller supplies instead of the user-level and project files (for example a team package that has
 * already resolved its own floor). `source` is named in the `class.off` reason.
 */
export interface DiffClassSettings {
  merge: MergeBylaws | undefined;
  source: string;
  /** Why the settings could not be read, or null. When set, nothing is review-free. */
  problem?: string | null;
  notes?: readonly string[];
}

/** The whole `openmorals diff-class` command without the process. Reads its inputs, writes nothing. */
export function diffClassCommand(argv: readonly string[], ctx: DiffClassEnv): DiffClassResult {
  return diffClassCommandWith(argv, ctx, null);
}

/**
 * The same command with the merge settings given by the caller; `null` reads them as `diffClassCommand` does (the
 * user-level file, narrowed by the base folder's project file). Every other input is read from `argv` as on the
 * command line.
 */
export function diffClassCommandWith(argv: readonly string[], ctx: DiffClassEnv, settings: DiffClassSettings | null): DiffClassResult {
  const o = diffClassVerdictWith(argv, ctx, settings);
  return o.ok ? formatDiffClass(o.verdict, o.json, o.review) : o.result;
}

/**
 * What `diffClassVerdictWith` gives: the verdict object, with whether `--json` was asked for, or the finished result of
 * a usage error or an unreadable input (both already "needs review" or a refusal; nothing to merge into).
 */
export type DiffClassOutcome = { ok: true; verdict: DiffVerdict; json: boolean; review?: DiffClassReview } | { ok: false; result: DiffClassResult };

/** What `--map` adds (0.33.0): the review map and, over the size line, a suggested split. Neither changes the verdict. */
export interface DiffClassReview {
  map: ReviewMap;
  split: SplitSuggestion | null;
}

/** The review map and split suggestion for a verdict and the parsed diff (0.33.0). */
export function reviewOf(verdict: DiffVerdict, files: readonly FileDiff[], limits: { maxLines?: number; maxFiles?: number } = {}): DiffClassReview {
  return { map: reviewMap(verdict, files), split: suggestSplit(files, limits) };
}

/** The command's output for a verdict, as `diffClassCommandWith` prints it; with `review`, the map follows the verdict. */
export function formatDiffClass(verdict: DiffVerdict, json: boolean, review?: DiffClassReview): DiffClassResult {
  if (json) return { exitCode: verdict.exitCode, stdout: review === undefined ? formatVerdictJson(verdict) : `${JSON.stringify({ ...verdict, map: review.map, split: review.split })}\n`, stderr: '' };
  return { exitCode: verdict.exitCode, stdout: formatVerdictText(verdict) + (review === undefined ? '' : formatMapText(review.map, review.split)), stderr: '' };
}

/**
 * `diffClassCommandWith` up to the verdict (0.14.0): the same argument and input handling, returning the verdict object
 * instead of printing it, so a caller can add its own reasons (which may only add review) and print it with
 * `formatDiffClass`. A usage error or an unreadable input comes back as the finished result.
 */
export function diffClassVerdictWith(argv: readonly string[], ctx: DiffClassEnv, settings: DiffClassSettings | null): DiffClassOutcome {
  const fail = (result: DiffClassResult): DiffClassOutcome => ({ ok: false, result });
  const pr = parse(argv);
  if (!pr.ok) return fail({ exitCode: DIFF_CLASS_EXIT.usage, stdout: '', stderr: `openmorals diff-class: ${pr.error}; nothing was done\nUsage:\n${DIFF_CLASS_USAGE}\n` });
  const p = pr.p;
  const diffBytes = readBytes(p.diff, ctx.readStdin);
  if (!diffBytes.ok) return fail(unreadable(diffBytes.error, null, p.json));
  const diff = decodeDiff(diffBytes.bytes);
  if (!diff.ok) return fail(unreadable(diff.error, null, p.json));
  const parsedDiff = parseDiff(diff.text);
  const diffPaths = parsedDiff.ok ? parsedDiff.files.flatMap((f) => [f.path, ...(f.oldPath !== null && f.oldPath !== f.path ? [f.oldPath] : [])]) : [];
  const noteReasons: Reason[] = [];
  const noteLines: string[] = [];
  for (const n of p.notes) {
    const nb = readBytes(n, ctx.readStdin);
    if (!nb.ok) return fail(unreadable(`the note: ${nb.error}`, null, p.json));
    if (nb.bytes.length > MAX_NOTE_BYTES) return fail(unreadable(`the note ${n} is larger than ${MAX_NOTE_BYTES} bytes`, null, p.json));
    const nt = decodeNote(nb.bytes);
    if (!nt.ok) return fail(unreadable(`the note ${n}: ${nt.error}`, null, p.json));
    const read = readNote(nt.text, n === '-' ? 'the note on standard input' : `note ${n}`, diffPaths);
    noteReasons.push(...read.reasons);
    const a = approvalNote(read);
    if (a !== null) noteLines.push(a);
  }
  let reproduced: string | null = null;
  if (p.reproduced !== undefined) {
    const rb = readBytes(p.reproduced, ctx.readStdin);
    if (!rb.ok) return fail(unreadable(`the reproduced diff: ${rb.error}`, null, p.json));
    const rd = decodeDiff(rb.bytes);
    if (!rd.ok) return fail(unreadable(`the reproduced diff: ${rd.error}`, null, p.json));
    reproduced = rd.text;
  }
  let record: RecordFacts | null = null;
  if (p.summary !== undefined) {
    const sb = readBytes(p.summary, ctx.readStdin);
    if (!sb.ok) return fail(unreadable(`the run summary: ${sb.error}`, null, p.json));
    const ps = parseSummary(new TextDecoder().decode(sb.bytes));
    if (!ps.ok) return fail(unreadable(ps.error, null, p.json));
    record = ps.facts;
  } else if (p.run !== undefined) {
    const file = p.audit !== undefined ? resolve(ctx.cwd, p.audit) : auditLogPath(configDir(ctx.env));
    record = factsOf(summarizeRun(file, p.run));
  }
  const baseDir = resolve(ctx.cwd, p.base ?? '.');
  let s: DiffClassSettings;
  if (settings !== null) s = settings;
  else {
    const load = resolveBylaws(baseDir, ctx.env);
    const notes: string[] = [];
    if (load.ok) {
      for (const l of load.ignored ?? []) if (l.field.startsWith('merge.')) notes.push(`${load.source} tried to set ${l.field} to ${l.candidate}; only the user-level file can switch a class on, so it was ignored`);
    }
    s = { merge: load.ok ? load.bylaws.merge : undefined, source: 'the user-level file', problem: load.ok ? null : `${load.source}: ${load.error}`, notes };
  }
  const r = classifyDiff({
    diff: diff.text,
    merge: s.merge,
    settingsProblem: s.problem ?? null,
    settingsSource: s.source,
    notes: [...(s.notes ?? []), ...noteLines],
    noteReasons,
    declaredPaths: p.paths,
    ...(p.maxLines !== undefined ? { maxLines: p.maxLines } : {}),
    ...(p.maxFiles !== undefined ? { maxFiles: p.maxFiles } : {}),
    base: folderReader(baseDir),
    reproduced,
    record,
    declaredRun: p.run ?? (record !== null ? record.run : null),
  });
  if (!r.ok) return fail(unreadable(r.error, r.line, p.json));
  if (p.map && parsedDiff.ok) return { ok: true, verdict: r.verdict, json: p.json, review: reviewOf(r.verdict, parsedDiff.files, { ...(p.maxLines !== undefined ? { maxLines: p.maxLines } : {}), ...(p.maxFiles !== undefined ? { maxFiles: p.maxFiles } : {}) }) };
  return { ok: true, verdict: r.verdict, json: p.json };
}

/** A note must be UTF-8 text without NUL bytes or a byte-order mark; one that cannot be read fails closed (exit 2). */
function decodeNote(bytes: Uint8Array): { ok: true; text: string } | { ok: false; error: string } {
  if (bytes.includes(0)) return { ok: false, error: 'it holds a NUL byte (binary data or UTF-16, not UTF-8 text)' };
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return { ok: false, error: 'it starts with a UTF-16 byte-order mark' };
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) };
  } catch {
    return { ok: false, error: 'it is not valid UTF-8' };
  }
}
