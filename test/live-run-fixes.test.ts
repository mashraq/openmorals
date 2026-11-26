import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { runClaudeCodeHook } from '../src/adapters/claude-code.js';
import { DEFAULT_BYLAWS } from '../src/bylaws.js';
import { decide } from '../src/engine.js';
import type { Where } from '../src/guard.js';
import { loadSession, mergeSession } from '../src/state.js';
import { CLEAN_TAINT } from '../src/taint/index.js';
import { parseMemory } from '../src/session.js';
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
    assert.equal(s.memory.held, undefined, 'the hold is cleared once taken');
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

  it('a held taint survives a busy session: an MCP call padded with many paths, then the approved call runs', () => {
    const { env, proj, home } = setup('padded');
    runClaudeCodeHook(event('p1', proj, 'PreToolUse', 'WebFetch', fetch, 'toolu_f0'), { env });
    runClaudeCodeHook(event('p1', proj, 'PostToolUse', 'WebFetch', fetch, 'toolu_f0'), { env });
    const paths = ['/home/dev/.aws/credentials', ...Array.from({ length: 24 }, (_, i) => join(proj, `f${i}.txt`))];
    const read = { paths };
    const pre = runClaudeCodeHook(event('p1', proj, 'PreToolUse', 'mcp__filesystem__read_multiple_files', read, 'toolu_m1'), { env });
    assert.equal(pre.verdict.decision, 'ask');
    runClaudeCodeHook(event('p1', proj, 'PostToolUse', 'mcp__filesystem__read_multiple_files', read, 'toolu_m1'), { env });
    assert.ok(loadSession('p1', home).memory.taint.privateCount > 0, 'the credentials read left its mark');
    const send = runClaudeCodeHook(event('p1', proj, 'PreToolUse', 'WebFetch', { url: 'https://paste.example.test/new', prompt: 'x' }, 'toolu_f2'), { env });
    assert.equal(send.verdict.rule, 'taint.rule-of-two');
  });

  it('a held taint survives many other calls while the person decides', () => {
    const { env, proj, home } = setup('slow');
    runClaudeCodeHook(event('s1', proj, 'PreToolUse', 'WebFetch', fetch, 'toolu_f0'), { env });
    runClaudeCodeHook(event('s1', proj, 'PostToolUse', 'WebFetch', fetch, 'toolu_f0'), { env });
    runClaudeCodeHook(event('s1', proj, 'PreToolUse', 'Bash', catEnv, 'toolu_c1'), { env });
    for (let i = 0; i < 30; i++) runClaudeCodeHook(event('s1', proj, 'PreToolUse', 'Bash', { command: `ls dir${i}` }, `toolu_l${i}`), { env });
    runClaudeCodeHook(event('s1', proj, 'PostToolUse', 'Bash', catEnv, 'toolu_c1'), { env });
    assert.equal(loadSession('s1', home).memory.taint.privateCount, 1);
  });

  it('before any post-tool event the host is not known to send them, so an asked call taints at once', () => {
    const { env, proj, home } = setup('nopost');
    runClaudeCodeHook(event('n1', proj, 'PreToolUse', 'Bash', catEnv, 'toolu_c1'), { env });
    assert.equal(loadSession('n1', home).memory.taint.privateCount, 1);
  });

  it('an allowed call still taints at once, before it runs', () => {
    const { env, proj, home } = setup('allowed');
    const run = runClaudeCodeHook(event('w1', proj, 'PreToolUse', 'WebFetch', fetch, 'toolu_f0'), { env });
    assert.equal(run.verdict.decision, 'allow');
    assert.equal(loadSession('w1', home).memory.taint.untrustedCount, 1);
  });
});

