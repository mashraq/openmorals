import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { runClaudeCodeHook } from '../src/adapters/claude-code.js';
import { judge } from '../src/adapters/codex/pipeline.js';
import { appendAudit, makeAuditRecord, readAudit } from '../src/audit.js';
import { sessionStatePath } from '../src/paths.js';
import type { SessionMemory } from '../src/session.js';
import { loadSession, saveSession } from '../src/state.js';
import { recordUsage } from '../src/usage.js';
import { REPO_ROOT } from './helpers.js';

// Everything here lives in one fresh temp folder, removed at the end; permissions are restored before removal.
const root = mkdtempSync(join(tmpdir(), 'om-caution-'));
after(() => {
  rmSync(root, { recursive: true, force: true });
});

let n = 0;
function home(): string {
  n++;
  const h = join(root, `home-${n}`);
  mkdirSync(h, { recursive: true });
  return h;
}

const TAINTED: SessionMemory = { history: [], taint: { untrusted: [{ source: 'web-fetch', detail: 'a fetched page' }], privateData: [], untrustedCount: 1, privateCount: 0 } };

// chmod 000 does not stop the owner reading on Windows, and root reads anything.
const NO_PERMISSIONS = process.platform === 'win32' || (typeof process.getuid === 'function' && process.getuid() === 0);
const NO_PERMISSIONS_WHY = 'file permissions cannot make a file unreadable here (Windows, or running as root)';

