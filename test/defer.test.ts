import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runClaudeCodeHook } from '../src/adapters/claude-code.js';
import { DEFAULT_BYLAWS, parseBylaws, resolveBylaws } from '../src/bylaws.js';
import { decide } from '../src/engine.js';
import { approveCommand, pendingCommand, refuseCommand } from '../src/defer/command.js';
import type { DeferCommandOptions } from '../src/defer/command.js';
import { isDeferrableRule } from '../src/defer/index.js';
import { DEFER_LIFETIME_MS, codeHash, deferDir, readQueue } from '../src/defer/store.js';
import { tempDir } from './helpers.js';

const GUIDE = '## Section\n\nA paragraph of the guide that carries real content for a reader.\n\n'.repeat(30);
const CODE = /approve (D-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{6})/;

interface Setup {
  home: string;
  project: string;
  env: NodeJS.ProcessEnv;
}

function setup(userYaml: string | null = null, unattended = false): Setup {
  const root = tempDir('defer');
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'notes.md'), GUIDE);
  writeFileSync(join(project, 'other.md'), GUIDE);
  if (userYaml !== null) writeFileSync(join(home, 'openmorals.yaml'), userYaml);
  return { home, project, env: { OPENMORALS_HOME: home, OPENMORALS_UNATTENDED: unattended ? '1' : '' } };
}

function pre(s: Setup, tool: string, toolInput: Record<string, unknown>, session = 'sess-1', cwd = s.project): string {
  return JSON.stringify({ session_id: session, cwd, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput, tool_use_id: `toolu_${Math.random().toString(16).slice(2)}` });
}

function prompt(s: Setup, text: string, session = 'sess-1'): string {
  return JSON.stringify({ session_id: session, cwd: s.project, hook_event_name: 'UserPromptSubmit', prompt: text });
}

function out(stdout: string): Record<string, unknown> {
  return stdout === '' ? {} : (JSON.parse(stdout) as Record<string, unknown>);
}

function reasonOf(stdout: string): string {
  const h = out(stdout)['hookSpecificOutput'] as Record<string, unknown> | undefined;
  return String(h?.['permissionDecisionReason'] ?? '');
}

function codeOf(stdout: string): string {
  const m = CODE.exec(String(out(stdout)['systemMessage'] ?? ''));
  assert.ok(m !== null, `no code in ${stdout}`);
  return m[1] ?? '';
}

const RM = (cmd = 'rm notes.md'): Record<string, unknown> => ({ command: cmd, description: 'remove the notes' });

/** Holds `rm notes.md` (unattended) and returns the code. */
function hold(s: Setup, cmd = 'rm notes.md', session = 'sess-1'): { code: string; id: string } {
  const r = runClaudeCodeHook(pre(s, 'Bash', RM(cmd), session), { env: { ...s.env, OPENMORALS_UNATTENDED: '1' } });
  assert.equal(r.verdict.decision, 'deny', r.stdout);
  const code = codeOf(r.stdout);
  return { code, id: code.slice(0, 6) };
}

function approveByPrompt(s: Setup, code: string, session = 'sess-1'): Record<string, unknown> {
  const r = runClaudeCodeHook(prompt(s, `yes, approve ${code} please`, session), { env: s.env });
  return out(r.stdout);
}

function cli(s: Setup, over: Partial<DeferCommandOptions> = {}): DeferCommandOptions {
  return { env: s.env, interactive: false, readLine: () => null, prompt: () => undefined, ...over };
}

function allFiles(dir: string): string[] {
  const outList: string[] = [];
  for (const n of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, n.name);
    if (n.isDirectory()) outList.push(...allFiles(p));
    else outList.push(p);
  }
  return outList;
}

