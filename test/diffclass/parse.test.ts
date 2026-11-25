import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyHunks, gitBlobHash, hashNames } from '../../src/diffclass/apply.js';
import { compileGlob, globProblem } from '../../src/diffclass/glob.js';
import { decodeDiff, parseDiff } from '../../src/diffclass/parse.js';
import { exclusionsFor } from '../../src/diffclass/rules.js';

const MOD = `diff --git a/docs/a.md b/docs/a.md
index 1111111..2222222 100644
--- a/docs/a.md
+++ b/docs/a.md
@@ -1,2 +1,2 @@
 one
-two
+three
`;

describe('parseDiff: what git writes', () => {
  it('reads a modified file with its hunk, modes and hashes', () => {
    const r = parseDiff(MOD);
    assert.ok(r.ok, r.ok ? '' : r.error);
    const f = r.files[0];
    assert.equal(r.files.length, 1);
    assert.equal(f?.path, 'docs/a.md');
    assert.equal(f?.status, 'modified');
    assert.equal(f?.oldMode, '100644');
    assert.equal(f?.oldHash, '1111111');
    assert.deepEqual(f?.hunks[0]?.lines.map((l) => l.op + l.text), [' one', '-two', '+three']);
    assert.deepEqual(f?.doubts, []);
  });
  it('splits a plain header with a space only when both halves agree, and reads the ---/+++ tab', () => {
    const d = 'diff --git a/x y.md b/x y.md\nindex 1111111..2222222 100644\n--- a/x y.md\t\n+++ b/x y.md\t\n@@ -1 +1 @@\n-a\n+b\n';
    const r = parseDiff(d);
    assert.ok(r.ok, r.ok ? '' : r.error);
    assert.equal(r.files[0]?.path, 'x y.md');
    assert.ok(r.files[0]?.doubts.some((x) => x.id === 'doubt.path-space'));
  });
  it('decodes C-quoted paths and keeps a doubt for them', () => {
    const d = 'diff --git "a/n\\303\\244me.md" "b/n\\303\\244me.md"\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ "b/n\\303\\244me.md"\n@@ -0,0 +1 @@\n+z\n';
    const r = parseDiff(d);
    assert.ok(r.ok, r.ok ? '' : r.error);
    assert.equal(r.files[0]?.path, 'näme.md');
    assert.ok(r.files[0]?.doubts.some((x) => x.id === 'doubt.quoted-path'));
  });
  it('marks a carriage return, NEL or line separator inside a line', () => {
    for (const ch of ['\r', '\u0085', ' ', ' ']) {
      const r = parseDiff(MOD.replace('+three', `+thr${ch}ee`));
      assert.ok(r.ok);
      assert.ok(r.files[0]?.doubts.some((x) => x.id === 'doubt.line-break'), JSON.stringify(ch));
    }
  });
  it('fails closed on input it does not fully understand', () => {
    const bad: [string, string][] = [
      ['', 'empty'],
      ['not a diff\n', 'text before'],
      [MOD.slice(0, -1), 'newline'],
      [MOD.replace('@@ -1,2 +1,2 @@', '@@ -1,2 +1,3 @@'), 'cut off'],
      [MOD.replace('@@ -1,2 +1,2 @@', '@@ -1,1 +1,1 @@'), 'not context'],
      [MOD.replace('index ', 'weird header\nindex '), 'header line'],
      [MOD.replace(' one', 'one'), 'not context'],
      [MOD.replace(/a\/docs/g, 'docs').replace(/b\/docs/g, 'docs'), 'prefixes'],
      [MOD.replace('+++ b/docs/a.md', '+++ b/docs/other.md'), 'does not match'],
      [`${MOD}trailing words\n`, 'expected a "diff --git"'],
      [MOD.replace('--- a/docs/a.md\n', ''), 'header line'],
      [MOD.replace(/\n/g, '\r\n'), 'carriage return'],
      ['diff --git a/x b/x\nGIT binary patch\nliteral 2\n!!! not base85 ???\n', 'binary patch data'],
    ];
    for (const [text, why] of bad) {
      const r = parseDiff(text);
      assert.equal(r.ok, false, `${why}: ${JSON.stringify(text.slice(0, 60))}`);
      if (!r.ok) assert.ok(r.error.length > 10, why);
    }
  });
  it('rejects bytes that are not diff text', () => {
    assert.equal(decodeDiff(new Uint8Array([0x64, 0x00, 0x0a])).ok, false);
    assert.equal(decodeDiff(new Uint8Array([0xff, 0xfe, 0x0a])).ok, false);
    assert.equal(decodeDiff(new TextEncoder().encode(MOD)).ok, true);
  });
  it('terminates on hostile input', () => {
    const many = 'diff --git a/x b/x\n'.repeat(5000);
    const t0 = Date.now();
    assert.equal(parseDiff(many).ok, true);
    assert.equal(parseDiff('@@'.repeat(100000) + '\n').ok, false);
    assert.equal(parseDiff(`diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,99999999 +1,99999999 @@\n a\n`).ok, false);
    assert.ok(Date.now() - t0 < 5000);
  });
});

