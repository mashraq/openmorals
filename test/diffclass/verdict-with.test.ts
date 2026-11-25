import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { DIFF_CLASS_EXIT, diffClassCommandWith, diffClassVerdictWith, formatDiffClass } from '../../src/diffclass/command.js';
import * as om from '../../src/index.js';
import { folderSource, loadCasesFrom } from '../../src/eval/cases.js';
import { REPO_ROOT, tempDir } from '../helpers.js';

function rowCtx(name: string): { env: NodeJS.ProcessEnv; cwd: string; readStdin: () => Uint8Array } {
  const r = loadCasesFrom(folderSource(join(REPO_ROOT, 'cases')));
  assert.ok(r.ok, r.ok ? '' : r.error);
  const c = r.value.diffClass.flatMap((f) => f.cases).find((x) => x.name === name);
  assert.ok(c !== undefined, `no row named ${name}`);
  const base = tempDir('dvw-base');
  for (const [p, t] of Object.entries(c.base)) {
    const full = join(base, ...p.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, t);
  }
  const home = tempDir('dvw-home');
  writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\nmerge:\n  review_free: [tighten-only]\n');
  return { env: { OPENMORALS_HOME: home }, cwd: base, readStdin: () => new TextEncoder().encode(c.diff) };
}

describe('diffClassVerdictWith: the verdict object for callers that add their own reasons (0.14.0)', () => {
  const ctx = rowCtx('A1: two added rows expecting ask and deny, class switched on');
  it('formatDiffClass of its verdict is exactly what diffClassCommandWith prints, for text, JSON and caller settings', () => {
    const team = { merge: { review_free: [], always_review: [] }, source: 'the team floor file' };
    for (const [argv, settings] of [[['-'], null], [['-', '--json'], null], [['-', '--json'], team], [['-', '--paths', 'src/'], null]] as const) {
      const o = diffClassVerdictWith(argv, ctx, settings);
      assert.ok(o.ok);
      assert.deepEqual(formatDiffClass(o.verdict, o.json), diffClassCommandWith(argv, ctx, settings));
    }
  });
  it('a caller can add a reason, and the printed verdict carries it', () => {
    const o = diffClassVerdictWith(['-', '--json'], ctx, null);
    assert.ok(o.ok);
    const merged = { ...o.verdict, verdict: 'review' as const, class: 'B' as const, exitCode: 1 as const, basis: null, reasons: [...o.verdict.reasons, { rule: 'team.example', path: null, text: 'a team rule asked for review' }] };
    const out = formatDiffClass(merged, true);
    assert.equal(out.exitCode, 1);
    assert.match(out.stdout, /team\.example/);
  });
  it('a usage error and an unreadable input come back as the finished result', () => {
    const u = diffClassVerdictWith(['--bogus'], ctx, null);
    assert.ok(!u.ok);
    assert.equal(u.result.exitCode, DIFF_CLASS_EXIT.usage);
    assert.deepEqual(u.result, diffClassCommandWith(['--bogus'], ctx, null));
    const bad = diffClassVerdictWith(['/nonexistent/diff.patch'], ctx, null);
    assert.ok(!bad.ok);
    assert.equal(bad.result.exitCode, DIFF_CLASS_EXIT.unreadable);
  });
  it('is exported beside diffClassCommandWith in the diffClass namespace', () => {
    assert.equal(typeof om.diffClass.diffClassVerdictWith, 'function');
    assert.equal(typeof om.diffClass.formatDiffClass, 'function');
    assert.equal(typeof om.diffClass.diffClassCommandWith, 'function');
  });
});
