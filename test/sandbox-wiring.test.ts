import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_BYLAWS, DEFAULT_BYLAWS_YAML, parseBylaws } from '../src/bylaws.js';
import { loosenings } from '../src/packs/compare.js';
import { sandboxCommand } from '../src/sandbox/command.js';
import type { SandboxCommandDeps } from '../src/sandbox/command.js';
import { planSandbox } from '../src/sandbox/plan.js';
import type { SpawnLike } from '../src/sandbox/run.js';
import type { BylawsLoad } from '../src/types.js';
import { REPO_ROOT, tempDir } from './helpers.js';

const CLI = join(REPO_ROOT, 'dist', 'src', 'cli.js');

interface SchemaCase {
  name: string;
  yaml: string;
  ok: boolean;
  error?: RegExp;
}

const SCHEMA_CASES: SchemaCase[] = [
  { name: 'absent: network off, nothing extra', yaml: 'version: 1\n', ok: true },
  { name: 'empty section', yaml: 'version: 1\nsandbox:\n', ok: true },
  { name: 'full section', yaml: 'version: 1\nsandbox: { network: { allow_hosts: [registry.example.test, "*.example.org"] }, write: { allow: [~/.cache/tool, out] }, read: { deny: [private] } }\n', ok: true },
  { name: 'unknown key', yaml: 'version: 1\nsandbox: { exec: { allow: [] } }\n', ok: false, error: /sandbox\.exec: unknown key/ },
  { name: 'unknown nested key', yaml: 'version: 1\nsandbox: { network: { deny_hosts: [] } }\n', ok: false, error: /sandbox\.network\.deny_hosts: unknown key/ },
  { name: 'an IP address is not a host name', yaml: 'version: 1\nsandbox: { network: { allow_hosts: [10.0.0.1] } }\n', ok: false, error: /not a host name/ },
  { name: 'a bare star is refused', yaml: 'version: 1\nsandbox: { network: { allow_hosts: ["*"] } }\n', ok: false, error: /not a host name/ },
  { name: 'a URL is not a host name', yaml: 'version: 1\nsandbox: { network: { allow_hosts: ["https://x.example.test"] } }\n', ok: false, error: /not a host name/ },
  { name: 'allow is a string, not a list', yaml: 'version: 1\nsandbox: { write: { allow: out } }\n', ok: false, error: /sandbox\.write\.allow: must be a list of strings/ },
  { name: 'read.deny holds a number', yaml: 'version: 1\nsandbox: { read: { deny: [1] } }\n', ok: false, error: /sandbox\.read\.deny/ },
  { name: 'section not a mapping', yaml: 'version: 1\nsandbox: [a]\n', ok: false, error: /sandbox: must be a mapping/ },
];

describe('sandbox section of the bylaws', () => {
  for (const c of SCHEMA_CASES) {
    it(c.name, () => {
      const r = parseBylaws(c.yaml);
      assert.equal(r.ok, c.ok, r.ok ? 'valid' : r.error);
      if (!r.ok && c.error !== undefined) assert.match(r.error, c.error);
    });
  }
  it('the commented default file parses to the defaults', () => {
    const r = parseBylaws(DEFAULT_BYLAWS_YAML);
    assert.ok(r.ok);
    assert.deepEqual(r.bylaws.sandbox, DEFAULT_BYLAWS.sandbox);
  });
  it('the planner reads the section from the loaded bylaws', () => {
    const r = parseBylaws('version: 1\nsandbox: { network: { allow_hosts: [Registry.Example.Test] }, write: { allow: [out] } }\n');
    assert.ok(r.ok);
    const plan = planSandbox(r, 'darwin', '/work/app', { home: '/home/dev' });
    assert.ok(plan.ok);
    assert.deepEqual(plan.policy.network, { mode: 'hosts', hosts: ['registry.example.test'] });
    assert.ok(plan.policy.writable.includes('/work/app/out') || plan.policy.writable.includes('/work/app'));
    const off = planSandbox(parseBylaws('version: 1\n'), 'darwin', '/work/app', { home: '/home/dev' });
    assert.ok(off.ok);
    assert.deepEqual(off.policy.network, { mode: 'off' });
  });
  it('more hosts, more writable paths and fewer read-denied paths count as loosenings', () => {
    const base = parseBylaws('version: 1\nsandbox: { read: { deny: [private] } }\n');
    const cand = parseBylaws('version: 1\nsandbox: { network: { allow_hosts: [x.example.test] }, write: { allow: [out] } }\n');
    assert.ok(base.ok && cand.ok);
    assert.deepEqual(loosenings(cand.bylaws, base.bylaws).map((l) => l.field), ['sandbox.network.allow_hosts', 'sandbox.write.allow', 'sandbox.read.deny']);
    assert.deepEqual(loosenings(base.bylaws, cand.bylaws), []);
  });
});

