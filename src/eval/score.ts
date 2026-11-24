import { validateBylaws } from '../bylaws.js';
import { BUILTIN_GUARDS, decide } from '../engine.js';
import type { Guard } from '../guard.js';
import { scanInbound } from '../inbound/scan.js';
import type { BylawsLoad, Decision } from '../types.js';
import { decisionRank } from '../types.js';
import type { Case, EvalCases, InboundExpect } from './cases.js';

/** Timed repetitions of every row after one untimed warm-up pass; each repetition is one sample. */
export const EVAL_REPETITIONS = 25;

/**
 * Why a row is wrong. `missed`: expected ask or deny (or an inbound finding) and got less. `false-alarm`: expected allow
 * (or no inbound finding) and got more. `stricter`: expected ask (or a weak finding) and got deny (or a strong one).
 * `rule`: the decision matched but another rule decided it.
 */
export type WrongKind = 'missed' | 'false-alarm' | 'stricter' | 'rule';

export interface WrongRow {
  guard: string;
  file: string;
  /** 0-based position in the file's `cases` list. */
  index: number;
  line: number | null;
  label: string;
  kind: WrongKind;
  expect: string;
  got: string;
  expectedRule: string | null;
  gotRule: string;
}

export interface Score {
  rows: number;
  /** Rows expecting ask or deny (inbound: a weak or strong finding). */
  blocking: number;
  /** Of those, rows that got at least the expected decision. */
  caught: number;
  /** caught / blocking, or null when there are no blocking rows. */
  catchRate: number | null;
  /** Rows expecting allow (inbound: no finding). */
  allowing: number;
  /** Of those, rows that got ask or deny (inbound: any finding). */
  falseAlarms: number;
  falseAlarmRate: number | null;
  /** Rows whose decision matched but whose rule did not. */
  ruleMismatches: number;
  /** Rows wrong for any reason (they are listed in `wrong`). */
  wrong: number;
  /** Time per decision in milliseconds, over rows x repetitions samples; null when timing was off or there are no rows. */
  p50Ms: number | null;
  p95Ms: number | null;
}

export interface GuardScore extends Score {
  guard: string;
  files: string[];
}

export interface EvalReport {
  source: string;
  bylaws: string;
  repetitions: number;
  ok: boolean;
  total: Score;
  guards: GuardScore[];
  wrong: WrongRow[];
}

export interface ScoreOptions {
  /** The guards to judge with (default: the built-in ones). A test passes a set that allows everything to prove the score drops. */
  guards?: readonly Guard[];
  /** The bylaws for rows that carry none (default: the built-in defaults). Must be valid. */
  bylaws?: BylawsLoad;
  /** Only score rows of this guard (`inbound` for the inbound table). */
  guard?: string;
  /** Timed repetitions per row; 0 times nothing. */
  repetitions?: number;
}

export type ScoreResult = { ok: true; value: EvalReport } | { ok: false; error: string };

interface Tally {
  guard: string;
  files: Set<string>;
  rows: number;
  blocking: number;
  caught: number;
  allowing: number;
  falseAlarms: number;
  ruleMismatches: number;
  wrong: number;
  samples: number[];
}

function newTally(guard: string): Tally {
  return { guard, files: new Set(), rows: 0, blocking: 0, caught: 0, allowing: 0, falseAlarms: 0, ruleMismatches: 0, wrong: 0, samples: [] };
}

function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return round(sorted[i] ?? 0, 4);
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function finish(t: Tally): Score {
  const sorted = [...t.samples].sort((a, b) => a - b);
  return {
    rows: t.rows,
    blocking: t.blocking,
    caught: t.caught,
    catchRate: t.blocking === 0 ? null : round(t.caught / t.blocking, 4),
    allowing: t.allowing,
    falseAlarms: t.falseAlarms,
    falseAlarmRate: t.allowing === 0 ? null : round(t.falseAlarms / t.allowing, 4),
    ruleMismatches: t.ruleMismatches,
    wrong: t.wrong,
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
  };
}

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

/** The expected rule check of the case tests: a named rule must decide the row; otherwise a non-allow row must be decided by its own guard. */
function ruleOk(c: Case, guard: string, gotRule: string): boolean {
  if (c.rule !== null) return gotRule === c.rule;
  if (c.expect !== 'allow' && !c.ruleAny) return gotRule.startsWith(`${guard}.`);
  return true;
}

const INBOUND_RANK: Readonly<Record<InboundExpect, number>> = { none: 0, weak: 1, strong: 2 };

function label(s: string): string {
  return s.length > 200 ? `${s.slice(0, 197)}...` : s;
}

/**
 * Runs every guard row through `decide()` and every inbound row through `scanInbound()`, the way the case tests do,
 * and scores them. Calls no model and writes nothing. An invalid bylaws block in a row is unreadable input.
 */
