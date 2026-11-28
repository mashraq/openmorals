import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { installAgentHook } from '../src/adapters/install.js';
import { runClaudeCodeHook } from '../src/adapters/claude-code.js';
import { DEFAULT_BYLAWS } from '../src/bylaws.js';
import type { SelfCli, SpawnResult, Spawner } from '../src/doctor/index.js';
import { BUILTIN_GUARDS, decide } from '../src/engine.js';
import { initProject } from '../src/init.js';
import { POSTURE_LINE, RUN_REFUSED_EXIT, exitForChild, hostOfCommand, runCommand } from '../src/run/index.js';
import type { RunDeps } from '../src/run/index.js';
import { startChildWith, type ChildOptions, type ChildResult, type SignalTarget, type SpawnFn } from '../src/run/spawn.js';
import { parseCommand } from '../src/shell.js';
import { budgetCommand, stopCommand } from '../src/tokens/command.js';
import { readRunFile, runDir } from '../src/tokens/run.js';
import { EMPTY_STATE } from '../src/types.js';
import { REPO_ROOT, tempDir } from './helpers.js';

const CLI = join(REPO_ROOT, 'dist', 'src', 'cli.js');

/** A stand-in `openmorals` the hook command resolves to; doctor's self-test is answered by the stub spawner, never run. */
const BIN = ((): string => {
  const bin = tempDir('run-bin');
  writeFileSync(join(bin, 'openmorals'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'openmorals'), 0o755);
  return bin;
})();
const SELF: SelfCli = { file: process.execPath, args: [join(BIN, 'openmorals')], identity: realpathSync(join(BIN, 'openmorals')) };
const ASK = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: 'r' } });
/** Answers like a working hook: nothing for ls and the prompt, ask for rm -rf. */
const goodHook: Spawner = (_f, _a, input): SpawnResult => ({ status: 0, stdout: input.includes('rm -rf') ? ASK : '', stderr: '', timedOut: false, ms: 1 });
const deadHook: Spawner = (): SpawnResult => ({ status: 1, stdout: '', stderr: 'cannot start', timedOut: false, ms: 1 });

interface Started {
  file: string;
  args: readonly string[];
  options: ChildOptions;
}

function setup(kind: 'claude' | 'codex' | 'none' = 'claude') {
  const proj = tempDir('run-proj');
  const home = tempDir('run-home');
  if (kind === 'claude') assert.ok(initProject(proj).ok);
  if (kind === 'codex') assert.ok(installAgentHook(proj, 'codex', {}).ok);
  const env: NodeJS.ProcessEnv = { PATH: BIN, OPENMORALS_HOME: join(home, 'om'), CLAUDE_CONFIG_DIR: join(home, 'claude'), SOME_VAR: 'kept as is', EMPTY: '' };
  const calls: Started[] = [];
  let lines = '';
  let answer: ChildResult = { code: 0, signal: null };
  const deps = (over: Partial<RunDeps> = {}): RunDeps => ({
    env,
    cwd: proj,
    platform: 'linux',
    err: (t) => {
      lines += t;
    },
    start: async (file, args, options) => {
      calls.push({ file, args, options });
      return answer;
    },
    doctor: { home, spawn: goodHook, self: SELF },
    ...over,
  });
  return {
    proj,
    home,
    env,
    calls,
    dir: join(home, 'om'),
    deps,
    stderr: () => lines,
    answer: (r: ChildResult) => {
      answer = r;
    },
  };
}

