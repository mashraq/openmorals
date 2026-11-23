import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_BYLAWS } from '../../src/bylaws.js';
import {
  SANDBOX_REFUSED_EXIT,
  TOOL_LOCATIONS,
  findProjectSecretFiles,
  isInside,
  nameToRegex,
  planSandbox,
  runSandboxed,
  scrubEnv,
} from '../../src/sandbox/index.js';
import type { PlanOptions, SandboxPlan, SpawnLike } from '../../src/sandbox/index.js';
import { HOME_D, HOME_L, HOME_W, PLAN_CASES } from './cases.js';

const HOMES: Record<string, string> = { darwin: HOME_D, linux: HOME_L, win32: HOME_W, freebsd: HOME_L };

function containsRun(haystack: string[], needle: string[]): boolean {
  for (let i = 0; i + needle.length <= haystack.length; i++) if (needle.every((n, j) => haystack[i + j] === n)) return true;
  return false;
}

function allPaths(plan: SandboxPlan): string[] {
  if (!plan.ok) return [];
  return [plan.policy.projectRoot, ...plan.policy.writable, ...plan.policy.denyWrite, ...plan.policy.denyRead.map((d) => d.path)];
}

describe('planSandbox case table', () => {
  it('has at least 20 cases', () => assert.ok(PLAN_CASES.length >= 20, `${PLAN_CASES.length}`));
  for (const c of PLAN_CASES) {
    it(c.name, () => {
      const opts: PlanOptions = { home: HOMES[c.platform] ?? HOME_L, ...(c.opts ?? {}) };
      const plan = planSandbox(c.bylaws ?? DEFAULT_BYLAWS, c.platform, c.root, opts);
      const e = c.expect;
      assert.equal(plan.ok, e.ok, plan.ok ? 'expected an error' : plan.error);
      if (!plan.ok) {
        if (e.error !== undefined) assert.match(plan.error, e.error);
        return;
      }
      const p = plan.policy;
      if (e.root !== undefined) assert.equal(p.projectRoot, e.root);
      if (e.enforced !== undefined) assert.equal(plan.enforced, e.enforced);
      for (const w of e.writableHas ?? []) assert.ok(p.writable.includes(w), `writable lacks ${w}: ${p.writable.join(' | ')}`);
      for (const w of e.writableLacks ?? []) assert.ok(!p.writable.includes(w), `writable has ${w}`);
      for (const d of e.denyReadHas ?? []) assert.ok(p.denyRead.some((x) => x.path === d), `denyRead lacks ${d}`);
      for (const d of e.denyReadLacks ?? []) assert.ok(!p.denyRead.some((x) => x.path === d), `denyRead has ${d}`);
      for (const d of e.denyWriteHas ?? []) assert.ok(p.denyWrite.includes(d), `denyWrite lacks ${d}`);
      if (e.network !== undefined) assert.deepEqual(p.network, e.network);
      if (e.srtDomains !== undefined) assert.deepEqual(plan.platform === 'win32' ? [] : plan.srt.network.allowedDomains, e.srtDomains);
      if (e.noteMatch !== undefined) assert.ok(plan.notes.some((n) => e.noteMatch?.test(n) === true), `notes: ${plan.notes.join(' | ')}`);
      if (e.seatbeltHas !== undefined) {
        assert.equal(plan.platform, 'darwin');
        if (plan.platform === 'darwin') for (const s of e.seatbeltHas) assert.ok(plan.seatbelt.includes(s), `seatbelt lacks ${s}`);
      }
      if (e.bwrapSeq !== undefined || e.bwrapLacks !== undefined) {
        assert.equal(plan.platform, 'linux');
        if (plan.platform === 'linux') {
          for (const s of e.bwrapSeq ?? []) assert.ok(containsRun(plan.bwrapArgs, s), `bwrap lacks ${s.join(' ')}`);
          for (const s of e.bwrapLacks ?? []) assert.ok(!plan.bwrapArgs.includes(s), `bwrap has ${s}`);
        }
      }
      // invariants for every plan
      for (const x of allPaths(plan)) assert.ok(!/(^|[\\/])\.\.([\\/]|$)/.test(x), `path keeps a '..': ${x}`);
      assert.ok(p.writable.includes(p.projectRoot), 'project root is writable');
      for (const w of p.writable) for (const d of p.denyRead) assert.ok(!isInside(w, d.path, plan.platform), `${w} is writable inside read-denied ${d.path}`);
      if (p.network.mode === 'off' && plan.platform !== 'win32') assert.deepEqual(plan.srt.network.allowedDomains, []);
      if (plan.platform === 'darwin') {
        assert.ok(plan.seatbelt.includes('(deny network*)'));
        assert.equal((plan.seatbelt.match(/\(/g) ?? []).length, (plan.seatbelt.match(/\)/g) ?? []).length, 'balanced parentheses');
      }
      if (plan.platform === 'linux') {
        assert.ok(plan.bwrapArgs.includes('--unshare-all'));
        assert.ok(!plan.bwrapArgs.includes('--'), 'the -- separator is added by the runner, not the plan');
      }
    });
  }
  it('is pure: the same input gives the same plan', () => {
    const a = planSandbox(DEFAULT_BYLAWS, 'darwin', '/Users/alex/proj', { home: HOME_D });
    const b = planSandbox(DEFAULT_BYLAWS, 'darwin', '/Users/alex/proj', { home: HOME_D });
    assert.deepEqual(a, b);
  });
});

