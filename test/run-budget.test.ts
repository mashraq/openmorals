import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runClaudeCodeHook } from '../src/adapters/claude-code.js';
import { DEFAULT_BYLAWS } from '../src/bylaws.js';
import { decide } from '../src/engine.js';
import { budgetCommand, stopCommand } from '../src/tokens/command.js';
import { readRunFile, runControl, runDir, runStatus, startRun, stopVerdict } from '../src/tokens/index.js';
import type { RunLimits } from '../src/tokens/index.js';
import { EMPTY_STATE } from '../src/types.js';
import { tempDir } from './helpers.js';

const lim = (soft: number, hard: number) => ({ soft, hard, step: hard > 0 ? hard : soft });
const counts = (tool_calls: number, tokens = 0, spawns = 0) => ({ tool_calls, tokens, spawns });
const started = (limits: RunLimits): string => {
  const dir = tempDir('run');
  const r = startRun(dir, 'r1', limits, new Date('2026-11-26T10:00:00Z'));
  assert.ok(r.ok);
  return dir;
};
const rules = (r: ReturnType<typeof runControl>): string[] => r.findings.map((f) => `${f.decision} ${f.rule}`);

describe('the run budget: one budget for a tree of agents (0.37.0)', () => {
  it('sums every session of a run, and refuses every session once a hard limit is reached', () => {
    const dir = started({ tool_calls: lim(0, 5) });
    assert.deepEqual(rules(runControl({ dir, run: 'r1', session: 'a', counts: counts(2) })), []);
    assert.deepEqual(rules(runControl({ dir, run: 'r1', session: 'b', counts: counts(2) })), []);
    const c = runControl({ dir, run: 'r1', session: 'c', counts: counts(1) });
    assert.equal(c.totals.tool_calls, 5);
    assert.deepEqual(rules(c), ['deny budget.run.tool_calls.hard']);
    assert.deepEqual(rules(runControl({ dir, run: 'r1', session: 'a', counts: counts(3) })), ['deny budget.run.tool_calls.hard'], 'a sibling is refused too');
  });

  it('asks once for the whole run when it passes a soft limit, whichever session crosses it', () => {
    const dir = started({ tool_calls: lim(3, 0) });
    runControl({ dir, run: 'r1', session: 'a', counts: counts(2) });
    assert.deepEqual(rules(runControl({ dir, run: 'r1', session: 'b', counts: counts(1) })), ['ask budget.run.tool_calls.soft']);
    assert.deepEqual(rules(runControl({ dir, run: 'r1', session: 'c', counts: counts(1) })), [], 'the siblings do not ask again');
    assert.deepEqual(rules(runControl({ dir, run: 'r1', session: 'a', counts: counts(3) })), []);
  });

  it('counts a restarted or re-dispatched worker as a new session, and refuses the one past the limit without counting it', () => {
    const dir = started({ sessions: lim(0, 2) });
    assert.deepEqual(rules(runControl({ dir, run: 'r1', session: 'w1', counts: counts(1) })), []);
    assert.deepEqual(rules(runControl({ dir, run: 'r1', session: 'w2', counts: counts(1) })), []);
    const w3 = runControl({ dir, run: 'r1', session: 'w3', counts: counts(1) });
    assert.deepEqual(rules(w3), ['deny budget.run.sessions.hard']);
    assert.match(w3.findings[0]?.reason ?? '', /restarted or re-dispatched worker counts as a new session/);
    assert.equal(runStatus(dir, 'r1').totals.sessions, 2, 'the refused session is not written');
    assert.deepEqual(rules(runControl({ dir, run: 'r1', session: 'w1', counts: counts(2) })), [], 'the sessions already in the run go on');
  });

  it('keeps the highest count it has seen, so a session that restarts its own counter does not refill the run', () => {
    const dir = started({ tokens: lim(0, 1000) });
    runControl({ dir, run: 'r1', session: 'a', counts: counts(1, 800) });
    const r = runControl({ dir, run: 'r1', session: 'a', counts: counts(1, 50) });
    assert.equal(r.totals.tokens, 800);
  });

  it('tells the agent once per session at 90% of a hard limit', () => {
    const dir = started({ tool_calls: lim(0, 10) });
    assert.equal(runControl({ dir, run: 'r1', session: 'a', counts: counts(8) }).notice, null);
    assert.match(runControl({ dir, run: 'r1', session: 'a', counts: counts(9) }).notice ?? '', /used 9 of its 10 tool calls \(90%\)/);
    assert.equal(runControl({ dir, run: 'r1', session: 'a', counts: counts(9) }).notice, null, 'once');
  });

  it('holds a call when the run limits or a session file cannot be read', () => {
    const dir = started({ tool_calls: lim(0, 10) });
    writeFileSync(join(runDir(dir, 'r1'), 'run.json'), '{nope');
    assert.deepEqual(rules(runControl({ dir, run: 'r1', session: 'a', counts: counts(1) })), ['ask budget.run.unreadable']);
    writeFileSync(join(runDir(dir, 'r1'), 'run.json'), JSON.stringify({ version: 1, run: 'r1', limits: { tool_calls: { soft: 9, hard: 3 } } }));
    assert.ok('error' in (readRunFile(dir, 'r1') ?? {}), 'soft above hard is refused, not read as unlimited');
    const d2 = started({ tool_calls: lim(0, 10) });
    runControl({ dir: d2, run: 'r1', session: 'a', counts: counts(1) });
    writeFileSync(join(runDir(d2, 'r1'), 'nodes', 'b.json'), 'x');
    assert.deepEqual(rules(runControl({ dir: d2, run: 'r1', session: 'a', counts: counts(2) })), ['ask budget.run.unreadable']);
  });

  it('a run with no limits file is counted only', () => {
    const dir = tempDir('run-none');
    const r = runControl({ dir, run: 'loose', session: 'a', counts: counts(4) });
    assert.deepEqual(rules(r), []);
    assert.equal(runStatus(dir, 'loose').totals.tool_calls, 4);
  });

  it('sets a run budget once: starting the same run again does not refill it', () => {
    const dir = started({ tool_calls: lim(0, 5) });
    const again = startRun(dir, 'r1', { tool_calls: lim(0, 500) });
    assert.equal(again.ok, false);
    const f = readRunFile(dir, 'r1');
    assert.ok(f !== null && !('error' in f));
    assert.equal(f.limits.tool_calls?.hard, 5);
  });

  it('stops a whole run by its id, and only a clear lifts it', () => {
    const home = tempDir('run-stop');
    const env = { OPENMORALS_HOME: home };
    assert.equal(stopCommand(['--run', 'r1'], { env }).exitCode, 0);
    assert.match(stopVerdict(home, 's1', 'r1')?.reason ?? '', /stopped this run/);
    assert.equal(stopVerdict(home, 's1', 'r2'), null);
    assert.equal(stopVerdict(home, 's1'), null, 'a session outside the run goes on');
    assert.equal(stopCommand(['--clear', '--run', 'r1'], { env }).exitCode, 0);
    assert.equal(stopVerdict(home, 's1', 'r1'), null);
    assert.equal(stopCommand(['--run', '../x'], { env }).exitCode, 64);
  });
});

