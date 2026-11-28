import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runClaudeCodeHook, toAction } from '../src/adapters/claude-code.js';
import { codexActions, runCodexHook } from '../src/adapters/codex/index.js';
import { geminiActions, runGeminiHook } from '../src/adapters/gemini-cli/index.js';
import { HOST_TOOLS, UNKNOWN_TOOL_RULE, isUnknownEvent, isUnknownTool, unknownToolVerdict } from '../src/adapters/known-tools.js';
import type { ToolListHost } from '../src/adapters/known-tools.js';
import { runOpencodeHook } from '../src/adapters/opencode/index.js';
import { runOpenclawHook } from '../src/adapters/openclaw/index.js';
import { DEFAULT_BYLAWS, resolveBylaws, validateBylaws } from '../src/bylaws.js';
import { EMPTY_MEMORY, TOOLS_RAN_KEEP, noteToolRan, parseMemory } from '../src/session.js';
import { loadSession, saveSession } from '../src/state.js';
import { EMPTY_STATE } from '../src/types.js';
import { tempDir } from './helpers.js';

// Events shaped like each host's hooks reference (read 27 Nov 2026), not captured from a live agent.
function setup(prefix: string): { env: NodeJS.ProcessEnv; proj: string; home: string } {
  const home = tempDir(`${prefix}-home`);
  const proj = tempDir(`${prefix}-proj`);
  return { env: { OPENMORALS_HOME: home, OPENMORALS_UNATTENDED: '' }, proj, home };
}
let n = 0;
const cc = (tool: string, input: Record<string, unknown>, cwd: string, session: string, event = 'PreToolUse', extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ session_id: session, cwd, hook_event_name: event, tool_name: tool, tool_input: input, tool_use_id: `toolu_${++n}`, ...extra });
const cx = (tool: string, input: unknown, cwd: string, session: string, event = 'PreToolUse', extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ session_id: session, cwd, hook_event_name: event, turn_id: 't', tool_name: tool, tool_input: input, tool_use_id: `call_${++n}`, ...extra });
const gm = (tool: string, input: Record<string, unknown>, cwd: string, session: string, event = 'BeforeTool', extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ session_id: session, cwd, hook_event_name: event, tool_name: tool, tool_input: input, ...extra });

