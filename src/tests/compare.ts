import type { TestReport, TestStatus } from './report.js';

/** What a test that passed before has become. Each is a loss the person approves by name, or the comparison exits 1. */
export const LOSS_KINDS = ['fails', 'gone', 'skipped'] as const;
export type LossKind = (typeof LOSS_KINDS)[number];

export function isLossKind(s: string): s is LossKind {
  return (LOSS_KINDS as readonly string[]).includes(s);
}

/** One approval line: this test may have this loss in this comparison. */
export interface Approval {
  kind: LossKind;
  id: string;
  line: number;
}

export interface Gain {
  id: string;
  /** What it was before it passed: failing, skipped, or not in the before report at all (a new test). */
  was: 'failing' | 'skipped' | 'new';
  flaky: boolean;
  /** Present (true) when the test is on hold in the held-tests file (0.32.0): it never counts as a gain or as proof. */
  held?: true;
}

export interface Loss {
  id: string;
  kind: LossKind;
  flaky: boolean;
  /** The approval line that covers it, or null when it is not approved and so blocks. */
  approvedBy: number | null;
  /** Present (true) when the test is on hold in the held-tests file (0.32.0): the loss is listed and does not block. */
  held?: true;
}

export interface RenameGroup {
  file: string;
  gone: string[];
  added: string[];
}

export interface Totals {
  tests: number;
  pass: number;
  fail: number;
  skip: number;
}

export interface Comparison {
  /** Failed, skipped or absent in every before run, and passing in every after run. */
  failToPass: Gain[];
  /** Passed in a before run and failing in an after run. */
  passToFail: Loss[];
  /** Passed in a before run and missing from an after run. */
  gone: Loss[];
  /** Passed in a before run and skipped in an after run (and not failing or missing there). */
  newlySkipped: Loss[];
  /** Tests that disappeared and tests that appeared in the same file: possibly one renamed test each. */
  likelyRenames: RenameGroup[];
  /** Tests whose outcome differs between the runs of one side (only seen when repeats are given). */
  flaky: string[];
  /** Failing (in every before run where present) and now missing: not a loss, but a failing test that went away. */
  failingGone: string[];
  /** Losses no approval line covers and no hold covers; the exit code is 1 exactly when this is above 0. */
  blocking: number;
  /** Approval lines that matched no loss in this comparison. */
  unusedApprovals: Approval[];
  /** Counts from the first report of each side. Printed only; they never decide the exit code. */
  totals: { before: Totals; after: Totals };
}

type Seen = Set<TestStatus | 'absent'>;

function statusesBy(runs: readonly TestReport[]): { ids: Set<string>; files: Map<string, string | null>; of: (id: string) => Seen } {
  const maps = runs.map((r) => new Map(r.tests.map((t) => [t.id, t.status] as const)));
  const ids = new Set<string>();
  const files = new Map<string, string | null>();
  for (const r of runs) for (const t of r.tests) {
    ids.add(t.id);
    if (!files.has(t.id)) files.set(t.id, t.file);
  }
  const of = (id: string): Seen => {
    const s: Seen = new Set();
    for (const m of maps) s.add(m.get(id) ?? 'absent');
    return s;
  };
  return { ids, files, of };
}

function totalsOf(r: TestReport | undefined): Totals {
  const t: Totals = { tests: 0, pass: 0, fail: 0, skip: 0 };
  for (const x of r?.tests ?? []) {
    t.tests++;
    t[x.status]++;
  }
  return t;
}

/**
 * Compares the test reports of the code before and after a change, by test id. Pure: reads no file, runs nothing.
 * Each side may hold several reports of the same code (repeats); then a test whose outcome differs between them is
 * flaky, and a loss on any run counts (a flaky loss still blocks until it is approved).
 */
export function compareTests(before: readonly TestReport[], after: readonly TestReport[], approvals: readonly Approval[] = [], held: ReadonlySet<string> = new Set()): Comparison {
  if (before.length === 0 || after.length === 0) throw new RangeError('compareTests needs at least one report on each side');
  const b = statusesBy(before);
  const a = statusesBy(after);
  const all = [...new Set([...b.ids, ...a.ids])].sort();
  const failToPass: Gain[] = [];
  const losses: Loss[] = [];
  const flaky: string[] = [];
  const failingGone: string[] = [];
  const goneIds: string[] = [];
  const addedIds: string[] = [];
  const used = new Set<number>();
  const approvalFor = (kind: LossKind, id: string): number | null => {
    const hit = approvals.find((p) => p.kind === kind && p.id === id);
    if (hit === undefined) return null;
    used.add(hit.line);
    return hit.line;
  };
  for (const id of all) {
    const sb = b.of(id);
    const sa = a.of(id);
    const isFlaky = sb.size > 1 || sa.size > 1;
    if (isFlaky) flaky.push(id);
    const passedBefore = sb.has('pass');
    if (passedBefore) {
      const kind: LossKind | null = sa.has('fail') ? 'fails' : sa.has('absent') ? 'gone' : sa.has('skip') ? 'skipped' : null;
      if (kind !== null) losses.push({ id, kind, flaky: isFlaky, approvedBy: approvalFor(kind, id), ...(held.has(id) ? { held: true as const } : {}) });
      if (kind === 'gone' && sa.size === 1) goneIds.push(id);
      continue;
    }
    if (sb.size === 1 && sb.has('absent')) addedIds.push(id);
    if (sa.size === 1 && sa.has('pass')) failToPass.push({ id, was: sb.has('fail') ? 'failing' : sb.has('skip') ? 'skipped' : 'new', flaky: isFlaky, ...(held.has(id) ? { held: true as const } : {}) });
    else if (sb.has('fail') && sa.size === 1 && sa.has('absent')) failingGone.push(id);
  }
  const fileOf = (id: string): string | null => a.files.get(id) ?? b.files.get(id) ?? null;
  const groups = new Map<string, RenameGroup>();
  for (const [ids, key] of [[goneIds, 'gone'], [addedIds, 'added']] as const) {
    for (const id of ids) {
      const f = fileOf(id);
      if (f === null) continue;
      const g = groups.get(f) ?? { file: f, gone: [], added: [] };
      g[key].push(id);
      groups.set(f, g);
    }
  }
  const likelyRenames = [...groups.values()].filter((g) => g.gone.length > 0 && g.added.length > 0).sort((x, y) => x.file.localeCompare(y.file));
  const pick = (k: LossKind): Loss[] => losses.filter((l) => l.kind === k);
  return {
    failToPass,
    passToFail: pick('fails'),
    gone: pick('gone'),
    newlySkipped: pick('skipped'),
    likelyRenames,
    flaky,
    failingGone,
    blocking: losses.filter((l) => l.approvedBy === null && l.held !== true).length,
    unusedApprovals: approvals.filter((p) => !used.has(p.line)),
    totals: { before: totalsOf(before[0]), after: totalsOf(after[0]) },
  };
}

/** Reads an approval file: one `<fails|gone|skipped> <test id>` per line; blank lines and lines starting with # are skipped. */
export function parseApprovals(text: string): { ok: true; approvals: Approval[] } | { ok: false; error: string } {
  const approvals: Approval[] = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const sp = line.search(/\s/);
    const kind = sp === -1 ? line : line.slice(0, sp);
    const id = sp === -1 ? '' : line.slice(sp).trim();
    if (!isLossKind(kind) || id === '') return { ok: false, error: `line ${i + 1} is not "<${LOSS_KINDS.join('|')}> <test id>": ${JSON.stringify(line.slice(0, 120))}` };
    approvals.push({ kind, id, line: i + 1 });
  }
  return { ok: true, approvals };
}
