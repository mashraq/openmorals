import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { decideCall, runClaudeCodeHook, toActions } from '../src/adapters/claude-code.js';
import { codexActions, runCodexHook } from '../src/adapters/codex/index.js';
import { runGeminiHook } from '../src/adapters/gemini-cli/index.js';
import { opencodeToolActions } from '../src/adapters/opencode/index.js';
import { openclawToolActions } from '../src/adapters/openclaw/index.js';
import { DEFAULT_BYLAWS, DEFAULT_BYLAWS_YAML, parseBylaws, resolveBylaws, validateBylaws } from '../src/bylaws.js';
import { readQueue } from '../src/defer/store.js';
import { isDeferrableRule } from '../src/defer/index.js';
import { BUILTIN_GUARDS } from '../src/engine.js';
import { CASE_CWD, CASE_HOME, caseFiles, caseVolumes } from '../src/eval/cases.js';
import type { Where } from '../src/guard.js';
import { makeWhere, volumeOf } from '../src/guard.js';
import { deleteGuard, trashRoot } from '../src/guards/delete.js';
import { loosenings } from '../src/packs/compare.js';
import { trash } from '../src/undo/index.js';
import type { Action, Verdict } from '../src/types.js';
import { EMPTY_STATE } from '../src/types.js';
import { loadCaseFiles } from './case-loader.js';
import { tempDir } from './helpers.js';

const CODE = 'export const x = 1;\n'.repeat(20);

function whereWith(files: Record<string, unknown>, cwd = CASE_CWD): Where {
  const f = caseFiles(files, cwd, CASE_HOME);
  assert.ok(f.ok, f.ok ? '' : f.error);
  return makeWhere({ home: CASE_HOME, cwd, configDir: `${CASE_HOME}/.config/openmorals`, realpath: (p) => p, exists: () => true, readFile: f.value, volume: caseVolumes(files, cwd, CASE_HOME) }, {});
}

function judge(actions: readonly Action[], files: Record<string, unknown>, bylaws: unknown = null, guards = BUILTIN_GUARDS): Verdict {
  const load = bylaws === null ? DEFAULT_BYLAWS : validateBylaws(bylaws);
  return decideCall(actions[0]?.tool ?? 'x', actions, load, EMPTY_STATE, guards, whereWith(files));
}

function bash(command: string): Action[] {
  return toActions('Bash', { command });
}

function patch(body: string): string {
  return `*** Begin Patch\n${body}*** End Patch\n`;
}

const WITHOUT = BUILTIN_GUARDS.filter((g) => g !== deleteGuard);

describe('delete guard: every host that can delete a file', () => {
  const rows: { host: string; actions: () => Action[]; files: Record<string, unknown>; rule: string }[] = [
    { host: 'codex', actions: () => codexActions('apply_patch', { command: patch('*** Delete File: src/old.ts\n') }).actions, files: { 'src/old.ts': CODE }, rule: 'delete.trash' },
    { host: 'codex', actions: () => codexActions('shell', { command: ['rm', 'src/old.ts'] }).actions, files: { 'src/old.ts': CODE }, rule: 'delete.trash' },
    { host: 'opencode', actions: () => opencodeToolActions('patch', { patchText: patch('*** Delete File: src/old.ts\n') }).actions, files: { 'src/old.ts': CODE }, rule: 'delete.trash' },
    { host: 'opencode', actions: () => opencodeToolActions('bash', { command: 'unlink src/old.ts' }).actions, files: { 'src/old.ts': CODE }, rule: 'delete.trash' },
    { host: 'openclaw', actions: () => openclawToolActions('apply_patch', { input: patch('*** Delete File: src/old.ts\n') }, ['src/old.ts']).actions, files: { 'src/old.ts': CODE }, rule: 'delete.trash' },
    { host: 'claude-code', actions: () => toActions('PowerShell', { command: 'Remove-Item src/old.ts' }), files: { 'src/old.ts': CODE }, rule: 'delete.trash' },
    { host: 'codex', actions: () => codexActions('apply_patch', { command: patch('*** Delete File: /srv/x.bin\n') }).actions, files: { '/srv/x.bin': { bytes: 9 } }, rule: 'delete.ask' },
  ];
  for (const r of rows) {
    it(`${r.host}: ${JSON.stringify(r.actions())} -> ${r.rule}`, () => {
      const v = judge(r.actions(), r.files);
      assert.equal(v.rule, r.rule, v.reason);
      assert.equal(judge(r.actions(), r.files, null, WITHOUT).decision, 'allow', 'without the delete guard nothing else objects');
    });
  }
  it('a patch delete names the trash command with the path from the project folder', () => {
    const v = judge(codexActions('apply_patch', { command: patch('*** Delete File: /work/app/src/old.ts\n') }).actions, { 'src/old.ts': CODE });
    assert.match(v.reason, /`openmorals trash src\/old\.ts`/);
  });
});

