import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { runClaudeCodeHook } from '../src/adapters/claude-code.js';
import { runGeminiHook } from '../src/adapters/gemini-cli/index.js';
import { runOpencodeHook } from '../src/adapters/opencode/index.js';
import { tempDir } from './helpers.js';

// The hook's output for search and read calls, pinned byte for byte as 0.39.0 printed it (measured on the 0.39.0
// build): the 0.40.0 search note goes to the audit text only, never to what the host is told. Paths are obviously fake.
const root = tempDir('hook-pinned');
after(() => {
  rmSync(root, { recursive: true, force: true });
});
let n = 0;
function fresh(): { home: string; proj: string } {
  n++;
  const home = join(root, `h${n}`);
  const proj = join(root, `p${n}`);
  mkdirSync(home, { recursive: true });
  mkdirSync(proj, { recursive: true });
  return { home, proj };
}
const now = new Date('2026-11-26T00:00:00.000Z');
const ASK_ENV = (tool: string, what: string): string => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `openmorals ask [secrets.read]: ${tool} reads an environment file ('${what}')` } });

describe('hook output is unchanged by the 0.40.0 search note', () => {
  const cc: [string, Record<string, unknown>, string][] = [
    ['Grep', { pattern: 'secret' }, ''],
    ['Grep', { pattern: 'x', path: '.env' }, ASK_ENV('Grep', '.env')],
    ['Grep', { pattern: 'x', path: 'src', glob: '*.ts' }, ''],
    ['Grep', { pattern: `AKIA${'ABCDEFGHIJKLMNOP'}` }, ''],
    ['Glob', { pattern: '**/*.ts' }, ''],
    ['Glob', { pattern: '.env*' }, ASK_ENV('Glob', '.env*')],
    ['Read', { file_path: '.env' }, ASK_ENV('Read', '.env')],
  ];
  for (const [tool, input, want] of cc) {
    it(`Claude Code ${tool} ${JSON.stringify(input)}`, () => {
      const { home, proj } = fresh();
      const r = runClaudeCodeHook(JSON.stringify({ session_id: 's', cwd: proj, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: `u${n}` }), { env: { OPENMORALS_HOME: home }, cwd: proj, now });
      assert.equal(r.stdout ?? '', want);
    });
  }
  it('Gemini CLI grep_search', () => {
    const a = fresh();
    assert.equal(runGeminiHook(JSON.stringify({ session_id: 's', cwd: a.proj, hook_event_name: 'BeforeTool', tool_name: 'grep_search', tool_input: { pattern: 'secret' } }), { env: { OPENMORALS_HOME: a.home }, cwd: a.proj, now }).stdout, '{}');
    const b = fresh();
    const text = "openmorals ask [secrets.read]: grep_search reads an environment file ('.env')";
    assert.equal(runGeminiHook(JSON.stringify({ session_id: 's', cwd: b.proj, hook_event_name: 'BeforeTool', tool_name: 'grep_search', tool_input: { pattern: 'x', dir_path: '.env' } }), { env: { OPENMORALS_HOME: b.home }, cwd: b.proj, now }).stdout, JSON.stringify({ decision: 'ask', reason: text, systemMessage: text }));
  });
  it('opencode grep', () => {
    const a = fresh();
    assert.equal(runOpencodeHook(JSON.stringify({ event: 'tool.execute.before', sessionID: 's', callID: 'c', tool: 'grep', args: { pattern: 'x' }, cwd: a.proj }), { env: { OPENMORALS_HOME: a.home }, cwd: a.proj, now }).stdout, JSON.stringify({ decision: 'allow', rule: 'none', block: false, effect: 'allow', message: '' }));
    const b = fresh();
    const msg = "openmorals ask [secrets.read]: grep reads an environment file ('.env'). This opencode plugin API cannot ask the user, so openmorals blocked this call: tell the user what you wanted to run and why, and let them decide.";
    assert.equal(runOpencodeHook(JSON.stringify({ event: 'tool.execute.before', sessionID: 's', callID: 'c', tool: 'grep', args: { pattern: 'x', path: '.env' }, cwd: b.proj }), { env: { OPENMORALS_HOME: b.home }, cwd: b.proj, now }).stdout, JSON.stringify({ decision: 'ask', rule: 'secrets.read', block: true, effect: 'ask', message: msg }));
  });
});
