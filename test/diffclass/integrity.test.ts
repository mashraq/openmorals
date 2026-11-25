import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { memoryReader } from '../../src/diffclass/apply.js';
import { REASON_SOURCES, classifyDiff, formatVerdictText } from '../../src/diffclass/classify.js';
import { diffClassCommandWith } from '../../src/diffclass/command.js';
import { INTEGRITY_RULES, integrityReasons, literalShape } from '../../src/diffclass/integrity.js';
import type { DiffClassCase } from '../../src/diffclass/rows.js';
import { classifyRow, rowOutcome, rowWrong } from '../../src/diffclass/score.js';
import type { ReasonSource } from '../../src/diffclass/types.js';
import { folderSource, loadCasesFrom } from '../../src/eval/cases.js';
import { REPO_ROOT, tempDir } from '../helpers.js';

function rows(): DiffClassCase[] {
  const r = loadCasesFrom(folderSource(join(REPO_ROOT, 'cases')));
  assert.ok(r.ok, r.ok ? '' : r.error);
  return r.value.diffClass.flatMap((f) => f.cases);
}

const ROWS = rows();
const only = (ids: readonly string[]): readonly ReasonSource[] => [(files, ctx) => integrityReasons(files, ctx, INTEGRITY_RULES.filter((r) => !ids.includes(r.id)))];

describe('the test-integrity rule list', () => {
  it('has the thirteen test-integrity rules and the two of 0.32.0, each with an id, a published pattern and what it misses', () => {
    assert.deepEqual(INTEGRITY_RULES.map((r) => r.id), [
      'integrity.assert-removed',
      'integrity.skip-added',
      'integrity.snapshot',
      'integrity.runner-config',
      'integrity.scripts',
      'integrity.exit-added',
      'integrity.expected-changed',
      'integrity.equality-override',
      'integrity.suppression-added',
      'integrity.dependency-added',
      'integrity.lockfile',
      'integrity.secret-added',
      'integrity.outside-paths',
      'integrity.size',
      'integrity.boundary-no-adr',
    ]);
    for (const r of INTEGRITY_RULES) {
      assert.ok(r.pattern.length > 20, r.id);
      assert.ok(r.misses.length > 20, r.id);
    }
  });
  it('runs on every diff through REASON_SOURCES', () => {
    assert.equal(REASON_SOURCES.length, 1);
  });
  it('no size line is set by default: integrity.size has no input until one is declared', () => {
    const c = ROWS.find((x) => x.name === 'Integrity: more changed lines than the size line');
    assert.ok(c !== undefined);
    const r = classifyRow({ ...c, maxLines: null });
    assert.ok(r.ok);
    assert.ok(!r.verdict.reasons.some((x) => x.rule === 'integrity.size'));
    assert.ok(r.verdict.notChecked.some((x) => x.startsWith('integrity.size:')));
  });
  it('docs/test-integrity.md publishes every rule id with its exact pattern text', () => {
    const doc = readFileSync(join(REPO_ROOT, 'docs', 'test-integrity.md'), 'utf8');
    for (const r of INTEGRITY_RULES) {
      assert.ok(doc.includes(`\`${r.id}\``), `docs/test-integrity.md does not name ${r.id}`);
      assert.ok(doc.includes(r.pattern), `docs/test-integrity.md does not publish the pattern of ${r.id}`);
      assert.ok(doc.includes(r.misses), `docs/test-integrity.md does not say what ${r.id} misses`);
    }
  });
  it('literalShape makes lines that differ only in literals equal, and keeps names', () => {
    assert.equal(literalShape('assert.equal(add(2, 2), 4);'), literalShape('assert.equal(add(2, 2), 5);'));
    assert.equal(literalShape("expect(x).toBe('a')"), literalShape('expect(x).toBe("b")'));
    assert.notEqual(literalShape('assert.equal(add(2, 2), 4);'), literalShape('assert.equal(sum(2, 2), 4);'));
  });
});

describe('every test-integrity rule has case rows and is load-bearing', () => {
  for (const r of INTEGRITY_RULES) {
    it(`${r.id}: at least one row names it, and without the rule that row fails`, () => {
      const named = ROWS.filter((c) => c.rule === r.id);
      assert.ok(named.length >= 1, `no row for ${r.id}`);
      for (const c of named) assert.equal(rowWrong(c, rowOutcome(classifyRow(c))), null, c.name);
      const failing = named.filter((c) => rowWrong(c, rowOutcome(classifyRow(c, undefined, only([r.id])))) !== null);
      assert.ok(failing.length >= 1, `removing ${r.id} changed no row`);
    });
  }
  it('every rule except the declared-input ones has a near-miss row it must stay silent on', () => {
    for (const r of INTEGRITY_RULES) {
      if (['integrity.snapshot', 'integrity.runner-config', 'integrity.exit-added', 'integrity.equality-override'].includes(r.id)) continue;
      assert.ok(ROWS.some((c) => c.notRule === r.id), `no near-miss row for ${r.id}`);
    }
  });
});