describe('the reasons: short, and naming what reaches the goal', () => {
  it('names the exact trash command, for git rm with --cached after it', () => {
    const one = judge(bash('rm src/a.js'), { 'src/a.js': CODE });
    assert.equal(one.reason, "rm would delete 'src/a.js' (400 bytes): not run. Use `openmorals trash src/a.js` instead (the file is moved aside; the person can restore it, and only they can purge it). Carry on.");
    const git = judge(bash('git rm src/a.js'), { 'src/a.js': CODE });
    assert.match(git.reason, /`openmorals trash src\/a\.js && git rm -q --cached src\/a\.js`/);
    const spaced = judge(bash('rm "my notes.js"'), { 'my notes.js': CODE });
    assert.match(spaced.reason, /`openmorals trash "my notes\.js"`/);
    const many = judge(bash('rm a.js b.js c.js d.js'), { 'a.js': 'x', 'b.js': 'x', 'c.js': 'x', 'd.js': 'x' });
    assert.match(many.reason, /'a\.js' and 3 more \(4 bytes\).*`openmorals trash <path>`/);
    for (const v of [one, git, spaced, many]) assert.ok(v.reason.length <= 240, `${v.reason.length}: ${v.reason}`);
  });
  it('an ask says why the trash cannot take it, and a temp file can be left', () => {
    const out = judge(bash('rm /tmp/x.bin'), { '/tmp/x.bin': { bytes: 5 } });
    assert.equal(out.rule, 'delete.ask');
    assert.match(out.reason, /outside the project folder.*; a temp file can be left for the system to clear$/);
    const blind = judge(bash('rm "$TARGET"'), {});
    assert.equal(blind.reason, 'rm names a path built at run time, so openmorals cannot see what it deletes: not run. Write the path out, or use `openmorals trash $TARGET`');
  });
});

describe('documents stay with the document guard; one target is asked about once', () => {
  it('a document delete is the document guard ask; a document with another file: the other file is refused', () => {
    assert.equal(judge(bash('rm notes.md'), { 'notes.md': 'Meeting notes.\n' }).rule, 'document.delete');
    const both = judge(bash('rm notes.md scratch.js'), { 'notes.md': 'Meeting notes.\n', 'scratch.js': 'x\n' });
    assert.equal(both.rule, 'delete.trash');
    assert.match(both.reason, /'scratch\.js'.*\(\+1 more\)$/);
    assert.equal(judge(bash('rm notes.md scratch.js'), { 'notes.md': 'Meeting notes.\n', 'scratch.js': 'x\n' }, null, WITHOUT).rule, 'document.delete');
  });
  it('with the document guard off, the delete guard judges documents too', () => {
    const v = judge(bash('rm notes.md'), { 'notes.md': 'Meeting notes.\n' }, { version: 1, guards: { document: { decision: 'allow' } } });
    assert.equal(v.rule, 'delete.trash');
  });
  it('with destructive off, a forced delete of one file is this guard', () => {
    const v = judge(bash('rm -f src/a.js'), { 'src/a.js': CODE }, { version: 1, guards: { destructive: { decision: 'allow' } } });
    assert.equal(v.rule, 'delete.trash');
  });
});

