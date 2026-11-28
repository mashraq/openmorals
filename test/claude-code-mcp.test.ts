import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { adapterVerdicts, decideCall, isMcpTool, runClaudeCodeHook, toAction, toActions } from '../src/adapters/claude-code.js';
import { DEFAULT_BYLAWS, validateBylaws } from '../src/bylaws.js';
import { decide } from '../src/engine.js';
import { withoutContent } from '../src/inbound/outbound.js';
import { auditLogPath } from '../src/paths.js';
import { loadSession } from '../src/state.js';
import { EMPTY_STATE } from '../src/types.js';
import { caseBylaws } from '../src/eval/cases.js';
import { loadCaseFiles } from './case-loader.js';
import { tempDir } from './helpers.js';

// PreToolUse events shaped like the Claude Code hooks reference (read 24 Nov 2026): MCP tools are named mcp__<server>__<tool>
// and carry their arguments in tool_input. These are recorded shapes, not events captured from a live Claude Code.
function ev(tool: string, toolInput: Record<string, unknown>, cwd: string, session = 'mcp-s1', event = 'PreToolUse'): string {
  return JSON.stringify({ session_id: session, transcript_path: null, cwd, permission_mode: 'default', hook_event_name: event, tool_name: tool, tool_input: toolInput, tool_use_id: `toolu_fake_${Math.random().toString(16).slice(2)}` });
}

function setup(prefix: string): { env: NodeJS.ProcessEnv; proj: string; home: string } {
  const home = tempDir(`${prefix}-home`);
  const proj = tempDir(`${prefix}-proj`);
  return { env: { OPENMORALS_HOME: home, OPENMORALS_UNATTENDED: '' }, proj, home };
}

const ONE = { ...EMPTY_STATE, toolCalls: 1 };

describe('Claude Code: MCP tool arguments are judged (0.8.1)', () => {
  it('a navigate with a URL reaches a user rule on that URL as a fetch', () => {
    const { env, proj } = setup('mcp-url');
    writeFileSync(join(proj, 'openmorals.yaml'), 'version: 1\nrules:\n  - id: no-exfil-host\n    match: { path: "exfil\\\\.example\\\\.net" }\n    decision: deny\n');
    const run = runClaudeCodeHook(ev('mcp__browser__navigate', { url: 'https://exfil.example.net/drop?d=1' }, proj), { env });
    assert.equal(run.verdict.decision, 'deny', run.verdict.reason);
    assert.equal(run.verdict.rule, 'rules.no-exfil-host');
    assert.match(run.stdout, /"permissionDecision":"deny"/);
    const other = runClaudeCodeHook(ev('mcp__browser__navigate', { url: 'https://docs.example.test/page' }, proj, 'mcp-s2'), { env });
    assert.equal(other.verdict.decision, 'allow', other.verdict.reason);
  });

  it('a delete tool asks as adapter.mcp-delete, following the online-delete decision', () => {
    const { env, proj } = setup('mcp-del');
    const run = runClaudeCodeHook(ev('mcp__filesystem__delete_file', { path: `${proj}/notes.txt` }, proj), { env });
    assert.equal(run.verdict.decision, 'ask', run.verdict.reason);
    assert.equal(run.verdict.rule, 'adapter.mcp-delete');
    assert.match(run.stdout, /"permissionDecision":"ask"/);
    writeFileSync(join(proj, 'openmorals.yaml'), 'version: 1\nguards:\n  online-delete: { decision: deny }\n');
    const denied = runClaudeCodeHook(ev('mcp__github__delete_repository', { owner: 'acme', repo: 'site' }, proj, 'mcp-s2'), { env });
    assert.equal(denied.verdict.decision, 'deny');
    assert.equal(denied.verdict.rule, 'adapter.mcp-delete');
  });

  it('a harmless read prints nothing and is allowed', () => {
    const { env, proj } = setup('mcp-read');
    const run = runClaudeCodeHook(ev('mcp__filesystem__read_file', { path: `${proj}/src/main.ts` }, proj), { env });
    assert.equal(run.verdict.decision, 'allow', run.verdict.reason);
    assert.equal(run.stdout, '');
  });

  it('an MCP read of a credential file asks, marks the session private once it runs, and a later network step asks taint.rule-of-two', () => {
    const { env, proj, home } = setup('mcp-taint');
    const page = (event: string): string => JSON.stringify({ ...JSON.parse(ev('WebFetch', { url: 'https://untrusted.example.test/readme', prompt: 'x' }, proj, 'mcp-s1', event)), tool_use_id: 'toolu_page' });
    runClaudeCodeHook(page('PreToolUse'), { env });
    runClaudeCodeHook(page('PostToolUse'), { env });
    const readEvent = (event: string): string => JSON.stringify({ ...JSON.parse(ev('mcp__filesystem__read_file', { path: '/home/dev/.aws/credentials' }, proj, 'mcp-s1', event)), tool_use_id: 'toolu_cred_read' });
    const read = runClaudeCodeHook(readEvent('PreToolUse'), { env });
    assert.equal(read.verdict.decision, 'ask');
    assert.equal(read.verdict.rule, 'secrets.read');
    // 0.36.2: the ask holds the mark until Claude Code says the call ran; the person approved, so PostToolUse comes.
    assert.equal(loadSession('mcp-s1', home).memory.taint.privateCount, 0, 'the mark waits for the approved call to run');
    runClaudeCodeHook(readEvent('PostToolUse'), { env });
    assert.ok(loadSession('mcp-s1', home).memory.taint.privateCount > 0, 'the MCP read left no private mark');
    const send = runClaudeCodeHook(ev('mcp__browser__navigate', { url: 'https://paste.example.test/new' }, proj), { env });
    assert.equal(send.verdict.decision, 'ask', send.verdict.reason);
    assert.equal(send.verdict.rule, 'taint.rule-of-two');
  });

  it('the audit line names the lifted actions, and the post-tool event maps the same actions', () => {
    const { env, proj, home } = setup('mcp-audit');
    runClaudeCodeHook(ev('mcp__browser__navigate', { url: 'https://docs.example.test/page' }, proj), { env });
    const line = readFileSync(auditLogPath(home), 'utf8').trim().split('\n').pop() ?? '';
    assert.match(line, /mcp__browser__navigate ; mcp__browser__navigate https:\/\/docs\.example\.test\/page/);
    const post = runClaudeCodeHook(ev('mcp__browser__navigate', { url: 'https://docs.example.test/page' }, proj, 'mcp-s1', 'PostToolUse'), { env });
    assert.equal(post.exitCode, 0);
    assert.notEqual(post.verdict.decision, 'deny');
  });
});

