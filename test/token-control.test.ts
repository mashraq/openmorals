import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runClaudeCodeHook } from '../src/adapters/claude-code.js';
import { DEFAULT_BYLAWS, validateBylaws } from '../src/bylaws.js';
import { decide } from '../src/engine.js';
import { loosenings, tighten } from '../src/packs/compare.js';
import { mergeSession, loadSession } from '../src/state.js';
import { EMPTY_MEMORY } from '../src/session.js';
import { sessionsCommand, stopCommand } from '../src/tokens/command.js';
import { agentFindings, clearStop, countAgentCall, countLines, lineUsage, mergeAgentsMemory, mergeTranscriptMemory, readStop, readTranscripts, stopPath, stopSessions, stopVerdict, transcriptFiles, transcriptTotals } from '../src/tokens/index.js';
import type { AgentsMemory } from '../src/tokens/index.js';
import type { Bylaws } from '../src/types.js';
import { EMPTY_STATE } from '../src/types.js';
import { tempDir } from './helpers.js';

/** One transcript line as Claude Code writes it: a model reply with its usage (a reply with several blocks repeats it). */
const reply = (id: string, input: number, output: number, write = 0, read = 0): string =>
  `${JSON.stringify({ type: 'assistant', uuid: `u-${id}-${Math.random()}`, message: { id, role: 'assistant', content: [{ type: 'text', text: 'secret words' }], usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: write, cache_read_input_tokens: read } } })}\n`;