const ROOT = '/work/app';
const fakeInputs: SandboxCommandDeps['planInputs'] = () => ({ projectRoot: ROOT, opts: { home: '/home/dev', tmpDirs: ['/private/tmp'] } });

function recorder(code: number): { spawn: SpawnLike; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    spawn: (file, args) => {
      calls.push([file, ...args]);
      return Promise.resolve({ code, signal: null });
    },
  };
}

const defaults: BylawsLoad = { ok: true, bylaws: DEFAULT_BYLAWS, source: '<defaults>' };

interface RunCase {
  name: string;
  rest: string[];
  platform: string;
  tool: string | null;
  childCode?: number;
  exit: number;
  started: boolean;
  stderr?: RegExp;
  bylaws?: BylawsLoad;
  inputs?: SandboxCommandDeps['planInputs'];
}

const winInputs: SandboxCommandDeps['planInputs'] = () => ({ projectRoot: 'C:\\work\\app', opts: { home: 'C:\\Users\\dev' } });

const RUN_CASES: RunCase[] = [
  { name: 'macOS with sandbox-exec: runs and passes the exit code through', rest: ['run', '--', 'npm', 'test'], platform: 'darwin', tool: '/usr/bin/sandbox-exec', childCode: 3, exit: 3, started: true },
  { name: 'Linux with bwrap: runs', rest: ['run', '--', 'make'], platform: 'linux', tool: '/usr/bin/bwrap', childCode: 0, exit: 0, started: true },
  { name: 'macOS without sandbox-exec: refuses with 125', rest: ['run', '--', 'npm', 'test'], platform: 'darwin', tool: null, exit: 125, started: false, stderr: /sandbox-exec was not found.*The command was not run/ },
  { name: 'Linux without bwrap: refuses with 125', rest: ['run', '--', 'make'], platform: 'linux', tool: null, exit: 125, started: false, stderr: /bwrap was not found/ },
  { name: 'Windows: plan only, refuses with 125', rest: ['run', '--', 'dir'], platform: 'win32', tool: 'C:\\fake', exit: 125, started: false, stderr: /documentation only/, inputs: winInputs },
  { name: 'an unknown platform refuses', rest: ['run', '--', 'ls'], platform: 'aix', tool: '/usr/bin/x', exit: 125, started: false, stderr: /no valid sandbox plan/ },
  { name: 'no "--" refuses', rest: ['run', 'npm', 'test'], platform: 'darwin', tool: '/usr/bin/sandbox-exec', exit: 125, started: false, stderr: /after "--"/ },
  { name: 'nothing after "--" refuses', rest: ['run', '--'], platform: 'darwin', tool: '/usr/bin/sandbox-exec', exit: 125, started: false },
  { name: 'a command starting with "-" refuses', rest: ['run', '--', '-rf'], platform: 'darwin', tool: '/usr/bin/sandbox-exec', exit: 125, started: false },
  { name: 'invalid bylaws still plan from the defaults (network off) and run', rest: ['run', '--', 'ls'], platform: 'darwin', tool: '/usr/bin/sandbox-exec', childCode: 0, exit: 0, started: true, bylaws: { ok: false, error: 'bad', source: 'x.yaml' } },
];