describe('escalate-only: a test-integrity reason never lowers a class', () => {
  it('on every row, with the rules on the verdict is at least as strict as with them off', () => {
    let raised = 0;
    for (const c of ROWS) {
      const on = classifyRow(c);
      const off = classifyRow(c, undefined, []);
      assert.equal(on.ok, off.ok, c.name);
      if (!on.ok || !off.ok) continue;
      assert.ok(on.verdict.exitCode >= off.verdict.exitCode, c.name);
      if (off.verdict.verdict === 'review') assert.equal(on.verdict.verdict, 'review', c.name);
      for (const r of off.verdict.reasons) assert.ok(on.verdict.reasons.some((x) => x.rule === r.rule && x.path === r.path), `${c.name}: lost ${r.rule}`);
      if (off.verdict.verdict === 'review-free' && on.verdict.verdict === 'review') raised++;
    }
    assert.ok(raised >= 1, 'no row shows a review-free diff raised to review by a test-integrity reason');
  });
  it('a reason line is a pointer, not a new exit code: review stays exit 1, never 2 or 64', () => {
    for (const c of ROWS) {
      const on = classifyRow(c);
      if (on.ok) assert.ok(on.verdict.exitCode === 0 || on.verdict.exitCode === 1, c.name);
    }
  });
});

describe('declared inputs and the short output', () => {
  const row = (name: string): DiffClassCase => {
    const c = ROWS.find((x) => x.name === name);
    assert.ok(c !== undefined, name);
    return c;
  };
  it('notChecked names the rules that had no input, and the text says how many', () => {
    const c = row('Integrity near miss: no paths declared, so the rule has no input');
    const r = classifyRow(c);
    assert.ok(r.ok);
    assert.deepEqual(r.verdict.notChecked, ['integrity.outside-paths: no declared paths (--paths)', 'integrity.size: no size line declared (--max-lines, --max-files)', 'integrity.boundary-no-adr: no boundary paths declared (merge.boundary_paths)']);
    assert.match(formatVerdictText(r.verdict), /3 test-integrity rules had no input \(notChecked in --json\)/);
    const declared = classifyRow(row('Integrity: a file changed outside the declared paths'));
    assert.ok(declared.ok);
    assert.deepEqual(declared.verdict.notChecked, ['integrity.size: no size line declared (--max-lines, --max-files)', 'integrity.boundary-no-adr: no boundary paths declared (merge.boundary_paths)']);
  });
  it('test-integrity lines come before the exclusion lines, and the text still prints at most three', () => {
    const c = row('Integrity: a file changed outside the declared paths');
    const r = classifyRow(c);
    assert.ok(r.ok);
    assert.equal(r.verdict.reasons[0]?.rule, 'integrity.outside-paths');
    const text = formatVerdictText(r.verdict);
    assert.ok(text.split('\n').filter((l) => l.startsWith('  - ')).length <= 3, text);
    assert.match(text, /changes a file outside the declared paths: src\/other\.ts/);
  });
  it('the class.off reason names the source the caller gave', () => {
    const c = row('A1: two added rows expecting ask and deny, class switched on');
    const r = classifyDiff({ diff: c.diff, merge: undefined, base: memoryReader(c.base), settingsSource: 'the team floor file' });
    assert.ok(r.ok);
    assert.ok(r.verdict.reasons.some((x) => x.rule === 'class.off' && x.text.includes('merge.review_free in the team floor file')), JSON.stringify(r.verdict.reasons));
    const d = classifyDiff({ diff: c.diff, merge: undefined, base: memoryReader(c.base) });
    assert.ok(d.ok);
    assert.ok(d.verdict.reasons.some((x) => x.rule === 'class.off' && x.text.includes('merge.review_free in the user-level file')));
  });
  it('diffClassCommandWith takes the merge settings from the caller and reads no settings file', () => {
    const c = row('A1: two added rows expecting ask and deny, class switched on');
    const base = tempDir('dcw-base');
    for (const [p, t] of Object.entries(c.base)) {
      const full = join(base, ...p.split('/'));
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, t);
    }
    const home = tempDir('dcw-home');
    writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\nmerge:\n  review_free: [tighten-only]\n');
    const ctx = { env: { OPENMORALS_HOME: home }, cwd: base, readStdin: () => new TextEncoder().encode(c.diff) };
    const team = diffClassCommandWith(['-', '--json'], ctx, { merge: { review_free: [], always_review: [] }, source: 'the team floor file' });
    assert.equal(team.exitCode, 1);
    assert.match(team.stdout, /merge\.review_free in the team floor file/);
    const on = diffClassCommandWith(['-'], ctx, { merge: { review_free: ['tighten-only'], always_review: [] }, source: 'the team floor file' });
    assert.equal(on.exitCode, 0, on.stdout + on.stderr);
    const files = diffClassCommandWith(['-'], ctx, null);
    assert.equal(files.exitCode, 0, 'null reads the user-level file, which switches tighten-only on');
    const declared = diffClassCommandWith(['-', '--paths', 'src/'], ctx, null);
    assert.equal(declared.exitCode, 1);
    assert.match(declared.stdout, /outside the declared paths: cases\/destructive\.cases\.yaml/);
  });
});
