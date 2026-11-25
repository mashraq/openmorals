import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_BYLAWS, cloneBylaws, compileRuleRegex, parseBylaws, resolveBylaws } from '../../src/bylaws.js';
import { compileGlob } from '../../src/diffclass/glob.js';
import { tighten } from '../../src/packs/compare.js';
import { findProtectedPaths, globToSeatbeltRegex, planSandbox } from '../../src/sandbox/index.js';
import { TEST_LOCK_PROTECTED_GLOBS, expandProtectedPaths, validateSandboxSection } from '../../src/sandbox/section.js';
import type { PlanOptions, SandboxPlan } from '../../src/sandbox/types.js';
import { REPO_ROOT, tempDir } from '../helpers.js';

const ROOT = '/work/proj';
const HOME = '/home/someone';

function plan(platform: string, protectedPaths: string[] | undefined, extra: Partial<PlanOptions> = {}): SandboxPlan {
  const b = cloneBylaws(DEFAULT_BYLAWS);
  if (protectedPaths !== undefined) b.sandbox.write.protected_paths = protectedPaths;
  return planSandbox(b, platform, ROOT, { home: HOME, tmpDirs: platform === 'win32' ? [] : ['/tmp'], ...extra });
}

const FOUND = [`${ROOT}/test/acceptance`, `${ROOT}/web/a/__snapshots__`, `${ROOT}/vitest.config.ts`];

describe('sandbox.write.protected_paths: the setting', () => {
  it('accepts test-lock and globs, and refuses what a profile could not hold', () => {
    const ok = validateSandboxSection({ write: { protected_paths: ['test-lock', 'spec/judging/', '**/golden/*.json', 'test-lock'] } });
    assert.ok(ok.ok);
    if (ok.ok) assert.deepEqual(ok.section.protectedPaths, ['test-lock', 'spec/judging/', '**/golden/*.json']);
    for (const bad of ['/abs/path', 'a\\b', '../up', 'say"hi', '[ab]', '', 'x\u0001']) {
      const r = validateSandboxSection({ write: { protected_paths: [bad] } });
      assert.equal(r.ok, false, JSON.stringify(bad));
    }
    assert.equal(validateSandboxSection({ write: { protected_paths: 'test-lock' } }).ok, false);
    assert.equal(validateSandboxSection({ write: { protected_paths: Array.from({ length: 201 }, (_, i) => `p${i}/`) } }).ok, false);
    const none = validateSandboxSection({ write: { allow: [] } });
    assert.ok(none.ok && none.section.protectedPaths === undefined, 'absent stays absent');
  });

  it('is absent from the defaults, so a default plan and the default bylaws are unchanged', () => {
    assert.equal('protected_paths' in DEFAULT_BYLAWS.sandbox.write, false);
    const p = plan('darwin', undefined);
    assert.ok(p.ok);
    if (!p.ok || p.platform !== 'darwin') return;
    assert.equal(p.policy.protectedGlobs, undefined);
    assert.doesNotMatch(p.seatbelt, /protected paths/);
    assert.ok(!p.notes.some((n) => n.startsWith('protected paths')));
  });

  it('comes from the user-level file only: a project file can neither set it nor drop the user\'s entries', () => {
    const user = parseBylaws('version: 1\nsandbox:\n  write:\n    protected_paths: [test-lock]\n', 'user.yaml');
    assert.ok(user.ok);
    if (!user.ok) return;
    assert.deepEqual(user.bylaws.sandbox.write.protected_paths, ['test-lock']);
    const proj = parseBylaws('version: 1\nsandbox:\n  write:\n    protected_paths: [docs/]\n', 'openmorals.yaml', user.bylaws, true);
    assert.ok(proj.ok);
    if (!proj.ok) return;
    const merged = tighten(proj.bylaws, user.bylaws);
    assert.deepEqual(merged.bylaws.sandbox.write.protected_paths, ['test-lock']);
    assert.ok(merged.ignored.some((l) => l.field === 'sandbox.write.protected_paths' && l.baseline.includes('user-level only')), JSON.stringify(merged.ignored));
    const noUser = tighten(proj.bylaws, cloneBylaws(DEFAULT_BYLAWS));
    assert.equal(noUser.bylaws.sandbox.write.protected_paths, undefined, 'a project file alone sets nothing');
  });

  it('resolveBylaws reads it from the config directory and ignores the project\'s', () => {
    const home = tempDir('pp-home');
    const cwd = tempDir('pp-proj');
    writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\nsandbox:\n  write:\n    protected_paths: [spec/judging/]\n');
    writeFileSync(join(cwd, 'openmorals.yaml'), 'version: 1\nsandbox:\n  write:\n    protected_paths: []\n');
    const r = resolveBylaws(cwd, { OPENMORALS_HOME: home });
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.bylaws.sandbox.write.protected_paths, ['spec/judging/']);
  });

  it('test-lock expands to the paths the test-lock pack protects by rule, and they agree path by path', () => {
    const pack = parseYaml(readFileSync(join(REPO_ROOT, 'packs', 'test-lock.yaml'), 'utf8')) as { rules: Array<{ id: string; match: { path?: string } }> };
    const re = (id: string): RegExp => compileRuleRegex(pack.rules.find((r) => r.id === id)?.match.path ?? '$^');
    const judging = re('test-lock.judging-tests');
    const runner = re('test-lock.runner-config');
    const globs = expandProtectedPaths(['test-lock']).map(compileGlob);
    assert.deepEqual(expandProtectedPaths(['test-lock']), [...TEST_LOCK_PROTECTED_GLOBS]);
    const paths = [
      'test/acceptance/a.test.ts', 'tests/acceptance/x/y.py', 'pkg/test/contracts/c.ts', 'a/tests/contract/z.js', 'test/contract/k.go',
      '__snapshots__/a.snap', 'src/__snapshots__/b.js', 'x.snap', 'deep/dir/conftest.py', 'conftest.py', 'vitest.config.ts', 'web/jest.config.mjs',
      'pytest.ini', 'app/dart_test.yaml', 'TEST/ACCEPTANCE/A.TS', 'Src/__SNAPSHOTS__/c.txt',
      'test/unit/a.test.ts', 'tests/acceptances/a.js', 'src/snapshot.ts', 'x.snapshot', 'conftest.pyc', 'vitest.config', 'pytest.ini.bak',
      'mytest/acceptance/x.js', 'test/acceptance', 'jest.config', 'src/test.ts', 'testacceptance/x',
    ];
    for (const p of paths) {
      const byPack = judging.test(p) || runner.test(p) || judging.test(`${p}/`);
      assert.equal(globs.some((g) => g(p)), byPack, `${p}: pack ${byPack}`);
    }
  });
});

