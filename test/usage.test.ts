import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runClaudeCodeHook } from '../src/adapters/claude-code.js';
import { runCodexHook } from '../src/adapters/codex/index.js';
import { DEFAULT_BYLAWS, parseBylaws, resolveBylaws } from '../src/bylaws.js';
import { loadSessionState } from '../src/state.js';
import { costOf, usageCounts } from '../src/usage.js';
import { tempDir } from './helpers.js';

describe('usageCounts reads only documented or named count fields', () => {
  const CASES: [string, unknown, ReturnType<typeof usageCounts>][] = [
    ['snake case with total', { input_tokens: 100, output_tokens: 20, total_tokens: 120 }, { input: 100, output: 20, total: 120 }],
    ['snake case without total', { input_tokens: 100, output_tokens: 20 }, { input: 100, output: 20, total: 120 }],
    ['chat completions names', { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }, { input: 7, output: 3, total: 10 }],
    ['Gemini names', { promptTokenCount: 50, candidatesTokenCount: 5, totalTokenCount: 55 }, { input: 50, output: 5, total: 55 }],
    ['Gemini total only', { totalTokenCount: 55 }, { input: null, output: null, total: 55 }],
    ['short names', { input: 4, output: 6 }, { input: 4, output: 6, total: 10 }],
    ['fractions are floored', { total_tokens: 9.9 }, { input: null, output: null, total: 9 }],
    ['negative is unreadable', { total_tokens: -5 }, null],
    ['strings are unreadable', { total_tokens: '120' }, null],
    ['null', null, null],
    ['empty object', {}, null],
    ['an array', [1, 2], null],
  ];
  for (const [name, raw, expected] of CASES) it(name, () => assert.deepEqual(usageCounts(raw), expected));
});

describe('costOf uses only the user price table', () => {
  const prices = { 'example-small': { input: 1, output: 4 } };
  it('prices split usage per million tokens, in hundredths', () => {
    assert.equal(costOf({ input: 1_000_000, output: 500_000, total: 1_500_000 }, 'example-small', prices), 100 + 200);
  });
  it('an unsplit total is priced at the higher rate (never low)', () => {
    assert.equal(costOf({ input: null, output: null, total: 1_000_000 }, 'example-small', prices), 400);
  });
  it('no model, an unknown model, or no table: no cost', () => {
    const u = { input: 1, output: 1, total: 2 };
    assert.equal(costOf(u, null, prices), null);
    assert.equal(costOf(u, 'other', prices), null);
    assert.equal(costOf(u, 'example-small', undefined), null);
    assert.equal(costOf(u, 'toString', prices), null);
  });
  it('openmorals ships no prices', () => {
    assert.deepEqual(DEFAULT_BYLAWS.guards.budget.prices, {});
    assert.deepEqual(DEFAULT_BYLAWS.guards.budget.cost, { soft: 0, hard: 0, step: 100 });
  });
  it('the price table is validated', () => {
    for (const bad of ['{ m: { input: -1, output: 1 } }', '{ m: { input: 1 } }', '{ m: 3 }', '{ "bad id!": { input: 1, output: 1 } }', '{ m: { input: 1, output: 1, cached: 1 } }']) {
      assert.equal(parseBylaws(`version: 1\nguards: { budget: { prices: ${bad} } }\n`).ok, false, bad);
    }
    assert.ok(parseBylaws('version: 1\nguards: { budget: { prices: { m-1: { input: 0.25, output: 1.25 } }, cost: { soft: 50, hard: 200, step: 25 } } }\n').ok);
  });
});

function codex(event: Record<string, unknown>, cwd: string, env: NodeJS.ProcessEnv): ReturnType<typeof runCodexHook> {
  return runCodexHook(JSON.stringify({ session_id: 'u1', cwd, model: 'example-small', ...event }), { env, cwd, platform: 'linux' });
}
const PRE = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } };
const usage = (total: number): Record<string, unknown> => ({ hook_event_name: 'PostModelRequest', turn_id: 't', status: 'completed', error: null, token_usage: { input_tokens: total - 10, output_tokens: 10, total_tokens: total } });

function setup(user: string, project = 'version: 1\n'): { cwd: string; home: string; env: NodeJS.ProcessEnv } {
  const cwd = tempDir('usage-proj');
  const home = tempDir('usage-home');
  writeFileSync(join(home, 'openmorals.yaml'), user);
  writeFileSync(join(cwd, 'openmorals.yaml'), project);
  return { cwd, home, env: { OPENMORALS_HOME: home, OPENMORALS_UNATTENDED: '' } };
}