describe('loadSession fails toward caution', () => {
  it('a missing session file is a new, clean session', () => {
    const l = loadSession('fresh', home());
    assert.equal(l.state.toolCalls, 0);
    assert.equal(l.memory.taint.untrustedCount, 0);
    assert.equal(l.memory.unreadable, undefined);
  });
  it('a session file that cannot be read (EACCES) reads as tainted, not clean', (t) => {
    if (NO_PERMISSIONS) {
      t.skip(NO_PERMISSIONS_WHY);
      return;
    }
    const h = home();
    saveSession('s1', { toolCalls: 7, tokens: 0, prevTokens: 0 }, TAINTED, h);
    const f = sessionStatePath('s1', h);
    chmodSync(f, 0o000);
    try {
      const l = loadSession('s1', h);
      assert.equal(l.memory.taint.untrustedCount, 1, 'taint was reset');
      assert.match(l.memory.unreadable ?? '', /EACCES/);
    } finally {
      chmodSync(f, 0o600);
    }
  });
  it('a session path that is a folder (EISDIR) reads as tainted, not clean', () => {
    const h = home();
    mkdirSync(sessionStatePath('s1', h), { recursive: true });
    const l = loadSession('s1', h);
    assert.equal(l.memory.taint.untrustedCount, 1, 'taint was reset');
    assert.ok((l.memory.unreadable ?? '') !== '', 'the read error is reported');
  });
  it('unparsable content is reported as unreadable too', () => {
    const h = home();
    mkdirSync(join(h, 'sessions'), { recursive: true });
    writeFileSync(sessionStatePath('s1', h), '{not json');
    const l = loadSession('s1', h);
    assert.equal(l.memory.taint.untrustedCount, 1);
    assert.ok((l.memory.unreadable ?? '') !== '');
  });
  it('the Claude Code hook asks once when the session state could not be read, and keeps the taint', (t) => {
    if (NO_PERMISSIONS) {
      t.skip(NO_PERMISSIONS_WHY);
      return;
    }
    const h = home();
    saveSession('s1', { toolCalls: 7, tokens: 0, prevTokens: 0 }, TAINTED, h);
    const f = sessionStatePath('s1', h);
    chmodSync(f, 0o000);
    const input = JSON.stringify({ session_id: 's1', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
    let run;
    try {
      run = runClaudeCodeHook(input, { env: { OPENMORALS_HOME: h } });
    } finally {
      chmodSync(f, 0o600);
    }
    assert.equal(run.verdict.decision, 'ask');
    assert.equal(run.verdict.rule, 'budget.unmeasured');
    assert.match(run.verdict.reason, /could not be read/);
    assert.equal(loadSession('s1', h).memory.taint.untrustedCount, 1, 'the saved state still carries the taint');
    assert.equal(loadSession('s1', h).memory.unreadable, undefined, 'asked once, then cleared');
  });
  it('a usage report saved over an unreadable state keeps the mark, so the next judged call still asks', () => {
    const h = home();
    mkdirSync(join(h, 'sessions'), { recursive: true });
    writeFileSync(sessionStatePath('s2', h), '{not json');
    assert.equal(recordUsage({ session: 's2', cwd: root, model: null, usage: { input_tokens: 10, output_tokens: 5 } }, { env: { OPENMORALS_HOME: h } }).counted, true);
    assert.ok((loadSession('s2', h).memory.unreadable ?? '') !== '', 'the usage writer dropped the mark');
    const input = JSON.stringify({ session_id: 's2', cwd: root, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } });
    const run = runClaudeCodeHook(input, { env: { OPENMORALS_HOME: h } });
    assert.equal(run.verdict.rule, 'budget.unmeasured');
    assert.equal(runClaudeCodeHook(input, { env: { OPENMORALS_HOME: h } }).verdict.decision, 'allow', 'only once');
  });
  it('the shared pipeline (Codex, Gemini CLI, opencode, OpenClaw) asks once too, and only for a counted call', () => {
    const h = home();
    mkdirSync(join(h, 'sessions'), { recursive: true });
    writeFileSync(sessionStatePath('s3', h), '[]');
    const req = (countCall: boolean) => ({ source: 'codex', session: 's3', cwd: root, tool: 'shell', actions: [{ kind: 'exec' as const, command: 'ls', shell: 'posix' as const, tool: 'shell' }], countCall });
    assert.equal(judge(req(false), { env: { OPENMORALS_HOME: h }, platform: 'linux' }).decision, 'allow', 'a second event for the same call is not counted');
    const v = judge(req(true), { env: { OPENMORALS_HOME: h }, platform: 'linux' });
    assert.equal(v.decision, 'ask');
    assert.equal(v.rule, 'budget.unmeasured');
    assert.equal(judge(req(true), { env: { OPENMORALS_HOME: h }, platform: 'linux' }).decision, 'allow', 'only once');
  });
});

describe('readAudit tells a missing log from an empty one', () => {
  it('missing, empty, ok and unreadable', () => {
    const h = home();
    const file = join(h, 'audit.jsonl');
    assert.equal(readAudit(file).status, 'missing');
    writeFileSync(file, '');
    assert.equal(readAudit(file).status, 'empty');
    writeFileSync(file, '\n\n');
    assert.equal(readAudit(file).status, 'empty');
    appendAudit(makeAuditRecord({ source: 'cli', session: null, tool: 'Bash', action: 'ls', decision: 'allow', rule: 'none', reason: 'r', cwd: null, budget: null }), file);
    const ok = readAudit(file);
    assert.equal(ok.status, 'ok');
    assert.equal(ok.records.length, 1);
    const dir = readAudit(h);
    assert.equal(dir.status, 'unreadable');
    assert.equal(dir.errors.length, 1);
  });
  it('openmorals audit says the log is missing rather than empty', () => {
    const h = home();
    const cli = (args: string[]) => spawnSync(process.execPath, [join(REPO_ROOT, 'dist', 'src', 'cli.js'), ...args], { encoding: 'utf8', env: { ...process.env, OPENMORALS_HOME: h }, cwd: root });
    const missing = cli(['audit']);
    assert.equal(missing.status, 0);
    assert.match(missing.stdout, /no audit log at .*nothing has been recorded there yet, or it was removed/);
    writeFileSync(join(h, 'audit.jsonl'), '');
    const empty = cli(['audit']);
    assert.match(empty.stdout, /no decisions recorded in /);
    const json = cli(['audit', '--json']);
    assert.equal(json.stdout, '');
    rmSync(join(h, 'audit.jsonl'));
    const missingJson = cli(['audit', '--json']);
    assert.equal(missingJson.stdout, '');
    assert.match(missingJson.stderr, /no audit log at /);
    mkdirSync(join(h, 'audit.jsonl'));
    const unreadable = cli(['audit']);
    assert.equal(unreadable.status, 1);
    assert.match(unreadable.stderr, /cannot read/);
  });
});
