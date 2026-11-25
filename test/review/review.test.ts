import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyDiff } from '../../src/diffclass/classify.js';
import { diffClassCommandWith } from '../../src/diffclass/command.js';
import { memoryReader } from '../../src/diffclass/apply.js';
import { parseDiff } from '../../src/diffclass/parse.js';
import { readNote, approvalNote } from '../../src/review/notes.js';
import { reviewMap, riskOf, suggestSplit } from '../../src/review/map.js';
import { tempDir } from '../helpers.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function added(path: string, lines: readonly string[]): string {
  return [`diff --git a/${path} b/${path}`, 'new file mode 100644', 'index 0000000..1111111', '--- /dev/null', `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`), ''].join('\n');
}

const n = (k: number, word = 'x'): string[] => Array.from({ length: k }, (_, i) => `const ${word}${i} = ${i};`);

function verdictOf(diff: string, noteReasons = [] as ReturnType<typeof readNote>['reasons']) {
  const r = classifyDiff({ diff, merge: { review_free: ['tighten-only', 'reproduced'], always_review: [] }, base: memoryReader({ 'cases/destructive.cases.yaml': BASE_CASES }), noteReasons });
  assert.ok(r.ok);
  return r.verdict;
}

const BASE_CASES = 'guard: destructive\ncases:\n  - { cmd: "rm -rf build", expect: ask }\n  - { cmd: "ls", expect: allow }\n';
const caseRow = [
  'diff --git a/cases/destructive.cases.yaml b/cases/destructive.cases.yaml',
  'index ace95ecb8440cc2c60bbe4488b9616bddaf310e2..7de71ca7529c2ad72d175659a4306a5a5eb7cb02 100644',
  '--- a/cases/destructive.cases.yaml',
  '+++ b/cases/destructive.cases.yaml',
  '@@ -2,3 +2,5 @@ guard: destructive',
  ' cases:',
  '   - { cmd: "rm -rf build", expect: ask }',
  '   - { cmd: "ls", expect: allow }',
  '+  - { cmd: "rm -rf dist", expect: ask }',
  '+  - { cmd: "git push --force origin main", expect: deny }',
  '',
].join('\n');

