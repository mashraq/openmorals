import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, tempDir } from './helpers.js';

const CLI = join(REPO_ROOT, 'dist', 'src', 'cli.js');

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd: string, home: string): Run {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd, input: '{"tool_name":"Bash","tool_input":{"command":"ls"}}', env: { ...process.env, OPENMORALS_HOME: home, OPENMORALS_UNATTENDED: '' } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function listAll(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String);
}

const COMMANDS: readonly string[][] = [
  ['check'],
  ['scan'],
  ['trash'],
  ['restore'],
  ['purge'],
  ['guidance'],
  ['packs'],
  ['hook', 'claude-code'],
  ['hook', 'codex'],
  ['hook', 'gemini-cli'],
  ['hook', 'opencode'],
  ['init'],
  ['init', '.'],
  ['init', '--agent', 'codex'],
  ['guidance', '--file', 'CLAUDE.md'],
  ['sandbox'],
  ['sandbox', 'plan'],
  ['sandbox', 'run'],
  ['validate'],
  ['audit'],
  ['help'],
];

describe('cli --help and -h on every subcommand (D-1)', () => {
  for (const cmd of COMMANDS) {
    for (const flag of ['--help', '-h']) {
      if (cmd[0] === 'check' && flag === '-h' && cmd.length > 1) continue;
      it(`${cmd.join(' ')} ${flag} prints usage, exits 0 and writes nothing`, () => {
        const dir = tempDir('help-cwd');
        const home = tempDir('help-home');
        const r = run([...cmd, flag], dir, home);
        assert.equal(r.code, 0, `exit ${String(r.code)}: ${r.stderr}`);
        assert.match(r.stdout, /Usage:/);
        if (cmd[0] !== 'help') assert.ok(r.stdout.includes(`openmorals ${cmd[0]}`), r.stdout);
        assert.deepEqual(listAll(dir), [], `${cmd.join(' ')} ${flag} wrote into the current folder`);
        assert.deepEqual(listAll(home), [], `${cmd.join(' ')} ${flag} wrote into the config folder`);
      });
    }
  }

  it('help <command> prints that command only, and help with an unknown command is a usage error', () => {
    const dir = tempDir('help-cwd');
    const home = tempDir('help-home');
    const init = run(['help', 'init'], dir, home);
    assert.equal(init.code, 0);
    assert.match(init.stdout, /openmorals init \[DIR\]/);
    assert.doesNotMatch(init.stdout, /openmorals trash/);
    assert.equal(run(['help', 'nope'], dir, home).code, 64);
    assert.deepEqual(listAll(dir), []);
    assert.deepEqual(listAll(home), []);
  });

  it('-h after "check" is help, but -h later is part of the command being judged', () => {
    const dir = tempDir('help-cwd');
    const home = tempDir('help-home');
    assert.match(run(['check', '-h'], dir, home).stdout, /Usage:/);
    const judged = run(['check', 'ls', '-h'], dir, home);
    assert.equal(judged.code, 0, judged.stderr);
    assert.match(judged.stdout, /^ALLOW/);
  });

  it('--help after "--" belongs to the sandboxed command, not to openmorals', () => {
    const dir = tempDir('help-cwd');
    const home = tempDir('help-home');
    const r = run(['sandbox', 'run', '--', 'node', '--help'], dir, home);
    assert.doesNotMatch(r.stdout, /Usage:\n {2}openmorals sandbox/);
  });
});

describe('cli unknown options on commands that write files (D-1)', () => {
  const bad: readonly string[][] = [
    ['init', '--force'],
    ['init', '-f'],
    ['init', 'a', 'b'],
    ['init', '--agent', 'codex', '--yes'],
    ['guidance', '--bogus'],
    ['guidance', 'extra'],
    ['guidance', '-x'],
    ['trash', '-r', 'build'],
    ['trash', '--force', 'build'],
    ['restore', '--all', 'abc'],
    ['purge', '--older-than', '1', '--force'],
    ['check', '--bogus', 'ls'],
    ['audit', '--bogus'],
    ['validate', '--strict'],
  ];
  for (const args of bad) {
    it(`${args.join(' ')} is a usage error (64) that writes nothing`, () => {
      const dir = tempDir('opt-cwd');
      const home = tempDir('opt-home');
      const r = run(args, dir, home);
      assert.equal(r.code, 64, `exit ${String(r.code)}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /unknown option|unexpected argument/);
      assert.match(r.stderr, /Usage:/);
      assert.deepEqual(listAll(dir), []);
      assert.deepEqual(listAll(home), []);
    });
  }

  it('a file name starting with a dash can still be trashed after "--"', () => {
    const dir = tempDir('opt-cwd');
    const home = tempDir('opt-home');
    const r = run(['trash', '--', '-odd'], dir, home);
    assert.notEqual(r.code, 64, r.stderr);
  });
});
