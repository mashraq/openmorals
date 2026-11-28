import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { resolveBylaws } from '../../src/bylaws.js';
import { SANDBOX_REFUSED_EXIT, sandboxCommand } from '../../src/sandbox/index.js';
import type { SandboxCommandDeps, SpawnLike } from '../../src/sandbox/index.js';
import { REPO_ROOT, tempDir } from '../helpers.js';

const PROTECTED_NO_VERSION = 'sandbox:\n  write:\n    protected_paths: [test-lock]\n';
const PROTECTED = `version: 1\n${PROTECTED_NO_VERSION}`;

interface Setup {
  home: string;
  proj: string;
  calls: number;
  deps: SandboxCommandDeps;
}

function setup(user: string | null, project: string | null): Setup {
  const home = tempDir('ib-home');
  const proj = realpathSync(tempDir('ib-proj'));
  if (user !== null) writeFileSync(join(home, 'openmorals.yaml'), user);
  if (project !== null) writeFileSync(join(proj, 'openmorals.yaml'), project);
  const s: Setup = { home, proj, calls: 0, deps: {} };
  const spawn: SpawnLike = async () => {
    s.calls++;
    return { code: 0, signal: null };
  };
  s.deps = { platform: 'darwin', detect: () => '/usr/bin/sandbox-exec', spawn, planInputs: (root) => ({ projectRoot: root, opts: { home: '/home/someone', tmpDirs: ['/tmp'] } }), env: { PATH: '/usr/bin' } };
  return s;
}

async function both(s: Setup): Promise<{ plan: Awaited<ReturnType<typeof sandboxCommand>>; json: Awaited<ReturnType<typeof sandboxCommand>>; run: Awaited<ReturnType<typeof sandboxCommand>> }> {
  const load = resolveBylaws(s.proj, { OPENMORALS_HOME: s.home });
  return {
    plan: await sandboxCommand(['plan', '--platform', 'darwin'], load, s.proj, s.deps),
    json: await sandboxCommand(['plan', '--json', '--platform', 'darwin'], load, s.proj, s.deps),
    run: await sandboxCommand(['run', '--', '/bin/sh', '-c', 'echo changed > test/acceptance/a.test.js'], load, s.proj, s.deps),
  };
}

describe('sandbox plan and run with a bylaws file that is not valid (0.17.0: fail closed)', () => {
  it('an invalid user-level file: plan exits 1 naming the file and the first error; run exits 125 and starts nothing', async () => {
    const s = setup(PROTECTED_NO_VERSION, null);
    const r = await both(s);
    const file = join(s.home, 'openmorals.yaml');
    assert.equal(r.plan.exitCode, 1);
    assert.equal(r.plan.stdout, '');
    assert.ok(r.plan.stderr.includes(`the bylaws file ${file} is invalid (version: must be 1)`), r.plan.stderr);
    assert.match(r.plan.stderr, /run openmorals validate/);
    assert.doesNotMatch(r.plan.stderr, /enforced: yes/);
    assert.equal(r.json.exitCode, 1);
    const j = JSON.parse(r.json.stdout) as { plan: { ok: boolean; error: string } };
    assert.equal(j.plan.ok, false);
    assert.match(j.plan.error, /is invalid \(version: must be 1\)/);
    assert.equal(r.run.exitCode, SANDBOX_REFUSED_EXIT);
    assert.match(r.run.stderr, /refused: no valid sandbox plan \(the bylaws file .* is invalid \(version: must be 1\).*\)\. The command was not run\./);
    assert.equal(s.calls, 0, 'the child was started');
  });

  it('an invalid project file over a valid user-level file: the same refusal, naming the project file', async () => {
    const s = setup(PROTECTED, 'version: 1\nsandbox:\n  shell: true\n');
    const r = await both(s);
    assert.equal(r.plan.exitCode, 1);
    assert.ok(r.plan.stderr.includes(`the bylaws file ${join(s.proj, 'openmorals.yaml')} is invalid (sandbox.shell: unknown key (allowed: network, write, read))`), r.plan.stderr);
    assert.equal(r.run.exitCode, SANDBOX_REFUSED_EXIT);
    assert.equal(s.calls, 0);
  });

  it('an unreadable user-level file is refused the same way', async () => {
    const s = setup(null, null);
    mkdirSync(join(s.home, 'openmorals.yaml'));
    const r = await both(s);
    assert.equal(r.plan.exitCode, 1);
    assert.match(r.plan.stderr, /is invalid \(cannot read/);
    assert.equal(r.run.exitCode, SANDBOX_REFUSED_EXIT);
    assert.equal(s.calls, 0);
  });

  it('no bylaws file at all is unchanged: a plan from the defaults, and the command runs', async () => {
    const s = setup(null, null);
    const r = await both(s);
    assert.equal(r.plan.exitCode, 0, r.plan.stderr);
    assert.match(r.plan.stdout, /enforced: yes, by sandbox-exec {3}bylaws: <defaults>/);
    assert.equal(r.run.exitCode, 0, r.run.stderr);
    assert.equal(s.calls, 1);
  });

  it('a valid user-level file with protected paths still plans them', async () => {
    const s = setup(PROTECTED, null);
    const r = await both(s);
    assert.equal(r.plan.exitCode, 0, r.plan.stderr);
    assert.match(r.plan.stdout, /protected \(sandbox\.write\.protected_paths\)/);
  });

  it('through the built CLI: sandbox run with the invalid file leaves the judging test unchanged', () => {
    const s = setup(PROTECTED_NO_VERSION, null);
    mkdirSync(join(s.proj, 'test', 'acceptance'), { recursive: true });
    const judged = join(s.proj, 'test', 'acceptance', 'a.test.js');
    writeFileSync(judged, 'original\n');
    const cli = join(REPO_ROOT, 'dist', 'src', 'cli.js');
    const env = { ...process.env, OPENMORALS_HOME: s.home };
    const run = spawnSync(process.execPath, [cli, 'sandbox', 'run', '--', '/bin/sh', '-c', 'echo changed > test/acceptance/a.test.js'], { cwd: s.proj, encoding: 'utf8', env, timeout: 30000 });
    assert.equal(run.status, SANDBOX_REFUSED_EXIT, run.stderr);
    assert.equal(readFileSync(judged, 'utf8'), 'original\n');
    const plan = spawnSync(process.execPath, [cli, 'sandbox', 'plan'], { cwd: s.proj, encoding: 'utf8', env, timeout: 30000 });
    assert.equal(plan.status, 1);
    assert.doesNotMatch(plan.stdout + plan.stderr, /enforced: yes/);
  });
});