describe('notes from bots and AI summaries only add review (0.33.0)', () => {
  it('an approval changes nothing; a concern or a review line adds review', () => {
    const paths = ['src/auth.ts', 'src/a.ts'];
    const ok = readNote('LGTM, approved.\nAll checks passed.\nSafe to merge.', 'note bot.txt', paths);
    assert.equal(ok.reasons.length, 0);
    assert.equal(ok.approvals, 3);
    assert.match(approvalNote(ok) ?? '', /changed nothing/);
    const c = readNote('Looks good overall, but this may bypass the check in src/auth.ts.', 'note ai.md', paths);
    assert.equal(c.reasons[0]?.rule, 'note.concern');
    assert.equal(c.reasons[0]?.path, 'src/auth.ts');
    const r = readNote('- review: src/a.ts the retry loop never ends\nreview: * migration order', 'note n', paths);
    assert.deepEqual(r.reasons.map((x) => [x.rule, x.path]), [['note.review', 'src/a.ts'], ['note.review', null]]);
  });

  it('a change that would be review-free needs review once a note raises a concern, and an approval note leaves it review-free', () => {
    const free = verdictOf(caseRow);
    assert.equal(free.verdict, 'review-free');
    const approved = verdictOf(caseRow, readNote('LGTM, ship it', 'note bot', ['cases/destructive.cases.yaml']).reasons);
    assert.equal(approved.verdict, 'review-free');
    const concern = verdictOf(caseRow, readNote('This row could be a regression for the delete guard', 'note bot', ['cases/destructive.cases.yaml']).reasons);
    assert.equal(concern.verdict, 'review');
    assert.equal(concern.reasons[0]?.rule, 'note.concern');
  });

  it('the command reads --note files and lists ignored approvals', () => {
    const dir = tempDir('review-cli');
    writeFileSync(join(dir, 'change.diff'), caseRow);
    mkdirSync(join(dir, 'cases'));
    writeFileSync(join(dir, 'cases', 'destructive.cases.yaml'), BASE_CASES);
    writeFileSync(join(dir, 'bot.txt'), 'Approved by the review bot. LGTM.');
    writeFileSync(join(dir, 'user.yaml'), 'version: 1\nmerge: { review_free: [tighten-only] }\n');
    const env = { OPENMORALS_HOME: dir } as NodeJS.ProcessEnv;
    const settings = { merge: { review_free: ['tighten-only' as const], always_review: [] }, source: 'the test' };
    const ok = diffClassCommandWith([join(dir, 'change.diff'), '--note', join(dir, 'bot.txt')], { env, cwd: dir, readStdin: () => new Uint8Array() }, settings);
    assert.equal(ok.exitCode, 0);
    assert.match(ok.stdout, /changed nothing; a bot's approval or an AI summary can only add review/);
    writeFileSync(join(dir, 'ai.txt'), 'Summary: adds a row. Note: untested against the hold guard.');
    const bad = diffClassCommandWith([join(dir, 'change.diff'), '--note', join(dir, 'bot.txt'), '--note', join(dir, 'ai.txt')], { env, cwd: dir, readStdin: () => new Uint8Array() }, settings);
    assert.equal(bad.exitCode, 1);
    assert.match(bad.stdout, /raises a concern/);
    const missing = diffClassCommandWith([join(dir, 'change.diff'), '--note', join(dir, 'nope.txt')], { env, cwd: dir, readStdin: () => new Uint8Array() }, settings);
    assert.equal(missing.exitCode, 2);
  });

  it('a hostile note never loosens the verdict, crashes the command or reaches the terminal raw', () => {
    const dir = tempDir('review-cli');
    writeFileSync(join(dir, 'change.diff'), caseRow);
    mkdirSync(join(dir, 'cases'));
    writeFileSync(join(dir, 'cases', 'destructive.cases.yaml'), BASE_CASES);
    const env = { OPENMORALS_HOME: dir } as NodeJS.ProcessEnv;
    const ctx = { env, cwd: dir, readStdin: () => new Uint8Array() };
    const settings = { merge: { review_free: ['tighten-only' as const], always_review: [] }, source: 'the test' };
    const run = (note: string) => diffClassCommandWith([join(dir, 'change.diff'), '--note', note], ctx, settings);
    // UTF-16 text saying "DO NOT MERGE" must not read as a silent note: it cannot be read, so exit 2.
    writeFileSync(join(dir, 'utf16.txt'), Buffer.from('\ufeffDO NOT MERGE: security hole', 'utf16le'));
    assert.equal(run(join(dir, 'utf16.txt')).exitCode, 2);
    writeFileSync(join(dir, 'bad.txt'), Buffer.from([0x62, 0x75, 0x67, 0xc3, 0x28]));
    assert.equal(run(join(dir, 'bad.txt')).exitCode, 2);
    // Two notes near the size limit, each line a concern: needs review, no stack overflow, reasons capped.
    const many = 'bug\n'.repeat(60_000);
    writeFileSync(join(dir, 'big1.txt'), many);
    writeFileSync(join(dir, 'big2.txt'), many);
    const big = diffClassCommandWith([join(dir, 'change.diff'), '--note', join(dir, 'big1.txt'), '--note', join(dir, 'big2.txt'), '--json'], ctx, settings);
    assert.equal(big.exitCode, 1);
    const reasons = JSON.parse(big.stdout).reasons as { rule: string }[];
    assert.ok(reasons.length <= 2 * 51 + 5, `reasons are capped (${reasons.length})`);
    // Terminal escapes and direction overrides are not printed.
    writeFileSync(join(dir, 'esc.txt'), 'bug \u001b[2K\u001b[1AREVIEW-FREE \u202e here\n');
    const esc = run(join(dir, 'esc.txt'));
    assert.equal(esc.exitCode, 1);
    assert.doesNotMatch(esc.stdout, /[\u001b\u202e]/);
  });

  it('the tool\'s own findings are listed before what a note raised', () => {
    const r = readNote('bug here', 'note n', []);
    const v = verdictOf(added('test/a.test.ts', ['it.skip("x", () => {});']), r.reasons);
    const rules = v.reasons.map((x) => x.rule);
    const firstNote = rules.findIndex((x) => x.startsWith('note.'));
    assert.ok(firstNote > 0, rules.join(','));
    assert.ok(rules.slice(0, firstNote).every((x) => !x.startsWith('note.')));
  });
});

describe('the review map orders files riskiest first (0.33.0)', () => {
  it('a secret, CI config and a test-weakening change come before source, which comes before docs', () => {
    const diff = [
      added('docs/guide.md', ['# Guide', 'text']),
      added('src/big.ts', n(50)),
      added('.github/workflows/ci.yml', ['on: push']),
      added('src/config.ts', ['export const k = "ghp_' + 'A'.repeat(36) + '";']),
    ].join('');
    const v = verdictOf(diff);
    const parsed = parseDiff(diff);
    assert.ok(parsed.ok);
    const m = reviewMap(v, parsed.files);
    assert.deepEqual(m.files.map((f) => [f.path, f.risk]), [['src/config.ts', 'high'], ['.github/workflows/ci.yml', 'high'], ['src/big.ts', 'medium'], ['docs/guide.md', 'low']]);
    assert.ok(m.files[0]?.rules.includes('integrity.secret-added'));
    assert.equal(m.files[2]?.added, 50);
  });

  it('risk classes are fixed by rule id', () => {
    assert.equal(riskOf('integrity.assert-removed'), 'high');
    assert.equal(riskOf('note.concern'), 'high');
    assert.equal(riskOf('exclude.executable'), 'medium');
    assert.equal(riskOf('exclude.readme-legal'), 'low');
    assert.equal(riskOf('class.none'), 'low');
  });
});

describe('split suggestions for an oversized change (0.33.0)', () => {
  it('within the line: no suggestion', () => {
    const parsed = parseDiff(added('src/a.ts', n(10)));
    assert.ok(parsed.ok);
    assert.equal(suggestSplit(parsed.files), null);
  });

  it('over the line: dependencies first, tests with their source, then tooling, then docs', () => {
    const diff = [
      added('docs/notes.md', n(5, 'd')),
      added('src/payments/charge.ts', n(300, 'c')),
      added('test/payments/charge.test.ts', n(120, 't')),
      added('src/ui/button.ts', n(40, 'b')),
      added('package.json', ['{"name":"x"}']),
      added('.github/workflows/ci.yml', ['on: push']),
      added('test/misc/other.test.ts', n(3, 'o')),
    ].join('');
    const parsed = parseDiff(diff);
    assert.ok(parsed.ok);
    const s = suggestSplit(parsed.files);
    assert.ok(s !== null);
    assert.deepEqual(s.groups.map((g) => g.name), ['dependencies', 'code: src/payments', 'code: src/ui', 'tests: test/misc', 'tooling and CI', 'docs']);
    assert.deepEqual(s.groups[1]?.files, ['src/payments/charge.ts', 'test/payments/charge.test.ts']);
    assert.equal(s.groups[1]?.lines, 420);
    const tight = suggestSplit(parsed.files, { maxLines: 1000, maxFiles: 3 });
    assert.ok(tight !== null, 'the file count alone can put a change over the line');
  });

  it('--map adds the map and split to the output and never changes the exit code', () => {
    const dir = tempDir('review-map');
    writeFileSync(join(dir, 'change.diff'), [added('src/a.ts', n(450)), caseRow].join(''));
    const ctx = { env: { OPENMORALS_HOME: dir } as NodeJS.ProcessEnv, cwd: dir, readStdin: () => new Uint8Array() };
    const settings = { merge: undefined, source: 'the test' };
    const plain = diffClassCommandWith([join(dir, 'change.diff')], ctx, settings);
    const mapped = diffClassCommandWith([join(dir, 'change.diff'), '--map'], ctx, settings);
    assert.equal(mapped.exitCode, plain.exitCode);
    assert.match(mapped.stdout, /Review map, riskiest first/);
    assert.match(mapped.stdout, /Split suggestion: 452 changed lines/);
    const json = JSON.parse(diffClassCommandWith([join(dir, 'change.diff'), '--map', '--json'], ctx, settings).stdout);
    assert.equal(json.map.files[0].path, 'src/a.ts');
    assert.equal(json.split.groups.length, 2);
  });

  it('--map keeps a review-free change review-free and the JSON verdict the same', () => {
    const dir = tempDir('review-map');
    writeFileSync(join(dir, 'change.diff'), caseRow);
    mkdirSync(join(dir, 'cases'));
    writeFileSync(join(dir, 'cases', 'destructive.cases.yaml'), BASE_CASES);
    const ctx = { env: { OPENMORALS_HOME: dir } as NodeJS.ProcessEnv, cwd: dir, readStdin: () => new Uint8Array() };
    const settings = { merge: { review_free: ['tighten-only' as const], always_review: [] }, source: 'the test' };
    const plain = diffClassCommandWith([join(dir, 'change.diff'), '--json'], ctx, settings);
    const mapped = diffClassCommandWith([join(dir, 'change.diff'), '--map', '--json'], ctx, settings);
    assert.equal(plain.exitCode, 0);
    assert.equal(mapped.exitCode, 0);
    const a = JSON.parse(plain.stdout);
    const b = JSON.parse(mapped.stdout);
    delete b.map;
    delete b.split;
    assert.deepEqual(b, a);
  });
});