describe('deferred ask: which asks are held, and when', () => {
  it('a document delete is held under --unattended: deny with the guard rule, a short reason, and the code only for the person', () => {
    const s = setup();
    const r = runClaudeCodeHook(pre(s, 'Bash', RM()), { env: { ...s.env, OPENMORALS_UNATTENDED: '1' } });
    assert.equal(r.verdict.decision, 'deny');
    assert.equal(r.verdict.rule, 'document.delete');
    const reason = reasonOf(r.stdout);
    assert.match(reason, /^openmorals deny \[document\.delete\]: not run; queued as D-[0-9A-Z]{4} for the user's approval\. Carry on with other work; do not retry it or get the same result another way\. You will be told if it is approved\.$/);
    assert.ok(reason.length <= 220, `${reason.length} characters`);
    const code = codeOf(r.stdout);
    assert.ok(!reason.includes(code), 'the code is not in the text the agent reads');
    const q = readQueue(s.home);
    assert.equal(q.items.length, 1);
    assert.equal(q.items[0]?.state, 'waiting');
    assert.equal(q.items[0]?.item.rule, 'document.delete');
    const again = runClaudeCodeHook(pre(s, 'Bash', RM()), { env: { ...s.env, OPENMORALS_UNATTENDED: '1' } });
    assert.equal(reasonOf(again.stdout), reason, 'a retry is held under the same id');
    assert.match(String(out(again.stdout)['systemMessage']), /still held for your approval/);
    assert.ok(!String(out(again.stdout)['systemMessage']).includes(code));
    assert.equal(readQueue(s.home).items.length, 1, 'and is not queued again');
  });
  it('an attended session keeps the ask and queues nothing unless defer: true is set (the default is unchanged)', () => {
    const s = setup();
    const r = runClaudeCodeHook(pre(s, 'Bash', RM()), { env: s.env });
    assert.equal(r.verdict.decision, 'ask');
    assert.equal(r.verdict.rule, 'document.delete');
    assert.equal(out(r.stdout)['systemMessage'], undefined);
    assert.equal(readQueue(s.home).items.length, 0);
    const on = setup('version: 1\ndefer: true\n');
    const held = runClaudeCodeHook(pre(on, 'Bash', RM()), { env: on.env });
    assert.equal(held.verdict.decision, 'deny');
    assert.equal(readQueue(on.home).items.length, 1);
  });
  it('holds online deletes, recursive deletes, document shrinks and MCP deletes; never a self-protect, secrets or other ask', () => {
    const s = setup('version: 1\ndefer: true\n');
    mkdirSync(join(s.project, 'old'));
    const held = (tool: string, ti: Record<string, unknown>): string => {
      const r = runClaudeCodeHook(pre(s, tool, ti), { env: s.env });
      return `${r.verdict.decision} ${r.verdict.rule}`;
    };
    assert.equal(held('Bash', { command: 'gh repo delete acme/site --yes' }), 'deny online-delete.cloud-delete');
    assert.equal(held('Bash', { command: 'rm -rf old' }), 'deny destructive.recursive-delete');
    assert.equal(held('Write', { file_path: join(s.project, 'notes.md'), content: '## Section\n\nShort now.\n' }), 'deny document.shrink');
    assert.equal(held('mcp__files__delete_file', { name: 'report' }), 'deny adapter.mcp-delete');
    assert.equal(held('Write', { file_path: join(s.project, 'openmorals.yaml'), content: 'version: 1\n' }), 'ask self-protect.write');
    assert.equal(held('Read', { file_path: join(s.project, '.env') }), 'ask secrets.read');
    assert.equal(held('Bash', { command: 'echo $(cat notes.md) | sh' }).startsWith('ask'), true);
    assert.equal(readQueue(s.home).items.length, 4);
    for (const r of ['self-protect.write', 'secrets.read', 'document.unreadable', 'budget.tool_calls.soft', 'taint.rule-of-two', 'rules.mine', 'destructive.error']) assert.equal(isDeferrableRule(r), false, r);
  });
  it('a call with another objection beside the deletion is not held, and no grant is used for it', () => {
    const s = setup('version: 1\ndefer: true\nrules:\n  - { id: no-notes, match: { command: notes }, decision: ask, reason: mine }\n');
    const r = runClaudeCodeHook(pre(s, 'Bash', RM()), { env: s.env });
    assert.equal(r.verdict.decision, 'ask');
    assert.equal(readQueue(s.home).items.length, 0);
  });
  it('an invalid bylaws file fails closed: nothing is held and no approval is used', () => {
    const ok = setup();
    const { code } = hold(ok);
    approveByPrompt(ok, code);
    writeFileSync(join(ok.home, 'openmorals.yaml'), 'version: 1\ndefer: maybe\n');
    assert.equal(resolveBylaws(ok.project, ok.env).ok, false);
    const unatt = runClaudeCodeHook(pre(ok, 'Bash', RM()), { env: { ...ok.env, OPENMORALS_UNATTENDED: '1' } });
    assert.equal(unatt.verdict.decision, 'deny');
    assert.match(unatt.verdict.reason, /unattended/);
    const att = runClaudeCodeHook(pre(ok, 'Bash', RM()), { env: ok.env });
    assert.equal(att.verdict.decision, 'ask');
    assert.equal(readQueue(ok.home).items.filter((v) => v.state === 'approved').length, 1, 'the approval was not used');
    assert.equal(readQueue(ok.home).items.length, 1, 'nothing new was queued');
  });
});

describe('deferred ask: the grant', () => {
  it('an approval typed in the prompt lets exactly that call run once; the next one is held again', () => {
    const s = setup();
    const { code, id } = hold(s);
    const a = approveByPrompt(s, code);
    assert.match(String(a['systemMessage']), new RegExp(`approved ${id}`));
    const ctx = (a['hookSpecificOutput'] as Record<string, unknown>)['additionalContext'];
    assert.match(String(ctx), new RegExp(`the user approved ${id}; you may retry that exact call once, unchanged\\.`));
    const env = { ...s.env, OPENMORALS_UNATTENDED: '1' };
    const first = runClaudeCodeHook(pre(s, 'Bash', { command: 'rm notes.md', description: 'a different note' }), { env });
    assert.equal(first.verdict.decision, 'allow', first.stdout);
    assert.equal(first.verdict.rule, 'defer.granted');
    assert.match(String(out(first.stdout)['systemMessage']), new RegExp(`${id} runs now`));
    assert.equal(out(first.stdout)['hookSpecificOutput'], undefined, 'openmorals never sends an allow decision to the host');
    const second = runClaudeCodeHook(pre(s, 'Bash', RM()), { env });
    assert.equal(second.verdict.decision, 'deny');
    assert.notEqual(codeOf(second.stdout), code);
    assert.equal(readQueue(s.home).items.find((v) => v.item.id === id)?.state, 'used');
  });
  it('a grant is bound to the arguments: another path or a changed command falls back to the normal verdict', () => {
    const s = setup();
    const { code } = hold(s);
    approveByPrompt(s, code);
    const env = { ...s.env, OPENMORALS_UNATTENDED: '1' };
    const other = runClaudeCodeHook(pre(s, 'Bash', RM('rm other.md')), { env });
    assert.equal(other.verdict.decision, 'deny');
    assert.equal(other.verdict.rule, 'document.delete');
    const changed = runClaudeCodeHook(pre(s, 'Bash', RM('rm -f notes.md')), { env });
    assert.equal(changed.verdict.decision, 'deny');
    const attended = runClaudeCodeHook(pre(s, 'Bash', RM('rm other.md')), { env: s.env });
    assert.equal(attended.verdict.decision, 'ask');
    assert.equal(readQueue(s.home).items.filter((v) => v.state === 'approved').length, 1, 'the approval is still unused');
  });
  it('a grant is bound to the file: a changed file voids it, with a line saying so', () => {
    const s = setup();
    const { code, id } = hold(s);
    approveByPrompt(s, code);
    writeFileSync(join(s.project, 'notes.md'), `${GUIDE}one more line\n`);
    const r = runClaudeCodeHook(pre(s, 'Bash', RM()), { env: s.env });
    assert.equal(r.verdict.decision, 'ask');
    assert.match(r.verdict.reason, new RegExp(`${id} was approved, but a file it names changed since, so that approval is void`));
    assert.equal(readQueue(s.home).items.find((v) => v.item.id === id)?.state, 'void');
    writeFileSync(join(s.project, 'notes.md'), GUIDE);
    assert.equal(runClaudeCodeHook(pre(s, 'Bash', RM()), { env: s.env }).verdict.decision, 'ask', 'a void approval stays void');
    const touched = setup();
    const t = hold(touched);
    approveByPrompt(touched, t.code);
    utimesSync(join(touched.project, 'notes.md'), new Date(), new Date(Date.now() + 5000));
    assert.equal(runClaudeCodeHook(pre(touched, 'Bash', RM()), { env: touched.env }).verdict.decision, 'ask', 'same size, new modified time');
  });
  it('a grant is bound to the session and to the project folder', () => {
    const s = setup();
    const { code } = hold(s);
    approveByPrompt(s, code);
    assert.equal(runClaudeCodeHook(pre(s, 'Bash', RM(), 'sess-2'), { env: s.env }).verdict.decision, 'ask');
    const elsewhere = join(s.project, '..', 'copy');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'notes.md'), GUIDE);
    assert.equal(runClaudeCodeHook(pre(s, 'Bash', RM(), 'sess-1', elsewhere), { env: s.env }).verdict.decision, 'ask');
    assert.equal(runClaudeCodeHook(pre(s, 'Bash', RM()), { env: s.env }).verdict.decision, 'allow');
  });
  it('an expired, refused or already-used request grants nothing', () => {
    const s = setup();
    const { code } = hold(s);
    approveByPrompt(s, code);
    const later = new Date(Date.now() + DEFER_LIFETIME_MS + 60000);
    const late = runClaudeCodeHook(pre(s, 'Bash', RM()), { env: s.env, now: later });
    assert.equal(late.verdict.decision, 'ask');
    const r = setup();
    const h = hold(r);
    approveByPrompt(r, h.code);
    assert.equal(refuseCommand([h.id], cli(r)).exitCode, 0);
    assert.equal(runClaudeCodeHook(pre(r, 'Bash', RM()), { env: r.env }).verdict.decision, 'ask');
    const u = setup();
    const g = hold(u);
    approveByPrompt(u, g.code);
    assert.equal(runClaudeCodeHook(pre(u, 'Bash', RM()), { env: u.env }).verdict.decision, 'allow');
    assert.equal(runClaudeCodeHook(pre(u, 'Bash', RM()), { env: u.env }).verdict.decision, 'ask');
    const again = approveByPrompt(u, g.code);
    assert.match(String(again['systemMessage']), /is used; nothing was approved/);
  });
  it('a grant never lowers a deny: with deletes set to deny, an approved call stays denied', () => {
    const s = setup();
    const { code } = hold(s, 'rm -r notes.md');
    approveByPrompt(s, code);
    writeFileSync(join(s.home, 'openmorals.yaml'), 'version: 1\nguards:\n  destructive: { decision: deny }\n');
    const r = runClaudeCodeHook(pre(s, 'Bash', RM('rm -r notes.md')), { env: s.env });
    assert.equal(r.verdict.decision, 'deny');
    assert.equal(r.verdict.rule, 'destructive.recursive-delete');
    assert.equal(readQueue(s.home).items.filter((v) => v.state === 'approved').length, 1);
  });
  it('a grant satisfies only the asks it was for: a new objection on the same call keeps the ask', () => {
    const s = setup();
    const { code } = hold(s);
    approveByPrompt(s, code);
    writeFileSync(join(s.home, 'openmorals.yaml'), 'version: 1\nrules:\n  - { id: no-notes, match: { command: notes }, decision: ask, reason: mine }\n');
    const r = runClaudeCodeHook(pre(s, 'Bash', RM()), { env: s.env });
    assert.equal(r.verdict.decision, 'ask');
  });
});

