import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_BYLAWS } from '../../src/bylaws.js';
import { decide } from '../../src/engine.js';
import { FAIL_FIRST_SETTINGS_FILE } from '../../src/tests/failfirst-run.js';
import { EMPTY_STATE } from '../../src/types.js';
import { REPO_ROOT, tempDir } from '../helpers.js';
import { BASE_FILES, HEAD_FILES, NODE_COMMAND, cleanGitEnv, commit, fixtureRepo, git, snapshot, writeSettings } from './fixture.js';

const CLI = join(REPO_ROOT, 'dist', 'src', 'cli.js');
const BOUND = { timeout: 90000 };

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Env {
  home: string;
  tmp: string;
  cwd: string;
  out: string;
}

function env(command: string | null = NODE_COMMAND): Env {
  const e: Env = { home: tempDir('ff-home'), tmp: tempDir('ff-tmp'), cwd: tempDir('ff-cwd'), out: tempDir('ff-out') };
  if (command !== null) writeSettings(e.home, command);
  return e;
}

function childEnv(e: Env, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...cleanGitEnv(), OPENMORALS_HOME: e.home, TMPDIR: e.tmp, OUT_DIR: e.out, OPENMORALS_UNATTENDED: '', ...extra };
}

function run(e: Env, args: string[], extra: NodeJS.ProcessEnv = {}): Run {
  const r = spawnSync(process.execPath, [CLI, 'tests', 'fail-first', ...args], { encoding: 'utf8', cwd: e.cwd, env: childEnv(e, extra), timeout: 80000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((res) => setTimeout(res, 50));
  }
  return false;
}

function tmpLeft(e: Env): string[] {
  return readdirSync(e.tmp);
}

describe('tests fail-first: end to end on a fixture repository (node --test, junit)', () => {
  it('reports the three outcomes per test, and only named acceptance tests decide the exit code', BOUND, () => {
    const f = fixtureRepo();
    const e = env();
    const before = snapshot(f.repo);
    const none = run(e, ['--repo', f.repo, '--base', f.base]);
    assert.equal(none.code, 0, none.stderr + none.stdout);
    assert.match(none.stdout, /test files the change added or changed: 4 run, 1 more copied/);
    assert.match(none.stdout, /New tests that fail on base by assertion: 1\n {2}\+ test\/clamp\.test\.mjs > clamps high {3}fails on base by assertion \(AssertionError\); passes at head/);
    assert.match(none.stdout, /! test\/mul\.test\.mjs > multiplies {3}red for the wrong reason on base \(TypeError\)/);
    assert.match(none.stdout, /! test\/named\.test\.mjs > multiplies by name {3}red for the wrong reason on base: the file did not load/);
    assert.match(none.stdout, /New tests that pass on base \(pointer lines[^\n]*: 1\n {2}> test\/add\.test\.mjs > adds negatives {3}passes on base; passes at head/);
    assert.ok(!none.stdout.includes('> adds   '), 'a test that existed on base is not listed');
    assert.match(none.stdout, /no acceptance test was named, so nothing here can fail the check/);
    const ok = run(e, ['--repo', f.repo, '--base', f.base, '--expect-red', 'clamps high', '--expect-red', 'test/named.test.mjs > multiplies by name']);
    assert.equal(ok.code, 0, ok.stdout);
    assert.match(ok.stdout, /1 of them only by an error or for a reason the report does not show/);
    const red = run(e, ['--repo', f.repo, '--base', f.base, '--expect-red', 'clamps high', '--expect-red', 'adds negatives']);
    assert.equal(red.code, 1, red.stdout);
    assert.match(red.stdout, /test\/add\.test\.mjs > adds negatives: passes on base, so it does not show the change is needed/);
    assert.equal(snapshot(f.repo), before, 'nothing in the working tree, the index or .git changed');
    assert.deepEqual(tmpLeft(e), [], 'the temporary checkouts are gone');
  });

  it('--json carries the lists; --reports copies the reports outside the repository for tests compare', BOUND, () => {
    const f = fixtureRepo();
    const e = env();
    const r = run(e, ['--repo', f.repo, '--base', f.base, '--json', '--expect-red', 'clamps high', '--reports', join(e.out, 'r')]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const j = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.equal(j['head'], f.head);
    assert.deepEqual(j['newPassingOnBase'], ['test/add.test.mjs > adds negatives']);
    assert.deepEqual(j['redWrongReason'], ['test/mul.test.mjs > multiplies', 'test/named.test.mjs > multiplies by name']);
    assert.deepEqual(j['copiedFiles'], ['test/helpers/data.json']);
    assert.deepEqual(readdirSync(join(e.out, 'r')).sort(), ['fail-first-base.xml', 'fail-first-before.xml', 'fail-first-head.xml']);
    const roots = j['reportRoots'] as Record<string, string>;
    const cmp = spawnSync(process.execPath, [CLI, 'tests', 'compare', join(e.out, 'r', 'fail-first-base.xml'), join(e.out, 'r', 'fail-first-head.xml'), '--before-root', roots['base'] ?? '', '--after-root', roots['head'] ?? ''], { encoding: 'utf8', cwd: e.cwd, env: childEnv(e) });
    assert.equal(cmp.status, 0, cmp.stdout);
    assert.match(cmp.stdout, /Failed or absent before, pass after: 3/);
    const inside = run(e, ['--repo', f.repo, '--base', f.base, '--reports', join(f.repo, 'reports')]);
    assert.equal(inside.code, 64);
    assert.match(inside.stderr, /inside the repository/);
    assert.equal(existsSync(join(f.repo, 'reports')), false);
    assert.deepEqual(tmpLeft(e), []);
  });

  it('a change with no test file and no named test runs nothing and exits 0', BOUND, () => {
    const f = fixtureRepo({ 'lib.mjs': HEAD_FILES['lib.mjs'] ?? '' });
    const e = env(`touch "$OUT_DIR/ran"; exit 7`);
    const r = run(e, ['--repo', f.repo, '--base', f.base]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /adds or changes no test file and no acceptance test was named, so nothing was run/);
    assert.equal(existsSync(join(e.out, 'ran')), false);
  });

  it('notes uncommitted changes and does not read them', BOUND, () => {
    const f = fixtureRepo();
    writeFileSync(join(f.repo, 'test', 'clamp.test.mjs'), 'this would not even parse');
    const e = env();
    const r = run(e, ['--repo', f.repo, '--base', f.base, '--expect-red', 'clamps high']);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /1 uncommitted change\(s\) in the working tree are not part of this check/);
  });
});

describe('tests fail-first: where the test command comes from', () => {
  it('with no user-level test command it exits 3 and runs nothing, whatever the project and the change say', BOUND, () => {
    const marker = join(tempDir('ff-marker'), 'ran');
    const f = fixtureRepo({
      ...HEAD_FILES,
      'package.json': JSON.stringify({ scripts: { test: `touch ${marker}` } }),
      [FAIL_FIRST_SETTINGS_FILE]: `fail_first:\n  command: ${JSON.stringify(`touch ${marker}`)}\n`,
      'openmorals.yaml': 'version: 1\n',
    });
    const e = env(null);
    const r = run(e, ['--repo', f.repo, '--base', f.base, '--expect-red', 'clamps high']);
    assert.equal(r.code, 3, r.stderr);
    assert.ok(r.stderr.includes(join(e.home, FAIL_FIRST_SETTINGS_FILE)), r.stderr);
    assert.match(r.stderr, /never takes the test command from the project, its package scripts or the change/);
    assert.equal(existsSync(marker), false);
    assert.deepEqual(tmpLeft(e), []);
    const j = run(e, ['--repo', f.repo, '--base', f.base, '--json']);
    assert.equal(j.code, 3);
    assert.equal((JSON.parse(j.stdout) as { exitCode: number }).exitCode, 3);
  });

  it('a settings file it cannot use exits 2, naming the problem', () => {
    const f = fixtureRepo();
    for (const [text, want] of [
      ['fail_first:\n  command: ""\n', /must be a non-empty string/],
      ['fail_first:\n  command: x\n  timeout_s: 0\n', /timeout_s must be a whole number/],
      ['fail_first:\n  command: x\n  shell: bash\n', /unknown key fail_first\.shell/],
      ['tests:\n  command: x\n', /unknown key tests/],
      ['fail_first: [\n', /YAML parse error/],
    ] as const) {
      const e = env(null);
      writeFileSync(join(e.home, FAIL_FIRST_SETTINGS_FILE), text);
      const r = run(e, ['--repo', f.repo, '--base', f.base]);
      assert.equal(r.code, 2, `${text}: ${r.stderr}`);
      assert.match(r.stderr, want);
      assert.match(r.stderr, /Nothing was judged/);
    }
  });

  it('an agent writing the settings file in the config directory is not allowed (self-protect)', () => {
    const home = tempDir('ff-sp');
    for (const path of [join(home, FAIL_FIRST_SETTINGS_FILE), `/home/someone/.config/openmorals/${FAIL_FIRST_SETTINGS_FILE}`]) {
      const v = decide({ kind: 'write', path, tool: 'Write' }, DEFAULT_BYLAWS, EMPTY_STATE, undefined, { configDir: home, home: '/home/someone' });
      assert.notEqual(v.decision, 'allow', `${path}: ${v.rule}`);
      const sh = decide({ kind: 'exec', command: `printf 'fail_first:\\n  command: true\\n' > ${path}`, shell: 'posix', tool: 'Bash' }, DEFAULT_BYLAWS, EMPTY_STATE, undefined, { configDir: home, home: '/home/someone' });
      assert.notEqual(sh.decision, 'allow', `shell write to ${path}: ${sh.rule}`);
    }
  });
});

describe('tests fail-first: nothing judged is never a pass', () => {
  it('no repository, no base, a head that is not a commit: exit 2', BOUND, () => {
    const f = fixtureRepo();
    const e = env();
    for (const args of [['--repo', e.out, '--base', 'HEAD'], ['--repo', f.repo, '--base', 'no-such-branch'], ['--repo', f.repo, '--base', f.base, '--head', 'deadbeef']]) {
      const r = run(e, args);
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, /Nothing was judged: read this as "needs review", never as a pass/);
    }
    assert.deepEqual(tmpLeft(e), []);
  });

  it('a command that writes no report exits 2 and shows its last lines', BOUND, () => {
    const f = fixtureRepo();
    const e = env('echo "runner says: no such reporter" >&2; exit 4');
    const r = run(e, ['--repo', f.repo, '--base', f.base]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /the test command on the base with the change's tests wrote no report to \$OPENMORALS_REPORT \(exit 4\)/);
    assert.match(r.stderr, /\| runner says: no such reporter/);
    assert.deepEqual(tmpLeft(e), []);
  });

  it('usage errors exit 64', () => {
    const e = env();
    for (const args of [[], ['--base'], ['--base', 'a', 'extra'], ['--base', 'a', '--bogus'], ['--base', 'a', '--timeout', '0'], ['--base', 'a', '--timeout', '1.5'], ['--base', 'a', '--head', 'b', '--head', 'c'], ['--base', '-x']]) {
      const r = run(e, args);
      assert.equal(r.code, 64, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, /Usage:/);
    }
  });

  it('help names the command', () => {
    const r = spawnSync(process.execPath, [CLI, 'tests', 'fail-first', '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /openmorals tests fail-first --base REV/);
  });
});

describe('tests fail-first: safety of running', () => {
  it('a timeout stops the command\'s whole process group, exits 2 and removes the temporary checkouts', BOUND, async () => {
    const f = fixtureRepo();
    const e = env('sleep 61 & echo $! > "$OUT_DIR/bg"; echo $$ > "$OUT_DIR/fg"; exec sleep 60');
    const t0 = Date.now();
    const r = run(e, ['--repo', f.repo, '--base', f.base, '--timeout', '1']);
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stderr, /did not finish within 1 s and was stopped/);
    assert.ok(Date.now() - t0 < 20000, 'bounded');
    for (const name of ['bg', 'fg']) {
      const pid = Number(readFileSync(join(e.out, name), 'utf8').trim());
      assert.ok(await gone(pid), `${name} process ${pid} still alive`);
    }
    assert.deepEqual(tmpLeft(e), []);
  });

  it('SIGTERM stops the command, removes the temporary checkouts and exits 143', BOUND, async () => {
    const f = fixtureRepo();
    const e = env('echo $$ > "$OUT_DIR/fg"; exec sleep 60');
    const child = spawn(process.execPath, [CLI, 'tests', 'fail-first', '--repo', f.repo, '--base', f.base], { cwd: e.cwd, env: childEnv(e), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (b: Buffer) => {
      stderr += b.toString('utf8');
    });
    const exited = new Promise<number | null>((res) => child.once('exit', (code) => res(code)));
    const fg = join(e.out, 'fg');
    for (let i = 0; i < 200 && !existsSync(fg); i++) await new Promise((res) => setTimeout(res, 50));
    assert.ok(existsSync(fg), 'the command started');
    assert.equal(tmpLeft(e).length, 1, 'one temporary folder while it runs');
    child.kill('SIGTERM');
    const code = await exited;
    assert.equal(code, 143, stderr);
    assert.match(stderr, /stopped by SIGTERM/);
    const pid = Number(readFileSync(fg, 'utf8').trim());
    assert.ok(await gone(pid), `process ${pid} still alive`);
    assert.deepEqual(tmpLeft(e), []);
  });

  it('the command gets no credential-named or git variable, and the repository\'s hooks never run', BOUND, () => {
    const f = fixtureRepo();
    const hook = join(f.repo, '.git', 'hooks', 'post-checkout');
    mkdirSync(join(f.repo, '.git', 'hooks'), { recursive: true });
    writeFileSync(hook, '#!/bin/sh\ntouch "$OUT_DIR/hook-ran"\n');
    chmodSync(hook, 0o755);
    const e = env(`env > "$OUT_DIR/env-$OPENMORALS_SIDE"; ${NODE_COMMAND}`);
    const r = run(e, ['--repo', f.repo, '--base', f.base], { FAKE_SERVICE_TOKEN: 'not-a-real-token', GIT_DIR: join(e.out, 'nowhere'), GIT_INDEX_FILE: join(e.out, 'nowhere-index') });
    assert.equal(r.code, 0, r.stderr);
    const seen = readFileSync(join(e.out, 'env-base'), 'utf8');
    assert.ok(!seen.includes('FAKE_SERVICE_TOKEN'), 'a credential-named variable reached the command');
    assert.ok(!/^GIT_/m.test(seen), 'a git variable reached the command');
    assert.match(seen, /^OPENMORALS_SIDE=base$/m);
    assert.match(seen, /^OPENMORALS_REPORT=/m);
    assert.equal(existsSync(join(e.out, 'hook-ran')), false);
    assert.deepEqual(readdirSync(e.out).sort(), ['env-base', 'env-before', 'env-head']);
  });

  it('the base gets the change\'s test files and nothing else from the change', BOUND, () => {
    const f = fixtureRepo();
    const e = env(`cat lib.mjs > "$OUT_DIR/lib-$OPENMORALS_SIDE"; ls test > "$OUT_DIR/tests-$OPENMORALS_SIDE"; ${NODE_COMMAND}`);
    const r = run(e, ['--repo', f.repo, '--base', f.base]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(join(e.out, 'lib-base'), 'utf8'), BASE_FILES['lib.mjs']);
    assert.equal(readFileSync(join(e.out, 'lib-head'), 'utf8'), HEAD_FILES['lib.mjs']);
    assert.equal(readFileSync(join(e.out, 'tests-base'), 'utf8'), 'add.test.mjs\nclamp.test.mjs\nhelpers\nmul.test.mjs\nnamed.test.mjs\n');
    assert.equal(readFileSync(join(e.out, 'tests-before'), 'utf8'), 'add.test.mjs\n');
  });

  it('a commit on top of the change still finds the base by name', BOUND, () => {
    const f = fixtureRepo();
    commit(f.repo, { 'README.md': 'x\n' }, 'docs');
    const e = env();
    const r = run(e, ['--repo', f.repo, '--base', 'HEAD~2', '--expect-red', 'clamps high']);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(git(f.repo, 'rev-parse', 'HEAD~2').trim(), f.base);
  });
});