describe('sandbox.write.protected_paths: the plans', () => {
  it('macOS: one regex per pattern and the parent folders of what was found, as single entries', () => {
    const p = plan('darwin', ['test-lock', 'spec/judging/'], { protectedFound: FOUND });
    assert.ok(p.ok && p.platform === 'darwin', p.ok ? '' : p.error);
    if (!p.ok || p.platform !== 'darwin') return;
    assert.deepEqual(p.policy.protectedGlobs, [...TEST_LOCK_PROTECTED_GLOBS, 'spec/judging/']);
    assert.deepEqual(p.policy.protectedAncestors, [`${ROOT}/test`, `${ROOT}/web/a`, `${ROOT}/web`]);
    assert.ok(p.seatbelt.includes(`(regex #"^/work/proj/([^/]+/)*[tT][eE][sS][tT]/[aA][cC][cC][eE][pP][tT][aA][nN][cC][eE](/|$)")`), p.seatbelt);
    assert.ok(p.seatbelt.includes('(regex #"^/work/proj/(.*/)?[^/]*\\.[sS][nN][aA][pP](/|$)")'), p.seatbelt);
    assert.ok(p.seatbelt.includes('(regex #"^/work/proj/[sS][pP][eE][cC]/[jJ][uU][dD][gG][iI][nN][gG](/|$)")'), p.seatbelt);
    assert.ok(p.seatbelt.includes(`(literal "${ROOT}/test")`));
    assert.ok(p.srt.filesystem.denyWrite.includes(`${ROOT}/vitest.config.ts`));
    assert.ok(p.notes.some((n) => /read-only by pattern in the seatbelt profile.*3 existing match/.test(n)), p.notes.join('\n'));
    assert.ok(p.notes.some((n) => n.includes('srt settings carry the protected paths found now (literal paths), not the patterns')));
    assert.equal((p.seatbelt.match(/\(/g) ?? []).length, (p.seatbelt.match(/\)/g) ?? []).length, 'balanced parentheses');
  });

  it('macOS without a search for existing matches says the parent folders are not covered', () => {
    const p = plan('darwin', ['test-lock']);
    assert.ok(p.ok);
    if (p.ok) assert.ok(p.notes.some((n) => n.includes('existing matches were not searched, so a parent folder of a protected path can still be renamed')));
  });

  it('Linux: only the paths found now are bound read-only, and the plan says what that leaves out', () => {
    const probe = (x: string): 'dir' | 'file' | 'missing' => (x.endsWith('.ts') ? 'file' : FOUND.includes(x) ? 'dir' : x.startsWith(ROOT) ? 'missing' : 'dir');
    const p = plan('linux', ['test-lock'], { protectedFound: FOUND, probe });
    assert.ok(p.ok && p.platform === 'linux');
    if (!p.ok || p.platform !== 'linux') return;
    for (const f of FOUND) assert.ok(p.bwrapArgs.join(' ').includes(`--ro-bind ${f} ${f}`), f);
    assert.ok(p.notes.some((n) => n.includes('a file created later under a protected pattern, or a renamed parent folder, is not covered') && n.includes('not run on Linux')), p.notes.join('\n'));
    const none = plan('linux', ['test-lock'], { protectedFound: [], probe });
    assert.ok(none.ok && none.notes.some((n) => n.includes('the 0 protected path(s) found now')));
  });

  it('Windows: written into the plan, and said to be unenforced', () => {
    const p = planSandbox((() => { const b = cloneBylaws(DEFAULT_BYLAWS); b.sandbox.write.protected_paths = ['test-lock']; return b; })(), 'win32', 'C:\\work\\proj', { home: 'C:\\Users\\someone', tmpDirs: [], protectedFound: ['C:\\work\\proj\\test\\acceptance'] });
    assert.ok(p.ok && p.platform === 'win32');
    if (!p.ok || p.platform !== 'win32') return;
    assert.ok(p.windows.steps.some((s) => s.includes('deny the sandbox capability SID write on C:\\work\\proj\\test\\acceptance')));
    assert.ok(p.notes.some((n) => n.includes('not enforced on Windows')));
  });

  it('refuses a found path outside the project root', () => {
    const p = plan('darwin', ['test-lock'], { protectedFound: ['/elsewhere/test/acceptance'] });
    assert.equal(p.ok, false);
  });

  it('names hard-linked protected files in the notes', () => {
    const p = plan('darwin', ['test-lock'], { protectedFound: FOUND, protectedLinked: [`${ROOT}/test/acceptance/a.test.ts`] });
    assert.ok(p.ok && p.notes.some((n) => n.includes('1 protected file(s) have another hard link')));
  });
});

