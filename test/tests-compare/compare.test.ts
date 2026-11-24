import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareTests, parseApprovals } from '../../src/tests/compare.js';
import type { Approval } from '../../src/tests/compare.js';
import type { TestReport, TestStatus } from '../../src/tests/report.js';

/** A report from `id=status` pairs; the file of each test is the part before " > ". */
function rep(pairs: Record<string, TestStatus>): TestReport {
  return { format: 'junit', skippedLines: 0, tests: Object.entries(pairs).map(([id, status]) => ({ id, status, file: id.includes(' > ') ? id.split(' > ')[0] ?? null : null })) };
}

const BEFORE = rep({ 'w.test > alpha sorts': 'pass', 'w.test > beta merges': 'pass', 'w.test > gamma rounds': 'fail', 'w.test > delta trims': 'skip' });

function approvals(text: string): Approval[] {
  const r = parseApprovals(text);
  if (!r.ok) assert.fail(r.error);
  return r.approvals;
}

describe('tests compare: the two lists', () => {
  it('identical reports: no list holds anything and nothing blocks', () => {
    const c = compareTests([BEFORE], [BEFORE]);
    assert.deepEqual([c.failToPass, c.passToFail, c.gone, c.newlySkipped, c.likelyRenames, c.flaky, c.failingGone], [[], [], [], [], [], [], []]);
    assert.equal(c.blocking, 0);
    assert.deepEqual(c.totals.before, { tests: 4, pass: 2, fail: 1, skip: 1 });
  });

  it('fail-to-pass: a failing test now passing, a skipped one now passing, and a new passing test', () => {
    const c = compareTests([BEFORE], [rep({ 'w.test > alpha sorts': 'pass', 'w.test > beta merges': 'pass', 'w.test > gamma rounds': 'pass', 'w.test > delta trims': 'pass', 'v.test > eta new': 'pass' })]);
    assert.deepEqual(c.failToPass.map((g) => [g.id, g.was]), [
      ['v.test > eta new', 'new'],
      ['w.test > delta trims', 'skipped'],
      ['w.test > gamma rounds', 'failing'],
    ]);
    assert.equal(c.blocking, 0);
  });

  it('pass-to-fail, gone and newly skipped each block', () => {
    const c = compareTests([BEFORE], [rep({ 'w.test > alpha sorts': 'fail', 'w.test > gamma rounds': 'fail', 'w.test > delta trims': 'skip' })]);
    assert.deepEqual(c.passToFail.map((l) => l.id), ['w.test > alpha sorts']);
    assert.deepEqual(c.gone.map((l) => l.id), ['w.test > beta merges']);
    assert.equal(c.blocking, 2);
    const s = compareTests([BEFORE], [rep({ 'w.test > alpha sorts': 'skip', 'w.test > beta merges': 'pass', 'w.test > gamma rounds': 'fail', 'w.test > delta trims': 'skip' })]);
    assert.deepEqual(s.newlySkipped.map((l) => [l.id, l.kind]), [['w.test > alpha sorts', 'skipped']]);
    assert.equal(s.blocking, 1);
  });

  it('a test that was failing and then removed is shown apart, and is not a loss', () => {
    const c = compareTests([BEFORE], [rep({ 'w.test > alpha sorts': 'pass', 'w.test > beta merges': 'pass', 'w.test > delta trims': 'skip' })]);
    assert.deepEqual(c.failingGone, ['w.test > gamma rounds']);
    assert.equal(c.blocking, 0);
  });

  it('totals never decide: more tests passing after, one lost, still blocks; fewer tests after, none lost, does not', () => {
    const more = compareTests([BEFORE], [rep({ 'w.test > alpha sorts': 'pass', 'w.test > gamma rounds': 'pass', 'w.test > delta trims': 'pass', 'w.test > x1': 'pass', 'w.test > x2': 'pass' })]);
    assert.ok(more.totals.after.pass > more.totals.before.pass);
    assert.equal(more.blocking, 1);
    const fewer = compareTests([BEFORE], [rep({ 'w.test > alpha sorts': 'pass', 'w.test > beta merges': 'pass' })]);
    assert.ok(fewer.totals.after.tests < fewer.totals.before.tests);
    assert.equal(fewer.blocking, 0);
  });

  it('a rename shows as one gone and one new in the same file, and the gone one still blocks', () => {
    const c = compareTests([BEFORE], [rep({ 'w.test > alpha sorts well': 'pass', 'w.test > beta merges': 'pass', 'w.test > gamma rounds': 'fail', 'w.test > delta trims': 'skip' })]);
    assert.deepEqual(c.gone.map((l) => l.id), ['w.test > alpha sorts']);
    assert.deepEqual(c.failToPass.map((g) => [g.id, g.was]), [['w.test > alpha sorts well', 'new']]);
    assert.deepEqual(c.likelyRenames, [{ file: 'w.test', gone: ['w.test > alpha sorts'], added: ['w.test > alpha sorts well'] }]);
    assert.equal(c.blocking, 1);
  });

  it('flaky with repeats: a test that passed in one before run and fails after counts as lost and is marked flaky', () => {
    const b2 = rep({ 'w.test > alpha sorts': 'fail', 'w.test > beta merges': 'pass', 'w.test > gamma rounds': 'fail', 'w.test > delta trims': 'skip' });
    const c = compareTests([BEFORE, b2], [rep({ 'w.test > alpha sorts': 'fail', 'w.test > beta merges': 'pass', 'w.test > gamma rounds': 'fail', 'w.test > delta trims': 'skip' })]);
    assert.deepEqual(c.flaky, ['w.test > alpha sorts']);
    assert.deepEqual(c.passToFail.map((l) => [l.id, l.flaky]), [['w.test > alpha sorts', true]]);
    assert.equal(c.blocking, 1);
  });

  it('flaky after: passing in one after run and failing in another is a loss, not a gain', () => {
    const a1 = rep({ 'w.test > alpha sorts': 'pass', 'w.test > beta merges': 'pass', 'w.test > gamma rounds': 'pass', 'w.test > delta trims': 'skip' });
    const a2 = rep({ 'w.test > alpha sorts': 'fail', 'w.test > beta merges': 'pass', 'w.test > gamma rounds': 'fail', 'w.test > delta trims': 'skip' });
    const c = compareTests([BEFORE], [a1, a2]);
    assert.deepEqual(c.flaky, ['w.test > alpha sorts', 'w.test > gamma rounds']);
    assert.deepEqual(c.passToFail.map((l) => l.id), ['w.test > alpha sorts']);
    assert.deepEqual(c.failToPass, [], 'a test that passes only some of the time has not shown new behaviour');
  });

  it('missing from one after run of several is gone (fail closed)', () => {
    const a2 = rep({ 'w.test > alpha sorts': 'pass', 'w.test > gamma rounds': 'fail', 'w.test > delta trims': 'skip' });
    const c = compareTests([BEFORE], [BEFORE, a2]);
    assert.deepEqual(c.gone.map((l) => [l.id, l.flaky]), [['w.test > beta merges', true]]);
    assert.equal(c.blocking, 1);
  });
});

describe('tests compare: approvals', () => {
  it('an approval line of the right kind covers a loss; another kind does not; unused lines are reported', () => {
    const after = rep({ 'w.test > alpha sorts': 'fail', 'w.test > gamma rounds': 'fail', 'w.test > delta trims': 'skip' });
    const ap = approvals('# approved for one change\n\ngone w.test > beta merges\nskipped w.test > alpha sorts\nfails w.test > nothing here\n');
    const c = compareTests([BEFORE], [after], ap);
    assert.equal(c.gone[0]?.approvedBy, 3);
    assert.equal(c.passToFail[0]?.approvedBy, null, 'skipped approves a skip, not a failure');
    assert.equal(c.blocking, 1);
    assert.deepEqual(c.unusedApprovals.map((a) => a.line), [4, 5]);
  });

  it('refuses an approval line it cannot read', () => {
    for (const bad of ['w.test > alpha sorts', 'ok w.test > alpha', 'gone', 'gone   ']) {
      const r = parseApprovals(bad);
      assert.equal(r.ok, false, bad);
      if (!r.ok) assert.match(r.error, /line 1/);
    }
  });
});
