import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { describe, it } from 'node:test';
import { hookStart, hostEnv, inRunnerCache, isRunnerPathEntry, ownCommandWords } from '../src/doctor/index.js';
import { REPO_ROOT, stubOpenmoralsDir, tempDir } from './helpers.js';

const CLI = join(REPO_ROOT, 'dist', 'src', 'cli.js');
const HOSTS = ['claude-code', 'codex', 'gemini-cli', 'opencode', 'openclaw'] as const;
type Host = (typeof HOSTS)[number];

/** The file each host's hook lives in, and settings already there that init must leave alone when it refuses. */
const SETTINGS: Readonly<Record<Host, { file: string; before: string | null }>> = {
  'claude-code': { file: '.claude/settings.json', before: '{\n  "model": "x",\n  "hooks": { "Stop": [] }\n}\n' },
  codex: { file: '.codex/hooks.json', before: '{ "hooks": {} }\n' },
  'gemini-cli': { file: '.gemini/settings.json', before: '{ "theme": "dark" }\n' },
  opencode: { file: '.opencode/plugins/openmorals.js', before: null },
  openclaw: { file: '.openclaw/plugins/openmorals/index.js', before: null },
};

function runInit(args: string[], path: string, home: string): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, OPENMORALS_HOME: home, PATH: path };
  delete env['Path'];
  const r = spawnSync(process.execPath, [CLI, 'init', ...args], { encoding: 'utf8', env, cwd: home });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function project(host: Host): string {
  const dir = tempDir(`hook-start-${host}`);
  const s = SETTINGS[host];
  if (s.before !== null) {
    mkdirSync(join(dir, s.file, '..'), { recursive: true });
    writeFileSync(join(dir, s.file), s.before);
  }
  return dir;
}

function listing(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const r = rel === '' ? n.name : `${rel}/${n.name}`;
      out.push(r);
      if (n.isDirectory()) walk(join(d, n.name), r);
    }
  };
  walk(dir, '');
  return out.sort();
}

describe('init refuses a hook command that will not start (0.41.2)', () => {
  for (const host of HOSTS) {
    it(`${host}: with openmorals not on PATH, it writes nothing and leaves the settings byte for byte`, () => {
      const dir = project(host);
      const before = listing(dir);
      const r = runInit([dir, '--agent', host], '', tempDir('hs-home'));
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /would not start: "openmorals" is not on PATH/);
      assert.match(r.stderr, /Nothing was written/);
      assert.match(r.stderr, /--hook-command/);
      assert.deepEqual(listing(dir), before);
      const s = SETTINGS[host];
      if (s.before !== null) assert.equal(readFileSync(join(dir, s.file), 'utf8'), s.before);
      assert.equal(existsSync(join(dir, 'openmorals.yaml')), false);
    });

    it(`${host}: with openmorals on PATH, it writes the hook`, () => {
      const dir = project(host);
      const r = runInit([dir, '--agent', host], stubOpenmoralsDir(), tempDir('hs-home'));
      assert.equal(r.status, 0, r.stderr);
      assert.ok(existsSync(join(dir, 'openmorals.yaml')));
      assert.match(readFileSync(join(dir, SETTINGS[host].file), 'utf8'), new RegExp(`openmorals["', ]+hook["', ]+${host}`));
    });
  }

  it('says why on Claude Code: init sets the hook to block on failure', () => {
    const r = runInit([project('claude-code')], '', tempDir('hs-home'));
    assert.match(r.stderr, /Claude Code would block every prompt and tool call, because init sets the hook to block when it fails/);
  });

  it('writes an absolute-path command with nothing on PATH', () => {
    const stub = join(stubOpenmoralsDir(), process.platform === 'win32' ? 'openmorals.cmd' : 'openmorals');
    const dir = project('claude-code');
    const r = runInit([dir, '--hook-command', `"${stub}" hook claude-code`], '', tempDir('hs-home'));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8').includes(stub.replace(/\\/g, '\\\\')));
    const oc = project('opencode');
    assert.equal(runInit([oc, '--agent', 'opencode', '--hook-command', JSON.stringify([stub, 'hook', 'opencode'])], '', tempDir('hs-home')).status, 0);
  });

  it('the command it suggests is one it then accepts', () => {
    const dir = project('claude-code');
    const r = runInit([dir], '', tempDir('hs-home'));
    const m = /--hook-command '([^']+)'/.exec(r.stderr);
    assert.ok(m !== null, r.stderr);
    const again = runInit([dir, '--hook-command', m[1] ?? ''], '', tempDir('hs-home'));
    assert.equal(again.status, 0, again.stderr);
  });

  it('does not count a folder a package runner put on PATH for this run', () => {
    const runner = tempDir('hs-runner');
    const bin = join(runner, 'node_modules', '.bin');
    mkdirSync(bin, { recursive: true });
    const stub = join(bin, 'openmorals');
    writeFileSync(stub, '#!/bin/sh\nexit 0\n');
    chmodSync(stub, 0o755);
    if (process.platform === 'win32') writeFileSync(`${stub}.cmd`, '@exit /b 0\r\n');
    const dir = project('claude-code');
    const r = runInit([dir], bin, tempDir('hs-home'));
    assert.equal(r.status, 1, r.stdout);
    assert.equal(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'), SETTINGS['claude-code'].before);
  });

  it('refuses a hook run through a package runner, even when the runner is on PATH', () => {
    const bin = tempDir('hs-npx');
    for (const n of ['npx', 'pnpm']) {
      writeFileSync(join(bin, n), '#!/bin/sh\nexit 0\n');
      chmodSync(join(bin, n), 0o755);
      if (process.platform === 'win32') writeFileSync(join(bin, `${n}.cmd`), '@exit /b 0\r\n');
    }
    for (const cmd of ['npx openmorals hook claude-code', 'pnpm dlx openmorals hook claude-code']) {
      const dir = project('claude-code');
      const r = runInit([dir, '--hook-command', cmd], bin, tempDir('hs-home'));
      assert.equal(r.status, 1, cmd);
      assert.match(r.stderr, /package runner/);
      assert.equal(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'), SETTINGS['claude-code'].before);
    }
  });

  it('refuses node with a script that does not exist', () => {
    const dir = project('claude-code');
    const r = runInit([dir, '--hook-command', `"${process.execPath}" /no/such/openmorals/cli.js hook claude-code`], '', tempDir('hs-home'));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /does not exist/);
  });

  it('writes a command with shell syntax, which it cannot check, and says so', () => {
    const dir = project('claude-code');
    const r = runInit([dir, '--hook-command', 'cd /tmp && openmorals hook claude-code'], '', tempDir('hs-home'));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /was not checked/);
  });

  it('--no-hook writes the rules file without checking any command', () => {
    const dir = tempDir('hs-nohook');
    const r = runInit([dir, '--no-hook'], '', tempDir('hs-home'));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(dir, 'openmorals.yaml')));
  });
});