describe('the run budget in the Claude Code hook (0.37.0)', () => {
  const setup = () => {
    const home = tempDir('run-hook');
    const proj = tempDir('run-proj');
    const call = (session: string, run: string | undefined): ReturnType<typeof runClaudeCodeHook> =>
      runClaudeCodeHook(JSON.stringify({ session_id: session, cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(proj, 'a') } }), { env: { OPENMORALS_HOME: home, ...(run !== undefined ? { OPENMORALS_RUN: run } : {}) } });
    return { home, call };
  };

  it('counts every session started with OPENMORALS_RUN against one budget', () => {
    const { home, call } = setup();
    const s = budgetCommand(['start', '--id', 'r1', '--tool-calls', '3'], { env: { OPENMORALS_HOME: home } });
    assert.equal(s.exitCode, 0);
    assert.equal(s.stdout, 'export OPENMORALS_RUN=r1\n');
    assert.equal(call('a', 'r1').verdict.decision, 'allow');
    assert.equal(call('b', 'r1').verdict.decision, 'allow');
    const third = call('c', 'r1');
    assert.equal(third.verdict.rule, 'budget.run.tool_calls.hard');
    assert.equal(call('d', undefined).verdict.decision, 'allow', 'a session outside the run keeps its own limits');
  });

  it('counts tokens from the transcript and gives the agent the 90% line beside an allowed call', () => {
    const home = tempDir('run-tok');
    const proj = tempDir('run-tok-proj');
    const tx = join(proj, 'sess.jsonl');
    writeFileSync(tx, `${JSON.stringify({ type: 'assistant', message: { id: 'm1', role: 'assistant', content: [], usage: { input_tokens: 900, output_tokens: 20 } } })}\n`);
    const env = { OPENMORALS_HOME: home, OPENMORALS_RUN: 'r1' };
    budgetCommand(['start', '--id', 'r1', '--tokens', '1000'], { env });
    const r = runClaudeCodeHook(JSON.stringify({ session_id: 'a', cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: join(proj, 'a') }, transcript_path: tx }), { env });
    assert.equal(r.verdict.decision, 'allow');
    assert.match(r.stdout, /this run has used 920 of its 1000 tokens \(90%\)/);
    assert.equal(runStatus(home, 'r1').totals.tokens, 920);
  });

  it('refuses every call of a stopped run and ends the turn', () => {
    const { home, call } = setup();
    const env = { OPENMORALS_HOME: home };
    budgetCommand(['start', '--id', 'r1', '--tokens', '1000'], { env });
    assert.equal(stopCommand(['--run', 'r1'], { env }).exitCode, 0);
    const r = call('a', 'r1');
    assert.equal(r.verdict.rule, 'budget.stopped');
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.equal(out['continue'], false);
    assert.match(String(out['stopReason']), /stopped this run/);
    assert.equal(call('a', 'r2').verdict.decision, 'allow');
  });
});

