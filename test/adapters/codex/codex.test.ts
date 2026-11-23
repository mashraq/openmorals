import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { codexActions, installSnippet, mergeConfig, mergeTomlText, runCodexHook, toCodexOutput } from '../../../src/adapters/codex/index.js';
import { parsePatchFiles } from '../../../src/adapters/codex/patch.js';
import { readAudit } from '../../../src/audit.js';
import { loadSessionState } from '../../../src/state.js';
import { CODEX_CASES } from './cases.js';
import { tempDir } from './helpers.js';

const ASK_SUFFIX = '. Codex hooks cannot ask the user, so openmorals blocked this call: tell the user what you wanted to run and why, and let them decide (they can run it themselves or allow it in openmorals.yaml).';

function expectedStdout(decision: string, rule: string, reason: string): string {
  if (decision === 'allow') return '';
  const text = `openmorals ${decision} [${rule}]: ${reason}${decision === 'ask' ? ASK_SUFFIX : ''}`;
  return `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":${JSON.stringify(text)}}}`;
}

describe('Codex adapter case table', () => {
  const home = tempDir('codex-home');
  assert.ok(CODEX_CASES.length >= 15);
  for (const c of CODEX_CASES) {
    it(c.name, () => {
      const run = runCodexHook(c.stdin, { env: { OPENMORALS_HOME: home, ...(c.env ?? {}) }, cwd: tempDir('codex-cwd'), ...(c.platform === undefined ? {} : { platform: c.platform }) });
      assert.equal(run.exitCode, 0);
      assert.equal(run.verdict.decision, c.decision, run.verdict.reason);
      assert.equal(run.verdict.rule, c.rule, run.verdict.reason);
      assert.equal(run.stdout, expectedStdout(c.decision, c.rule, run.verdict.reason));
    });
  }
});

describe('Codex output shape', () => {
  it('never prints ask or a bare allow, which Codex treats as a failed hook and runs the call', () => {
    for (const d of ['allow', 'ask', 'deny'] as const) {
      const out = toCodexOutput({ decision: d, rule: 'r.x', reason: 'why' });
      assert.ok(!out.includes('"permissionDecision":"ask"'));
      assert.ok(!out.includes('"permissionDecision":"allow"'));
    }
  });
  it('prints the literal fail-closed answer for unreadable input', () => {
    const run = runCodexHook('{', { env: { OPENMORALS_HOME: tempDir('codex-lit') } });
    assert.equal(
      run.stdout,
      `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"openmorals ask [hook.bad-input]: the hook input on stdin is not valid JSON${ASK_SUFFIX}"}}`,
    );
  });
  it('fails closed on an internal error', () => {
    const env = new Proxy<NodeJS.ProcessEnv>({}, {
      get() {
        throw new Error('boom');
      },
    });
    const run = runCodexHook(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 's', cwd: '/w' }), { env });
    assert.equal(run.verdict.decision, 'ask');
    assert.equal(run.verdict.rule, 'engine.error');
    assert.match(run.stdout, /"permissionDecision":"deny"/);
  });
  it('fails closed when the budget counter cannot be saved', () => {
    const home = tempDir('codex-ro');
    writeFileSync(join(home, 'sessions'), 'not a directory');
    const run = runCodexHook(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 's', cwd: tempDir('p') }), { env: { OPENMORALS_HOME: home } });
    assert.equal(run.verdict.decision, 'ask');
    assert.equal(run.verdict.rule, 'budget.unmeasured');
  });
});