describe('deferred ask: only the person approves', () => {
  it('the code is stored only as its hash: no file in the config folder holds it', () => {
    const s = setup();
    const { code } = hold(s);
    for (const f of allFiles(s.home)) assert.ok(!readFileSync(f, 'utf8').includes(code.slice(7)), `${f} holds the code`);
    const item = readQueue(s.home).items[0]?.item;
    assert.equal(item?.code_sha256, codeHash(code));
  });
  it('the agent running openmorals approve through its shell tool is asked, and refused unattended; writing the queue files is asked', () => {
    const s = setup();
    const { code, id } = hold(s);
    for (const cmd of [`openmorals approve ${code}`, `npx openmorals approve ${code}`, `node /opt/tools/openmorals/dist/src/cli.js approve ${code}`, `cd /tmp && openmorals approve ${id}`, 'openmorals release agent-1', 'openmorals accept p-1']) {
      const att = runClaudeCodeHook(pre(s, 'Bash', { command: cmd }), { env: s.env });
      assert.equal(`${att.verdict.decision} ${att.verdict.rule}`, 'ask self-protect.write', cmd);
      const un = runClaudeCodeHook(pre(s, 'Bash', { command: cmd }), { env: { ...s.env, OPENMORALS_UNATTENDED: '1' } });
      assert.equal(un.verdict.decision, 'deny', cmd);
      assert.equal(readQueue(s.home).items.length, 1, `${cmd} was not itself queued`);
    }
    const w = runClaudeCodeHook(pre(s, 'Write', { file_path: join(deferDir(s.home), `${id}.approved`), content: '{}' }), { env: s.env });
    assert.equal(`${w.verdict.decision} ${w.verdict.rule}`, 'ask self-protect.write');
    const echo = runClaudeCodeHook(pre(s, 'Bash', { command: `echo '{}' > ${join(deferDir(s.home), `${id}.approved`)}` }), { env: s.env });
    assert.equal(echo.verdict.rule, 'self-protect.write');
    assert.equal(runClaudeCodeHook(pre(s, 'Bash', { command: 'openmorals pending' }), { env: s.env }).verdict.decision, 'allow');
  });
  it('the CLI approves with the code; without it only in a terminal, after the person types the id', () => {
    const s = setup();
    const { code, id } = hold(s);
    const noTty = approveCommand([id], cli(s));
    assert.equal(noTty.exitCode, 1);
    assert.match(noTty.stderr, /only in a terminal/);
    const wrong = approveCommand([`${id}-000000`], cli(s));
    assert.equal(wrong.exitCode, 1);
    assert.match(wrong.stderr, /does not match/);
    let asked = '';
    const no = approveCommand([id], cli(s, { interactive: true, readLine: () => 'yes', prompt: (t) => (asked = t) }));
    assert.equal(no.exitCode, 1);
    assert.match(asked, /Type D-[0-9A-Z]{4} to approve/);
    const yes = approveCommand([id.toLowerCase()], cli(s, { interactive: true, readLine: () => id }));
    assert.equal(yes.exitCode, 0, yes.stderr);
    assert.equal(readQueue(s.home).items[0]?.approvedVia, 'terminal');
    assert.equal(approveCommand([code], cli(s)).exitCode, 1, 'already approved');
    const t = setup();
    const h = hold(t);
    const ok = approveCommand([h.code.toLowerCase()], cli(t));
    assert.equal(ok.exitCode, 0, ok.stderr);
    assert.equal(runClaudeCodeHook(pre(t, 'Bash', RM()), { env: t.env }).verdict.decision, 'allow');
  });
  it('a wrong code typed in the prompt approves nothing; the waiting line is shown once', () => {
    const s = setup();
    const { id } = hold(s);
    const bad = approveByPrompt(s, `${id}-ZZZZZZ`);
    assert.match(String(bad['systemMessage']), /matches no request; nothing was approved/);
    assert.equal(bad['hookSpecificOutput'], undefined);
    assert.equal(readQueue(s.home).items[0]?.state, 'waiting');
    const s2 = setup();
    hold(s2);
    const first = out(runClaudeCodeHook(prompt(s2, 'carry on'), { env: s2.env }).stdout);
    assert.match(String(first['systemMessage']), /1 request waits for your approval/);
    const second = out(runClaudeCodeHook(prompt(s2, 'carry on'), { env: s2.env }).stdout);
    assert.equal(second['systemMessage'], undefined);
    const other = out(runClaudeCodeHook(prompt(s2, 'carry on', 'sess-9'), { env: s2.env }).stdout);
    assert.equal(other['systemMessage'], undefined, 'another session is not told');
  });
  it('pending lists what is held, never the code', () => {
    const s = setup();
    const { code, id } = hold(s);
    const p = pendingCommand([], cli(s));
    assert.equal(p.exitCode, 0);
    assert.match(p.stdout, /1 action held for your approval/);
    assert.match(p.stdout, new RegExp(`${id}  waiting`));
    assert.match(p.stdout, /Bash: rm notes\.md/);
    assert.ok(!p.stdout.includes(code));
    const j = JSON.parse(pendingCommand(['--json'], cli(s)).stdout) as { items: Array<{ id: string; state: string }> };
    assert.deepEqual(j.items.map((x) => [x.id, x.state]), [[id, 'waiting']]);
    assert.equal(pendingCommand(['--bogus'], cli(s)).exitCode, 64);
  });
  it('the queue keeps the redacted action and no file content', () => {
    const s = setup('version: 1\ndefer: true\n');
    const token = 'ghp_FAKEfakeFAKEfakeFAKEfake00000000000';
    runClaudeCodeHook(pre(s, 'Bash', { command: `GITHUB_TOKEN=${token} rm notes.md` }), { env: s.env });
    runClaudeCodeHook(pre(s, 'Write', { file_path: join(s.project, 'other.md'), content: `## Section\n\nSECRET-BODY ${token}\n` }), { env: s.env });
    assert.equal(readQueue(s.home).items.length, 2);
    for (const f of allFiles(deferDir(s.home))) {
      const text = readFileSync(f, 'utf8');
      assert.ok(!text.includes(token), `${f} holds the token`);
      assert.ok(!text.includes('SECRET-BODY'), `${f} holds file content`);
      assert.ok(!text.includes('real content for a reader'), `${f} holds file content`);
    }
  });
});

