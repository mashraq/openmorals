import type { MergeBylaws, MergeClass } from '../types.js';
import type { BaseReader } from './apply.js';
import { compileGlob } from './glob.js';
import type { FileDiff } from './parse.js';
import { parseDiff } from './parse.js';
import type { RecordFacts } from './record.js';
import { recordReasons } from './record.js';
import type { Exclusion } from './rules.js';
import { CANNOT_SEE, CANNOT_SEE_REPRODUCED, EXCLUSIONS, exclusionsFor, isRootBylaws } from './rules.js';
import { checkBylaws, checkCaseRows, isCaseFile } from './tighten.js';
import type { DiffVerdict, FileVerdict, Reason, ReasonSource } from './types.js';

/**
 * Extra reason sources over the whole diff, run on every diff. Empty today; the test-integrity reasons go here. A source
 * can only add reasons, and a reason only ever makes a change need review.
 */
export const REASON_SOURCES: readonly ReasonSource[] = [];

export interface ClassifyInput {
  /** The diff text, as `git diff` wrote it. */
  diff: string;
  /** The merge settings in force (user-level floor, narrowed by the base branch's project file); undefined switches nothing on. */
  merge: MergeBylaws | undefined;
  /** Why the settings could not be read, or null. When set, nothing is review-free. */
  settingsProblem?: string | null;
  /** Notes about the settings, printed with the verdict. */
  notes?: readonly string[];
  /** The base tree, for rebuilding the files a tighten-only check needs. */
  base: BaseReader;
  /** The diff a pinned tool produced on the base tree, or null when none was given. */
  reproduced?: string | null;
  /** What the run's record says, or null when no run was named. */
  record?: RecordFacts | null;
  /** The run id named on the command line, or null. */
  declaredRun?: string | null;
  /** Replaces the built-in exclusion list (the removal test uses it). */
  exclusions?: readonly Exclusion[];
  /** Replaces `REASON_SOURCES`. */
  reasonSources?: readonly ReasonSource[];
}

export type ClassifyResult = { ok: true; verdict: DiffVerdict } | { ok: false; error: string; line: number | null };

const ORDER = ['settings.', 'class.off', 'record.', 'doubt.', 'exclude.', 'tighten.', 'reproduced.', 'class.none'];

function rank(rule: string): number {
  const i = ORDER.findIndex((p) => rule.startsWith(p));
  return i === -1 ? ORDER.length : i;
}

function firstDifference(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a.charCodeAt(i) !== b.charCodeAt(i)) return i;
  return n;
}