describe('Codex PostModelRequest feeds the token budget', () => {
  const USER = 'version: 1\nguards: { budget: { tokens: { soft: 1000, hard: 5000, step: 1000 } } }\n';
  it('prints nothing, counts the tokens, and the next judged call asks at the soft limit, then denies at the hard one', () => {
    const { cwd, home, env } = setup(USER);
    assert.equal(codex(PRE, cwd, env).verdict.decision, 'allow');
    const u = codex(usage(1500), cwd, env);
    assert.equal(u.stdout, '');
    assert.equal(u.verdict.rule, 'budget.usage');
    assert.equal(loadSessionState('u1', home).tokens, 1500);
    const soft = codex(PRE, cwd, env);
    assert.equal(soft.verdict.decision, 'ask', soft.verdict.reason);
    assert.equal(soft.verdict.rule, 'budget.tokens.soft');
    assert.equal(codex(PRE, cwd, env).verdict.decision, 'allow', 'asks once per step, not on every call');
    codex(usage(4000), cwd, env);
    const hard = codex(PRE, cwd, env);
    assert.equal(hard.verdict.decision, 'deny');
    assert.equal(hard.verdict.rule, 'budget.tokens.hard');
  });
  it('an unreadable or missing token_usage counts nothing', () => {
    const { cwd, home, env } = setup(USER);
    for (const tu of [null, 'lots', { tokens: 9 }]) codex({ hook_event_name: 'PostModelRequest', token_usage: tu }, cwd, env);
    assert.equal(loadSessionState('u1', home).tokens, 0);
  });
  it('the install snippet registers PostModelRequest', async () => {
    const { installSnippet, CODEX_EVENTS } = await import('../src/adapters/codex/index.js');
    assert.ok(CODEX_EVENTS.includes('PostModelRequest'));
    assert.match(installSnippet().toml, /^\[\[hooks\.PostModelRequest\]\]$/m);
  });
});

describe('cost budget from the user price table', () => {
  const USER = 'version: 1\nguards: { budget: { cost: { soft: 10, hard: 50, step: 10 }, prices: { example-small: { input: 10, output: 40 } } } }\n';
  it('priced usage raises the spend; the next judged call asks at the soft limit and denies at the hard one', () => {
    const { cwd, home, env } = setup(USER);
    codex(PRE, cwd, env);
    codex(usage(10_010), cwd, env);
    const s = loadSessionState('u1', home);
    assert.ok(s.cost !== undefined && Math.abs(s.cost - 10.04) < 1e-9, `cost ${s.cost}`);
    const soft = codex(PRE, cwd, env);
    assert.equal(soft.verdict.rule, 'budget.cost.soft', soft.verdict.reason);
    codex(usage(50_000), cwd, env);
    assert.equal(codex(PRE, cwd, env).verdict.rule, 'budget.cost.hard');
  });
  it('a model with no price adds tokens but no spend', () => {
    const { cwd, home, env } = setup(USER);
    runCodexHook(JSON.stringify({ session_id: 'u1', cwd, model: 'unpriced-model', ...usage(100_000) }), { env, cwd, platform: 'linux' });
    const s = loadSessionState('u1', home);
    assert.equal(s.tokens, 100_000);
    assert.equal(s.cost, undefined);
  });
  it('a project file cannot set prices (it could zero them) but may lower the cost limit', () => {
    const { cwd, env } = setup(USER, 'version: 1\nguards: { budget: { prices: { example-small: { input: 0, output: 0 } }, cost: { soft: 5, hard: 20 } } }\n');
    const load = resolveBylaws(cwd, env);
    assert.ok(load.ok);
    if (!load.ok) return;
    assert.deepEqual(load.bylaws.guards.budget.prices, { 'example-small': { input: 10, output: 40 } });
    assert.deepEqual(load.bylaws.guards.budget.cost, { soft: 5, hard: 20, step: 10 });
    assert.ok((load.ignored ?? []).some((l) => l.field === 'guards.budget.prices'));
  });
  it('a project file cannot raise or switch off the cost limit', () => {
    const { cwd, env } = setup(USER, 'version: 1\nguards: { budget: { cost: { soft: 0, hard: 0 } } }\n');
    const load = resolveBylaws(cwd, env);
    assert.ok(load.ok && load.bylaws.guards.budget.cost?.hard === 50 && load.bylaws.guards.budget.cost.soft === 10);
  });
});

describe('hosts that report no usage', () => {
  it('Claude Code: hook inputs carry no token counts, so only tool calls are counted', () => {
    const { cwd, home, env } = setup('version: 1\n');
    for (let i = 0; i < 3; i++) runClaudeCodeHook(JSON.stringify({ session_id: 'u1', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), { env });
    const s = loadSessionState('u1', home);
    assert.equal(s.toolCalls, 3);
    assert.equal(s.tokens, 0);
  });
});