describe('openmorals run (0.44.0)', () => {
  it('starts a known host with OPENMORALS_RUN and an environment that is otherwise the same', async () => {
    const s = setup();
    const code = await runCommand(['--', 'claude', '--model', 'x'], s.deps());
    assert.equal(code, 0, s.stderr());
    assert.equal(s.calls.length, 1);
    const c = s.calls[0] as Started;
    assert.equal(c.file, 'claude');
    assert.deepEqual(c.args, ['--model', 'x']);
    assert.equal(c.options.cwd, s.proj);
    const run = c.options.env['OPENMORALS_RUN'] as string;
    assert.match(run, /^run-\d{8}T\d{6}-[0-9a-f]{6}$/);
    const { OPENMORALS_RUN: _drop, ...rest } = c.options.env;
    assert.deepEqual(rest, s.env, 'every other variable is passed on as it was, the empty one included');
    assert.ok(existsSync(runDir(s.dir, run)), 'the new run id is claimed by its folder');
  });

  it('refuses when the host has no hook, and starts nothing and writes nothing', async () => {
    const s = setup('none');
    const code = await runCommand(['--', 'claude'], s.deps());
    assert.equal(code, RUN_REFUSED_EXIT);
    assert.notEqual(code, 0);
    assert.equal(s.calls.length, 0, 'the command was never started');
    assert.match(s.stderr(), /refused: the claude-code hook is not installed or does not start/);
    assert.match(s.stderr(), /Install it with: openmorals init\n/);
    assert.match(s.stderr(), /Nothing was started\./);
    assert.ok(!existsSync(join(s.dir, 'runs')), 'no run was set up');
  });

  it('refuses when the Claude Code hook is installed but does not start or does not block on failure', async () => {
    const s = setup();
    assert.equal(await runCommand(['--', 'claude'], s.deps({ doctor: { home: s.home, spawn: deadHook, self: SELF } })), RUN_REFUSED_EXIT);
    assert.match(s.stderr(), /self-test: harmless tool call \(ls\): exited 1/);
    const t = setup();
    const f = join(t.proj, '.claude', 'settings.json');
    writeFileSync(f, readFileSync(f, 'utf8').replace(/"onFailure": "block"/g, '"onFailure": "continue"'));
    assert.equal(await runCommand(['--', 'claude'], t.deps()), RUN_REFUSED_EXIT);
    assert.match(t.stderr(), /blocks on failure/);
    assert.equal(s.calls.length + t.calls.length, 0);
  });

  it('refuses when the self-test could not run, since the hook is then not shown to start', async () => {
    const s = setup();
    const f = join(s.proj, '.claude', 'settings.json');
    writeFileSync(f, readFileSync(f, 'utf8').replace(/openmorals hook claude-code/g, 'X=$Y openmorals hook claude-code'));
    assert.equal(await runCommand(['--', 'claude'], s.deps()), RUN_REFUSED_EXIT);
    assert.match(s.stderr(), /self-test: did not run/);
    assert.equal(s.calls.length, 0);
  });

  it('checks another host by the same doctor check, and refuses a folder with only another host hooked', async () => {
    const s = setup('codex');
    assert.equal(await runCommand(['--', 'codex', 'exec', 'hi'], s.deps()), 0, s.stderr());
    assert.equal(s.calls.length, 1);
    assert.equal(await runCommand(['--', 'gemini'], s.deps()), RUN_REFUSED_EXIT);
    assert.match(s.stderr(), /no gemini-cli hook was found/);
    assert.match(s.stderr(), /Install it with: openmorals init --agent gemini-cli/);
    assert.equal(s.calls.length, 1);
  });

  it('refuses an unknown command with 64 and points a program that is not a host at guard', async () => {
    const s = setup();
    for (const cmd of ['python3', 'claude-dev', 'myclaude', 'claude.sh', 'npx', 'Claude']) {
      assert.equal(await runCommand(['--', cmd], s.deps()), 64, cmd);
    }
    assert.match(s.stderr(), /name it with --agent/);
    assert.match(s.stderr(), /openmorals guard --json/);
    assert.equal(s.calls.length, 0);
  });

  it('knows a host by its base name only, and by --agent for anything else', async () => {
    assert.equal(hostOfCommand('/usr/local/bin/claude', 'linux'), 'claude-code');
    assert.equal(hostOfCommand('gemini', 'linux'), 'gemini-cli');
    assert.equal(hostOfCommand('xcodex', 'linux'), null);
    assert.equal(hostOfCommand('codex-wrapper', 'linux'), null);
    assert.equal(hostOfCommand('C:\\bin\\Claude.exe', 'win32'), 'claude-code');
    assert.equal(hostOfCommand('claude.exe', 'linux'), null);
    const s = setup();
    assert.equal(await runCommand(['--agent', 'claude-code', '--', './my-claude.sh'], s.deps()), 0, s.stderr());
    assert.equal(await runCommand(['--agent=claude-code', '--', '/opt/x/run-agent'], s.deps()), 0, s.stderr());
    assert.equal(s.calls.length, 2);
    assert.equal(await runCommand(['--agent', 'cursor', '--', 'claude'], s.deps()), 64);
    assert.match(s.stderr(), /unknown agent "cursor"/);
    assert.equal(s.calls.length, 2);
  });

  it('usage errors exit 64 and start nothing', async () => {
    const s = setup();
    const after = /write the command after "--"/;
    const none = /name the command to start after "--"/;
    const whole = /--tokens needs a whole number above 0/;
    const bad: [string[], RegExp][] = [[['claude'], after], [[], after], [['--'], none], [['--', ''], none], [['--agent', 'claude-code', '--', ''], none], [['--tokens', '5', 'claude'], after], [['--bogus', '--', 'claude'], /unknown option --bogus/], [['--tokens', '--', 'claude'], /--tokens needs a value/], [['--tokens', '0', '--', 'claude'], whole], [['--tokens', '9:3', '--', 'claude'], whole], [['--tokens', '5', '--tokens', '6', '--', 'claude'], /--tokens is given twice/], [['--id', '', '--', 'claude'], /--id needs a value/], [['--', 'claude', 'a\0b'], /contains a NUL/]];
    for (const [a, why] of bad) {
      const t = setup();
      assert.equal(await runCommand(a, t.deps()), 64, JSON.stringify(a));
      assert.match(t.stderr(), why, JSON.stringify(a));
      assert.equal(t.calls.length, 0);
    }
    assert.equal(s.calls.length, 0);
    assert.ok(!existsSync(join(s.dir, 'runs')));
  });

  it('passes every word after "--" as given, even ones that look like its own options', async () => {
    const s = setup();
    const words = ['--tokens', '5', '--agent', 'codex', '--id', 'x', '--', '$(rm -rf ~)', '; ls', '*', '--help', '-h'];
    assert.equal(await runCommand(['--', 'claude', ...words], s.deps()), 0, s.stderr());
    assert.deepEqual(s.calls[0]?.args, words);
    assert.equal(readRunFile(s.dir, s.calls[0]?.options.env['OPENMORALS_RUN'] as string), null, 'the words after -- set no limits');
  });

  it('refuses limits for a host other than Claude Code', async () => {
    const s = setup('codex');
    for (const a of [['--tokens', '100'], ['--tool-calls', '3:10']]) {
      assert.equal(await runCommand([...a, '--', 'codex'], s.deps()), 64);
    }
    assert.match(s.stderr(), /limits are counted on Claude Code only/);
    assert.equal(s.calls.length, 0);
  });

  it('writes the limits as openmorals budget start does', async () => {
    const s = setup();
    assert.equal(await runCommand(['--id', 'r1', '--tokens', '100', '--tool-calls', '3:10', '--', 'claude'], s.deps()), 0, s.stderr());
    const t = setup();
    assert.equal(budgetCommand(['start', '--id', 'r1', '--tokens', '100', '--tool-calls', '3:10'], { env: t.env }).exitCode, 0);
    const a = readRunFile(s.dir, 'r1');
    const b = readRunFile(t.dir, 'r1');
    assert.ok(a !== null && !('error' in a) && b !== null && !('error' in b));
    assert.deepEqual(a.limits, b.limits);
    assert.deepEqual(a.limits, { tokens: { soft: 0, hard: 100, step: 100 }, tool_calls: { soft: 3, hard: 10, step: 10 } });
    assert.equal(s.calls[0]?.options.env['OPENMORALS_RUN'], 'r1');
  });

  it('sets a run budget once: limits for a run that has them are refused, and a run with no limits is joined', async () => {
    const s = setup();
    assert.equal(budgetCommand(['start', '--id', 'r1', '--tokens', '100'], { env: s.env }).exitCode, 0);
    assert.equal(await runCommand(['--id', 'r1', '--tokens', '999999', '--', 'claude'], s.deps()), 64);
    assert.match(s.stderr(), /already has limits/);
    assert.equal(s.calls.length, 0);
    assert.equal(await runCommand(['--id', 'r1', '--', 'claude'], s.deps()), 0);
    assert.match(s.stderr(), /run r1 \(--id, already started/);
    const f = readRunFile(s.dir, 'r1');
    assert.ok(f !== null && !('error' in f));
    assert.deepEqual(f.limits.tokens, { soft: 0, hard: 100, step: 100 }, 'the limits are unchanged');
  });

  it('a run limit never loosens the user file: the per-session cap still stops the session', async () => {
    const s = setup();
    mkdirSync(s.dir, { recursive: true });
    writeFileSync(join(s.dir, 'openmorals.yaml'), 'version: 1\nguards:\n  budget:\n    tool_calls: { soft: 0, hard: 2, step: 1 }\n');
    assert.equal(await runCommand(['--id', 'big', '--tool-calls', '1000', '--', 'claude'], s.deps()), 0, s.stderr());
    const env = s.calls[0]?.options.env as NodeJS.ProcessEnv;
    const call = () => runClaudeCodeHook(JSON.stringify({ session_id: 'a', cwd: s.proj, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(s.proj, 'a') } }), { env });
    call();
    const second = call();
    assert.equal(second.verdict.decision, 'deny', JSON.stringify(second.verdict));
    assert.match(second.verdict.rule, /^budget\.tool_calls/, 'the user cap of 2 decides, not the run limit of 1000');
  });

  it('checks a given id as run ids are checked, and refuses one the store would have to clean', async () => {
    const s = setup();
    for (const id of ['a/b', '../x', '.', '..', 'a.', '.a', 'a b', 'x'.repeat(129), 'ü']) {
      assert.equal(await runCommand(['--id', id, '--', 'claude'], s.deps()), 64, id);
    }
    assert.equal(s.calls.length, 0);
    assert.equal(await runCommand(['--id', 'x'.repeat(128), '--', 'claude'], s.deps()), 0);
  });

  it('never starts a fresh run stopped: a new id skips a stopped or existing run, and a stopped id is refused', async () => {
    const s = setup();
    assert.equal(stopCommand(['--run', 'run-taken'], { env: s.env }).exitCode, 0);
    assert.equal(budgetCommand(['start', '--id', 'run-old', '--tokens', '5'], { env: s.env }).exitCode, 0);
    const ids = ['run-taken', 'run-old', 'run-new'];
    assert.equal(await runCommand(['--', 'claude'], s.deps({ newId: () => ids.shift() as string })), 0, s.stderr());
    assert.equal(s.calls[0]?.options.env['OPENMORALS_RUN'], 'run-new');
    assert.equal(await runCommand(['--', 'claude'], s.deps({ newId: () => 'run-taken' })), RUN_REFUSED_EXIT);
    assert.match(s.stderr(), /no new run id was free/);
    assert.equal(await runCommand(['--id', 'run-taken', '--', 'claude'], s.deps()), RUN_REFUSED_EXIT);
    assert.match(s.stderr(), /run run-taken is stopped/);
    assert.equal(stopCommand(['--all'], { env: s.env }).exitCode, 0);
    assert.equal(await runCommand(['--', 'claude'], s.deps()), RUN_REFUSED_EXIT);
    assert.match(s.stderr(), /every session is stopped/);
    assert.equal(s.calls.length, 1);
  });

  it('inside a run, joins it: the same id, no new limits, no other id', async () => {
    const s = setup();
    const inner = { ...s.env, OPENMORALS_RUN: 'parent' };
    assert.equal(await runCommand(['--', 'claude'], s.deps({ env: inner })), 0, s.stderr());
    assert.equal(s.calls[0]?.options.env['OPENMORALS_RUN'], 'parent');
    assert.deepEqual(s.calls[0]?.options.env, inner);
    assert.match(s.stderr(), /joins run parent/);
    assert.equal(await runCommand(['--id', 'parent', '--', 'claude'], s.deps({ env: inner })), 0);
    assert.equal(await runCommand(['--id', 'other', '--', 'claude'], s.deps({ env: inner })), 64);
    assert.equal(await runCommand(['--tokens', '5', '--', 'claude'], s.deps({ env: inner })), 64);
    assert.equal(await runCommand(['--', 'claude'], s.deps({ env: { ...s.env, OPENMORALS_RUN: '../x' } })), 64);
    assert.equal(s.calls.length, 2);
    assert.equal(await runCommand(['--', 'claude'], s.deps({ env: { ...s.env, OPENMORALS_RUN: '' } })), 0, 'an empty OPENMORALS_RUN is no run, as the hook reads it');
    assert.notEqual(s.calls[2]?.options.env['OPENMORALS_RUN'], '');
  });

  it("returns the command's exit code, and 128 + N when signal N ended it", async () => {
    const s = setup();
    for (const [r, want] of [[{ code: 0, signal: null }, 0], [{ code: 7, signal: null }, 7], [{ code: null, signal: 'SIGTERM' }, 143], [{ code: null, signal: 'SIGINT' }, 130], [{ code: null, signal: 'SIGKILL' }, 137], [{ code: null, signal: 'SIGUSR1' }, 128 + osConstants.signals.SIGUSR1]] as [ChildResult, number][]) {
      s.answer(r);
      assert.equal(await runCommand(['--', 'claude'], s.deps()), want, JSON.stringify(r));
    }
    assert.equal(exitForChild({ code: null, signal: null }), 1);
    s.answer({ code: null, signal: null, error: { message: 'spawn claude ENOENT', errno: 'ENOENT' } });
    assert.equal(await runCommand(['--', 'claude'], s.deps()), 127);
    s.answer({ code: null, signal: null, error: { message: 'spawn claude EACCES', errno: 'EACCES' } });
    assert.equal(await runCommand(['--', 'claude'], s.deps()), 126);
    assert.match(s.stderr(), /could not start claude: spawn claude EACCES/);
  });

  it('prints the posture line at start and the run card at the end, on standard error', async () => {
    const s = setup();
    const env0 = { ...s.env };
    assert.equal(await runCommand(['--id', 'r9', '--', 'claude'], s.deps({
      start: async (file, args, options) => {
        assert.ok(s.stderr().startsWith(`${POSTURE_LINE}\n`), 'the posture line comes before the start');
        assert.match(s.stderr(), /Checked: its hook in .* is installed and starts \(doctor's self-test ran it\)\. Not checked: that claude loads it\./);
        s.calls.push({ file, args, options });
        runClaudeCodeHook(JSON.stringify({ session_id: 'a', cwd: s.proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf ./build' } }), { env: options.env });
        return { code: 3, signal: null };
      },
    })), 3);
    assert.match(s.stderr(), /claude ended with exit 3\./);
    assert.match(s.stderr(), /openmorals run: the run card:\nrun r9: 1 record in 1 session; 0 denied, 1 asked/);
    assert.doesNotMatch(s.stderr(), /sandbox|contained|isolated/i);
    assert.deepEqual(s.env, env0);
  });

  it('says in one line when there is no run card, and invents nothing', async () => {
    const s = setup();
    assert.equal(await runCommand(['--id', 'quiet', '--', 'claude'], s.deps()), 0);
    assert.match(s.stderr(), /openmorals run: no run card: no hook call was recorded under run quiet\.\n$/);
    assert.doesNotMatch(s.stderr().split('ended with exit 0.')[1] ?? '', /\d/, 'no figure is printed');
  });

  it('an agent cannot give itself a fresh budget through run; a run with no limits is not person-only', () => {
    const rule = (c: string) => decide({ kind: 'exec', command: c, shell: 'posix', tool: 'Bash' }, DEFAULT_BYLAWS, EMPTY_STATE).rule;
    for (const c of ['openmorals run --tokens 5 -- claude', 'openmorals run --tool-calls=3:10 -- claude', 'openmorals run --id r --tokens 1 -- claude', 'npx openmorals run --tokens 5 -- claude', 'env A=1 openmorals run --tokens 5 -- claude', 'node /x/node_modules/openmorals/dist/src/cli.js run --tool-calls 9 -- claude']) assert.ok(rule(c).startsWith('self-protect'), c);
    for (const c of ['openmorals run -- claude', 'openmorals run -- claude --tokens 5']) assert.ok(!rule(c).startsWith('self-protect'), c);
  });
});

describe('openmorals run: the command after "--" is judged as if typed', () => {
  const verdict = (c: string, where = {}) => decide({ kind: 'exec', command: c, shell: 'posix', tool: 'Bash' }, DEFAULT_BYLAWS, EMPTY_STATE, BUILTIN_GUARDS, where);

  it('the parser goes on with the words after the first "--", in every form the words show openmorals', () => {
    for (const c of ['openmorals run -- rm -rf build', 'npx openmorals run --agent codex -- rm -rf build', 'npm exec openmorals -- run -- rm -rf build', 'node /x/node_modules/openmorals/dist/src/cli.js run -- rm -rf build', '/x/openmorals/dist/src/cli.js run -- rm -rf build', 'python3 -m openmorals run -- rm -rf build', 'env A=1 sudo time openmorals run --id r -- rm -rf build', 'openmorals run -- openmorals run -- rm -rf build']) {
      const p = parseCommand(c);
      const rm = p.commands.find((x) => x.name === 'rm');
      assert.ok(rm !== undefined, c);
      assert.deepEqual(rm.args, ['-rf', 'build'], c);
      assert.ok(rm.via.includes('openmorals run'), c);
      assert.deepEqual(p.opaque, [], c);
    }
    assert.equal(parseCommand('openmorals sandbox run -- rm -rf build').commands.length, 1, 'sandbox run is not changed here');
  });

  it('a dangerous command after "--" gets the rule it gets when typed; a harmless one is not flagged', () => {
    for (const inner of ['rm -rf ~/work', "bash -c 'rm -rf ~/work'", 'git push --force origin main', 'openmorals init --agent codex', "sh -c 'echo x > openmorals.yaml'", 'openmorals run --tokens 9 -- claude']) {
      const typed = verdict(inner);
      assert.notEqual(typed.decision, 'allow', inner);
      for (const c of [`openmorals run --agent claude-code -- ${inner}`, `npx openmorals run -- ${inner}`, `env A=1 openmorals run -- ${inner}`, `openmorals run -- openmorals run -- ${inner}`]) {
        const v = verdict(c);
        assert.equal(v.decision, typed.decision, c);
        assert.equal(v.rule, typed.rule, c);
      }
    }
    for (const c of ['openmorals run -- claude', 'openmorals run --agent claude-code -- ./my-claude.sh --resume', 'openmorals run -- claude -p "explain why rm -rf is dangerous"', 'openmorals run --help']) assert.equal(verdict(c).decision, 'allow', c);
  });

  it('a run whose command cannot be read is asked about, never allowed silently', () => {
    for (const c of ['openmorals run --agent claude-code', 'openmorals run --', 'openmorals run -- for x']) assert.equal(verdict(c).rule, 'parser.opaque', c);
    assert.equal(verdict('alias rm=ls; openmorals run -- rm -rf build').rule, 'destructive.recursive-delete', 'no alias applies to the program run starts');
  });

  it('a run started from a source checkout, which only its package.json shows, is asked about', () => {
    const co = tempDir('run-checkout');
    mkdirSync(join(co, 'dist', 'src'), { recursive: true });
    writeFileSync(join(co, 'package.json'), '{"name":"openmorals"}');
    writeFileSync(join(co, 'dist', 'src', 'cli.js'), '');
    for (const c of ['node dist/src/cli.js run -- ls', 'node dist/src/cli.js run -- rm -rf build /x/node_modules/openmorals/dist/src/cli.js']) assert.equal(verdict(c, { cwd: co }).rule, 'self-protect.write', c);
    assert.equal(verdict('node dist/src/cli.js run --help', { cwd: co }).decision, 'allow');
    assert.equal(verdict('node dist/src/cli.js check "rm -rf x"', { cwd: co }).decision, 'allow');
  });
});

describe('openmorals run: --agent, what was checked per host, and doctor', () => {
  it('refuses --agent that names one host while the command is another host', async () => {
    const s = setup();
    assert.equal(await runCommand(['--agent', 'claude-code', '--', 'codex', 'exec', 'hi'], s.deps()), 64);
    assert.match(s.stderr(), /--agent claude-code would check the claude-code hook, but codex starts codex/);
    assert.equal(await runCommand(['--agent', 'claude-code', '--', '/usr/local/bin/gemini'], s.deps()), 64);
    assert.equal(s.calls.length, 0);
    assert.equal(await runCommand(['--agent', 'claude-code', '--', '/usr/local/bin/claude'], s.deps()), 0, s.stderr());
    assert.equal(await runCommand(['--agent', 'claude-code', '--', 'bash', '-c', 'x'], s.deps()), 0, s.stderr());
    assert.match(s.stderr(), /host claude-code\. Checked: .*\. Not checked: that bash, the program you named, is claude-code or loads its hook\./);
    assert.equal(s.calls.length, 2);
  });

  it('says for another host only what was checked: a hook entry in the project, not that it starts', async () => {
    const s = setup('codex');
    writeFileSync(join(s.proj, '.codex', 'hooks.json'), '{}');
    writeFileSync(join(s.proj, '.codex', 'config.toml'), '# openmorals hook codex\n');
    assert.equal(await runCommand(['--', 'codex'], s.deps()), 0, s.stderr());
    assert.match(s.stderr(), /Checked: a codex hook entry was found in this project's settings in .* \(a text check; it was not started, and whether Codex loads it is not checked\)\./);
    assert.doesNotMatch(s.stderr(), /installed and starts/);
  });

  it("prints doctor's warnings and next step for the host before the start line, and still starts", async () => {
    const s = setup('codex');
    assert.equal(await runCommand(['--', 'codex'], s.deps()), 0, s.stderr());
    const err = s.stderr();
    const warn = err.indexOf('openmorals run: doctor warns (codex, on failure): Codex runs the call when a hook fails or times out');
    const next = err.indexOf('openmorals run: doctor notes (codex, next step): trust the hook in Codex');
    const startLine = err.indexOf(', host codex. Checked');
    assert.ok(warn !== -1 && next !== -1 && startLine !== -1, err);
    assert.ok(warn < startLine && next < startLine, err);
    assert.equal(s.calls.length, 1);
  });

  it('a refusal for another host says that user-level settings are not read', async () => {
    const s = setup('claude');
    assert.equal(await runCommand(['--', 'codex'], s.deps()), RUN_REFUSED_EXIT);
    assert.match(s.stderr(), /For codex, only this project's files are read; a hook in your user-level codex settings is not seen\. If yours is there, either install it in this project or start codex directly/);
    const t = setup('none');
    assert.equal(await runCommand(['--', 'claude'], t.deps()), RUN_REFUSED_EXIT);
    assert.doesNotMatch(t.stderr(), /user-level/, 'Claude Code user settings are read');
  });

  it('a failure of the check itself is a refusal: 125, nothing started, no stack', async () => {
    const s = setup();
    const code = await runCommand(['--', 'claude'], s.deps({ runDoctor: () => { throw new Error('disk gone'); } }));
    assert.equal(code, RUN_REFUSED_EXIT);
    assert.match(s.stderr(), /refused: the check of the claude-code hook could not be made \(disk gone\)\. Nothing was started\./);
    assert.doesNotMatch(s.stderr(), /\n\s+at /);
    assert.equal(s.calls.length, 0);
    assert.ok(!existsSync(join(s.dir, 'runs')));
  });

  it('joining a run that was never started says so in the start line', async () => {
    const s = setup();
    assert.equal(await runCommand(['--', 'claude'], s.deps({ env: { ...s.env, OPENMORALS_RUN: 'ghost' } })), 0);
    assert.match(s.stderr(), /joins run ghost \(OPENMORALS_RUN; no run by this id was started here, so it has no limits; the hook counts it from now as a run with no limits\)/);
    const t = setup();
    assert.equal(budgetCommand(['start', '--id', 'real', '--tokens', '100'], { env: t.env }).exitCode, 0);
    assert.equal(await runCommand(['--', 'claude'], t.deps({ env: { ...t.env, OPENMORALS_RUN: 'real' } })), 0);
    assert.match(t.stderr(), /joins run real \(OPENMORALS_RUN\), host/);
    const u = setup();
    assert.equal(await runCommand(['--id', 'new1', '--', 'claude'], u.deps()), 0);
    assert.match(u.stderr(), /run new1 \(--id; no run by this id was started here/);
  });
});

describe('openmorals run: the started program', () => {
  class FakeChild extends EventEmitter {
    kills: string[] = [];
    kill(sig: NodeJS.Signals): boolean {
      this.kills.push(sig);
      return true;
    }
  }
  const make = () => {
    const child = new FakeChild();
    const proc = new EventEmitter();
    const fn = ((): FakeChild => child) as unknown as SpawnFn;
    const opts: ChildOptions = { cwd: '/', env: {}, terminal: false };
    return { child, proc, start: startChildWith(fn, proc as unknown as SignalTarget), opts };
  };

  it('an error after the program started is not "could not start": it waits for the exit', async () => {
    const f = make();
    const p = f.start('claude', [], f.opts);
    f.child.emit('spawn');
    f.child.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));
    f.proc.emit('SIGTERM');
    assert.deepEqual(f.child.kills, ['SIGTERM'], 'signals are still passed on');
    f.child.emit('exit', 0, null);
    assert.deepEqual(await p, { code: 0, signal: null });
    assert.equal(f.proc.listenerCount('SIGTERM'), 0);
  });

  it('an error before it started is "could not start"', async () => {
    const f = make();
    const p = f.start('claude', [], f.opts);
    f.child.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }));
    f.child.emit('exit', -2, null);
    assert.deepEqual(await p, { code: null, signal: null, error: { message: 'spawn claude ENOENT', errno: 'ENOENT' } });
    assert.equal(f.proc.listenerCount('SIGINT'), 0);
  });

  it('each signal is passed on once, and Ctrl-C is not passed again when a terminal sends it', async () => {
    const f = make();
    const p = f.start('claude', [], { ...f.opts, terminal: true });
    f.child.emit('spawn');
    f.proc.emit('SIGINT');
    f.proc.emit('SIGHUP');
    f.proc.emit('SIGHUP');
    assert.deepEqual(f.child.kills, ['SIGHUP', 'SIGHUP']);
    f.child.emit('exit', null, 'SIGHUP');
    f.child.emit('exit', 0, null);
    assert.deepEqual(await p, { code: null, signal: 'SIGHUP' });
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) assert.equal(f.proc.listenerCount(sig), 0, sig);
  });
});

/** The built command, started for real. The child is node running a short script, named a host with --agent; no host is run. */
describe('openmorals run, the built command', () => {
  const project = () => {
    const proj = tempDir('run-cli-proj');
    const home = tempDir('run-cli-home');
    assert.ok(initProject(proj, { hookCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} hook claude-code` }).ok);
    const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? home, OPENMORALS_HOME: join(home, 'om'), CLAUDE_CONFIG_DIR: join(home, 'claude'), XDG_CONFIG_HOME: join(home, 'xdg') };
    return { proj, env };
  };
  const start = (args: string[], cwd: string, env: NodeJS.ProcessEnv) => {
    const p = spawn(process.execPath, [CLI, 'run', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (b: Buffer) => (out += b.toString()));
    p.stderr.on('data', (b: Buffer) => (err += b.toString()));
    const done = new Promise<{ code: number | null; out: string; err: string }>((res) => p.on('close', (code) => res({ code, out, err })));
    return { p, done, err: () => err };
  };

  it("leaves the host's standard output alone and returns its exit code", { timeout: 30000 }, async () => {
    const { proj, env } = project();
    const r = await start(['--agent', 'claude-code', '--', process.execPath, '-e', 'process.stdout.write("child out"); process.exit(5)'], proj, env).done;
    assert.equal(r.code, 5, r.err);
    assert.equal(r.out, 'child out', 'only the child wrote to standard output');
    assert.match(r.err, /this does not limit what the agent can reach/);
    assert.match(r.err, /no run card/);
  });

  it('passes a signal on to the host and still prints the run card', { timeout: 30000 }, async () => {
    const { proj, env } = project();
    for (const [sig, want] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
      const s = start(['--agent', 'claude-code', '--', process.execPath, '-e', 'setTimeout(() => {}, 20000)'], proj, env);
      let closed = false;
      void s.done.then(() => (closed = true));
      await new Promise<void>((res) => {
        const t = setInterval(() => {
          if (closed || /Not checked/.test(s.err())) {
            clearInterval(t);
            res();
          }
        }, 20);
      });
      await new Promise((res) => setTimeout(res, 150));
      s.p.kill(sig);
      const r = await s.done;
      assert.equal(r.code, want, `${sig}: ${r.err}`);
      assert.match(r.err, new RegExp(`ended with signal ${sig}`));
      assert.match(r.err, /no run card/);
    }
  });

  it('help is its own, and help after "--" goes to the host', { timeout: 30000 }, async () => {
    const { proj, env } = project();
    const h = await start(['--help'], proj, env).done;
    assert.equal(h.code, 0);
    assert.match(h.out, /openmorals run \[--agent NAME\]/);
    const r = await start(['--agent', 'claude-code', '--', process.execPath, '-e', 'process.stdout.write(process.argv.slice(1).join(" "))', '--', '--help', '-h'], proj, env).done;
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, '--help -h');
  });
});