describe('Codex budget and audit', () => {
  it('counts each call, writes one redacted audit line per call with source codex', () => {
    const home = tempDir('codex-audit');
    const proj = tempDir('codex-proj');
    const env = { OPENMORALS_HOME: home };
    const ev = (command: string): string => JSON.stringify({ session_id: 'cx-2', cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
    runCodexHook(ev('rm -rf build'), { env });
    runCodexHook(ev('GITHUB_TOKEN=ghp_FAKEfakeFAKEfakeFAKEfake0000 ls'), { env });
    assert.equal(loadSessionState('cx-2', home).toolCalls, 2);
    const log = readAudit(join(home, 'audit.jsonl'));
    assert.equal(log.records.length, 2);
    assert.equal(log.records[0]?.source, 'codex');
    assert.equal(log.records[0]?.rule, 'destructive.recursive-delete');
    assert.deepEqual(log.records[1]?.budget, { tool_calls: 2, tokens: 0 });
    assert.ok(!readFileSync(join(home, 'audit.jsonl'), 'utf8').includes('ghp_FAKE'));
  });
  it('denies at the hard tool-call budget from the project bylaws', () => {
    const home = tempDir('codex-budget');
    const proj = tempDir('codex-budget-proj');
    writeFileSync(join(proj, 'openmorals.yaml'), 'version: 1\nguards:\n  budget:\n    tool_calls: { soft: 2, hard: 3, step: 1 }\n');
    const ev = JSON.stringify({ session_id: 'b', cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
    const got = [1, 2, 3].map(() => runCodexHook(ev, { env: { OPENMORALS_HOME: home } }).verdict.decision);
    assert.deepEqual(got, ['allow', 'ask', 'deny']);
  });
  it('an invalid bylaws file is at least ask', () => {
    const proj = tempDir('codex-bad-bylaws');
    writeFileSync(join(proj, 'openmorals.yaml'), 'version: 1\nguards: [oops\n');
    const run = runCodexHook(JSON.stringify({ session_id: 'x', cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), { env: { OPENMORALS_HOME: tempDir('codex-bb') } });
    assert.equal(run.verdict.decision, 'ask');
    assert.equal(run.verdict.rule, 'bylaws.invalid');
  });
});

describe('Codex tool mapping and patch reading', () => {
  it('reads every file a patch names, including moves and deletes', () => {
    const p = parsePatchFiles('*** Begin Patch\n*** Add File: a.ts\n+x\n*** Delete File: b.ts\n*** Update File: c.ts\n*** Move to: d.ts\n@@\n-1\n+2\n*** End Patch');
    assert.deepEqual(p, { ok: true, files: [{ op: 'add', path: 'a.ts' }, { op: 'delete', path: 'b.ts' }, { op: 'update', path: 'c.ts' }, { op: 'move', path: 'd.ts' }] });
    assert.equal(parsePatchFiles('*** Begin Patch\n*** Add File: a.ts\n+x\n').ok, false);
    assert.equal(parsePatchFiles('*** Begin Patch\n*** End Patch').ok, false);
  });
  it('joins an argv command so nested shells stay visible', () => {
    const m = codexActions('Bash', { command: ['bash', '-lc', "echo 'hi there'"] });
    assert.deepEqual(m.actions, [{ kind: 'exec', command: "bash -lc 'echo '\\''hi there'\\'''", shell: 'posix', tool: 'Bash' }]);
  });
});

describe('Codex install snippet and merge', () => {
  it('snippet is the documented hooks.json shape', () => {
    const s = installSnippet();
    assert.equal(s.file, '.codex/hooks.json');
    assert.equal(s.text, '{\n  "hooks": {\n    "PreToolUse": [\n      {\n        "matcher": "*",\n        "hooks": [\n          {\n            "type": "command",\n            "command": "openmorals hook codex",\n            "timeout": 30,\n            "statusMessage": "openmorals: checking the call"\n          }\n        ]\n      }\n    ]\n  }\n}\n');
    assert.match(s.toml, /^\[\[hooks\.PreToolUse\]\]$/m);
    assert.match(s.toml, /^command = "openmorals hook codex"$/m);
  });
  it('creates, appends without dropping keys, and is idempotent', () => {
    const fresh = mergeConfig(null);
    assert.ok(fresh.ok && fresh.changed);
    const existing = { description: 'team hooks', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'python3 check.py' }] }], Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } };
    const merged = mergeConfig(existing);
    assert.ok(merged.ok && merged.changed);
    if (!merged.ok) return;
    assert.equal(merged.config['description'], 'team hooks');
    const hooks = merged.config['hooks'] as Record<string, unknown[]>;
    assert.equal(hooks['PreToolUse']?.length, 2);
    assert.deepEqual(hooks['PreToolUse']?.[0], existing.hooks.PreToolUse[0]);
    assert.deepEqual(hooks['Stop'], existing.hooks.Stop);
    const again = mergeConfig(merged.config);
    assert.ok(again.ok && !again.changed);
    assert.deepEqual(existing.hooks.PreToolUse.length, 1);
  });
  it('refuses to overwrite a file it cannot merge', () => {
    assert.equal(mergeConfig([1]).ok, false);
    assert.equal(mergeConfig({ hooks: 'x' }).ok, false);
    assert.equal(mergeConfig({ hooks: { PreToolUse: {} } }).ok, false);
  });
  it('TOML merge appends once and keeps the existing text', () => {
    const base = 'model = "gpt-test"\n\n[features]\nhooks = true\n';
    const once = mergeTomlText(base);
    assert.ok(once.changed && once.text.startsWith(base));
    assert.deepEqual(mergeTomlText(once.text), { text: once.text, changed: false });
  });
  it('the merged file round-trips through disk', () => {
    const dir = tempDir('codex-init');
    mkdirSync(join(dir, '.codex'));
    const r = mergeConfig(null);
    assert.ok(r.ok);
    if (!r.ok) return;
    writeFileSync(join(dir, '.codex', 'hooks.json'), JSON.stringify(r.config));
    const back = mergeConfig(JSON.parse(readFileSync(join(dir, '.codex', 'hooks.json'), 'utf8')) as unknown);
    assert.ok(back.ok && !back.changed);
  });
});
