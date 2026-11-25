import { ID_SEPARATOR } from './report.js';
import type { FailureInfo, TestReport, TestResult, TestStatus } from './report.js';

/**
 * What one test did on the base: the base commit's source with the change's test files on top.
 * `fails-assertion`: an expectation did not hold (red for the right reason).
 * `fails-error` and `load-error`: red for the wrong reason (a missing function, module or file; a file that did not load).
 * `fails-unknown`: red, and the report does not say why (cannot tell).
 */
export type BaseOutcome = 'fails-assertion' | 'fails-error' | 'load-error' | 'fails-unknown' | 'passes' | 'skipped' | 'absent';

export type HeadOutcome = TestStatus | 'absent';

export interface FailFirstRow {
  id: string;
  file: string | null;
  /** Absent from the run of the base commit as it was, so the change added it (or renamed it). */
  isNew: boolean;
  /** The acceptance name the person gave that matched this test, or null. */
  named: string | null;
  base: BaseOutcome;
  /** The failure evidence on base, when it failed. */
  baseWhy: string | null;
  head: HeadOutcome;
}

/** A named acceptance test that did not do what an acceptance test must: fail on base and pass at head. */
export interface FailFirstProblem {
  named: string;
  id: string | null;
  why: 'not-found' | 'ambiguous' | 'passes-on-base' | 'skipped-on-base' | 'did-not-run-on-base' | 'not-passing-at-head' | 'held';
  text: string;
}

export interface FailFirstJudgement {
  rows: FailFirstRow[];
  /** Named tests that block (each makes the exit code 1). */
  problems: FailFirstProblem[];
  /** Named tests red for the wrong reason or red with no reason shown: reported, never a block. */
  namedRedWrongReason: FailFirstRow[];
  namedRedCannotTell: FailFirstRow[];
  /** New tests the person did not name that pass on base: pointer lines, never a failure. */
  newPassingOnBase: FailFirstRow[];
  newRedByAssertion: FailFirstRow[];
  newRedWrongReason: FailFirstRow[];
  newRedCannotTell: FailFirstRow[];
  newSkippedOrAbsentOnBase: FailFirstRow[];
  /** New tests the person did not name that do not pass at head: shown, never a failure (`tests compare` judges head). */
  newNotPassingAtHead: FailFirstRow[];
  exitCode: 0 | 1;
}

export interface FailFirstInput {
  /** The base commit as it was, run with the same command (null when it was not run: no test file of the change existed there). */
  before: TestReport | null;
  /** The base commit with the change's added and changed test files on top. */
  base: TestReport;
  head: TestReport;
  /** Acceptance tests the person named (`--expect-red`; later a work order): full ids, or a unique tail after " > ". */
  acceptance: readonly string[];
  /** Tests on hold as flaky (0.32.0): a held acceptance test cannot be the proof, so it blocks. */
  held?: ReadonlySet<string>;
}

function byId(r: TestReport): Map<string, TestResult> {
  return new Map(r.tests.filter((t) => t.failure?.load !== true).map((t) => [t.id, t]));
}

/** Files that did not load in a report: whole-file entries and the report's own load errors. */
function loadFailures(r: TestReport): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of r.tests) if (t.failure?.load === true && t.file !== null) out.set(t.file, t.failure.why);
  for (const e of r.loadErrors ?? []) if (e.file !== null) out.set(e.file, e.why);
  return out;
}

function baseOutcome(t: TestResult | undefined, file: string | null, loads: ReadonlyMap<string, string>): { outcome: BaseOutcome; why: string | null } {
  if (t === undefined) {
    const w = file !== null ? loads.get(file) : undefined;
    return w !== undefined ? { outcome: 'load-error', why: w } : { outcome: 'absent', why: null };
  }
  if (t.status === 'pass') return { outcome: 'passes', why: null };
  if (t.status === 'skip') return { outcome: 'skipped', why: null };
  const f: FailureInfo = t.failure ?? { kind: 'unknown', why: 'the report gives no reason', load: false };
  return { outcome: f.kind === 'assertion' ? 'fails-assertion' : f.kind === 'error' ? 'fails-error' : 'fails-unknown', why: f.why };
}

