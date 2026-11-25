import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { summarizeRun } from '../audit-verify.js';
import { resolveBylaws } from '../bylaws.js';
import { auditLogPath, configDir } from '../paths.js';
import { folderReader } from './apply.js';
import { classifyDiff, formatVerdictJson, formatVerdictText } from './classify.js';
import { MAX_DIFF_BYTES, decodeDiff } from './parse.js';
import type { RecordFacts } from './record.js';
import { factsOf, parseSummary } from './record.js';

/** Exit codes of `openmorals diff-class`. `unreadable` is also review: nothing was judged (ADR 0005). */
export const DIFF_CLASS_EXIT = { reviewFree: 0, review: 1, unreadable: 2, usage: 64 } as const;

export const DIFF_CLASS_USAGE = `  openmorals diff-class <DIFF | -> [--json] [--base DIR] [--reproduced FILE]
                  [--run ID [--audit FILE]] [--summary FILE]
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
  base: string | undefined;
  reproduced: string | undefined;
  run: string | undefined;
  audit: string | undefined;
  summary: string | undefined;
}

const VALUE_OPTS = new Set(['--base', '--reproduced', '--run', '--audit', '--summary']);

function parse(argv: readonly string[]): { ok: true; p: Parsed } | { ok: false; error: string } {
  const pos: string[] = [];
  const p: Parsed = { diff: '', json: false, base: undefined, reproduced: undefined, run: undefined, audit: undefined, summary: undefined };
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
    if (a.startsWith('-') && a !== '-') {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      if (!VALUE_OPTS.has(name)) return { ok: false, error: `unknown option ${name}` };
      const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (value === undefined || value === '') return { ok: false, error: `${name} needs a value` };
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

/** The whole `openmorals diff-class` command without the process. Reads its inputs, writes nothing. */
export function diffClassCommand(argv: readonly string[], ctx: DiffClassEnv): DiffClassResult {
  const pr = parse(argv);
  if (!pr.ok) return { exitCode: DIFF_CLASS_EXIT.usage, stdout: '', stderr: `openmorals diff-class: ${pr.error}; nothing was done\nUsage:\n${DIFF_CLASS_USAGE}\n` };
  const p = pr.p;
  const diffBytes = readBytes(p.diff, ctx.readStdin);
  if (!diffBytes.ok) return unreadable(diffBytes.error, null, p.json);
  const diff = decodeDiff(diffBytes.bytes);
  if (!diff.ok) return unreadable(diff.error, null, p.json);
  let reproduced: string | null = null;
  if (p.reproduced !== undefined) {
    const rb = readBytes(p.reproduced, ctx.readStdin);
    if (!rb.ok) return unreadable(`the reproduced diff: ${rb.error}`, null, p.json);
    const rd = decodeDiff(rb.bytes);
    if (!rd.ok) return unreadable(`the reproduced diff: ${rd.error}`, null, p.json);
    reproduced = rd.text;
  }
  let record: RecordFacts | null = null;
  if (p.summary !== undefined) {
    const sb = readBytes(p.summary, ctx.readStdin);
    if (!sb.ok) return unreadable(`the run summary: ${sb.error}`, null, p.json);
    const ps = parseSummary(new TextDecoder().decode(sb.bytes));
    if (!ps.ok) return unreadable(ps.error, null, p.json);
    record = ps.facts;
  } else if (p.run !== undefined) {
    const file = p.audit !== undefined ? resolve(ctx.cwd, p.audit) : auditLogPath(configDir(ctx.env));
    record = factsOf(summarizeRun(file, p.run));
  }
  const baseDir = resolve(ctx.cwd, p.base ?? '.');
  const load = resolveBylaws(baseDir, ctx.env);
  const notes: string[] = [];
  if (load.ok) {
    for (const l of load.ignored ?? []) if (l.field.startsWith('merge.')) notes.push(`${load.source} tried to set ${l.field} to ${l.candidate}; only the user-level file can switch a class on, so it was ignored`);
  }
  const r = classifyDiff({
    diff: diff.text,
    merge: load.ok ? load.bylaws.merge : undefined,
    settingsProblem: load.ok ? null : `${load.source}: ${load.error}`,
    notes,
    base: folderReader(baseDir),
    reproduced,
    record,
    declaredRun: p.run ?? (record !== null ? record.run : null),
  });
  if (!r.ok) return unreadable(r.error, r.line, p.json);
  return { exitCode: r.verdict.exitCode, stdout: p.json ? formatVerdictJson(r.verdict) : formatVerdictText(r.verdict), stderr: '' };
}