const userLine = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'usage of the "usage" word' } })}\n`;
const budget = (b: Partial<Bylaws['guards']['budget']>): Bylaws => ({ ...DEFAULT_BYLAWS, guards: { ...DEFAULT_BYLAWS.guards, budget: { ...DEFAULT_BYLAWS.guards.budget, ...b } } });

describe('token counts from Claude Code transcripts (0.36.0)', () => {
  it('reads only model replies with usage, and counts cache reads apart', () => {
    assert.deepEqual(lineUsage(reply('m1', 3, 40, 500, 9000).trim()), { id: 'm1', t: 543, r: 9000 });
    assert.equal(lineUsage(userLine.trim()), null);
    assert.equal(lineUsage('{"type":"assistant","message":{"usage":"x"'), null);
    assert.equal(lineUsage('not json "usage"'), null);
  });

  it('counts a reply written as several lines once, and only the rise when a later line reports more', () => {
    const f = countLines(reply('m1', 3, 40, 500) + reply('m1', 3, 40, 500) + reply('m1', 3, 40, 500) + reply('m2', 1, 10) + reply('m2', 1, 25), { off: 0, t: 0, r: 0 });
    assert.equal(f.t, 543 + 11 + 15);
  });

  it('finds the session file and its sub-agents from either side', () => {
    assert.deepEqual(transcriptFiles('/h/.claude/projects/p/abc.jsonl'), { main: '/h/.claude/projects/p/abc.jsonl', subDir: '/h/.claude/projects/p/abc/subagents' });
    assert.deepEqual(transcriptFiles('/h/.claude/projects/p/abc/subagents/agent-x1.jsonl'), { main: '/h/.claude/projects/p/abc.jsonl', subDir: '/h/.claude/projects/p/abc/subagents' });
    assert.equal(transcriptFiles('/etc/passwd'), null);
  });

  it('reads on from where it stopped, waits for a half-written line, and follows sub-agents', () => {
    const dir = tempDir('tx');
    const main = join(dir, 'sess.jsonl');
    writeFileSync(main, reply('a', 10, 90) + reply('a', 10, 90) + userLine);
    let m = readTranscripts(main, undefined);
    assert.equal(transcriptTotals(m).tokens, 100);
    const half = reply('b', 5, 5);
    appendFileSync(main, half.slice(0, 20));
    m = readTranscripts(main, m);
    assert.equal(transcriptTotals(m).tokens, 100, 'a half-written line is not read yet');
    appendFileSync(main, half.slice(20) + reply('a', 10, 90));
    m = readTranscripts(main, m);
    assert.equal(transcriptTotals(m).tokens, 110, 'the rest of the line is read once it is whole; the repeated reply is not counted again');
    mkdirSync(join(dir, 'sess', 'subagents'), { recursive: true });
    writeFileSync(join(dir, 'sess', 'subagents', 'agent-x1.jsonl'), reply('s1', 1000, 1000, 0, 50000));
    writeFileSync(join(dir, 'sess', 'subagents', 'notes.txt'), reply('s2', 99999, 0));
    m = readTranscripts(join(dir, 'sess', 'subagents', 'agent-x1.jsonl'), m);
    assert.deepEqual(transcriptTotals(m), { tokens: 2110, cacheRead: 50000, files: 2 });
    writeFileSync(main, reply('c', 1, 1));
    m = readTranscripts(main, m);
    assert.equal(transcriptTotals(m).tokens, 2002, 'a file rewritten shorter is counted again from the start');
    assert.equal(JSON.stringify(m).includes('secret words'), false, 'no text is kept');
  });

  it('a missing transcript counts nothing and keeps the last counts', () => {
    const m = readTranscripts('/no/such/dir/x.jsonl', { files: { 'x.jsonl': { off: 5, t: 7, r: 0 } }, prev: 7 });
    assert.equal(transcriptTotals(m).tokens, 7);
  });

  it('two hooks of one session keep the file read further', () => {
    const a = { files: { 'x.jsonl': { off: 100, t: 10, r: 0 } }, prev: 10 };
    const b = { files: { 'x.jsonl': { off: 200, t: 30, r: 0 }, 'agent-1.jsonl': { off: 5, t: 1, r: 0 } }, prev: 31 };
    assert.deepEqual(mergeTranscriptMemory(a, b), { files: { 'x.jsonl': { off: 200, t: 30, r: 0 }, 'agent-1.jsonl': { off: 5, t: 1, r: 0 } }, prev: 31 });
    assert.deepEqual(mergeTranscriptMemory(b, a)?.files['x.jsonl'], { off: 200, t: 30, r: 0 });
  });

  it('the hook asks when the transcript passes the soft token limit, and transcript: false turns it off', () => {
    const home = tempDir('tx-home');
    const proj = tempDir('tx-proj');
    const tx = join(proj, 'sess.jsonl');
    writeFileSync(tx, reply('a', 100, 100));
    writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\nguards:\n  budget:\n    tokens: { soft: 1000, hard: 50000, step: 1000 }\n');
    const env = { OPENMORALS_HOME: home };
    // Different files each time, so the loop check stays out of it.
    const names = ['readme', 'package', 'index', 'main', 'config', 'notes', 'tests', 'docs'];
    const call = (): ReturnType<typeof runClaudeCodeHook> => runClaudeCodeHook(JSON.stringify({ session_id: 'tx1', cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(proj, `${names.shift() ?? 'x'}.md`) }, transcript_path: tx }), { env });
    assert.equal(call().verdict.decision, 'allow');
    appendFileSync(tx, reply('b', 500, 600));
    const v = call().verdict;
    assert.equal(v.rule, 'budget.tokens.soft');
    assert.match(v.reason, /1300 tokens/);
    assert.equal(call().verdict.decision, 'allow', 'asked once per step');
    appendFileSync(tx, reply('c', 25000, 25000));
    assert.equal(call().verdict.rule, 'budget.tokens.hard');
    writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\nguards:\n  budget:\n    transcript: false\n    tokens: { soft: 1000, hard: 50000, step: 1000 }\n');
    assert.equal(call().verdict.decision, 'allow');
    writeFileSync(join(proj, 'openmorals.yaml'), 'version: 1\nguards:\n  budget:\n    transcript: false\n');
    writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\nguards:\n  budget:\n    tokens: { soft: 1000, hard: 50000, step: 1000 }\n');
    assert.equal(call().verdict.rule, 'budget.tokens.hard', 'a project file cannot turn the count off');
  });
});

describe('per-agent counts, sub-agent runs and fan-out (0.36.0)', () => {
  it('counts sub-agents started together as one run, and closes the batch on any other call', () => {
    let m: AgentsMemory | undefined;
    for (const tool of ['Agent', 'Agent', 'Agent']) m = countAgentCall(m, null, tool);
    assert.deepEqual(m, { calls: {}, spawns: 1, started: 3, open: { main: 3 } });
    m = countAgentCall(m, null, 'Bash');
    assert.deepEqual(m.open, {});
    m = countAgentCall(m, null, 'Task');
    assert.equal(m.spawns, 2);
    m = countAgentCall(m, 'sub-1', 'Read');
    m = countAgentCall(m, 'sub-1', 'Read');
    m = countAgentCall(m, 'sub-2', 'Agent');
    assert.deepEqual(m.calls, { 'sub-1': 2, 'sub-2': 1 });
    assert.equal(m.spawns, 3, 'a sub-agent starting one is a run of its own');
    assert.deepEqual(m.open, { main: 1, 'sub-2': 1 }, "the main batch stays open: a sub-agent's call is not the main conversation's");
  });

  it('records the kind of each sub-agent, keeps it through a merge, and shows it in sessions', () => {
    let m = countAgentCall(undefined, 'a1', 'Read', 'Explore');
    m = countAgentCall(m, 'a1', 'Read', 'Explore');
    m = countAgentCall(m, 'a2', 'Read', null);
    assert.deepEqual(m.names, { a1: 'Explore' });
    assert.equal(countAgentCall(undefined, null, 'Read', 'Explore').names, undefined, 'the main conversation has no kind');
    const other = countAgentCall(undefined, 'b1', 'Read', 'Plan');
    assert.deepEqual(mergeAgentsMemory(undefined, other, m)?.names, { b1: 'Plan', a1: 'Explore' });
  });

  it('asks past the fan-out limit once per batch, and when runs pass their soft limit', () => {
    let m: AgentsMemory | undefined;
    const b = budget({ fanout: 3, spawns: { soft: 2, hard: 4, step: 1 } });
    const rules: string[][] = [];
    for (let i = 0; i < 5; i++) {
      const next = countAgentCall(m, null, 'Agent');
      rules.push(agentFindings(m, next, null, null, 'Agent', b).map((f) => f.rule));
      m = next;
    }
    assert.deepEqual(rules, [[], [], [], ['budget.fanout'], []]);
    const runs: string[][] = [];
    for (let i = 0; i < 4; i++) {
      const closed = countAgentCall(m, null, 'Bash');
      const next = countAgentCall(closed, null, 'Agent');
      runs.push(agentFindings(closed, next, null, null, 'Agent', b).map((f) => f.rule));
      m = next;
    }
    assert.deepEqual(runs, [['budget.spawns.soft'], ['budget.spawns.soft'], ['budget.spawns.hard'], ['budget.spawns.hard']]);
  });

  it('holds a sub-agent to its own tool-call limit, naming it', () => {
    const b = budget({ agent_tool_calls: { soft: 2, hard: 3, step: 1 } });
    let m: AgentsMemory | undefined;
    const out: string[] = [];
    for (let i = 0; i < 3; i++) {
      const next = countAgentCall(m, 'a1', 'Bash');
      const f = agentFindings(m, next, 'a1', 'Explore', 'Bash', b);
      out.push(f.map((x) => x.rule).join());
      if (i === 1) assert.match(f[0]?.reason ?? '', /sub-agent 'Explore' \('a1'\)/);
      m = next;
    }
    assert.deepEqual(out, ['', 'budget.agent_tool_calls.soft', 'budget.agent_tool_calls.hard']);
    assert.deepEqual(agentFindings(undefined, countAgentCall(undefined, null, 'Bash'), null, null, 'Bash', b), [], 'the main conversation is held by tool_calls');
  });

  it('two hooks of one session add both their counts', () => {
    const base: AgentsMemory = { calls: { a: 1 }, spawns: 1, started: 2, open: {} };
    const disk: AgentsMemory = { calls: { a: 3, b: 1 }, spawns: 2, started: 3, open: {} };
    const ours: AgentsMemory = { calls: { a: 2 }, spawns: 1, started: 3, open: { main: 1 } };
    assert.deepEqual(mergeAgentsMemory(base, disk, ours), { calls: { a: 4, b: 1 }, spawns: 2, started: 4, open: { main: 1 } });
    const merged = mergeSession({ state: EMPTY_STATE, memory: { ...EMPTY_MEMORY, agents: base }, rev: 1 }, { state: EMPTY_STATE, memory: { ...EMPTY_MEMORY, agents: disk }, rev: 2 }, { state: EMPTY_STATE, memory: { ...EMPTY_MEMORY, agents: ours } });
    assert.equal(merged.memory.agents?.calls['a'], 4);
  });

  it('the hook counts sub-agents and asks past the fan-out limit', () => {
    const home = tempDir('fan-home');
    const proj = tempDir('fan-proj');
    const env = { OPENMORALS_HOME: home };
    writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\nguards:\n  budget:\n    fanout: 2\n');
    const spawn = (): string => runClaudeCodeHook(JSON.stringify({ session_id: 'f1', cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { description: 'x', prompt: 'y', subagent_type: 'Explore' } }), { env }).verdict.rule;
    assert.deepEqual([spawn(), spawn(), spawn()].map((r) => r === 'budget.fanout'), [false, false, true]);
    runClaudeCodeHook(JSON.stringify({ session_id: 'f1', cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(proj, 'a') }, agent_id: 'ag1', agent_type: 'Explore' }), { env });
    const agents = loadSession('f1', home).memory.agents;
    assert.deepEqual({ spawns: agents?.spawns, started: agents?.started, calls: agents?.calls }, { spawns: 1, started: 3, calls: { ag1: 1 } });
  });
});

describe('the budget settings (0.36.0)', () => {
  it('reads the new keys, absent by default, and refuses bad values', () => {
    const ok = validateBylaws({ version: 1, guards: { budget: { transcript: false, agent_tool_calls: { soft: 50, hard: 100, step: 10 }, spawns: { soft: 5 }, fanout: 4 } } });
    assert.ok(ok.ok, ok.ok ? '' : ok.error);
    assert.equal(ok.bylaws.guards.budget.transcript, false);
    assert.deepEqual(ok.bylaws.guards.budget.spawns, { soft: 5, hard: 0, step: 25 });
    assert.equal(ok.bylaws.guards.budget.fanout, 4);
    const def = validateBylaws({ version: 1 });
    assert.ok(def.ok);
    for (const k of ['transcript', 'agent_tool_calls', 'spawns', 'fanout'] as const) assert.equal(def.bylaws.guards.budget[k], undefined, k);
    const bad = validateBylaws({ version: 1, guards: { budget: { transcript: 'yes', fanout: -1, spawns: { soft: 9, hard: 3 } } } });
    assert.ok(!bad.ok);
    assert.match(bad.error, /transcript/);
    assert.match(bad.error, /fanout/);
    assert.match(bad.error, /spawns/);
  });

  it('a project file can only make them stricter', () => {
    const floor = DEFAULT_BYLAWS;
    assert.deepEqual(loosenings(budget({ transcript: false }), floor).map((l) => l.field), ['guards.budget.transcript']);
    assert.deepEqual(loosenings(budget({ fanout: 0 }), floor).map((l) => l.field), ['guards.budget.fanout'], '0 is no fan-out limit, the loosest');
    assert.deepEqual(loosenings(budget({ fanout: 50 }), floor).map((l) => l.field), ['guards.budget.fanout']);
    assert.deepEqual(loosenings(budget({ spawns: { soft: 0, hard: 0, step: 25 } }), floor).map((l) => l.field), ['guards.budget.spawns.soft']);
    assert.deepEqual(loosenings(budget({ fanout: 2, spawns: { soft: 10, hard: 20, step: 5 }, agent_tool_calls: { soft: 10, hard: 20, step: 5 }, transcript: true }), floor), []);
    const t = tighten(budget({ transcript: false, fanout: 0 }), budget({ fanout: 4, agent_tool_calls: { soft: 10, hard: 0, step: 5 } }));
    assert.equal(t.bylaws.guards.budget.transcript, true);
    assert.equal(t.bylaws.guards.budget.fanout, 4);
    assert.deepEqual(t.bylaws.guards.budget.agent_tool_calls, { soft: 10, hard: 0, step: 5 });
  });

  it('the default bylaws decide as before', () => {
    assert.equal(decide({ kind: 'exec', command: 'ls', shell: 'posix', tool: 'Bash' }, DEFAULT_BYLAWS, EMPTY_STATE).decision, 'allow');
  });
});

describe('openmorals stop (0.36.0)', () => {
  it('stops one session or all, and only a clear lifts it', () => {
    const dir = tempDir('stop');
    assert.equal(stopVerdict(dir, 's1'), null);
    stopSessions(dir, 's1', new Date('2026-11-25T10:00:00Z'));
    assert.equal(stopVerdict(dir, 's1')?.rule, 'budget.stopped');
    assert.match(stopVerdict(dir, 's1')?.reason ?? '', /this session/);
    assert.equal(stopVerdict(dir, 's2'), null);
    stopSessions(dir, null);
    assert.match(stopVerdict(dir, 's2')?.reason ?? '', /every session/);
    clearStop(dir, 's1');
    assert.notEqual(stopVerdict(dir, 's1'), null, 'the stop of every session still holds');
    clearStop(dir, null);
    assert.equal(stopVerdict(dir, 's1'), null);
    assert.deepEqual(readStop(dir), { sessions: {} });
  });

  it('keeps a stop scope it does not know when it writes the file', () => {
    const dir = tempDir('stop-scope');
    writeFileSync(stopPath(dir), JSON.stringify({ sessions: {}, kinds: { reviewer: '2026-11-25T00:00:00Z' } }));
    stopSessions(dir, 's1');
    clearStop(dir, 's1');
    const raw = JSON.parse(readFileSync(stopPath(dir), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(raw['kinds'], { reviewer: '2026-11-25T00:00:00Z' });
    assert.equal(stopVerdict(dir, 's2'), null, 'this version stops nothing for a scope it does not know');
  });

  it('a stop file that cannot be read stops every session', () => {
    const dir = tempDir('stop-bad');
    writeFileSync(stopPath(dir), '{nope');
    assert.equal(stopVerdict(dir, 'any')?.decision, 'deny');
  });

  it('the hook refuses every call of a stopped session and ends the turn, even one approved before', () => {
    const home = tempDir('stop-home');
    const proj = tempDir('stop-proj');
    const env = { OPENMORALS_HOME: home };
    const call = (session: string, agent?: string): ReturnType<typeof runClaudeCodeHook> => runClaudeCodeHook(JSON.stringify({ session_id: session, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(proj, 'a') }, ...(agent !== undefined ? { agent_id: agent } : {}) }), { env });
    assert.equal(call('s1').verdict.decision, 'allow');
    assert.equal(stopCommand(['s1'], { env }).exitCode, 0);
    const r = call('s1', 'sub');
    assert.equal(r.verdict.rule, 'budget.stopped');
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.equal(out['continue'], false);
    assert.equal((out['hookSpecificOutput'] as Record<string, unknown>)['permissionDecision'], 'deny');
    assert.equal(call('s2').verdict.decision, 'allow');
    assert.equal(stopCommand(['--clear', 's1'], { env }).exitCode, 0);
    assert.equal(call('s1').verdict.decision, 'allow');
  });

  it('the commands check their arguments, and an agent cannot clear a stop', () => {
    const env = { OPENMORALS_HOME: tempDir('stop-cli') };
    assert.equal(stopCommand([], { env }).exitCode, 64);
    assert.equal(stopCommand(['a', 'b'], { env }).exitCode, 64);
    assert.equal(stopCommand(['../x'], { env }).exitCode, 64);
    assert.equal(stopCommand(['--all', 's1'], { env }).exitCode, 64);
    assert.equal(decide({ kind: 'exec', command: 'openmorals stop --clear', shell: 'posix', tool: 'Bash' }, DEFAULT_BYLAWS, EMPTY_STATE).rule.startsWith('self-protect'), true);
    assert.equal(decide({ kind: 'exec', command: 'openmorals stop s1', shell: 'posix', tool: 'Bash' }, DEFAULT_BYLAWS, EMPTY_STATE).decision, 'allow', 'an agent may stop, never restart');
  });

  it('sessions lists what each session used', () => {
    const home = tempDir('sess-home');
    const proj = tempDir('sess-proj');
    const env = { OPENMORALS_HOME: home };
    const tx = join(proj, 'sess.jsonl');
    writeFileSync(tx, reply('a', 1000, 234, 0, 5000));
    runClaudeCodeHook(JSON.stringify({ session_id: 'L1', cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(proj, 'a') }, transcript_path: tx, agent_id: 'w1' }), { env });
    stopSessions(home, 'L1');
    const text = sessionsCommand([], { env }).stdout;
    assert.match(text, /L1 {2}STOPPED/);
    assert.match(text, /1 tool calls, 1,234 tokens \(\+5,000 cache reads\)/);
    assert.match(text, /busiest: w1 1/);
    const json = JSON.parse(sessionsCommand(['--json'], { env }).stdout) as { sessions: { session: string; tokens: number }[] };
    assert.equal(json.sessions[0]?.tokens, 1234);
    assert.equal(sessionsCommand(['--limit', 'x'], { env }).exitCode, 64);
  });
});