describe('sandbox.write.protected_paths: the Seatbelt regex reads a glob the way the glob reader does', () => {
  it('for every test-lock glob and a few more, on paths in and out', () => {
    const globs = [...TEST_LOCK_PROTECTED_GLOBS, 'src/**', 'docs/adr/0013-*', 'README*', 'a/**/b/', 'x?y.txt', 'we(i)rd+dir/'];
    const paths = ['test/acceptance/a.ts', 'a/b/test/acceptance', 'x/__snapshots__/s', 'f.snap', 'a/f.SNAP', 'conftest.py', 'z/conftest.py', 'conftest.py.bak',
      'vitest.config.ts', 'vitest.configts', 'src', 'src/a/b.ts', 'srcx/a', 'docs/adr/0013-x.md', 'docs/adr/0014-x.md', 'README', 'readme.md', 'x/README.md',
      'a/b/c', 'a/q/r/b/c', 'ab/c', 'xay.txt', 'xy.txt', 'we(i)rd+dir/f', 'weirddir/f', 'dart_test.yaml', 'pytest.ini'];
    for (const g of globs) {
      const sb = new RegExp(globToSeatbeltRegex(g, ROOT));
      const gl = compileGlob(g);
      for (const p of paths) assert.equal(sb.test(`${ROOT}/${p}`), gl(p), `${g} on ${p}`);
      assert.equal(sb.test(`/other/${'test/acceptance/a.ts'}`), false);
    }
  });
});

describe('sandbox.write.protected_paths: finding what exists now', () => {
  it('finds matches, takes a matching folder whole, skips .git and node_modules, and notes hard links', () => {
    const root = realpathSync(tempDir('pp-find'));
    for (const d of ['test/acceptance/deep', 'web/a/__snapshots__', 'node_modules/x/test/acceptance', '.git/test/acceptance', 'src']) mkdirSync(join(root, d), { recursive: true });
    for (const f of ['test/acceptance/deep/a.test.ts', 'web/a/__snapshots__/s.snap', 'src/x.ts', 'vitest.config.ts', 'web/conftest.py']) writeFileSync(join(root, f), 'x');
    linkSync(join(root, 'test/acceptance/deep/a.test.ts'), join(root, 'src', 'alias.ts'));
    const r = findProtectedPaths(root, expandProtectedPaths(['test-lock']));
    assert.deepEqual([...r.found].sort(), [join(root, 'test/acceptance'), join(root, 'vitest.config.ts'), join(root, 'web/a/__snapshots__'), join(root, 'web/conftest.py')].sort());
    assert.deepEqual(r.linked, [join(root, 'test/acceptance/deep/a.test.ts')]);
  });
});

describe('sandbox.write.protected_paths: openmorals sandbox plan', () => {
  it('shows the protected patterns and what was found, from the user-level file', () => {
    const home = tempDir('pp-cli-home');
    const proj = realpathSync(tempDir('pp-cli-proj'));
    mkdirSync(join(proj, 'test', 'acceptance'), { recursive: true });
    writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\nsandbox:\n  write:\n    protected_paths: [test-lock]\n');
    const r = spawnSync(process.execPath, [join(REPO_ROOT, 'dist', 'src', 'cli.js'), 'sandbox', 'plan', '--platform', 'darwin'], { cwd: proj, encoding: 'utf8', env: { ...process.env, OPENMORALS_HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /protected \(sandbox\.write\.protected_paths\): \*\*\/test\/acceptance\/ /);
    assert.ok(r.stdout.includes(`found now: ${join(proj, 'test', 'acceptance')}`), r.stdout);
    assert.match(r.stdout, /;; protected paths \(sandbox\.write\.protected_paths\)/);
  });
});