describe('seatbelt name regexes', () => {
  const table: [string, string][] = [
    ['.env', '/\\.env$'],
    ['.env.*', '/\\.env\\.[^/]+$'],
    ['*.pem', '\\.pem$'],
    ['id_ed25519', '/id_ed25519$'],
    ['terraform.tfstate', '/terraform\\.tfstate$'],
  ];
  for (const [name, re] of table) it(`${name} -> ${re}`, () => assert.equal(nameToRegex(name), re));
  it('the regexes match what they should and not their look-alikes', () => {
    const r = (n: string): RegExp => new RegExp(nameToRegex(n));
    assert.ok(r('.env').test('/p/.env') && !r('.env').test('/p/x.env') && !r('.env').test('/p/.envrc'));
    assert.ok(r('.env.*').test('/p/.env.local') && !r('.env.*').test('/p/.env.'));
    assert.ok(r('*.pem').test('/p/a.pem') && !r('*.pem').test('/p/a.pem.txt'));
  });
});

const darwinPlan = planSandbox(DEFAULT_BYLAWS, 'darwin', '/Users/alex/proj', { home: HOME_D });
const linuxPlan = planSandbox(DEFAULT_BYLAWS, 'linux', '/home/alex/proj', { home: HOME_L, probe: () => 'missing' });
const winPlan = planSandbox(DEFAULT_BYLAWS, 'win32', 'C:\\Users\\alex\\proj', { home: HOME_W });

function recordingSpawn(result: { code: number | null; signal: string | null; error?: string } = { code: 0, signal: null }): { spawn: SpawnLike; calls: { file: string; args: string[]; cwd: string; env: Record<string, string> }[] } {
  const calls: { file: string; args: string[]; cwd: string; env: Record<string, string> }[] = [];
  return {
    calls,
    spawn: (file, args, options) => {
      calls.push({ file, args, cwd: options.cwd, env: options.env });
      return Promise.resolve(result);
    },
  };
}