/** Facts that keep a file out of every review-free class: parse doubts, exclusions, always-review paths. */
function hardReasons(f: FileDiff, merge: MergeBylaws | undefined, exclusions: readonly Exclusion[]): Reason[] {
  const out: Reason[] = f.doubts.map((d) => ({ rule: d.id, path: f.path, text: d.text }));
  const paths = [...new Set([f.oldPath, f.newPath].filter((p): p is string => p !== null))];
  const seen = new Set<string>();
  for (const p of paths) {
    for (const h of exclusionsFor(p, exclusions)) {
      const key = `${h.id}\0${p}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ rule: h.id, path: p, text: `${h.what}: ${p}` });
    }
    for (const g of merge?.always_review ?? []) {
      if (compileGlob(g)(p)) out.push({ rule: 'exclude.always-review', path: p, text: `a path your settings always send to review (${g}): ${p}` });
    }
  }
  return out;
}

/** Classifies a diff. Pure apart from reading base files through `base`; calls no model and runs nothing. */
export function classifyDiff(input: ClassifyInput): ClassifyResult {
  const parsed = parseDiff(input.diff);
  if (!parsed.ok) return parsed;
  const exclusions = input.exclusions ?? EXCLUSIONS;
  const merge = input.settingsProblem === null || input.settingsProblem === undefined ? input.merge : undefined;
  const switchedOn: MergeClass[] = [...(merge?.review_free ?? [])];
  const files: FileVerdict[] = [];
  const hardAll: Reason[] = [];
  const tightenAll: Reason[] = [];
  let tightenOk = parsed.files.length > 0;
  for (const f of parsed.files) {
    const hard = hardReasons(f, merge, exclusions);
    hardAll.push(...hard);
    let fileReasons: Reason[] = [...hard];
    let note: string | null = null;
    let tightened = false;
    if (hard.length === 0) {
      if (isCaseFile(f.path)) {
        const c = checkCaseRows(f, input.base);
        if (c.ok) {
          tightened = true;
          note = `${c.rows} added row${c.rows === 1 ? '' : 's'}, each expecting ask or deny`;
        } else fileReasons = c.reasons;
      } else if (isRootBylaws(f.path)) {
        const c = checkBylaws(f, input.base);
        if (c.ok) {
          tightened = true;
          note = 'tightens the bylaws only';
        } else fileReasons = c.reasons;
      } else fileReasons = [{ rule: 'class.none', path: f.path, text: `not an added ask or deny case row, nor a tighten-only bylaws change: ${f.path}` }];
    }
    if (!tightened) {
      tightenOk = false;
      if (hard.length === 0) tightenAll.push(...fileReasons);
    }
    files.push({ path: f.path, oldPath: f.oldPath !== f.newPath ? f.oldPath : null, status: f.status, class: tightened ? 'tighten-only' : 'review', note, reasons: fileReasons });
  }
  const reproducedGiven = input.reproduced !== null && input.reproduced !== undefined;
  const reproducedEqual = reproducedGiven && input.reproduced === input.diff;
  const reproducedOk = reproducedEqual && hardAll.length === 0 && parsed.files.length > 0;
  if (reproducedOk && !tightenOk) {
    for (const fv of files) {
      fv.class = 'reproduced';
      fv.note = 'equal to the reproduced diff';
      fv.reasons = [];
    }
  }
  const record = input.record !== null && input.record !== undefined ? recordReasons(input.record, input.declaredRun ?? null) : [];
  if ((input.declaredRun ?? null) !== null && (input.record === null || input.record === undefined)) record.push({ rule: 'record.missing', path: null, text: `run ${input.declaredRun ?? ''} was declared and no record was read` });
  const extra = (input.reasonSources ?? REASON_SOURCES).flatMap((s) => [...s(parsed.files)]);
  const met: MergeClass[] = [...(tightenOk ? (['tighten-only'] as const) : []), ...(reproducedOk ? (['reproduced'] as const) : [])];
  const qualifiesDiff: MergeClass | null = met[0] ?? null;
  const clean = record.length === 0 && extra.length === 0;
  const qualifies = clean ? qualifiesDiff : null;
  const basis = clean ? (met.find((c) => switchedOn.includes(c)) ?? null) : null;
  const reasons: Reason[] = [];
  if (basis === null) {
    if (input.settingsProblem !== null && input.settingsProblem !== undefined) reasons.push({ rule: 'settings.unreadable', path: null, text: `the merge settings could not be read, so nothing is review-free: ${input.settingsProblem}` });
    if (qualifies !== null) reasons.push({ rule: 'class.off', path: null, text: `it meets ${qualifies}, which is not switched on (merge.review_free in the user-level file); by default every change needs review` });
    reasons.push(...record, ...hardAll);
    if (!reproducedOk) reasons.push(...tightenAll);
    if (reproducedGiven && !reproducedEqual && qualifiesDiff === null) reasons.push({ rule: 'reproduced.differs', path: null, text: `it differs from the reproduced diff (first difference at character ${firstDifference(input.diff, input.reproduced ?? '')})` });
    reasons.push(...extra);
    if (qualifies === null && reasons.length === 0) reasons.push({ rule: 'class.none', path: null, text: 'it meets no review-free class' });
  }
  const sorted = reasons.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r.rule) - rank(b.r.rule) || a.i - b.i).map((x) => x.r);
  const cannotSee = [...CANNOT_SEE, ...(reproducedGiven ? [CANNOT_SEE_REPRODUCED] : [])];
  const verdict: DiffVerdict = {
    verdict: basis !== null ? 'review-free' : 'review',
    class: basis !== null ? 'A' : 'B',
    basis,
    qualifies,
    exitCode: basis !== null ? 0 : 1,
    reasons: sorted,
    files,
    switchedOn,
    notes: [...(input.notes ?? [])],
    cannotSee,
  };
  return { ok: true, verdict };
}

const MAX_TEXT_LINES = 3;
const MAX_PATHS_PER_LINE = 3;

/** The reasons as at most three lines: one per rule, naming up to three paths. */
export function reasonLines(reasons: readonly Reason[]): { lines: string[]; more: number } {
  const groups = new Map<string, Reason[]>();
  for (const r of reasons) {
    const g = groups.get(r.rule) ?? [];
    g.push(r);
    groups.set(r.rule, g);
  }
  const all: string[] = [];
  const lead = (r: Reason): string | null => (r.path !== null && r.text.endsWith(`: ${r.path}`) ? r.text.slice(0, -(r.path.length + 2)) : null);
  for (const [, g] of groups) {
    const first = g[0];
    if (first === undefined) continue;
    const leads = new Set(g.map(lead));
    const prefix = lead(first);
    if (g.length > 1 && leads.size === 1 && prefix !== null) {
      const named = g.slice(0, MAX_PATHS_PER_LINE).map((r) => r.path ?? '');
      const rest = g.length - named.length;
      all.push(`${prefix}: ${named.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`);
    } else all.push(g.length === 1 ? first.text : `${first.text} (+${g.length - 1} more like it)`);
  }
  return { lines: all.slice(0, MAX_TEXT_LINES), more: Math.max(0, all.length - MAX_TEXT_LINES) };
}

export function formatVerdictText(v: DiffVerdict): string {
  const out: string[] = [];
  const nFiles = `${v.files.length} file${v.files.length === 1 ? '' : 's'}`;
  if (v.basis !== null) {
    out.push(`openmorals diff-class: REVIEW-FREE (class A, ${v.basis}), ${nFiles}`);
    for (const f of v.files) out.push(`  ${f.path}: ${f.note ?? ''}`);
  } else {
    const rl = reasonLines(v.reasons);
    out.push(`openmorals diff-class: REVIEW (class B), ${nFiles}${rl.more > 0 ? `; ${rl.more} more fact${rl.more === 1 ? '' : 's'} in --json` : ''}`);
    for (const l of rl.lines) out.push(`  - ${l}`);
  }
  for (const n of v.notes) out.push(`  note: ${n}`);
  if (v.basis !== null) {
    out.push('It cannot see:');
    for (const c of v.cannotSee) out.push(`  - ${c}`);
    out.push('So this exit 0 means only that the diff falls in a class you switched on. See docs/merge-verdict.md.');
  } else out.push(`It cannot see how it was run (${v.cannotSee.length} preconditions in --json and docs/merge-verdict.md).`);
  return `${out.join('\n')}\n`;
}

export function formatVerdictJson(v: DiffVerdict): string {
  return `${JSON.stringify(v)}\n`;
}
