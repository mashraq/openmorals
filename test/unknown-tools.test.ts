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
import { EMPTY_MEMORY, TOOLS_RAN_KEEP, TOOL_NAME_MAX, noteToolAsked, noteToolRan, parseMemory, takeToolAsked } from '../src/session.js';
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
    const claude = ['Bash', 'PowerShell', 'Monitor', 'Read', 'NotebookRead', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob', 'LS', 'WebFetch'];
    for (const t of claude) {
      assert.notEqual(toAction(t, { command: 'ls' }).kind, 'other', `${t} is mapped`);
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
    const again = runClaudeCodeHook(cc('NewWriteTool', { file: 'src/a.ts' }, proj, 's1', 'PreToolUse', { tool_use_id: 'toolu_asked' }), { env });
    assert.equal(again.verdict.rule, UNKNOWN_TOOL_RULE, 'declined (no post event): asks again');
    runClaudeCodeHook(cc('NewWriteTool', { file: 'src/a.ts' }, proj, 's1', 'PostToolUse', { tool_response: { ok: true }, tool_use_id: 'toolu_asked' }), { env });
    assert.deepEqual(loadSession('s1', env['OPENMORALS_HOME']).memory.toolsRan, ['NewWriteTool']);
    const after = runClaudeCodeHook(cc('NewWriteTool', { file: 'src/b.ts' }, proj, 's1'), { env });
    assert.equal(after.verdict.decision, 'allow', after.verdict.reason);
    assert.equal(runClaudeCodeHook(cc('NewWriteTool', { file: 'src/b.ts' }, proj, 's2'), { env }).verdict.rule, UNKNOWN_TOOL_RULE);
  });
  it('a post event with no asked call before it approves nothing; a PostToolUseFailure of an asked call counts', () => {
    const { env, proj } = setup('ut-cc2');
    const home = env['OPENMORALS_HOME'];
    runClaudeCodeHook(cc('ShellRunner', { command: 'ls' }, proj, 's1', 'PostToolUseFailure', { error: 'exit 1' }), { env });
    runClaudeCodeHook(cc('ShellRunner', { command: 'ls' }, proj, 's1', 'PostToolUse', { tool_response: {} }), { env });
    assert.equal(loadSession('s1', home).memory.toolsRan, undefined, 'a post event with no pre-call');
    assert.equal(runClaudeCodeHook(cc('ShellRunner', { command: 'ls' }, proj, 's1', 'PreToolUse', { tool_use_id: 'toolu_a' }), { env }).verdict.rule, UNKNOWN_TOOL_RULE);
    runClaudeCodeHook(cc('ShellRunner', { command: 'ls' }, proj, 's1', 'PostToolUse', { tool_response: {}, tool_use_id: 'toolu_other' }), { env });
    runClaudeCodeHook(cc('OtherRunner', { command: 'ls' }, proj, 's1', 'PostToolUse', { tool_response: {}, tool_use_id: 'toolu_a' }), { env });
    assert.equal(loadSession('s1', home).memory.toolsRan, undefined, 'another call id, or another name under the asked id');
    assert.equal(runClaudeCodeHook(cc('ShellRunner', { command: 'ls' }, proj, 's1'), { env }).verdict.rule, UNKNOWN_TOOL_RULE, 'still asks');
    runClaudeCodeHook(cc('ShellRunner', { command: 'ls' }, proj, 's1', 'PostToolUseFailure', { error: 'exit 1', tool_use_id: 'toolu_a' }), { env });
    runClaudeCodeHook(cc('Bash', { command: 'ls' }, proj, 's1', 'PostToolUse', { tool_response: {} }), { env });
    runClaudeCodeHook(cc('mcp__gh__search', { q: 'a' }, proj, 's1', 'PostToolUse', { tool_response: {} }), { env });
    const m = loadSession('s1', home).memory;
    assert.deepEqual(m.toolsRan, ['ShellRunner']);
    assert.deepEqual(m.toolsAsked?.filter((k) => k.startsWith('toolu_a\n')) ?? [], [], 'the asked call is used once');
  });
  it('when another ask wins a tie, the reason shown still names the unknown tool and what approving it means', () => {
    const { env, proj } = setup('ut-cc6');
    const r = runClaudeCodeHook(cc('FileGrabber', { path: '~/.ssh/id_ed25519' }, proj, 's1', 'PreToolUse', { tool_use_id: 'toolu_g' }), { env });
    assert.equal(r.verdict.rule, 'secrets.read');
    assert.match(r.verdict.reason, /openmorals does not know the tool 'FileGrabber'/);
    assert.match(r.verdict.reason, /not ask about that tool again in this session \[adapter\.unknown-tool\]/);
    assert.match(r.stdout, /does not know the tool 'FileGrabber'/, 'in the reason the host shows');
    assert.doesNotMatch(runClaudeCodeHook(cc('Read', { file_path: '~/.ssh/id_ed25519' }, proj, 's1'), { env }).verdict.reason, /does not know the tool/, 'a known tool gets no note');
    runClaudeCodeHook(cc('FileGrabber', { path: '~/.ssh/id_ed25519' }, proj, 's1', 'PostToolUse', { tool_response: {}, tool_use_id: 'toolu_g' }), { env });
    assert.deepEqual(loadSession('s1', env['OPENMORALS_HOME']).memory.toolsRan, ['FileGrabber']);
  });
  it('a name longer than the kept length asks every time and says so', () => {
    const { env, proj } = setup('ut-cc7');
    const long = `Tool${'x'.repeat(TOOL_NAME_MAX)}`;
    const r = runClaudeCodeHook(cc(long, {}, proj, 's1', 'PreToolUse', { tool_use_id: 'toolu_l' }), { env });
    assert.equal(r.verdict.rule, UNKNOWN_TOOL_RULE);
    assert.match(r.verdict.reason, /longer than 128 characters, so openmorals asks about it every time/);
    runClaudeCodeHook(cc(long, {}, proj, 's1', 'PostToolUse', { tool_response: {}, tool_use_id: 'toolu_l' }), { env });
    assert.equal(loadSession('s1', env['OPENMORALS_HOME']).memory.toolsRan, undefined);
    assert.equal(unknownToolVerdict('claude-code', long, DEFAULT_BYLAWS, [long.slice(0, TOOL_NAME_MAX)])?.rule, UNKNOWN_TOOL_RULE, 'names are compared in full');
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
    assert.match(r.verdict.reason, /Codex cannot ask, so a call of it is blocked each time/);
    assert.doesNotMatch(r.verdict.reason, /If you approve it/, 'no promise Codex cannot keep');
    assert.equal(runCodexHook(cx('js_runner', { code: '1' }, proj, 's1'), { env }).verdict.rule, UNKNOWN_TOOL_RULE);
    assert.equal(runCodexHook(cx('update_plan', { plan: [] }, proj, 's1'), { env }).verdict.decision, 'allow');
    assert.equal(runCodexHook(cx('mcp__fs__read', { path: 'src/a.ts' }, proj, 's1'), { env }).verdict.decision, 'allow');
  });
  it('Codex: once the user file allows it, the call passes; nothing is remembered, since Codex never asks', () => {
    const { env, proj, home } = setup('ut-cx2');
    assert.equal(runCodexHook(cx('js_runner', { code: '1' }, proj, 's1', 'PreToolUse', { tool_use_id: 'call_b' }), { env }).verdict.rule, UNKNOWN_TOOL_RULE);
    runCodexHook(cx('js_runner', { code: '1' }, proj, 's1', 'PostToolUse', { tool_response: { output: '2' }, tool_use_id: 'call_b' }), { env });
    assert.equal(loadSession('s1', env['OPENMORALS_HOME']).memory.toolsRan, undefined, 'a post event under a blocked call id');
    assert.equal(runCodexHook(cx('js_runner', { code: '1' }, proj, 's1'), { env }).verdict.rule, UNKNOWN_TOOL_RULE);
    assert.doesNotMatch(runCodexHook(cx('js_runner', { path: '~/.ssh/id_ed25519' }, proj, 's1'), { env }).verdict.reason, /Also: openmorals does not know/, 'no note where nothing is remembered');
    writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\nguards:\n  unknown-tools:\n    allow: [js_runner]\n');
    assert.equal(runCodexHook(cx('js_runner', { code: '1' }, proj, 's1'), { env }).verdict.decision, 'allow');
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
    runGeminiHook(gm('lint_runner', { target: 'src' }, proj, 's1', 'AfterTool', { tool_response: { llmContent: 'ok' } }), { env });
    assert.equal(loadSession('s1', env['OPENMORALS_HOME']).memory.toolsRan, undefined, 'an AfterTool with no asked call before it');
    const r = runGeminiHook(gm('lint_runner', { target: 'src' }, proj, 's1'), { env });
    assert.equal(r.verdict.rule, UNKNOWN_TOOL_RULE);
    assert.match(r.stdout, /"decision":"ask"/);
    runGeminiHook(gm('lint_runner', { target: 'src' }, proj, 's1', 'AfterTool', { tool_response: { llmContent: 'ok' } }), { env });
    assert.equal(runGeminiHook(gm('lint_runner', { target: 'src' }, proj, 's1'), { env }).verdict.decision, 'allow');
    const denyEnv = { ...env, OPENMORALS_GEMINI_ASK: 'deny' };
    assert.match(runGeminiHook(gm('other_runner', {}, proj, 's2'), { env: denyEnv }).stdout, /"decision":"deny"/);
    assert.equal(runGeminiHook(gm('mcp_github_search', { q: 'a' }, proj, 's1'), { env }).verdict.decision, 'allow');
    assert.equal(runGeminiHook(gm('mcp_helper', { q: 'a' }, proj, 's1'), { env }).verdict.rule, UNKNOWN_TOOL_RULE, 'not the mcp_<server>_<tool> shape');
  });
  it('Gemini CLI: when another ask wins a tie, the reason names the unknown tool; with the ask sent as deny nothing is noted', () => {
    const { env, proj } = setup('ut-gm3');
    const r = runGeminiHook(gm('file_grabber', { path: '~/.ssh/id_ed25519' }, proj, 's1'), { env });
    assert.equal(r.verdict.rule, 'secrets.read');
    assert.match(r.stdout, /does not know the tool 'file_grabber'/);
    const denyEnv = { ...env, OPENMORALS_GEMINI_ASK: 'deny' };
    runGeminiHook(gm('other_runner', {}, proj, 's2'), { env: denyEnv });
    assert.equal(loadSession('s2', env['OPENMORALS_HOME']).memory.toolsAsked, undefined);
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
    assert.deepEqual(noteToolRan([], 'y'.repeat(TOOL_NAME_MAX + 1)), [], 'a name too long is never kept');
  });
  it('toolsAsked: noted, used once, parsed back, and a used key is not brought back by another writer', () => {
    const asked = noteToolAsked(EMPTY_MEMORY, 'id1', 'NewTool');
    assert.deepEqual(asked.toolsAsked, ['id1\nNewTool']);
    assert.equal(takeToolAsked(asked, 'id2', 'NewTool'), asked, 'another id');
    assert.equal(takeToolAsked(asked, 'id1', 'OtherTool'), asked, 'another name');
    const used = takeToolAsked(asked, 'id1', 'NewTool');
    assert.deepEqual([used.toolsRan, used.toolsAsked], [['NewTool'], undefined]);
    assert.deepEqual(takeToolAsked(noteToolAsked(EMPTY_MEMORY, null, 'lint_runner'), null, 'lint_runner').toolsRan, ['lint_runner'], 'no call id: by name');
    assert.deepEqual(parseMemory({ toolsAsked: ['a\nb', 'bad', 3, '\nc', 'a\nb'] }).toolsAsked, ['a\nb', '\nc']);
    const home = tempDir('ut-merge2');
    saveSession('m', EMPTY_STATE, asked, home);
    const a = loadSession('m', home);
    const b = loadSession('m', home);
    saveSession('m', b.state, noteToolAsked(b.memory, 'id3', 'Third'), home, new Date(), b);
    saveSession('m', a.state, takeToolAsked(a.memory, 'id1', 'NewTool'), home, new Date(), a);
    const merged = loadSession('m', home).memory;
    assert.deepEqual([merged.toolsAsked, merged.toolsRan], [['id3\nThird'], ['NewTool']], 'the other writer saved first, still holding id1');
  });
});