export function scoreCases(cases: EvalCases, opts: ScoreOptions = {}): ScoreResult {
  const guards = opts.guards ?? BUILTIN_GUARDS;
  const reps = opts.repetitions ?? EVAL_REPETITIONS;
  if (!Number.isInteger(reps) || reps < 0) return { ok: false, error: 'repetitions must be a whole number' };
  const base: BylawsLoad = opts.bylaws ?? validateBylaws(null, '<defaults>');
  if (!base.ok) return { ok: false, error: `the bylaws ${base.source} are invalid: ${base.error}` };
  const files = opts.guard === undefined ? cases.guardFiles : cases.guardFiles.filter((f) => f.guard === opts.guard);
  const inbound = opts.guard === undefined || opts.guard === 'inbound' ? cases.inbound : [];
  const rowCount = files.reduce((n, f) => n + f.cases.length, 0) + inbound.reduce((n, f) => n + f.cases.length, 0);
  if (rowCount === 0) {
    const known = [...new Set([...cases.guardFiles.map((f) => f.guard), ...(cases.inbound.length > 0 ? ['inbound'] : [])])].sort();
    return { ok: false, error: opts.guard !== undefined ? `no rows for guard ${opts.guard} in ${cases.source} (it has: ${known.join(', ') || 'none'})` : `no rows in ${cases.source}` };
  }

  const tallies = new Map<string, Tally>();
  const tally = (g: string): Tally => {
    let t = tallies.get(g);
    if (t === undefined) {
      t = newTally(g);
      tallies.set(g, t);
    }
    return t;
  };
  const wrong: WrongRow[] = [];
  const jobs: { t: Tally; run: () => void }[] = [];

  for (const f of files) {
    for (let i = 0; i < f.cases.length; i++) {
      const c = f.cases[i] as Case;
      const load = c.bylaws === null ? base : validateBylaws(c.bylaws, `${f.file}[${i}]`);
      if (!load.ok) return { ok: false, error: `${f.file}[${i}] has invalid bylaws: ${load.error}` };
      const t = tally(f.guard);
      t.files.add(f.file);
      t.rows++;
      const run = (): Decision => decide(c.action, load, c.state, guards, c.where).decision;
      const v = decide(c.action, load, c.state, guards, c.where);
      const want = decisionRank(c.expect);
      const got = decisionRank(v.decision);
      let kind: WrongKind | null = null;
      if (c.expect === 'allow') {
        t.allowing++;
        if (got > want) {
          t.falseAlarms++;
          kind = 'false-alarm';
        }
      } else {
        t.blocking++;
        if (got >= want) t.caught++;
        if (got < want) kind = 'missed';
        else if (got > want) kind = 'stricter';
      }
      if (kind === null && !ruleOk(c, f.guard, v.rule)) {
        t.ruleMismatches++;
        kind = 'rule';
      }
      if (kind !== null) {
        t.wrong++;
        wrong.push({ guard: f.guard, file: f.file, index: i, line: c.line, label: label(c.label), kind, expect: c.expect, got: v.decision, expectedRule: c.rule, gotRule: v.rule });
      }
      jobs.push({ t, run });
    }
  }

  for (const f of inbound) {
    for (let i = 0; i < f.cases.length; i++) {
      const c = f.cases[i];
      if (c === undefined) continue;
      const t = tally('inbound');
      t.files.add(f.file);
      t.rows++;
      const scan = scanInbound(c.text);
      const got: InboundExpect = scan.strong ? 'strong' : scan.findings.length > 0 ? 'weak' : 'none';
      const gotRule = scan.findings.map((x) => x.rule).join(',') || 'none';
      let kind: WrongKind | null = null;
      if (c.expect === 'none') {
        t.allowing++;
        if (got !== 'none') {
          t.falseAlarms++;
          kind = 'false-alarm';
        }
      } else {
        t.blocking++;
        if (INBOUND_RANK[got] >= INBOUND_RANK[c.expect]) t.caught++;
        if (INBOUND_RANK[got] < INBOUND_RANK[c.expect]) kind = 'missed';
        else if (INBOUND_RANK[got] > INBOUND_RANK[c.expect]) kind = 'stricter';
        else if (c.rule !== null && !scan.findings.some((x) => x.rule === c.rule)) {
          t.ruleMismatches++;
          kind = 'rule';
        }
      }
      if (kind !== null) {
        t.wrong++;
        wrong.push({ guard: 'inbound', file: f.file, index: i, line: c.line, label: label(c.name), kind, expect: c.expect, got, expectedRule: c.rule, gotRule });
      }
      const text = c.text;
      jobs.push({ t, run: () => scanInbound(text) });
    }
  }

  for (let r = 0; r < reps; r++) {
    for (const j of jobs) {
      const t0 = nowMs();
      j.run();
      j.t.samples.push(nowMs() - t0);
    }
  }

  const all = newTally('total');
  const guardScores: GuardScore[] = [];
  for (const t of [...tallies.values()].sort((a, b) => a.guard.localeCompare(b.guard))) {
    guardScores.push({ guard: t.guard, files: [...t.files].sort(), ...finish(t) });
    all.rows += t.rows;
    all.blocking += t.blocking;
    all.caught += t.caught;
    all.allowing += t.allowing;
    all.falseAlarms += t.falseAlarms;
    all.ruleMismatches += t.ruleMismatches;
    all.wrong += t.wrong;
    for (const s of t.samples) all.samples.push(s);
  }
  return {
    ok: true,
    value: { source: cases.source, bylaws: base.source, repetitions: reps, ok: wrong.length === 0, total: finish(all), guards: guardScores, wrong },
  };
}