describe('openmorals sandbox (injected tool detection and spawn)', () => {
  for (const c of RUN_CASES) {
    it(c.name, async () => {
      const rec = recorder(c.childCode ?? 0);
      const res = await sandboxCommand(c.rest, c.bylaws ?? defaults, ROOT, { platform: c.platform, detect: () => c.tool, spawn: rec.spawn, planInputs: c.inputs ?? fakeInputs, env: { PATH: '/usr/bin', FAKE_API_TOKEN: 'x' } });
      assert.equal(res.exitCode, c.exit, res.stderr);
      assert.equal(rec.calls.length, c.started ? 1 : 0);
      if (c.stderr !== undefined) assert.match(res.stderr, c.stderr);
      if (c.started) {
        assert.equal(rec.calls[0]?.[0], c.tool);
        if (c.platform === 'darwin') assert.equal(rec.calls[0]?.[1], '-p');
        assert.deepEqual(rec.calls[0]?.slice(-(c.rest.length - 2)), c.rest.slice(2));
      }
    });
  }
  it('plan --json on macOS prints the Seatbelt profile with the network denied', async () => {
    const res = await sandboxCommand(['plan', '--json'], defaults, ROOT, { platform: 'darwin', planInputs: fakeInputs });
    assert.equal(res.exitCode, 0);
    const out = JSON.parse(res.stdout) as { plan: { ok: boolean; seatbelt: string } };
    assert.equal(out.plan.ok, true);
    assert.match(out.plan.seatbelt, /\(deny network/);
  });
  it('plan --platform linux prints bubblewrap arguments; win32 prints the written plan', async () => {
    const linux = await sandboxCommand(['plan', '--platform', 'linux'], defaults, ROOT, { platform: 'darwin', planInputs: fakeInputs });
    assert.equal(linux.exitCode, 0);
    assert.match(linux.stdout, /enforced: yes, by bwrap/);
    assert.match(linux.stdout, /"--unshare-all"/);
    const win = await sandboxCommand(['plan', '--platform=win32'], defaults, ROOT, { platform: 'darwin', planInputs: winInputs });
    assert.equal(win.exitCode, 0);
    assert.match(win.stdout, /enforced: no \(plan only\)/);
  });
  it('a plan that cannot be made exits 1; a bad flag exits 64', async () => {
    assert.equal((await sandboxCommand(['plan', '--platform', 'plan9'], defaults, ROOT, { planInputs: fakeInputs })).exitCode, 1);
    assert.equal((await sandboxCommand(['plan', '--verbose'], defaults, ROOT, { planInputs: fakeInputs })).exitCode, 64);
    assert.equal((await sandboxCommand(['explode'], defaults, ROOT, { planInputs: fakeInputs })).exitCode, 64);
  });
  it('drops credential-named variables from the child environment', async () => {
    let seen: Record<string, string> = {};
    const spawn: SpawnLike = (_f, _a, o) => {
      seen = o.env;
      return Promise.resolve({ code: 0, signal: null });
    };
    await sandboxCommand(['run', '--', 'ls'], defaults, ROOT, { platform: 'darwin', detect: () => '/usr/bin/sandbox-exec', spawn, planInputs: fakeInputs, env: { PATH: '/usr/bin', FAKE_API_TOKEN: 'x' } });
    assert.equal(seen['PATH'], '/usr/bin');
    assert.equal(seen['FAKE_API_TOKEN'], undefined);
  });
});

describe('openmorals sandbox through the CLI (nothing is run)', () => {
  // The project is a real temp folder, so its path has this machine's form: a Linux plan needs a POSIX root, a
  // Windows machine plans for win32 (a Linux plan of a drive path is refused; see the next case).
  const target = process.platform === 'win32' ? 'win32' : 'linux';
  it(`sandbox plan --json --platform ${target} exits 0 and reads the project bylaws`, () => {
    const cwd = tempDir('sbx-proj');
    const home = tempDir('sbx-home');
    writeFileSync(join(cwd, 'openmorals.yaml'), 'version: 1\nsandbox: { network: { allow_hosts: [registry.example.test] } }\n');
    const r = spawnSync(process.execPath, [CLI, 'sandbox', 'plan', '--json', '--platform', target], { cwd, env: { PATH: process.env['PATH'] ?? '', OPENMORALS_HOME: home }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout);
    const out = JSON.parse(r.stdout) as { plan: { platform: string; policy: { network: { hosts: string[] } }; srt?: { network: { allowedDomains: string[] } } } };
    assert.equal(out.plan.platform, target);
    assert.deepEqual(out.plan.policy.network.hosts, ['registry.example.test']);
    if (target === 'linux') assert.deepEqual(out.plan.srt?.network.allowedDomains, ['registry.example.test']);
  });
  it('a Linux plan of a Windows project folder is refused with exit 1, not made from a wrong path', async () => {
    const res = await sandboxCommand(['plan', '--json', '--platform', 'linux'], defaults, 'D:\\a\\proj', { platform: 'win32', planInputs: () => ({ projectRoot: 'D:\\a\\proj', opts: { home: 'C:\\Users\\dev' } }) });
    assert.equal(res.exitCode, 1);
    assert.match(res.stdout, /the project root contains a backslash/);
  });
  it('sandbox run without "--" refuses with 125 and runs nothing', () => {
    const cwd = tempDir('sbx-proj');
    const r = spawnSync(process.execPath, [CLI, 'sandbox', 'run', '/bin/echo', 'refused'], { cwd, env: { PATH: process.env['PATH'] ?? '', OPENMORALS_HOME: tempDir('sbx-home') }, encoding: 'utf8' });
    assert.equal(r.status, 125);
    assert.match(r.stderr, /The command was not run/);
  });
});
