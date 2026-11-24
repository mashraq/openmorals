import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { geminiActions, installSnippet, mergeConfig, runGeminiHook, toGeminiOutput } from '../../../src/adapters/gemini-cli/index.js';
import { readAudit } from '../../../src/audit.js';
import { loadSessionState } from '../../../src/state.js';
import { platformsOf, tempDir } from '../codex/helpers.js';
import { GEMINI_CASES } from './cases.js';

const DENY_SUFFIX = '. openmorals is set to block what it would ask about here: tell the user what you wanted to run and why, and let them decide.';

function expectedStdout(decision: string, rule: string, reason: string, askAsDeny: boolean): string {
  if (decision === 'allow') return '{}';
  const text = `openmorals ${decision} [${rule}]: ${reason}`;
  if (decision === 'ask' && askAsDeny) return `{"decision":"deny","reason":${JSON.stringify(text + DENY_SUFFIX)},"systemMessage":${JSON.stringify(text)}}`;
  return `{"decision":"${decision}","reason":${JSON.stringify(text)},"systemMessage":${JSON.stringify(text)}}`;
}

describe('Gemini CLI adapter case table', () => {
  // Each row starts from a clean session: the loop detector and the taint judge remember earlier calls.
  assert.ok(GEMINI_CASES.length >= 15);
  // A row without its own platform runs as macOS and as Windows, so the Windows branch is tested on every machine.
  for (const c of GEMINI_CASES) for (const platform of platformsOf(c)) {
    it(`${c.name} [${platform}]`, () => {
      const run = runGeminiHook(c.stdin, { env: { OPENMORALS_HOME: tempDir('gem-home'), ...(c.env ?? {}) }, cwd: tempDir('gem-cwd'), platform });
      assert.equal(run.exitCode, 0);
      assert.equal(run.verdict.decision, c.decision, run.verdict.reason);
      assert.equal(run.verdict.rule, c.rule, run.verdict.reason);
      assert.equal(run.stdout, expectedStdout(c.decision, c.rule, run.verdict.reason, c.env?.['OPENMORALS_GEMINI_ASK'] === 'deny'));
      assert.doesNotThrow(() => JSON.parse(run.stdout) as unknown);
    });
  }
});

describe('Gemini CLI output shape', () => {
  it('always prints one JSON object, because non-JSON stdout lets the call run', () => {
    for (const d of ['allow', 'ask', 'deny'] as const) {
      const out = JSON.parse(toGeminiOutput({ decision: d, rule: 'r.x', reason: 'why' })) as Record<string, unknown>;
      assert.equal(typeof out, 'object');
      if (d !== 'allow') assert.equal(out['decision'], d);
      else assert.deepEqual(out, {});
    }
  });
  it('prints the literal fail-closed answer for unreadable input', () => {
    const run = runGeminiHook('', { env: { OPENMORALS_HOME: tempDir('gem-lit') } });
    assert.equal(run.stdout, '{"decision":"ask","reason":"openmorals ask [hook.bad-input]: the hook input on stdin is not valid JSON","systemMessage":"openmorals ask [hook.bad-input]: the hook input on stdin is not valid JSON"}');
  });
  it('fails closed on an internal error', () => {
    let reads = 0;
    const env = new Proxy<NodeJS.ProcessEnv>({}, {
      get() {
        reads += 1;
        if (reads > 1) throw new Error('boom');
        return undefined;
      },
    });
    const run = runGeminiHook(JSON.stringify({ hook_event_name: 'BeforeTool', tool_name: 'read_file', tool_input: { file_path: '/w/a' }, session_id: 's', cwd: '/w' }), { env });
    assert.equal(run.verdict.decision, 'ask');
    assert.equal(run.verdict.rule, 'engine.error');
    assert.match(run.stdout, /^\{"decision":"ask"/);
  });
});

describe('Gemini CLI budget, audit and mapping', () => {
  it('counts calls and writes audit lines with source gemini-cli', () => {
    const home = tempDir('gem-audit');
    const proj = tempDir('gem-proj');
    const ev = JSON.stringify({ session_id: 'g-2', cwd: proj, hook_event_name: 'BeforeTool', tool_name: 'read_file', tool_input: { file_path: join(proj, '.env') } });
    runGeminiHook(ev, { env: { OPENMORALS_HOME: home } });
    runGeminiHook(ev, { env: { OPENMORALS_HOME: home } });
    assert.equal(loadSessionState('g-2', home).toolCalls, 2);
    const log = readAudit(join(home, 'audit.jsonl'));
    assert.equal(log.records.length, 2);
    assert.equal(log.records[0]?.source, 'gemini-cli');
    assert.equal(log.records[0]?.tool, 'read_file');
    assert.equal(log.records[0]?.rule, 'secrets.read');
  });
  it('a project rule on the tool name applies', () => {
    const proj = tempDir('gem-rule');
    writeFileSync(join(proj, 'openmorals.yaml'), 'version: 1\nrules:\n  - id: no-search\n    match: { tool: "^google_web_search$" }\n    decision: deny\n    reason: no searching in this repo\n');
    const run = runGeminiHook(JSON.stringify({ session_id: 'r', cwd: proj, hook_event_name: 'BeforeTool', tool_name: 'google_web_search', tool_input: { query: 'x' } }), { env: { OPENMORALS_HOME: tempDir('gem-rh') } });
    assert.equal(run.verdict.decision, 'deny');
    assert.equal(run.verdict.rule, 'rules.no-search');
  });
  it('every URL in a web_fetch prompt is checked', () => {
    const m = geminiActions('web_fetch', { prompt: 'compare https://a.example.test/x and https://b.example.test/y' });
    assert.deepEqual(m.actions.map((a) => (a.kind === 'fetch' ? a.url : a.kind)), ['https://a.example.test/x', 'https://b.example.test/y']);
  });
});

describe('Gemini CLI install snippet and merge', () => {
  it('snippet is the documented settings.json hooks shape', () => {
    const s = installSnippet();
    assert.equal(s.file, '.gemini/settings.json');
    assert.deepEqual(JSON.parse(s.text), { hooks: { BeforeTool: [{ matcher: '*', hooks: [{ name: 'openmorals', type: 'command', command: 'openmorals hook gemini-cli', timeout: 30000, description: 'openmorals: allow, ask or deny each tool call from openmorals.yaml' }] }] } });
  });
  it('merges into existing settings without dropping keys, once', () => {
    const existing = { theme: 'Default', mcpServers: { fs: { command: 'npx' } }, hooks: { AfterTool: [{ hooks: [{ type: 'command', command: 'log.sh' }] }] } };
    const r = mergeConfig(existing);
    assert.ok(r.ok && r.changed);
    if (!r.ok) return;
    assert.equal(r.config['theme'], 'Default');
    assert.deepEqual(r.config['mcpServers'], existing.mcpServers);
    const hooks = r.config['hooks'] as Record<string, unknown>;
    assert.deepEqual(hooks['AfterTool'], existing.hooks.AfterTool);
    assert.equal((hooks['BeforeTool'] as unknown[]).length, 1);
    const again = mergeConfig(r.config);
    assert.ok(again.ok && !again.changed);
    assert.equal(mergeConfig('x').ok, false);
    const dir = tempDir('gem-init');
    writeFileSync(join(dir, 'settings.json'), JSON.stringify(r.config));
    const back = mergeConfig(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as unknown);
    assert.ok(back.ok && !back.changed);
  });
});