describe('the known-tool lists (0.41.0)', () => {
  it('each host lists every name once, and every event once', () => {
    for (const [host, t] of Object.entries(HOST_TOOLS)) {
      assert.equal(new Set(t.tools).size, t.tools.length, `${host} tools`);
      assert.equal(new Set(t.events).size, t.events.length, `${host} events`);
      assert.ok(t.tools.length >= 20, `${host}: ${t.tools.length} tools`);
      for (const e of t.judged) assert.ok(t.events.includes(e), `${host}: judged event ${e} is documented`);
    }
  });
  it('every tool an adapter maps on its own is in its host list, so a mapped tool never asks', () => {
    const claude = ['Bash', 'PowerShell', 'Read', 'NotebookRead', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob', 'LS', 'WebFetch'];
    for (const t of claude) {
      assert.notEqual(toAction(t, {}).kind, 'other', `${t} is mapped`);
      assert.equal(isUnknownTool('claude-code', t), false, t);
    }
    for (const t of ['Bash', 'shell', 'local_shell', 'exec_command', 'container.exec', 'apply_patch', 'Edit', 'Write']) {
      assert.notEqual(codexActions(t, { command: 'ls' }).actions[0]?.kind, 'other', `${t} is mapped`);
      assert.equal(isUnknownTool('codex', t), false, t);
    }
    for (const t of ['run_shell_command', 'read_file', 'write_file', 'replace', 'read_many_files', 'list_directory', 'glob', 'grep_search', 'search_file_content', 'web_fetch']) {
      assert.equal(geminiActions(t, { command: 'ls', file_path: '/w/a', include: ['a'], prompt: 'https://a.example.test' }).problem, null, t);
      assert.equal(isUnknownTool('gemini-cli', t), false, t);
    }
  });
  it('every documented built-in passes the check, and MCP names are left to the MCP path', () => {
    for (const host of Object.keys(HOST_TOOLS) as ToolListHost[]) {
      for (const t of HOST_TOOLS[host].tools) assert.equal(unknownToolVerdict(host, t, DEFAULT_BYLAWS), null, `${host} ${t}`);
    }
    assert.equal(unknownToolVerdict('claude-code', 'mcp__github__list_issues', DEFAULT_BYLAWS), null);
    assert.equal(unknownToolVerdict('codex', 'mcp__fs__read', DEFAULT_BYLAWS), null);
    assert.equal(unknownToolVerdict('gemini-cli', 'mcp_github_search', DEFAULT_BYLAWS), null);
    assert.equal(unknownToolVerdict('claude-code', 'mcp_github_search', DEFAULT_BYLAWS)?.rule, UNKNOWN_TOOL_RULE, 'Gemini MCP prefix is not Claude Code MCP');
  });
  it('the ask names the tool, says openmorals cannot tell what it does, and how to allow it for good', () => {
    const v = unknownToolVerdict('claude-code', 'NewWriteTool', DEFAULT_BYLAWS);
    assert.ok(v !== null);
    assert.equal(v.decision, 'ask');
    assert.match(v.reason, /'NewWriteTool'/);
    assert.match(v.reason, /cannot tell what this call does/);
    assert.match(v.reason, /not ask about it again in this session/);
    assert.match(v.reason, /guards\.unknown-tools\.allow in your user-level openmorals\.yaml/);
    assert.equal(unknownToolVerdict('claude-code', 'NewWriteTool', DEFAULT_BYLAWS, ['NewWriteTool']), null, 'a name that ran');
  });
  it('documented events are known; a new name is not', () => {
    assert.equal(isUnknownEvent('claude-code', 'PermissionRequest'), false);
    assert.equal(isUnknownEvent('claude-code', 'PreToolUseV2'), true);
    assert.equal(isUnknownEvent('codex', 'PostModelRequest'), false);
    assert.equal(isUnknownEvent('gemini-cli', 'PreCompress'), false);
  });
});

describe('bylaws: guards.unknown-tools (0.41.0)', () => {
  it('absent is ask with no names; decision and allow are read; a bad value is an error', () => {
    assert.equal(DEFAULT_BYLAWS.guards['unknown-tools'], undefined);
    const ok = validateBylaws({ version: 1, guards: { 'unknown-tools': { decision: 'deny', allow: ['lint_runner'] } } }, 't');
    assert.ok(ok.ok);
    assert.deepEqual(ok.bylaws.guards['unknown-tools'], { decision: 'deny', allow: ['lint_runner'] });
    assert.equal(validateBylaws({ version: 1, guards: { 'unknown-tools': { allow: 'lint_runner' } } }, 't').ok, false);
    assert.equal(validateBylaws({ version: 1, guards: { 'unknown-tools': { decision: 'maybe' } } }, 't').ok, false);
    assert.equal(validateBylaws({ version: 1, guards: { 'unknown-tools': { names: [] } } }, 't').ok, false);
  });
  it('a project file can tighten but not loosen: its allow list and decision allow are dropped and listed', () => {
    const { env, proj } = setup('ut-floor');
    writeFileSync(join(proj, 'openmorals.yaml'), 'version: 1\nguards:\n  unknown-tools:\n    decision: allow\n    allow: [NewWriteTool]\n');
    const r = resolveBylaws(proj, env);
    assert.ok(r.ok);
    assert.equal(r.bylaws.guards['unknown-tools']?.decision, 'ask');
    assert.deepEqual(r.bylaws.guards['unknown-tools']?.allow ?? [], []);
    const fields = (r.ignored ?? []).map((l) => l.field);
    assert.ok(fields.includes('guards.unknown-tools.decision') && fields.includes('guards.unknown-tools.allow'), fields.join(', '));
    writeFileSync(join(proj, 'openmorals.yaml'), 'version: 1\nguards:\n  unknown-tools:\n    decision: deny\n');
    const tight = resolveBylaws(proj, env);
    assert.ok(tight.ok);
    assert.equal(tight.bylaws.guards['unknown-tools']?.decision, 'deny');
  });
  it('a name the user file allows may also be listed by a project file', () => {
    const { env, proj, home } = setup('ut-floor2');
    writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\nguards:\n  unknown-tools:\n    allow: [NewWriteTool, lint_runner]\n');
    writeFileSync(join(proj, 'openmorals.yaml'), 'version: 1\nguards:\n  unknown-tools:\n    allow: [lint_runner]\n');
    const r = resolveBylaws(proj, env);
    assert.ok(r.ok);
    assert.deepEqual(r.bylaws.guards['unknown-tools']?.allow, ['lint_runner']);
  });
});

describe('Claude Code: an unknown tool asks once per session (0.41.0)', () => {
  it('asks; after its PostToolUse the same name passes; another session asks again', () => {
    const { env, proj } = setup('ut-cc');
    const first = runClaudeCodeHook(cc('NewWriteTool', { file: 'src/a.ts' }, proj, 's1'), { env });
    assert.equal(first.verdict.rule, UNKNOWN_TOOL_RULE);
    assert.match(first.stdout, /"permissionDecision":"ask"/);
    const again = runClaudeCodeHook(cc('NewWriteTool', { file: 'src/a.ts' }, proj, 's1'), { env });
    assert.equal(again.verdict.rule, UNKNOWN_TOOL_RULE, 'declined (no post event): asks again');
    runClaudeCodeHook(cc('NewWriteTool', { file: 'src/a.ts' }, proj, 's1', 'PostToolUse', { tool_response: { ok: true } }), { env });
    assert.deepEqual(loadSession('s1', env['OPENMORALS_HOME']).memory.toolsRan, ['NewWriteTool']);
    const after = runClaudeCodeHook(cc('NewWriteTool', { file: 'src/b.ts' }, proj, 's1'), { env });
    assert.equal(after.verdict.decision, 'allow', after.verdict.reason);
    assert.equal(runClaudeCodeHook(cc('NewWriteTool', { file: 'src/b.ts' }, proj, 's2'), { env }).verdict.rule, UNKNOWN_TOOL_RULE);
  });
  it('a PostToolUseFailure also counts as having run; a known tool is never remembered', () => {
    const { env, proj } = setup('ut-cc2');
    runClaudeCodeHook(cc('ShellRunner', { command: 'ls' }, proj, 's1', 'PostToolUseFailure', { error: 'exit 1' }), { env });
    runClaudeCodeHook(cc('Bash', { command: 'ls' }, proj, 's1', 'PostToolUse', { tool_response: {} }), { env });
    runClaudeCodeHook(cc('mcp__gh__search', { q: 'a' }, proj, 's1', 'PostToolUse', { tool_response: {} }), { env });
    assert.deepEqual(loadSession('s1', env['OPENMORALS_HOME']).memory.toolsRan, ['ShellRunner']);
  });
  it('unattended, the ask is a deny, and an MCP tool is unchanged', () => {
    const { env, proj } = setup('ut-cc3');
    const v = runClaudeCodeHook(cc('NewWriteTool', {}, proj, 's1'), { env, unattended: true }).verdict;
    assert.deepEqual([v.decision, v.rule], ['deny', UNKNOWN_TOOL_RULE]);
    assert.equal(runClaudeCodeHook(cc('mcp__gh__search', { q: 'a' }, proj, 's1'), { env }).verdict.decision, 'allow');
  });
  it('the user file allows a name, or switches the check off; deny blocks even after a run', () => {
    const { env, proj, home } = setup('ut-cc4');
    writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\nguards:\n  unknown-tools:\n    allow: [NewWriteTool]\n');
    assert.equal(runClaudeCodeHook(cc('NewWriteTool', {}, proj, 's1'), { env }).verdict.decision, 'allow');
    assert.equal(runClaudeCodeHook(cc('OtherTool', {}, proj, 's1'), { env }).verdict.rule, UNKNOWN_TOOL_RULE);
    writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\nguards:\n  unknown-tools:\n    decision: allow\n');
    assert.equal(runClaudeCodeHook(cc('OtherTool', {}, proj, 's1'), { env }).verdict.decision, 'allow');
    writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\nguards:\n  unknown-tools:\n    decision: deny\n');
    runClaudeCodeHook(cc('OtherTool', {}, proj, 's1', 'PostToolUse', { tool_response: {} }), { env });
    assert.equal(runClaudeCodeHook(cc('OtherTool', {}, proj, 's1'), { env }).verdict.decision, 'deny');
  });
  it('a deny from another check still wins over the ask', () => {
    const { env, proj } = setup('ut-cc5');
    writeFileSync(join(proj, 'openmorals.yaml'), "version: 1\nrules:\n  - id: no-push-main\n    match: { content: 'push\\b.*\\bmain\\b' }\n    decision: deny\n    reason: No agent pushes to main.\n");
    const v = runClaudeCodeHook(cc('TaskRunner', { text: 'push the release to main' }, proj, 's1'), { env }).verdict;
    assert.deepEqual([v.decision, v.rule], ['deny', 'rules.no-push-main']);
  });
});

describe('Claude Code: an event it does not document (0.41.0)', () => {
  it('with a tool call is judged like PreToolUse, answered under its own name', () => {
    const { env, proj } = setup('ut-ev');
    const r = runClaudeCodeHook(cc('Bash', { command: 'rm -rf build' }, proj, 's1', 'PreToolUseV2'), { env });
    assert.equal(r.verdict.rule, 'destructive.recursive-delete');
    assert.match(r.stdout, /"hookEventName":"PreToolUseV2"/);
    assert.equal(runClaudeCodeHook(cc('NewWriteTool', {}, proj, 's1', 'PreToolUseV2'), { env }).verdict.rule, UNKNOWN_TOOL_RULE);
    assert.equal(loadSession('s1', env['OPENMORALS_HOME']).state.toolCalls, 2, 'counted as calls');
  });
  it('a documented event is left as before, and so is an unknown one without tool_input', () => {
    const { env, proj } = setup('ut-ev2');
    for (const event of ['PermissionRequest', 'PreCompact', 'SessionStart']) {
      assert.equal(runClaudeCodeHook(cc('Bash', { command: 'rm -rf build' }, proj, 's1', event), { env }).verdict.rule, 'hook.other-event', event);
    }
    const noInput = JSON.stringify({ session_id: 's1', cwd: proj, hook_event_name: 'BrandNew', tool_name: 'BrandNew' });
    assert.equal(runClaudeCodeHook(noInput, { env }).verdict.rule, 'hook.other-event');
    assert.equal(runClaudeCodeHook(JSON.stringify({ session_id: 's1', cwd: proj, hook_event_name: 'BrandNew' }), { env }).verdict.rule, 'hook.bad-input');
  });
});

describe('Codex CLI and Gemini CLI (0.41.0)', () => {
  it('Codex: an unknown tool is blocked (Codex has no ask) and stays blocked, since a blocked call never runs', () => {
    const { env, proj } = setup('ut-cx');
    const r = runCodexHook(cx('js_runner', { code: '1' }, proj, 's1'), { env });
    assert.equal(r.verdict.rule, UNKNOWN_TOOL_RULE);
    assert.match(r.stdout, /"permissionDecision":"deny"/);
    assert.equal(runCodexHook(cx('js_runner', { code: '1' }, proj, 's1'), { env }).verdict.rule, UNKNOWN_TOOL_RULE);
    assert.equal(runCodexHook(cx('update_plan', { plan: [] }, proj, 's1'), { env }).verdict.decision, 'allow');
    assert.equal(runCodexHook(cx('mcp__fs__read', { path: 'src/a.ts' }, proj, 's1'), { env }).verdict.decision, 'allow');
  });
  it('Codex: once the user file allows it, the call passes; a PostToolUse of it is remembered', () => {
    const { env, proj, home } = setup('ut-cx2');
    writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\nguards:\n  unknown-tools:\n    allow: [js_runner]\n');
    assert.equal(runCodexHook(cx('js_runner', { code: '1' }, proj, 's1'), { env }).verdict.decision, 'allow');
    runCodexHook(cx('js_runner', { code: '1' }, proj, 's1', 'PostToolUse', { tool_response: { output: '2' } }), { env });
    assert.deepEqual(loadSession('s1', env['OPENMORALS_HOME']).memory.toolsRan, ['js_runner']);
  });
  it('Codex: an unknown event with a tool call is judged, a documented one is not', () => {
    const { env, proj } = setup('ut-cx3');
    const r = runCodexHook(cx('Bash', { command: 'rm -rf build' }, proj, 's1', 'PreToolUseV2'), { env });
    assert.equal(r.verdict.rule, 'destructive.recursive-delete');
    assert.match(r.stdout, /"hookEventName":"PreToolUseV2"/);
    assert.equal(runCodexHook(cx('Bash', { command: 'rm -rf build' }, proj, 's1', 'PermissionRequest'), { env }).verdict.rule, 'hook.other-event');
  });
  it('Gemini CLI: asks once; after AfterTool the name passes; with the ask sent as deny it stays blocked', () => {
    const { env, proj } = setup('ut-gm');
    const r = runGeminiHook(gm('lint_runner', { target: 'src' }, proj, 's1'), { env });
    assert.equal(r.verdict.rule, UNKNOWN_TOOL_RULE);
    assert.match(r.stdout, /"decision":"ask"/);
    runGeminiHook(gm('lint_runner', { target: 'src' }, proj, 's1', 'AfterTool', { tool_response: { llmContent: 'ok' } }), { env });
    assert.equal(runGeminiHook(gm('lint_runner', { target: 'src' }, proj, 's1'), { env }).verdict.decision, 'allow');
    const denyEnv = { ...env, OPENMORALS_GEMINI_ASK: 'deny' };
    assert.match(runGeminiHook(gm('other_runner', {}, proj, 's2'), { env: denyEnv }).stdout, /"decision":"deny"/);
    assert.equal(runGeminiHook(gm('mcp_github_search', { q: 'a' }, proj, 's1'), { env }).verdict.decision, 'allow');
  });
  it('Gemini CLI: an unknown event with a tool call is judged like BeforeTool', () => {
    const { env, proj } = setup('ut-gm2');
    assert.equal(runGeminiHook(gm('run_shell_command', { command: 'rm -rf build' }, proj, 's1', 'BeforeToolV2'), { env }).verdict.rule, 'destructive.recursive-delete');
    assert.equal(runGeminiHook(gm('run_shell_command', { command: 'rm -rf build' }, proj, 's1', 'AfterAgent'), { env }).verdict.rule, 'hook.other-event');
  });
});

describe('opencode and OpenClaw are unchanged: their MCP and plugin tools have free names (0.41.0)', () => {
  it('an unlisted tool is judged on its arguments, as before', () => {
    const { env, proj } = setup('ut-oc');
    assert.equal(runOpencodeHook(JSON.stringify({ event: 'tool.execute.before', sessionID: 'o', tool: 'newtool', args: { x: 1 }, cwd: proj }), { env }).verdict.decision, 'allow');
    assert.equal(runOpenclawHook(JSON.stringify({ event: 'before_tool_call', sessionId: 'w', toolName: 'new_tool', params: { x: 1 }, cwd: proj }), { env }).verdict.decision, 'allow');
  });
});

describe('session memory: toolsRan (0.41.0)', () => {
  it('is capped, deduplicated, parsed back and merged by union on a concurrent save', () => {
    let list: readonly string[] = [];
    for (let i = 0; i < TOOLS_RAN_KEEP + 5; i++) list = noteToolRan(list, `t${i}`);
    assert.equal(list.length, TOOLS_RAN_KEEP);
    assert.equal(list[0], 't5');
    assert.equal(noteToolRan(list, 't9'), list);
    assert.deepEqual(parseMemory({ toolsRan: ['a', 'a', 3, '', 'b'] }).toolsRan, ['a', 'b']);
    assert.equal(parseMemory({ toolsRan: 'a' }).toolsRan, undefined);
    const home = tempDir('ut-merge');
    saveSession('m', EMPTY_STATE, EMPTY_MEMORY, home);
    const a = loadSession('m', home);
    const b = loadSession('m', home);
    saveSession('m', a.state, { ...a.memory, toolsRan: ['x'] }, home, new Date(), a);
    saveSession('m', b.state, { ...b.memory, toolsRan: ['y'] }, home, new Date(), b);
    assert.deepEqual([...(loadSession('m', home).memory.toolsRan ?? [])].sort(), ['x', 'y']);
  });
});