/** Matches a name to ids: the exact id, else the single id that ends with " > <name>". */
export function matchName(name: string, ids: readonly string[]): { id: string } | { none: true } | { many: string[] } {
  if (ids.includes(name)) return { id: name };
  const tail = ids.filter((id) => id.endsWith(`${ID_SEPARATOR}${name}`));
  if (tail.length === 1 && tail[0] !== undefined) return { id: tail[0] };
  return tail.length === 0 ? { none: true } : { many: tail };
}

/**
 * Pure. Reads three reports and says, per test, whether it fails on base and why. Only a named acceptance test can make
 * the result 1: when it is not found, passes or is skipped on base, did not run there for no shown reason, or does not
 * pass at head. A named test that is red for the wrong reason, or red with no reason shown, is reported and does not
 * block. Every other new test that passes on base is a pointer line: refactor and characterisation tests pass on base
 * by design.
 */
export function judgeFailFirst(input: FailFirstInput): FailFirstJudgement {
  const before = input.before !== null ? byId(input.before) : new Map<string, TestResult>();
  const base = byId(input.base);
  const head = byId(input.head);
  const loads = loadFailures(input.base);
  const universe = [...new Set([...head.keys(), ...base.keys()])];
  const named = new Map<string, string>();
  const problems: FailFirstProblem[] = [];
  for (const n of input.acceptance) {
    const m = matchName(n, universe);
    if ('id' in m) named.set(m.id, n);
    else if ('many' in m) problems.push({ named: n, id: null, why: 'ambiguous', text: `matches ${m.many.length} tests; give the full name (${m.many.slice(0, 3).join('; ')})` });
    else problems.push({ named: n, id: null, why: 'not-found', text: 'is in neither the base run nor the head run, so it was not shown to fail on base' });
  }
  const rows: FailFirstRow[] = [];
  for (const id of universe) {
    const h = head.get(id);
    const b = base.get(id);
    const isNew = !before.has(id);
    const n = named.get(id) ?? null;
    if (!isNew && n === null) continue;
    if (h === undefined && n === null) continue;
    const file = h?.file ?? b?.file ?? null;
    const bo = baseOutcome(b, file, loads);
    rows.push({ id, file, isNew, named: n, base: bo.outcome, baseWhy: bo.why, head: h?.status ?? 'absent' });
  }
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const isRed = (o: BaseOutcome): boolean => o === 'fails-assertion' || o === 'fails-error' || o === 'load-error' || o === 'fails-unknown';
  for (const r of rows) {
    if (r.named === null) continue;
    if (r.base === 'passes') problems.push({ named: r.named, id: r.id, why: 'passes-on-base', text: 'passes on base, so it does not show the change is needed' });
    else if (r.base === 'skipped') problems.push({ named: r.named, id: r.id, why: 'skipped-on-base', text: 'is skipped on base, so it was not shown to fail there' });
    else if (r.base === 'absent') problems.push({ named: r.named, id: r.id, why: 'did-not-run-on-base', text: 'did not run on base and no load error explains it, so it was not shown to fail there' });
    if (input.held?.has(r.id) === true) problems.push({ named: r.named, id: r.id, why: 'held', text: 'is on hold as flaky, so its result cannot show the change is needed; name a test that is not on hold' });
    if (isRed(r.base) && r.head !== 'pass') problems.push({ named: r.named, id: r.id, why: 'not-passing-at-head', text: r.head === 'absent' ? 'is not in the head run' : r.head === 'skip' ? 'is skipped at head' : 'fails at head' });
  }
  const unnamed = rows.filter((r) => r.named === null && r.isNew);
  const namedRows = rows.filter((r) => r.named !== null);
  return {
    rows,
    problems,
    namedRedWrongReason: namedRows.filter((r) => r.base === 'fails-error' || r.base === 'load-error'),
    namedRedCannotTell: namedRows.filter((r) => r.base === 'fails-unknown'),
    newPassingOnBase: unnamed.filter((r) => r.base === 'passes'),
    newRedByAssertion: unnamed.filter((r) => r.base === 'fails-assertion'),
    newRedWrongReason: unnamed.filter((r) => r.base === 'fails-error' || r.base === 'load-error'),
    newRedCannotTell: unnamed.filter((r) => r.base === 'fails-unknown'),
    newSkippedOrAbsentOnBase: unnamed.filter((r) => r.base === 'skipped' || r.base === 'absent'),
    newNotPassingAtHead: unnamed.filter((r) => r.head !== 'pass'),
    exitCode: problems.length > 0 ? 1 : 0,
  };
}
