import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { EXCLUSIONS } from '../../src/diffclass/rules.js';
import type { DiffClassCase } from '../../src/diffclass/rows.js';
import { classifyRow, rowOutcome, rowWrong } from '../../src/diffclass/score.js';
import { folderSource, loadCasesFrom } from '../../src/eval/cases.js';
import { REPO_ROOT } from '../helpers.js';

function rows(): DiffClassCase[] {
  const r = loadCasesFrom(folderSource(join(REPO_ROOT, 'cases')));
  assert.ok(r.ok, r.ok ? '' : r.error);
  const files = r.value.diffClass;
  assert.equal(files.length, 1, 'one diff-class table');
  return files[0]?.cases ?? [];
}

const ROWS = rows();

describe('cases/diff-class.cases.yaml: every row through the classifier', () => {
  for (let i = 0; i < ROWS.length; i++) {
    const c = ROWS[i] as DiffClassCase;
    it(`[${i}] line ${c.line ?? '?'}: ${c.name}`, () => {
      const o = rowOutcome(classifyRow(c));
      assert.equal(rowWrong(c, o), null, `expected ${c.expect}${c.rule !== null ? ` (${c.rule})` : ''}, got ${o.got} ${o.basis ?? o.rules.join(',')}`);
    });
  }
});

describe('the diff-class table covers both classes, review rows and every exclusion', () => {
  const ruleRows = (rule: string): DiffClassCase[] => ROWS.filter((c) => c.rule === rule);
  it('has rows for both classes, review rows, and unreadable input', () => {
    assert.ok(ruleRows('tighten-only').length >= 3);
    assert.ok(ruleRows('reproduced').length >= 2);
    assert.ok(ROWS.filter((c) => c.expect === 'unreadable').length >= 8);
    assert.ok(ROWS.filter((c) => c.expect === 'review').length >= 60);
  });
  it('an expect: allow case row is review, and the default (nothing switched on) is review', () => {
    assert.ok(ruleRows('tighten.case-allow').length >= 1);
    assert.ok(ROWS.some((c) => c.rule === 'class.off' && c.reviewFree.length === 0));
  });
  it('every exclusion rule has a row naming it', () => {
    for (const x of [...EXCLUSIONS.map((e) => e.id), 'exclude.self-protected', 'exclude.always-review']) assert.ok(ruleRows(x).length >= 1, `no row for ${x}`);
  });
  it('every evasion of the row has a row', () => {
    for (const d of ['doubt.rename', 'doubt.mode-change', 'doubt.executable', 'doubt.binary', 'doubt.symlink', 'doubt.submodule', 'doubt.line-break', 'doubt.quoted-path', 'doubt.path-space', 'doubt.delete', 'doubt.path-repeated']) {
      assert.ok(ruleRows(d).length >= 1, `no row for ${d}`);
    }
    assert.ok(ROWS.some((c) => c.name.startsWith('Evasion: a rename into an excluded path') && c.rule === 'exclude.ci-config'));
  });
  it('every escalation from the run record has a row, and a clean record changes nothing', () => {
    for (const r of ['record.deny', 'record.ask', 'record.approved-ask', 'record.taint', 'record.loosening', 'record.unverified', 'record.missing']) assert.ok(ruleRows(r).length >= 1, `no row for ${r}`);
    assert.ok(ROWS.some((c) => c.record !== null && c.expect === 'review-free'));
  });
});

describe('every exclusion entry is load-bearing', () => {
  for (const x of EXCLUSIONS) {
    it(`without ${x.id} (and with the test-integrity rules off, so only this layer is measured), a row that needed review comes out review-free`, () => {
      const without = EXCLUSIONS.filter((e) => e.id !== x.id);
      const turned = ROWS.filter((c) => c.rule === x.id && rowOutcome(classifyRow(c, without, [])).got === 'review-free');
      assert.ok(turned.length >= 1, `removing ${x.id} changed no row`);
    });
  }
});