describe('deferred ask: broken or tampered files fail closed', () => {
  it('a corrupt request file grants nothing and is named', () => {
    const s = setup();
    const { code, id } = hold(s);
    approveByPrompt(s, code);
    writeFileSync(join(deferDir(s.home), `${id}.json`), '{"v":1,"id":');
    const r = runClaudeCodeHook(pre(s, 'Bash', RM()), { env: s.env });
    assert.equal(r.verdict.decision, 'ask');
    assert.match(r.verdict.reason, /1 deferred-request file could not be read and grant nothing/);
    assert.match(pendingCommand([], cli(s)).stdout, new RegExp(`unreadable: ${id}\\.json: not valid JSON; it grants nothing`));
  });
  it('a tampered request (lifetime stretched, another id) and a malformed approval grant nothing', () => {
    const tamper = (change: (item: Record<string, unknown>, file: string, id: string, s: Setup) => void): string => {
      const s = setup();
      const { code, id } = hold(s);
      approveByPrompt(s, code);
      const file = join(deferDir(s.home), `${id}.json`);
      change(JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>, file, id, s);
      const r = runClaudeCodeHook(pre(s, 'Bash', RM()), { env: s.env });
      assert.equal(r.verdict.decision, 'ask');
      return r.verdict.reason;
    };
    assert.match(tamper((item, file) => writeFileSync(file, JSON.stringify({ ...item, expires: new Date(Date.now() + 10 * DEFER_LIFETIME_MS).toISOString() }))), /could not be read and grant nothing/);
    assert.match(tamper((item, file) => writeFileSync(file, JSON.stringify({ ...item, id: 'D-0000' }))), /could not be read and grant nothing/);
    assert.match(tamper((_item, _file, id, s) => writeFileSync(join(deferDir(s.home), `${id}.approved`), 'not json')), /could not be read and grant nothing/);
  });
  it('a queue folder that cannot be read keeps the normal verdict, says why, and queues nothing', () => {
    const s = setup();
    writeFileSync(deferDir(s.home), 'a file where the folder should be');
    const att = runClaudeCodeHook(pre(s, 'Bash', RM()), { env: s.env });
    assert.equal(att.verdict.decision, 'ask');
    assert.match(att.verdict.reason, /the deferred-request folder .* could not be read \(ENOTDIR\), so no approval is used/);
    const un = runClaudeCodeHook(pre(s, 'Bash', RM()), { env: { ...s.env, OPENMORALS_UNATTENDED: '1' } });
    assert.equal(un.verdict.decision, 'deny');
    assert.match(un.verdict.reason, /it could not be queued for approval/);
    assert.equal(out(un.stdout)['systemMessage'], undefined);
    assert.equal(pendingCommand([], cli(s)).exitCode, 1);
    rmSync(deferDir(s.home), { force: true });
  });
  it('a missing session id is never held', () => {
    const s = setup();
    const r = runClaudeCodeHook(JSON.stringify({ cwd: s.project, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: RM() }), { env: { ...s.env, OPENMORALS_UNATTENDED: '1' } });
    assert.equal(r.verdict.decision, 'deny');
    assert.match(r.verdict.reason, /unattended/);
    assert.equal(readQueue(s.home).items.length, 0);
  });
});