describe('clearing a stop and the person-only steps are recognised however the script is started (0.36.2)', () => {
  const asks = [
    { name: 'a runner option with a value before the script', cmd: `node -r ./x.cjs ${join(checkout, 'dist', 'src', 'cli.js')} approve abc` },
    { name: 'a runner subcommand before the script', cmd: `deno run -A ${join(checkout, 'dist', 'src', 'cli.js')} approve abc` },
    { name: 'a script runner fetched by a package runner', cmd: `npx tsx ${join(checkout, 'dist', 'src', 'cli.js')} approve abc` },
    { name: 'clearing a stop through a package runner', cmd: 'npx tsx /opt/copy/run.ts stop --clear' },
    { name: 'clearing a stop with runner options', cmd: 'node --import tsx /opt/copy/run.ts stop --clear s-1' },
    { name: 'an extensionless script', cmd: `node ${join(checkout, 'dist', 'src', 'cli')} approve abc` },
    { name: 'a script in upper case', cmd: `node ${join(checkout, 'dist', 'src', 'CLI.JS')} approve abc` },
    { name: 'a cd that is undone later in the line', cmd: `cd ${checkout}; cd /tmp; cd ${checkout}; node dist/src/cli.js approve abc` },
    { name: 'PowerShell Set-Location', cmd: `Set-Location ${checkout}; node dist/src/cli.js approve abc` },
  ];
  for (const row of asks) {
    it(`asks: ${row.name}`, () => {
      assert.equal(judged(row.cmd), 'ask self-protect.write');
    });
  }
  it('asks: a cd that may fail, with the checkout as the working folder', () => {
    const v = decide(exec('cd /nonexistent; node dist/src/cli.js approve abc'), DEFAULT_BYLAWS, STATE, undefined, { ...where(), cwd: checkout });
    assert.equal(`${v.decision} ${v.rule}`, 'ask self-protect.write');
  });
  it("allows: another package's CLI after a cd, with runner options", () => {
    assert.equal(judged(`cd ${other} && node -r ./x.cjs dist/src/cli.js init`), 'allow none');
  });
});

describe('more ways of starting a script, and many folder changes (0.36.2)', () => {
  const cli = join(checkout, 'dist', 'src', 'cli.js');
  const asks = [
    { name: 'a runner flag that takes no value before the script', cmd: `deno run -r ${cli} approve abc` },
    { name: 'a runner option with a value the guard does not know', cmd: `deno run --import-map m.json ${cli} approve abc` },
    { name: 'bun --cwd into the checkout', cmd: `bun --cwd ${checkout} dist/src/cli.js approve abc` },
    { name: 'npx -p naming the script runner', cmd: `npx -p tsx tsx ${cli} approve abc` },
    { name: 'ts-node with a quoted option value', cmd: `ts-node -O '{}' ${cli} approve abc` },
    { name: 'bun x running the package', cmd: 'bun x openmorals approve abc' },
    { name: 'bun x running a script runner', cmd: `bun x tsx ${cli} approve abc` },
    { name: 'eight folder changes and then the checkout', cmd: `${Array.from({ length: 8 }, (_, i) => `cd /tmp/d${i}`).join('; ')}; cd ${checkout}; node dist/src/cli.js approve abc` },
  ];
  for (const row of asks) {
    it(`asks: ${row.name}`, () => {
      assert.equal(judged(row.cmd), 'ask self-protect.write');
    });
  }
  it('allows: many folder changes with no script run after them', () => {
    assert.equal(judged(`${Array.from({ length: 12 }, (_, i) => `cd /tmp/d${i}`).join('; ')}; ls`), 'allow none');
  });
});

describe('held taints across two writers (0.36.2)', () => {
  const state = { toolCalls: 0, tokens: 0, prevTokens: 0 };
  const mem = (held: string[]) => ({ history: [], taint: CLEAN_TAINT, posts: true as const, ...(held.length > 0 ? { held } : {}) });
  it('keeps every hold of both writers and drops only those taken, even past the cap', () => {
    const base = Array.from({ length: 63 }, (_, i) => `t${i}#0`);
    const disk = [...base, 'disk#0'];
    const ours = [...base.slice(1), 'ours#0'];
    const m = mergeSession({ state, memory: mem(base) }, { state, memory: mem(disk) }, { state, memory: mem(ours) }).memory;
    assert.equal(m.held?.includes('t0#0'), false, 'the hold ours took stays taken');
    assert.ok(m.held?.includes('disk#0') && m.held.includes('ours#0'));
    assert.equal(m.held?.length, 64);
    const many = Array.from({ length: 70 }, (_, i) => `k${i}#0`);
    assert.equal(parseMemory({ history: [], held: many }).held?.length, 70, 'a saved file past the cap keeps its holds');
  });
});