describe('runSandboxed', () => {
  const FAKE_ENV = { PATH: '/usr/bin:/bin', HOME: '/h', GITHUB_TOKEN: 'fake-not-a-token', MY_API_KEY: 'fake', DB_PASSWORD: 'fake', SSH_AUTH_SOCK: '/tmp/fake.sock', LANG: 'C' };
  it('refuses when sandbox-exec is absent, and starts nothing', async () => {
    const r0 = recordingSpawn();
    const r = await runSandboxed('/bin/echo', ['hi'], darwinPlan, { platform: 'darwin', detect: () => null, spawn: r0.spawn });
    assert.equal(r.refused, true);
    assert.equal(r.exitCode, SANDBOX_REFUSED_EXIT);
    assert.match(r.message, /sandbox-exec was not found.*never runs a command unsandboxed/);
    assert.equal(r.argv, null);
    assert.equal(r0.calls.length, 0);
  });
  it('refuses when bwrap is absent', async () => {
    const r0 = recordingSpawn();
    const r = await runSandboxed('ls', [], linuxPlan, { platform: 'linux', detect: () => null, spawn: r0.spawn });
    assert.equal(r.refused, true);
    assert.equal(r0.calls.length, 0);
  });
  it('refuses the Windows plan even when a tool is "present"', async () => {
    const r0 = recordingSpawn();
    const r = await runSandboxed('cmd.exe', [], winPlan, { platform: 'win32', detect: () => 'C:\\x.exe', spawn: r0.spawn });
    assert.equal(r.refused, true);
    assert.match(r.message, /not enforced/);
    assert.equal(r0.calls.length, 0);
  });
  it('refuses an invalid plan', async () => {
    const r0 = recordingSpawn();
    const r = await runSandboxed('ls', [], planSandbox(DEFAULT_BYLAWS, 'darwin', 'relative', { home: HOME_D }), { platform: 'darwin', detect: () => '/usr/bin/sandbox-exec', spawn: r0.spawn });
    assert.equal(r.refused, true);
    assert.equal(r0.calls.length, 0);
  });
  it('refuses an unsupported platform plan', async () => {
    const r = await runSandboxed('ls', [], planSandbox(DEFAULT_BYLAWS, 'aix', '/x/y', { home: HOME_L }), { platform: 'aix', detect: () => '/bin/true', spawn: recordingSpawn().spawn });
    assert.equal(r.refused, true);
  });
  it('refuses a plan made for another platform', async () => {
    const r0 = recordingSpawn();
    const r = await runSandboxed('ls', [], linuxPlan, { platform: 'darwin', detect: () => '/usr/bin/bwrap', spawn: r0.spawn });
    assert.equal(r.refused, true);
    assert.match(r.message, /plan is for linux/);
    assert.equal(r0.calls.length, 0);
  });
  for (const [cmd, args] of [['', []], ['-rf', []], ['ls', ['a\0b']]] as [string, string[]][]) {
    it(`refuses a malformed command ${JSON.stringify([cmd, ...args])}`, async () => {
      const r0 = recordingSpawn();
      const r = await runSandboxed(cmd, args, darwinPlan, { platform: 'darwin', detect: () => '/usr/bin/sandbox-exec', spawn: r0.spawn });
      assert.equal(r.refused, true);
      assert.equal(r0.calls.length, 0);
    });
  }
  it('macOS: execs sandbox-exec with an argument vector, no shell string, scrubbed env', async () => {
    const r0 = recordingSpawn();
    const tricky = 'a b; rm -rf x $(id) `id` | cat';
    const r = await runSandboxed('echo', [tricky, '*'], darwinPlan, { platform: 'darwin', detect: () => '/usr/bin/sandbox-exec', spawn: r0.spawn, env: FAKE_ENV });
    assert.equal(r.refused, false);
    assert.equal(r.exitCode, 0);
    const call = r0.calls[0];
    assert.ok(call !== undefined && darwinPlan.ok && darwinPlan.platform === 'darwin');
    assert.equal(call.file, '/usr/bin/sandbox-exec');
    assert.deepEqual(call.args, ['-p', darwinPlan.seatbelt, 'echo', tricky, '*']);
    assert.equal(call.cwd, '/Users/alex/proj');
    assert.deepEqual(Object.keys(call.env).sort(), ['HOME', 'LANG', 'PATH']);
  });
  it('Linux: execs bwrap with the plan arguments, then --, then the command', async () => {
    const r0 = recordingSpawn();
    await runSandboxed('npm', ['test'], linuxPlan, { platform: 'linux', detect: () => '/usr/bin/bwrap', spawn: r0.spawn, env: FAKE_ENV });
    assert.ok(linuxPlan.ok && linuxPlan.platform === 'linux');
    assert.deepEqual(r0.calls[0]?.args, [...linuxPlan.bwrapArgs, '--', 'npm', 'test']);
    assert.equal(r0.calls[0]?.file, '/usr/bin/bwrap');
  });
  it('keepSecretEnv keeps credential-named variables', async () => {
    const r0 = recordingSpawn();
    await runSandboxed('ls', [], darwinPlan, { platform: 'darwin', detect: () => '/usr/bin/sandbox-exec', spawn: r0.spawn, env: FAKE_ENV, keepSecretEnv: true });
    assert.ok('GITHUB_TOKEN' in (r0.calls[0]?.env ?? {}));
  });
  it('passes the exit code through; a signal becomes 128+n; a spawn error is 127', async () => {
    const run = async (res: { code: number | null; signal: string | null; error?: string }): Promise<number> =>
      (await runSandboxed('ls', [], darwinPlan, { platform: 'darwin', detect: () => '/usr/bin/sandbox-exec', spawn: recordingSpawn(res).spawn })).exitCode;
    assert.equal(await run({ code: 3, signal: null }), 3);
    assert.equal(await run({ code: null, signal: 'SIGTERM' }), 143);
    assert.equal(await run({ code: null, signal: null, error: 'ENOENT' }), 127);
  });
  it('looks for tools only at fixed absolute locations, never through PATH', () => {
    for (const list of Object.values(TOOL_LOCATIONS)) for (const p of list) assert.ok(p.startsWith('/'), p);
  });
  it('scrubEnv drops credential-named variables by name only', () => {
    assert.deepEqual(scrubEnv({ PATH: '/bin', AWS_SECRET_ACCESS_KEY: 'x', NPM_TOKEN: 'x', openai_api_key: 'x', EDITOR: 'vi', UNSET: undefined }), { PATH: '/bin', EDITOR: 'vi' });
  });
});

describe('findProjectSecretFiles (temp directory only)', () => {
  const made: string[] = [];
  after(() => {
    for (const d of made) if (path.basename(d).startsWith('omr-sbx-')) fs.rmSync(d, { recursive: true, force: true });
  });
  it('finds .env-style and key files, skips node_modules and .git', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omr-sbx-'));
    made.push(root);
    for (const rel of ['.env', 'app/.env.local', 'certs/server.pem', 'node_modules/x/.env', '.git/.env', 'README.md', '.env.example']) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), 'FAKE=1\n');
    }
    const found = findProjectSecretFiles(root).map((f) => path.relative(root, f)).sort();
    assert.deepEqual(found, ['.env', '.env.example', path.join('app', '.env.local'), path.join('certs', 'server.pem')].sort());
  });
});