describe('openmorals budget (0.37.0)', () => {
  it('checks its arguments', () => {
    const env = { OPENMORALS_HOME: tempDir('budget-cli') };
    assert.equal(budgetCommand([], { env }).exitCode, 64);
    assert.equal(budgetCommand(['start'], { env }).exitCode, 64, 'at least one limit');
    assert.equal(budgetCommand(['start', '--tokens', '0'], { env }).exitCode, 64);
    assert.equal(budgetCommand(['start', '--tokens', '9:3'], { env }).exitCode, 64);
    assert.equal(budgetCommand(['start', '--id', '../x', '--tokens', '3'], { env }).exitCode, 64);
    assert.equal(budgetCommand(['start', '--bogus', '3'], { env }).exitCode, 64);
    const s = budgetCommand(['start', '--tokens', '100:200'], { env, now: new Date('2026-11-26T10:00:00Z') });
    assert.equal(s.exitCode, 0);
    assert.match(s.stdout, /^export OPENMORALS_RUN=run-[A-Za-z0-9_.-]+\n$/);
  });

  it('shows each run with its totals and limits', () => {
    const home = tempDir('budget-status');
    const env = { OPENMORALS_HOME: home };
    budgetCommand(['start', '--id', 'r1', '--tool-calls', '2:4', '--sessions', '3'], { env });
    runControl({ dir: home, run: 'r1', session: 'a', counts: counts(2) });
    const text = budgetCommand(['status'], { env }).stdout;
    assert.match(text, /^r1\n/);
    assert.match(text, /tool calls 2 \(asks once at 2, refused at 4\)/);
    const json = JSON.parse(budgetCommand(['status', 'r1', '--json'], { env }).stdout) as { runs: { run: string; totals: { sessions: number } }[] };
    assert.equal(json.runs[0]?.totals.sessions, 1);
    assert.equal(budgetCommand(['status', 'a', 'b'], { env }).exitCode, 64);
  });

  it('an agent cannot give itself or its run a fresh budget, nor stop or clear a run', () => {
    for (const c of ['openmorals budget start --tokens 5', 'openmorals stop --clear --run r1', 'openmorals stop --run r1']) {
      assert.equal(decide({ kind: 'exec', command: c, shell: 'posix', tool: 'Bash' }, DEFAULT_BYLAWS, EMPTY_STATE).rule.startsWith('self-protect'), true, c);
    }
    assert.equal(decide({ kind: 'exec', command: 'openmorals budget status', shell: 'posix', tool: 'Bash' }, DEFAULT_BYLAWS, EMPTY_STATE).decision, 'allow', 'reading the budget is fine');
  });
});

