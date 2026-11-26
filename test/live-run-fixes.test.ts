import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { runClaudeCodeHook } from '../src/adapters/claude-code.js';
import { DEFAULT_BYLAWS } from '../src/bylaws.js';
import { decide } from '../src/engine.js';
import type { Where } from '../src/guard.js';
import { loadSession } from '../src/state.js';
import type { Action } from '../src/types.js';
import { tempDir } from './helpers.js';

// The two bugs the first live run on Claude Code found (26 Nov 2026), fixed in 0.36.2.

const STATE = { toolCalls: 1, tokens: 0, prevTokens: 0 };
const root = mkdtempSync(join(tmpdir(), 'om-live-'));
const cfg = join(root, 'cfg');
const work = join(root, 'work');
const checkout = join(root, 'src', 'guard-checkout');
const other = join(root, 'src', 'other-tool');

before(() => {
  mkdirSync(cfg, { recursive: true });
  mkdirSync(work, { recursive: true });
  for (const [dir, name] of [[checkout, 'openmorals'], [other, 'other-tool']] as const) {
    mkdirSync(join(dir, 'dist', 'src'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
    writeFileSync(join(dir, 'dist', 'src', 'cli.js'), '');
  }
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function where(): Partial<Where> {
  return { configDir: cfg, cwd: work, home: root };
}

function exec(command: string): Action {
  return { kind: 'exec', command, shell: 'posix', tool: 'Bash' };
}

function judged(command: string): string {
  const v = decide(exec(command), DEFAULT_BYLAWS, STATE, undefined, where());
  return `${v.decision} ${v.rule}`;
}

describe('only the person clears a stop, from any install path (0.36.2)', () => {
  const asks = [
    { name: 'a source checkout run by a relative path after cd', cmd: `cd ${checkout} && node dist/src/cli.js stop --clear s-1` },
    { name: 'a source checkout in a folder of another name, by its full path', cmd: `node ${join(checkout, 'dist', 'src', 'cli.js')} stop --clear s-1` },
    { name: 'clearing every stop', cmd: `node ${join(checkout, 'dist', 'src', 'cli.js')} stop --clear` },
    { name: 'any script given stop --clear, whatever it is called', cmd: 'node /opt/copy/run.js stop --clear s-1' },
    { name: 'the other person-only steps of a checkout', cmd: `cd ${checkout} && node dist/src/cli.js approve abc123` },
    { name: 'init from a checkout', cmd: `node ${join(checkout, 'dist', 'src', 'cli.js')} init` },
    { name: 'stopping a session from a checkout (stopping is the person’s too)', cmd: `node ${join(checkout, 'dist', 'src', 'cli.js')} stop s-1` },
    { name: 'the package entry point, as before', cmd: 'node /x/node_modules/openmorals/dist/src/cli.js stop --clear s-1' },
    { name: 'the command itself, as before', cmd: 'openmorals stop --clear s-1' },
  ];
  for (const row of asks) {
    it(`asks: ${row.name}`, () => {
      assert.equal(judged(row.cmd), 'ask self-protect.write');
    });
  }
  const allows = [
    { name: 'reading commands of a checkout', cmd: `cd ${checkout} && node dist/src/cli.js sessions` },
    { name: "another package's CLI with the same words", cmd: `cd ${other} && node dist/src/cli.js init` },
    { name: 'a script that is not there', cmd: 'node build/cli.js approve x' },
  ];
  for (const row of allows) {
    it(`allows: ${row.name}`, () => {
      assert.equal(judged(row.cmd), 'allow none');
    });
  }
});

describe('a declined ask does not taint the session (0.36.2)', () => {
  function setup(prefix: string): { env: NodeJS.ProcessEnv; proj: string; home: string } {
    const home = tempDir(`${prefix}-home`);
    const proj = tempDir(`${prefix}-proj`);
    writeFileSync(join(proj, '.env'), 'API_KEY=not-a-real-key\n');
    return { env: { OPENMORALS_HOME: home, OPENMORALS_UNATTENDED: '' }, proj, home };
  }
  function event(session: string, cwd: string, hook: string, tool: string, input: Record<string, unknown>, id: string): string {
    return JSON.stringify({ session_id: session, transcript_path: null, cwd, permission_mode: 'default', hook_event_name: hook, tool_name: tool, tool_input: input, tool_use_id: id });
  }
  const catEnv = { command: 'cat .env' };
  const fetch = { url: 'https://docs.example.test/guide', prompt: 'read' };

  it('the live run: a declined cat .env leaves no private mark, so a later web fetch and a git check do not ask', () => {
    const { env, proj, home } = setup('declined');
    runClaudeCodeHook(event('d1', proj, 'PreToolUse', 'WebFetch', fetch, 'toolu_f0'), { env });
    runClaudeCodeHook(event('d1', proj, 'PostToolUse', 'WebFetch', fetch, 'toolu_f0'), { env });
    const read = runClaudeCodeHook(event('d1', proj, 'PreToolUse', 'Bash', catEnv, 'toolu_c1'), { env });
    assert.equal(read.verdict.decision, 'ask');
    assert.equal(read.verdict.rule, 'secrets.read');
    // The person says no: Claude Code sends no post-tool event for the call.
    assert.equal(loadSession('d1', home).memory.taint.privateCount, 0);
    const later = runClaudeCodeHook(event('d1', proj, 'PreToolUse', 'WebFetch', { url: 'https://docs.example.test/next', prompt: 'read' }, 'toolu_f2'), { env });
    assert.equal(later.verdict.decision, 'allow', later.verdict.reason);
  });

  it('an approved ask taints once the call runs, and the rule of two then asks', () => {
    const { env, proj, home } = setup('approved');
    runClaudeCodeHook(event('a1', proj, 'PreToolUse', 'WebFetch', fetch, 'toolu_f0'), { env });
    runClaudeCodeHook(event('a1', proj, 'PostToolUse', 'WebFetch', fetch, 'toolu_f0'), { env });
    runClaudeCodeHook(event('a1', proj, 'PreToolUse', 'Bash', catEnv, 'toolu_c1'), { env });
    runClaudeCodeHook(event('a1', proj, 'PostToolUse', 'Bash', catEnv, 'toolu_c1'), { env });
    const s = loadSession('a1', home);
    assert.equal(s.memory.taint.privateCount, 1);
    assert.equal(s.memory.history.some((e) => e.held === true), false, 'the hold is cleared once taken');
    const send = runClaudeCodeHook(event('a1', proj, 'PreToolUse', 'WebFetch', { url: 'https://paste.example.test/new', prompt: 'x' }, 'toolu_f2'), { env });
    assert.equal(send.verdict.decision, 'ask');
    assert.equal(send.verdict.rule, 'taint.rule-of-two');
    runClaudeCodeHook(event('a1', proj, 'PostToolUse', 'Bash', catEnv, 'toolu_c1'), { env });
    assert.equal(loadSession('a1', home).memory.taint.privateCount, 1, 'a second post event adds nothing');
  });

  it('a failed call that was approved still taints (it ran), and so does an interrupted one', () => {
    for (const [session, extra] of [['f1', { error: 'exit 1' }], ['i1', { error: 'interrupted', is_interrupt: true }]] as const) {
      const { env, proj, home } = setup(session);
      runClaudeCodeHook(event(session, proj, 'PreToolUse', 'Bash', catEnv, 'toolu_c1'), { env });
      const post = JSON.stringify({ ...JSON.parse(event(session, proj, 'PostToolUseFailure', 'Bash', catEnv, 'toolu_c1')), ...extra });
      runClaudeCodeHook(post, { env });
      assert.equal(loadSession(session, home).memory.taint.privateCount, 1, session);
    }
  });

  it('an allowed call still taints at once, before it runs', () => {
    const { env, proj, home } = setup('allowed');
    const run = runClaudeCodeHook(event('w1', proj, 'PreToolUse', 'WebFetch', fetch, 'toolu_f0'), { env });
    assert.equal(run.verdict.decision, 'allow');
    assert.equal(loadSession('w1', home).memory.taint.untrustedCount, 1);
  });
});