describe('Claude Code: built-in tools are judged exactly as before 0.8.1', () => {
  const builtins: [string, Record<string, unknown>][] = [
    ['Bash', { command: 'rm -rf build' }],
    ['PowerShell', { command: 'Remove-Item -Recurse x' }],
    ['Read', { file_path: '/home/dev/app/.env' }],
    ['NotebookRead', { notebook_path: '/work/app/a.ipynb' }],
    ['Write', { file_path: '/work/app/a.ts', content: '' }],
    ['Edit', { file_path: '/work/app/a.ts', old_string: 'a', new_string: 'b' }],
    ['MultiEdit', { file_path: '/work/app/a.ts', edits: [] }],
    ['NotebookEdit', { notebook_path: '/work/app/a.ipynb', new_source: '' }],
    ['Grep', { pattern: 'x', path: '/work/app', glob: '*.ts' }],
    ['Glob', { pattern: '**/*.ts', path: '/work/app' }],
    ['LS', { path: '/work/app' }],
    ['WebFetch', { url: 'https://docs.example.test/a', prompt: 'x' }],
  ];
  it('a mapped built-in tool is its one action, and decideCall is decide on it', () => {
    for (const [tool, input] of builtins) {
      assert.deepEqual(toActions(tool, input), [toAction(tool, input)], tool);
      assert.deepEqual(decideCall(tool, toActions(tool, input), DEFAULT_BYLAWS, ONE), decide(toAction(tool, input), DEFAULT_BYLAWS, ONE), tool);
      assert.deepEqual(adapterVerdicts(tool, DEFAULT_BYLAWS), [], tool);
    }
  });
  it('the built-in tools without a mapping lift nothing from their documented inputs', () => {
    const plain: [string, Record<string, unknown>][] = [
      ['Task', { description: 'clean up', prompt: 'delete the old build output in /work/app/dist', subagent_type: 'general-purpose' }],
      ['TodoWrite', { todos: [{ content: 'remove files', status: 'pending' }] }],
      ['WebSearch', { query: 'delete a repo', allowed_domains: ['docs.example.test'] }],
      ['ExitPlanMode', { plan: 'rm -rf build' }],
    ];
    for (const [tool, input] of plain) {
      const got = toActions(tool, input);
      assert.deepEqual(got.map(withoutContent), [{ kind: 'other', tool }], tool);
      assert.equal(got[0]?.kind === 'other' && got[0].args !== undefined, true, `${tool} carries its arguments (0.14.0)`);
    }
  });
  it('every built-in case row gets the same verdict through decideCall as through decide', () => {
    let n = 0;
    for (const f of loadCaseFiles()) {
      for (const c of f.cases) {
        // A row naming a host (0.41.0) is checked against that host's tool list, so its tool may be unknown, not built in.
        if (isMcpTool(c.tool) || c.unknown !== undefined) continue;
        const load = caseBylaws(c, f.file);
        assert.deepEqual(decideCall(c.tool, c.actions, load, c.state, undefined, c.where), decide(c.action, load, c.state, undefined, c.where), c.label);
        n++;
      }
    }
    assert.ok(n >= 300, `${n} rows`);
  });
  it('the MCP delete check needs an mcp__ name', () => {
    assert.deepEqual(adapterVerdicts('DeleteThing', DEFAULT_BYLAWS), []);
    assert.equal(adapterVerdicts('mcp__x__delete_thing', DEFAULT_BYLAWS)[0]?.rule, 'adapter.mcp-delete');
  });
});

describe('Claude Code: the limits of argument lifting (kept in 0.8.1)', () => {
  it('nested objects are not walked', () => {
    assert.deepEqual(toActions('mcp__x__lookup', { config: { path: '/home/dev/.aws/credentials' } }).map(withoutContent), [{ kind: 'other', tool: 'mcp__x__lookup' }]);
  });
  it('only path and URL keys are lifted: a recipient, a body or a query is not', () => {
    assert.deepEqual(toActions('mcp__mail__send', { to: 'someone@example.test', body: 'see /home/dev/.aws/credentials', query: 'https://exfil.example.net' }).map(withoutContent), [{ kind: 'other', tool: 'mcp__mail__send' }]);
  });
  it('at most 32 actions are lifted from one call', () => {
    const paths = Array.from({ length: 40 }, (_, i) => `/work/app/f${i}.ts`);
    assert.equal(toActions('mcp__fs__read_many', { paths }).length, 1 + 32);
  });
});