describe('hookStart', () => {
  const env = (path: string): NodeJS.ProcessEnv => ({ PATH: path });
  it('finds a program on PATH, skips env assignments, and refuses what is missing', () => {
    const bin = stubOpenmoralsDir();
    const ok = hookStart('FOO=1 openmorals hook claude-code', '/', env(bin), process.platform);
    assert.equal(ok.ok && ok.checked, true);
    assert.equal(hookStart('openmorals hook claude-code', '/', env(''), process.platform).ok, false);
    assert.equal(hookStart(['openmorals', 'hook', 'opencode'], '/', env(bin), process.platform).ok, true);
    assert.equal(hookStart([], '/', env(bin), process.platform).ok, false);
  });
  it('drops package-runner folders from PATH and knows a runner cache', () => {
    assert.equal(isRunnerPathEntry('/home/u/.npm/_npx/abc/node_modules/.bin'), true);
    assert.equal(isRunnerPathEntry('C:\\p\\node_modules\\.bin'), true);
    assert.equal(isRunnerPathEntry('/usr/local/bin'), false);
    assert.equal(hostEnv({ PATH: ['/a/node_modules/.bin', '/usr/bin'].join(delimiter) }, process.platform)['PATH'], '/usr/bin');
    assert.equal(inRunnerCache('/home/u/.npm/_npx/abc/node_modules/openmorals/dist/src/cli.js'), true);
    assert.equal(inRunnerCache('/usr/local/lib/node_modules/openmorals/dist/src/cli.js'), false);
  });
  it('offers no absolute path to a copy in a package runner cache', () => {
    assert.equal(ownCommandWords({ file: process.execPath, args: ['/h/.npm/_npx/1/node_modules/openmorals/dist/src/cli.js'], identity: '/h/.npm/_npx/1/node_modules/openmorals/dist/src/cli.js' }, {}, process.platform), null);
    assert.deepEqual(ownCommandWords({ file: '/opt/om', args: [], identity: '/opt/om' }, {}, process.platform), ['/opt/om']);
  });
});