describe('rebuilding a file from its base', () => {
  it('applies hunks, including a missing final newline, and checks the git hash', () => {
    const base = 'one\ntwo\n';
    const r = parseDiff(MOD);
    assert.ok(r.ok);
    const out = applyHunks(base, r.files[0]?.hunks ?? []);
    assert.deepEqual(out, { ok: true, text: 'one\nthree\n' });
    assert.equal(applyHunks('one\nTWO\n', r.files[0]?.hunks ?? []).ok, false);
    const noEol = parseDiff('diff --git a/x b/x\nindex 1111111..2222222 100644\n--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-a\n\\ No newline at end of file\n+a\n+b\n');
    assert.ok(noEol.ok);
    assert.deepEqual(applyHunks('a', noEol.files[0]?.hunks ?? []), { ok: true, text: 'a\nb\n' });
    const bytes = new TextEncoder().encode('one\ntwo\n');
    const sha1 = gitBlobHash(bytes, 'sha1');
    assert.equal(sha1, '814f4a422927b82f5f8a43f8fab6d3839e3983f2', 'git hash-object of the same bytes, run on this machine');
    assert.ok(hashNames(sha1, bytes) && hashNames(sha1.slice(0, 7), bytes) && hashNames(gitBlobHash(bytes, 'sha256'), bytes));
    assert.ok(!hashNames(sha1.slice(0, 6), bytes) && !hashNames('0000000', bytes));
  });
  it('matches git for the empty blob', () => {
    assert.equal(gitBlobHash(new Uint8Array(0), 'sha1'), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });
});

describe('globs and exclusions', () => {
  it('matches at any depth without a slash, from the root with one, case-insensitive, folders cover their contents', () => {
    assert.ok(compileGlob('README*')('docs/readme.md'));
    assert.ok(compileGlob('.github/')('.github/workflows/ci.yml'));
    assert.ok(compileGlob('clinical/**')('clinical/a/b.md'));
    assert.ok(!compileGlob('clinical/**')('docs/clinical/b.md'));
    assert.ok(compileGlob('**/secret')('a/b/secret/c'));
    assert.ok(compileGlob('*.test.*')('web/a.test.tsx'));
    assert.ok(!compileGlob('src/*.ts')('src/a/b.ts'));
  });
  it('refuses globs it cannot read safely', () => {
    for (const g of ['', '/abs', 'a\\b', '../x', 'a/../b', '{a,b}', '[ab]', '!x']) assert.notEqual(globProblem(g), null, g);
    assert.equal(globProblem('clinical/**'), null);
  });
  it('names the rules a path falls under, and the root bylaws file under none', () => {
    assert.deepEqual(exclusionsFor('openmorals.yaml'), []);
    assert.deepEqual(exclusionsFor('cases/destructive.cases.yaml'), []);
    assert.deepEqual(exclusionsFor('docs/guide.md'), []);
    assert.deepEqual(exclusionsFor('sub/openmorals.yaml').map((h) => h.id), ['exclude.self-protected']);
    assert.ok(exclusionsFor('src/diffclass/rules.ts').some((h) => h.id === 'exclude.classifier'));
    assert.ok(exclusionsFor('.GITHUB/workflows/x.yml').some((h) => h.id === 'exclude.ci-config'));
  });
});

describe('a diff with no files is never review-free', () => {
  it('classifyDiff refuses an empty change at the parser, and the class checks need at least one file', async () => {
    const { classifyDiff } = await import('../../src/diffclass/classify.js');
    const { memoryReader } = await import('../../src/diffclass/apply.js');
    const r = classifyDiff({ diff: '', merge: { review_free: ['tighten-only', 'reproduced'], always_review: [] }, base: memoryReader({}), reproduced: '' });
    assert.equal(r.ok, false);
  });
});