describe('deferred ask: the bylaws setting', () => {
  it('defer is a true-or-false setting, absent by default', () => {
    assert.equal(DEFAULT_BYLAWS.defer, undefined);
    const on = parseBylaws('version: 1\ndefer: true\n');
    assert.ok(on.ok);
    assert.equal(on.bylaws.defer, true);
    const bad = parseBylaws('version: 1\ndefer: yes-please\n');
    assert.equal(bad.ok, false);
    assert.match(bad.ok ? '' : bad.error, /defer: must be true or false/);
  });
  it('a project file can switch defer on, never off', () => {
    const s = setup('version: 1\ndefer: true\n');
    writeFileSync(join(s.project, 'openmorals.yaml'), 'version: 1\ndefer: false\n');
    const r = resolveBylaws(s.project, s.env);
    assert.ok(r.ok);
    assert.equal(r.bylaws.defer, true);
    assert.ok(r.ignored?.some((l) => l.field === 'defer'));
    const p = setup();
    writeFileSync(join(p.project, 'openmorals.yaml'), 'version: 1\ndefer: true\n');
    const q = resolveBylaws(p.project, p.env);
    assert.ok(q.ok);
    assert.equal(q.bylaws.defer, true);
  });
  it('decide() is unchanged by defer: the engine still asks', () => {
    const on = parseBylaws('version: 1\ndefer: true\n');
    assert.ok(on.ok);
    assert.equal(decide({ kind: 'exec', command: 'rm -rf build', shell: 'posix', tool: 'Bash' }, on.bylaws, { toolCalls: 1, tokens: 0, prevTokens: 0 }).decision, 'ask');
  });
});