describe('0.21.0 decides every existing row as 0.20.0 did (the delete guard is silent on them)', () => {
  it('every row of every other case file gets the same verdict with and without the delete guard', () => {
    let rows = 0;
    for (const f of loadCaseFiles()) {
      if (f.guard === 'delete') continue;
      for (const c of f.cases) {
        const load = c.bylaws === null ? DEFAULT_BYLAWS : validateBylaws(c.bylaws);
        const a = decideCall(c.tool, c.actions, load, c.state, BUILTIN_GUARDS, c.where);
        const b = decideCall(c.tool, c.actions, load, c.state, WITHOUT, c.where);
        assert.deepEqual(a, b, `${f.file}: ${c.label}`);
        rows++;
      }
    }
    assert.ok(rows >= 580, String(rows));
  });
});

describe('delete settings', () => {
  it('the defaults and the commented template agree: decision ask, steer trash', () => {
    assert.deepEqual(DEFAULT_BYLAWS.guards.delete, { decision: 'ask', steer: 'trash' });
    const t = parseBylaws(DEFAULT_BYLAWS_YAML);
    assert.ok(t.ok);
    if (t.ok) assert.deepEqual(t.bylaws.guards.delete, DEFAULT_BYLAWS.guards.delete);
  });
  it('refuses bad values with the reason', () => {
    for (const [yaml, re] of [
      ['steer: maybe', /guards\.delete\.steer: must be trash or ask \(got "maybe"\)/],
      ['steer: deny', /steer: must be trash or ask/],
      ['decision: sometimes', /guards\.delete\.decision: must be allow, ask or deny/],
      ['exempt: [build]', /unknown key \(allowed: decision, steer\)/],
    ] as const) {
      const r = parseBylaws(`version: 1\nguards:\n  delete: { ${yaml} }\n`);
      assert.equal(r.ok, false, yaml);
      if (!r.ok) assert.match(r.error, re, yaml);
    }
  });
  it('a project file can tighten and never loosen; loosenings() reports each', () => {
    const home = tempDir('del-home');
    const cwd = tempDir('del-cwd');
    writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\nguards:\n  delete: { steer: ask }\n');
    writeFileSync(join(cwd, 'openmorals.yaml'), 'version: 1\nguards:\n  delete: { decision: allow, steer: trash }\n');
    const r = resolveBylaws(cwd, { OPENMORALS_HOME: home });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(r.bylaws.guards.delete, { decision: 'ask', steer: 'trash' }, 'the decision stays; steer trash over the user ask is a tightening');
    assert.deepEqual(r.ignored?.map((l) => l.field), ['guards.delete.decision']);
    const loose = validateBylaws({ version: 1, guards: { delete: { decision: 'allow', steer: 'ask' } } });
    assert.ok(loose.ok);
    if (loose.ok) assert.deepEqual(loosenings(loose.bylaws, DEFAULT_BYLAWS).filter((l) => l.field.startsWith('guards.delete')), [
      { field: 'guards.delete.decision', candidate: 'allow', baseline: 'ask' },
      { field: 'guards.delete.steer', candidate: 'ask', baseline: 'trash' },
    ]);
    writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\n');
    writeFileSync(join(cwd, 'openmorals.yaml'), 'version: 1\nguards:\n  delete: { steer: ask }\n');
    const r2 = resolveBylaws(cwd, { OPENMORALS_HOME: home });
    assert.ok(r2.ok);
    if (r2.ok) {
      assert.equal(r2.bylaws.guards.delete?.steer, 'trash');
      assert.deepEqual(r2.ignored?.map((l) => l.field), ['guards.delete.steer']);
    }
  });
  it('an invalid delete section never switches the guard off', () => {
    const home = tempDir('del-bad');
    const cwd = tempDir('del-bad-cwd');
    writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\nguards:\n  delete: { decision: allow, steer: never }\n');
    writeFileSync(join(cwd, 'a.js'), 'x');
    const load = resolveBylaws(cwd, { OPENMORALS_HOME: home });
    assert.equal(load.ok, false);
    const v = decideCall('Bash', bash('rm a.js'), load, EMPTY_STATE, BUILTIN_GUARDS, makeWhere({ cwd, configDir: home }, {}));
    assert.equal(v.rule, 'delete.trash');
    assert.match(v.reason, /also the bylaws file .* is invalid \(guards\.delete\.steer: must be trash or ask/);
  });
});

describe('the trash root and volume, read from disk', () => {
  it('the root is the folder holding the nearest openmorals.yaml, else the working folder', () => {
    const root = tempDir('del-root');
    mkdirSync(join(root, 'src', 'deep'), { recursive: true });
    const where = makeWhere({ cwd: join(root, 'src', 'deep') }, {});
    assert.equal(trashRoot(where), join(root, 'src', 'deep'));
    writeFileSync(join(root, 'openmorals.yaml'), 'version: 1\n');
    assert.equal(trashRoot(where), root);
  });
  it('volumeOf gives a number for what exists and null for what does not', () => {
    const d = tempDir('del-vol');
    assert.equal(typeof volumeOf(d), 'number');
    assert.equal(volumeOf(join(d, 'none')), null);
  });
  it('a file in a parent folder of the working folder, inside the root, can be trashed', () => {
    const files = { '/work/openmorals.yaml': 'version: 1\n', '/work/lib/a.js': CODE };
    const f = caseFiles(files, '/work/app', CASE_HOME);
    assert.ok(f.ok);
    if (!f.ok) return;
    const where = makeWhere({ home: CASE_HOME, cwd: '/work/app', configDir: `${CASE_HOME}/.config/openmorals`, realpath: (p) => p, exists: () => true, readFile: f.value }, {});
    const v = decideCall('Bash', bash('rm ../lib/a.js'), DEFAULT_BYLAWS, EMPTY_STATE, BUILTIN_GUARDS, where);
    assert.equal(v.rule, 'delete.trash');
  });
});

interface Proj {
  project: string;
  outside: string;
  env: NodeJS.ProcessEnv;
}

function proj(): Proj {
  const root = tempDir('del-hook');
  const home = join(root, 'home');
  const project = join(root, 'project');
  const outside = join(root, 'outside');
  for (const d of [home, project, outside]) mkdirSync(d, { recursive: true });
  writeFileSync(join(project, 'a.js'), CODE);
  writeFileSync(join(outside, 'x.bin'), 'x');
  return { project, outside, env: { OPENMORALS_HOME: home } };
}

function hookPre(p: Proj, command: string, session = 's1'): string {
  return JSON.stringify({ session_id: session, cwd: p.project, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: `toolu_${Math.random().toString(16).slice(2)}` });
}

function hookPrompt(p: Proj, text: string, session = 's1'): string {
  return JSON.stringify({ session_id: session, cwd: p.project, hook_event_name: 'UserPromptSubmit', prompt: text });
}

function out(stdout: string): Record<string, unknown> {
  return stdout === '' ? {} : (JSON.parse(stdout) as Record<string, unknown>);
}

describe('through the Claude Code hook', () => {
  it('a delete the trash can take is refused, never queued; one it cannot take is held when nobody can answer', () => {
    const p = proj();
    const env = { ...p.env, OPENMORALS_UNATTENDED: '1' };
    const refused = runClaudeCodeHook(hookPre(p, 'rm a.js'), { env });
    assert.equal(refused.verdict.rule, 'delete.trash');
    assert.equal(refused.verdict.decision, 'deny');
    assert.equal(out(refused.stdout)['systemMessage'], undefined);
    assert.ok(existsSync(join(p.project, 'a.js')));
    const held = runClaudeCodeHook(hookPre(p, `rm ${join(p.outside, 'x.bin')}`), { env });
    assert.equal(held.verdict.decision, 'deny');
    assert.equal(held.verdict.rule, 'delete.ask');
    assert.match(held.verdict.reason, /not run; queued as D-[0-9A-Z]{4} for the user's approval/);
    assert.match(String(out(held.stdout)['systemMessage']), /held for your approval/);
    assert.equal(readQueue(String(p.env['OPENMORALS_HOME']), new Date()).items.length, 1);
    assert.ok(isDeferrableRule('delete.ask'));
    assert.ok(!isDeferrableRule('delete.trash') && !isDeferrableRule('delete.blind'));
  });
  it('attended, the same outside delete asks in the host dialog', () => {
    const p = proj();
    const r = runClaudeCodeHook(hookPre(p, `rm ${join(p.outside, 'x.bin')}`), { env: p.env });
    assert.equal(r.verdict.decision, 'ask');
    assert.equal(r.verdict.rule, 'delete.ask');
  });
  it('an agent cannot purge: asked attended, refused unattended', () => {
    const p = proj();
    for (const cmd of ['openmorals purge --older-than 0 --yes', 'npx openmorals purge --older-than 0 --yes', 'openmorals purge 20260101T000000Z-ab12cd34 --yes']) {
      assert.equal(runClaudeCodeHook(hookPre(p, cmd), { env: p.env }).verdict.rule, 'self-protect.write', cmd);
      const u = runClaudeCodeHook(hookPre(p, cmd, 's-u'), { env: { ...p.env, OPENMORALS_UNATTENDED: '1' } });
      assert.equal(u.verdict.decision, 'deny', cmd);
    }
  });
  it('tells the person, at their next message, how many items went to the trash; once per new count', () => {
    const p = proj();
    writeFileSync(join(p.project, 'b.js'), 'x');
    const first = runClaudeCodeHook(hookPrompt(p, 'tidy up the old files'), { env: p.env });
    assert.equal(out(first.stdout)['systemMessage'], undefined, 'the first message only starts the count');
    assert.ok(trash('a.js', { root: p.project, cwd: p.project }).ok);
    const second = runClaudeCodeHook(hookPrompt(p, 'thanks'), { env: p.env });
    assert.equal(out(second.stdout)['systemMessage'], "openmorals: 1 item moved to this project's trash since this session began; nothing is deleted until you purge (openmorals trash --list).");
    const third = runClaudeCodeHook(hookPrompt(p, 'and now?'), { env: p.env });
    assert.equal(out(third.stdout)['systemMessage'], undefined);
    assert.ok(trash('b.js', { root: p.project, cwd: p.project }).ok);
    const fourth = runClaudeCodeHook(hookPrompt(p, 'ok'), { env: p.env });
    assert.match(String(out(fourth.stdout)['systemMessage']), /^openmorals: 2 items moved/);
    const other = runClaudeCodeHook(hookPrompt(p, 'hello', 's-other'), { env: p.env });
    assert.equal(out(other.stdout)['systemMessage'], undefined, 'another session starts its own count');
    const model = out(fourth.stdout)['hookSpecificOutput'] as Record<string, unknown> | undefined;
    assert.equal(model?.['additionalContext'], undefined, 'the model is not told');
  });
  it('Codex UserPromptSubmit and Gemini CLI BeforeAgent carry the same line as systemMessage', () => {
    for (const host of ['codex', 'gemini'] as const) {
      const p = proj();
      const ev = (text: string): string => JSON.stringify({ session_id: `s-${host}`, cwd: p.project, hook_event_name: host === 'codex' ? 'UserPromptSubmit' : 'BeforeAgent', prompt: text });
      const run = (text: string): string => (host === 'codex' ? runCodexHook(ev(text), { env: p.env }) : runGeminiHook(ev(text), { env: p.env })).stdout;
      run('start');
      assert.ok(trash('a.js', { root: p.project, cwd: p.project }).ok);
      const line = String(out(run('next'))['systemMessage'] ?? '');
      assert.match(line, /^openmorals: 1 item moved to this project's trash/, host);
    }
  });
});
