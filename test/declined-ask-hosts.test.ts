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

// 0.41.3: on the hosts that go through the shared pipeline, an ask the person declines (or a call the host blocks)
// sends no post-tool event, so it must not mark the session as if the call ran. A call that ran still marks it.

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

describe('a declined or blocked ask leaves no mark on the shared-pipeline hosts (0.41.3)', () => {
  for (const h of HOSTS) {
    it(`${h.name}: the private read asks, no post-tool event arrives, and a later fetch does not ask`, () => {
      const { env, proj, home } = setup(`${slug(h.name)}-no`);
      h.pre(env, 's1', proj, FIRST, 'c0');
      h.post(env, 's1', proj, FIRST, 'c0');
      const read = h.pre(env, 's1', proj, READ, 'c1');
      assert.equal(`${read.decision} ${read.rule}`, 'ask secrets.read');
      assert.equal(loadSession('s1', home).memory.taint.privateCount, 0, 'the unanswered ask left no private mark');
      const later = h.pre(env, 's1', proj, LATER, 'c2');
      assert.equal(`${later.decision} ${later.rule}`, 'allow none', later.reason);
    });

    it(`${h.name}: the same read with a post-tool event saying it ran marks the session, and the later fetch asks`, () => {
      const { env, proj, home } = setup(`${slug(h.name)}-ran`);
      h.pre(env, 's1', proj, FIRST, 'c0');
      h.post(env, 's1', proj, FIRST, 'c0');
      h.pre(env, 's1', proj, READ, 'c1');
      h.post(env, 's1', proj, READ, 'c1');
      const s = loadSession('s1', home).memory;
      assert.equal(s.taint.privateCount, 1);
      assert.equal(s.held, undefined, 'the hold is cleared once taken');
      const later = h.pre(env, 's1', proj, LATER, 'c2');
      assert.equal(`${later.decision} ${later.rule}`, 'ask taint.rule-of-two');
      h.post(env, 's1', proj, READ, 'c1');
      assert.equal(loadSession('s1', home).memory.taint.privateCount, 1, 'a second post event adds nothing');
    });

    it(`${h.name}: an allowed private read still marks the session at once, before it runs`, () => {
      const { env, proj, home } = setup(`${slug(h.name)}-allowed`);
      writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\nguards:\n  secrets:\n    read: allow\n');
      const read = h.pre(env, 's1', proj, READ, 'c1');
      assert.equal(read.decision, 'allow', read.reason);
      assert.equal(loadSession('s1', home).memory.taint.privateCount, 1);
    });
  }

  it('Codex and opencode V1 block an ask, so it leaves no mark even before any post-tool event', () => {
    for (const h of HOSTS.filter((x) => x.name === 'Codex' || x.name === 'opencode V1')) {
      const { env, proj, home } = setup(`${slug(h.name)}-first`);
      const read = h.pre(env, 's1', proj, READ, 'c1');
      assert.equal(read.decision, 'ask', h.name);
      assert.equal(loadSession('s1', home).memory.taint.privateCount, 0, h.name);
      h.post(env, 's1', proj, READ, 'c1');
      assert.equal(loadSession('s1', home).memory.taint.privateCount, 1, `${h.name}: a post event for the call still marks it`);
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
