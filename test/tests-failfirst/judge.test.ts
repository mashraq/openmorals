import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { judgeFailFirst, matchName } from '../../src/tests/failfirst.js';
import type { FailureInfo, TestReport, TestResult } from '../../src/tests/report.js';

const A: FailureInfo = { kind: 'assertion', why: 'AssertionError', load: false };
const E: FailureInfo = { kind: 'error', why: 'TypeError', load: false };
const U: FailureInfo = { kind: 'unknown', why: 'names no assertion and no known error', load: false };

function t(id: string, status: TestResult['status'], failure?: FailureInfo): TestResult {
  const file = id.split(' > ')[0] ?? null;
  return { id, file, status, ...(failure !== undefined ? { failure } : {}) };
}

function rep(tests: TestResult[], loadErrors?: TestReport['loadErrors']): TestReport {
  return { format: 'junit', tests, skippedLines: 0, ...(loadErrors !== undefined ? { loadErrors } : {}) };
}

const BEFORE = rep([t('t/a.test.js > old', 'pass')]);
const BASE = rep([
  t('t/a.test.js > old', 'pass'),
  t('t/a.test.js > new red', 'fail', A),
  t('t/a.test.js > new green', 'pass'),
  t('t/b.test.js > missing fn', 'fail', E),
  t('t/b.test.js > plain error', 'fail', U),
  t('t/b.test.js > skipped', 'skip'),
  t('t/c.test.js', 'fail', { kind: 'error', why: 'the file did not load', load: true }),
]);
const HEAD = rep([
  t('t/a.test.js > old', 'pass'),
  t('t/a.test.js > new red', 'pass'),
  t('t/a.test.js > new green', 'pass'),
  t('t/b.test.js > missing fn', 'pass'),
  t('t/b.test.js > plain error', 'pass'),
  t('t/b.test.js > skipped', 'pass'),
  t('t/c.test.js > loads at head', 'pass'),
  t('t/d.test.js > not on base', 'pass'),
  t('t/e.test.js > red at head', 'fail', A),
]);

function judge(acceptance: string[], over: { before?: TestReport | null; base?: TestReport; head?: TestReport } = {}): ReturnType<typeof judgeFailFirst> {
  return judgeFailFirst({ before: over.before === undefined ? BEFORE : over.before, base: over.base ?? BASE, head: over.head ?? HEAD, acceptance });
}

const ids = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id);

describe('tests fail-first: the judge', () => {
  it('with no named test nothing fails the check, and every new test lands in one list by its base outcome', () => {
    const j = judge([]);
    assert.equal(j.exitCode, 0);
    assert.deepEqual(j.problems, []);
    assert.deepEqual(ids(j.newRedByAssertion), ['t/a.test.js > new red']);
    assert.deepEqual(ids(j.newPassingOnBase), ['t/a.test.js > new green']);
    assert.deepEqual(ids(j.newRedWrongReason), ['t/b.test.js > missing fn', 't/c.test.js > loads at head']);
    assert.deepEqual(ids(j.newRedCannotTell), ['t/b.test.js > plain error']);
    assert.deepEqual(ids(j.newSkippedOrAbsentOnBase), ['t/b.test.js > skipped', 't/d.test.js > not on base', 't/e.test.js > red at head']);
    assert.deepEqual(ids(j.newNotPassingAtHead), ['t/e.test.js > red at head']);
  });

  it('a test that existed on base as it was is not a new test and is not listed', () => {
    const j = judge([]);
    assert.ok(!j.rows.some((r) => r.id === 't/a.test.js > old'));
  });

  it('a whole-file load failure is never itself a test row', () => {
    assert.ok(!judge([]).rows.some((r) => r.id === 't/c.test.js'));
  });

  it('a named test that fails on base by assertion and passes at head is the one clean case', () => {
    const j = judge(['t/a.test.js > new red']);
    assert.equal(j.exitCode, 0);
    assert.equal(j.rows.find((r) => r.named !== null)?.base, 'fails-assertion');
    assert.deepEqual(ids(j.newRedByAssertion), [], 'a named test leaves the unnamed lists');
  });

  it('a named test that passes on base exits 1', () => {
    const j = judge(['new green']);
    assert.equal(j.exitCode, 1);
    assert.deepEqual(j.problems.map((p) => [p.id, p.why]), [['t/a.test.js > new green', 'passes-on-base']]);
  });

  it('named and skipped on base, or absent from base with no load error, exits 1', () => {
    assert.deepEqual(judge(['skipped']).problems.map((p) => p.why), ['skipped-on-base']);
    assert.deepEqual(judge(['not on base']).problems.map((p) => p.why), ['did-not-run-on-base']);
  });

  it('named and red on base but not passing at head exits 1', () => {
    const base = rep([...BASE.tests, t('t/e.test.js > red at head', 'fail', A)]);
    assert.deepEqual(judge(['red at head'], { base }).problems.map((p) => p.why), ['not-passing-at-head']);
    const head = rep(HEAD.tests.filter((x) => x.id !== 't/a.test.js > new red'));
    assert.deepEqual(judge(['t/a.test.js > new red'], { head }).problems.map((p) => [p.why, p.text]), [['not-passing-at-head', 'is not in the head run']]);
  });

  it('a name found nowhere, or matching two tests, exits 1', () => {
    assert.deepEqual(judge(['no such test']).problems.map((p) => p.why), ['not-found']);
    const head = rep([...HEAD.tests, t('t/z.test.js > new red', 'pass')]);
    assert.deepEqual(judge(['new red'], { head }).problems.map((p) => p.why), ['ambiguous']);
  });

  it('named and red for the wrong reason, or red with no reason shown, is reported and does not block', () => {
    const j = judge(['missing fn', 'loads at head', 'plain error']);
    assert.equal(j.exitCode, 0);
    assert.deepEqual(ids(j.namedRedWrongReason), ['t/b.test.js > missing fn', 't/c.test.js > loads at head']);
    assert.deepEqual(ids(j.namedRedCannotTell), ['t/b.test.js > plain error']);
    assert.equal(j.rows.find((r) => r.id === 't/c.test.js > loads at head')?.base, 'load-error');
  });

  it('a load error from the report list (jest, go) explains an absent test the same way', () => {
    const base = rep(BASE.tests.filter((x) => x.file !== 't/c.test.js'), [{ file: 't/c.test.js', why: 'the file failed with no test result' }]);
    assert.equal(judge(['loads at head'], { base }).rows.find((r) => r.named !== null)?.base, 'load-error');
  });

  it('with no run of the base as it was, every test is new', () => {
    const j = judge([], { before: null });
    assert.ok(j.rows.some((r) => r.id === 't/a.test.js > old' && r.isNew));
  });

  it('totals never decide: a head with many more passing tests changes nothing', () => {
    const head = rep([...HEAD.tests, ...Array.from({ length: 50 }, (_, i) => t(`t/x.test.js > extra ${i}`, 'pass'))]);
    assert.equal(judge(['new green'], { head }).exitCode, 1);
  });

  it('a name matches the exact id first, then a single tail after " > "', () => {
    const list = ['f > s > a', 'g > a', 'f > b'];
    assert.deepEqual(matchName('f > b', list), { id: 'f > b' });
    assert.deepEqual(matchName('b', list), { id: 'f > b' });
    assert.deepEqual(matchName('a', list), { many: ['f > s > a', 'g > a'] });
    assert.deepEqual(matchName('s > a', list), { id: 'f > s > a' });
    assert.deepEqual(matchName('> a', list), { none: true });
  });
});
