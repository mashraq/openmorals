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
import { boundPaths, fileStates, sameFiles } from '../src/defer/binding.js';
import { isDeferrableRule } from '../src/defer/index.js';
import { BUILTIN_GUARDS } from '../src/engine.js';
import { CASE_CWD, CASE_HOME, caseFiles, caseVolumes } from '../src/eval/cases.js';
import type { Where } from '../src/guard.js';
import { makeWhere, volumeOf } from '../src/guard.js';
import { deleteGuard, trashRoot } from '../src/guards/delete.js';
import { pathFrom } from '../src/guards/document.js';
import { commandPlaces } from '../src/guards/folders.js';
import { parseCommand } from '../src/shell.js';
import { loosenings } from '../src/packs/compare.js';
import { trash } from '../src/undo/index.js';
import type { Action, Decision, Verdict } from '../src/types.js';
import { EMPTY_STATE, decisionRank } from '../src/types.js';
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

describe('documents inside the project are steered to the trash like any file (0.22.0); one target is asked about once', () => {
  it('a document delete the trash can take is refused with the trash command named; one it cannot take keeps the document ask', () => {
    const v = judge(bash('rm notes.md'), { 'notes.md': 'Meeting notes.\n' });
    assert.equal(v.rule, 'delete.trash');
    assert.match(v.reason, /`openmorals trash notes\.md`/);
    assert.ok(!v.reason.includes('more)'), 'one finding: the document guard does not ask again');
    const both = judge(bash('rm notes.md scratch.js'), { 'notes.md': 'Meeting notes.\n', 'scratch.js': 'x\n' });
    assert.equal(both.rule, 'delete.trash');
    assert.match(both.reason, /'notes\.md' and 1 more \(/);
    assert.match(both.reason, /`openmorals trash notes\.md scratch\.js`/);
    assert.equal(judge(bash('rm /srv/notes.md'), { '/srv/notes.md': 'x' }).rule, 'document.delete');
    assert.equal(judge(bash('rm notes.md'), { 'notes.md': 'x' }, { version: 1, guards: { delete: { steer: 'ask' } } }).rule, 'document.delete');
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

describe('no setting makes a delete weaker by being stricter (0.22.0)', () => {
  const DECS: readonly Decision[] = ['allow', 'ask', 'deny'];
  const STEERS = ['ask', 'trash'] as const;
  const DISK = { 'notes.md': 'Meeting notes.\n', 'draft.md': '# Draft\n', 'a.js': CODE, 'b.js': CODE, '/srv/notes.md': 'x', '/srv/x.bin': 'x', '/srv/archive': { folder: true } };
  const CALLS: [string, () => Action[]][] = [
    ['rm notes.md', () => bash('rm notes.md')],
    ['git rm notes.md', () => bash('git rm notes.md')],
    ['mv notes.md /tmp/', () => bash('mv notes.md /tmp/')],
    ['mv draft.md notes.md', () => bash('mv draft.md notes.md')],
    ['cp draft.md notes.md', () => bash('cp draft.md notes.md')],
    ['mv notes.md /srv/archive/', () => bash('mv notes.md /srv/archive/')],
    ['rm /srv/notes.md', () => bash('rm /srv/notes.md')],
    ['mv /srv/notes.md /tmp/', () => bash('mv /srv/notes.md /tmp/')],
    ['cp draft.md /srv/notes.md', () => bash('cp draft.md /srv/notes.md')],
    ['patch delete notes.md', () => codexActions('apply_patch', { command: patch('*** Delete File: notes.md\n') }).actions],
    ['MCP delete notes.md', () => toActions('mcp__files__delete_file', { path: 'notes.md' })],
    ['rm a.js', () => bash('rm a.js')],
    ['mv a.js /tmp/', () => bash('mv a.js /tmp/')],
    ['cp a.js b.js', () => bash('cp a.js b.js')],
    ['mv a.js /srv/archive/', () => bash('mv a.js /srv/archive/')],
  ];
  const rank = (call: () => Action[], doc: Decision, del: Decision, steer: 'ask' | 'trash'): number =>
    decisionRank(judge(call(), DISK, { version: 1, guards: { document: { decision: doc }, delete: { decision: del, steer } } }).decision);
  it('an in-project document delete is refused for document decision allow, ask and deny', () => {
    for (const [label, call] of CALLS.slice(0, 5)) {
      for (const doc of DECS) {
        const v = judge(call(), DISK, { version: 1, guards: { document: { decision: doc } } });
        assert.equal(v.decision, 'deny', `${label} with document ${doc}: ${v.rule}`);
      }
    }
  });
  it('for every pair of settings, the stricter one never gives a lower-ranked decision', () => {
    let pairs = 0;
    for (const [label, call] of CALLS) {
      for (const del of DECS) {
        for (const steer of STEERS) {
          for (let k = 1; k < DECS.length; k++) {
            const lo = DECS[k - 1] as Decision;
            const hi = DECS[k] as Decision;
            assert.ok(rank(call, hi, del, steer) >= rank(call, lo, del, steer), `${label}: document ${hi} under ${lo} (delete ${del}, steer ${steer})`);
            assert.ok(rank(call, del, hi, steer) >= rank(call, del, lo, steer), `${label}: delete ${hi} under ${lo} (document ${del}, steer ${steer})`);
            pairs += 2;
          }
        }
        for (const doc of DECS) {
          assert.ok(rank(call, doc, del, 'trash') >= rank(call, doc, del, 'ask'), `${label}: steer trash under ask (document ${doc}, delete ${del})`);
          pairs++;
        }
      }
    }
    assert.equal(pairs, CALLS.length * (3 * 2 * 2 * 2 + 3 * 3));
  });
});

describe('a move into a temp folder, and mv or cp onto an existing file (0.22.0)', () => {
  it('a temp move is refused with the trash command named; a folder too; a run-time path is refused', () => {
    const v = judge(bash('mv src/a.js /tmp/'), { 'src/a.js': CODE });
    assert.equal(v.reason, "mv would move 'src/a.js' (400 bytes) into a temp folder, which does not keep files: not run. Use `openmorals trash src/a.js` instead (the file is moved aside; the person can restore it, and only they can purge it). Carry on.");
    assert.match(judge(bash('mv dist /tmp/x'), { dist: { folder: true } }).reason, /'dist' \(a folder\).*the folder is moved aside/);
    assert.equal(judge(bash('mv "$f" /tmp/'), {}).rule, 'delete.blind');
    const ask = judge(bash('mv /srv/x.bin /tmp/'), { '/srv/x.bin': { bytes: 9 } });
    assert.equal(ask.reason, "mv moves '/srv/x.bin' (9 bytes) into a temp folder: it is outside the project folder, where openmorals trash cannot take it");
  });
  it('an overwrite names the trash command for the old file, then the move', () => {
    const v = judge(bash('mv draft.js src/a.js'), { 'draft.js': CODE, 'src/a.js': CODE });
    assert.equal(v.reason, "mv would overwrite 'src/a.js' (400 bytes): not run. Run `openmorals trash src/a.js` first, then the mv (the old file is moved aside; the person can restore it, and only they can purge it). Carry on.");
    assert.match(judge(bash('git mv -f a.js b.js'), { 'a.js': CODE, 'b.js': CODE }).reason, /Run `openmorals trash b\.js && git rm -q --cached b\.js` first, then the git mv/);
    const asked = judge(bash('mv draft.js src/a.js'), { 'draft.js': CODE, 'src/a.js': CODE }, { version: 1, guards: { delete: { steer: 'ask' } } });
    assert.equal(asked.reason, "mv overwrites 'src/a.js' (400 bytes); running `openmorals trash src/a.js` first would keep the old file recoverable");
  });
  it('the temp folders, per platform', () => {
    for (const dest of ['/tmp/', '/private/tmp/x', '/var/tmp/', '/private/var/tmp/', '/var/folders/ab/c/T/', '/private/var/folders/ab/c/T/', '/dev/shm/', '$TMPDIR/', '${TMPDIR}/x', '$TMP/', '$TEMP/']) {
      assert.equal(judge(bash(`mv a.js ${dest}`), { 'a.js': CODE }).rule, 'delete.trash', dest);
    }
    for (const dest of ['$env:TEMP', '$env:TMP\\x', 'C:\\Windows\\Temp\\', 'C:\\Users\\me\\AppData\\Local\\Temp\\']) {
      assert.equal(judge(toActions('PowerShell', { command: `Move-Item a.js ${dest}` }), { 'a.js': CODE }).rule, 'delete.trash', dest);
    }
    for (const dest of ['%TEMP%', '%TMP%\\x']) assert.equal(judge(toActions('PowerShell', { command: `cmd /c move a.js ${dest}` }), { 'a.js': CODE }).rule, 'delete.trash', dest);
    for (const dest of ['/tmpfiles/', '/srv/tmp/', '/var/tmpx/', 'tmp/', '~/tmp/', 'C:\\Temp2\\']) {
      assert.equal(judge(bash(`mv a.js ${dest}`), { 'a.js': CODE }).decision, 'allow', dest);
    }
  });
});

describe('a command that empties its own input (0.22.0)', () => {
  it('is an emptying, for any file; another target or sort -o is not', () => {
    const v = judge(bash('sort data.csv > data.csv'), { 'data.csv': { bytes: 70 } });
    assert.equal(v.reason, "the redirect > empties 'data.csv' (it holds 70 bytes) before sort reads it, so its content is lost");
    assert.equal(judge(bash('sort data.csv > other.csv'), { 'data.csv': { bytes: 70 }, 'other.csv': { bytes: 70 } }).decision, 'allow');
    assert.equal(judge(bash('sort data.csv -o data.csv'), { 'data.csv': { bytes: 70 } }).decision, 'allow');
    assert.equal(judge(bash('python3 fix.py data.csv > data.csv'), { 'data.csv': { bytes: 70 } }).decision, 'allow', 'an unknown program is not judged (a stated limit)');
  });
});

describe('the deferred ask binds the file a move would replace, not the folder it goes into (0.22.0)', () => {
  it('a new file elsewhere in the folder leaves the binding unchanged; a change to the replaced file voids it', () => {
    const root = tempDir('del-bind');
    const project = join(root, 'p');
    const out = join(root, 'out');
    mkdirSync(project, { recursive: true });
    mkdirSync(out, { recursive: true });
    writeFileSync(join(project, 'a.js'), CODE);
    writeFileSync(join(out, 'a.js'), 'old');
    const paths = boundPaths(bash(`mv a.js ${out}/`), project, root);
    assert.deepEqual(paths, [join(project, 'a.js'), join(out, 'a.js')].sort());
    const before = fileStates(paths ?? []) ?? [];
    writeFileSync(join(out, 'unrelated.txt'), 'x');
    assert.ok(sameFiles(before, fileStates(paths ?? []) ?? []), 'the folder changed; the files did not');
    writeFileSync(join(out, 'a.js'), 'changed since the ask');
    assert.ok(!sameFiles(before, fileStates(paths ?? []) ?? []));
  });
});

describe('0.21.0 decides every existing row as 0.20.0 did (the delete guard is silent on them)', () => {
  it('every row of every other case file gets the same verdict with and without the delete guard', () => {
    let rows = 0;
    for (const f of loadCaseFiles()) {
      // The hold's cp row (0.28.0) is there to show the delete guard's refusal stands over the hold's ask.
      if (f.guard === 'delete' || f.guard === 'hold') continue;
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
    assert.equal(out(second.stdout)['systemMessage'], "openmorals: 1 item moved to this project's trash since this session began (a.js); nothing is deleted until you purge (openmorals trash --list).");
    const third = runClaudeCodeHook(hookPrompt(p, 'and now?'), { env: p.env });
    assert.equal(out(third.stdout)['systemMessage'], undefined);
    assert.ok(trash('b.js', { root: p.project, cwd: p.project }).ok);
    const fourth = runClaudeCodeHook(hookPrompt(p, 'ok'), { env: p.env });
    assert.match(String(out(fourth.stdout)['systemMessage']), /^openmorals: 2 items moved to this project's trash since this session began \(b\.js, a\.js\); /);
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

describe('a change of folder in the same call (0.21.1)', () => {
  const places = (cmd: string, shell: 'posix' | 'powershell' | 'cmd' = 'posix'): { dirs: readonly string[]; unknown: string | null }[] => {
    const where = whereWith({});
    return commandPlaces(parseCommand(cmd, shell).commands, where, pathFrom(where));
  };
  it('follows cd, pushd, popd, Set-Location and git -C, keeping the earlier folders as candidates', () => {
    assert.deepEqual(places('cd sub && rm c.py').map((p) => p.dirs), [['/work/app'], ['/work/app', '/work/app/sub']]);
    assert.deepEqual(places('cd sub && cd deep && rm c.py')[2]?.dirs, ['/work/app', '/work/app/sub', '/work/app/deep', '/work/app/sub/deep'], 'every earlier folder stays a candidate');
    assert.deepEqual(places('git -C sub rm c.py')[0]?.dirs, ['/work/app/sub']);
    assert.deepEqual(places('Set-Location -Path sub; Remove-Item c.py', 'powershell')[1]?.dirs, ['/work/app', '/work/app/sub']);
    assert.deepEqual(places('cd && rm c.py')[1]?.dirs, ['/work/app', '/home/u']);
    assert.deepEqual(places('cd ~/x && rm c.py')[1]?.dirs, ['/work/app', '/home/u/x']);
    assert.equal(places('pushd sub && popd && rm c.py')[2]?.unknown, null);
    assert.equal(places('ls && rm c.py').every((p) => p.unknown === null && p.dirs.length === 1), true);
  });
  it('a folder it cannot know makes the rest of the call unknown', () => {
    for (const cmd of ['cd "$D" && rm c.py', 'cd - && rm c.py', 'cd `pwd`/x && rm c.py', 'popd && rm c.py', 'pushd && rm c.py', 'cd a && cd b && cd c && cd d && cd e && cd f && cd g && cd h && rm c.py']) {
      const p = places(cmd);
      assert.notEqual(p[p.length - 1]?.unknown, null, cmd);
    }
  });
  it('after an unknown folder, a relative document delete asks even with the delete guard off', () => {
    const v = judge(bash('cd "$D" && rm notes.md'), {}, { version: 1, guards: { delete: { decision: 'allow' } } });
    assert.equal(v.rule, 'document.unknown');
    assert.match(v.reason, /after cd goes to a folder named by a variable/);
  });
  it('the reason names the path from the working folder, and a call without cd is judged as before', () => {
    const v = judge(bash('cd sub && rm c.py'), { 'sub/c.py': CODE });
    assert.match(v.reason, /^rm would delete 'sub\/c\.py' \(400 bytes\): not run\. Use `openmorals trash sub\/c\.py` instead/);
    const folder = judge(bash('git rm -r lib/old'), { 'lib/old': { folder: true } });
    assert.match(folder.reason, /'lib\/old' \(a folder\).*`openmorals trash lib\/old && git rm -r -q --cached lib\/old`.*the folder is moved aside/);
  });
  it('through the Claude Code hook on a real folder', () => {
    const p = proj();
    mkdirSync(join(p.project, 'sub'));
    writeFileSync(join(p.project, 'sub', 'c.py'), 'x');
    assert.equal(runClaudeCodeHook(hookPre(p, 'cd sub && rm c.py'), { env: p.env }).verdict.rule, 'delete.trash');
    assert.equal(runClaudeCodeHook(hookPre(p, 'cd sub && ls'), { env: p.env }).verdict.decision, 'allow');
  });
});

describe('a held delete after a cd is bound to the file it deletes (0.21.1)', () => {
  it('the file the cd names is in the binding', () => {
    const d = tempDir('del-bind');
    mkdirSync(join(d, 'docs'));
    writeFileSync(join(d, 'docs', 'notes.md'), '# n\n');
    const paths = boundPaths(bash('cd docs && rm notes.md'), d, CASE_HOME) ?? [];
    assert.ok(paths.includes(join(d, 'docs', 'notes.md')), paths.join(', '));
  });
});

describe('moves, overwrites and the notice through the Claude Code hook (0.22.0)', () => {
  const CODE_RE = /approve (D-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{6})/;
  it('a temp move under steer: ask is held when nobody can answer, and an approval survives other files appearing in that folder', () => {
    const p = proj();
    const home = String(p.env['OPENMORALS_HOME']);
    writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\nguards:\n  delete: { steer: ask }\n');
    const dest = join(p.outside, 'tmp-like');
    mkdirSync(dest, { recursive: true });
    const env = { ...p.env, OPENMORALS_UNATTENDED: '1' };
    const cmd = `mv a.js ${dest}/`;
    const temp = isTempLike(dest);
    const held = runClaudeCodeHook(hookPre(p, cmd), { env });
    if (!temp) {
      assert.equal(held.verdict.decision, 'allow', 'the test folder is not a temp folder on this system: a move there is not a delete');
      return;
    }
    assert.equal(held.verdict.rule, 'delete.ask', held.stdout);
    assert.equal(held.verdict.decision, 'deny');
    const code = CODE_RE.exec(String(out(held.stdout)['systemMessage']))?.[1] ?? '';
    assert.notEqual(code, '');
    runClaudeCodeHook(hookPrompt(p, `approve ${code}`), { env: p.env });
    writeFileSync(join(dest, 'unrelated.txt'), 'made after the ask');
    const again = runClaudeCodeHook(hookPre(p, cmd), { env });
    assert.equal(again.verdict.rule, 'defer.granted', again.stdout);
  });
  it('an overwrite is refused with the old file named; the file the refusal names can be trashed, then the move is silent', () => {
    const p = proj();
    writeFileSync(join(p.project, 'b.js'), 'old');
    const v = runClaudeCodeHook(hookPre(p, 'cp a.js b.js'), { env: p.env });
    assert.equal(v.verdict.rule, 'delete.trash');
    assert.match(v.verdict.reason, /Run `openmorals trash b\.js` first, then the cp/);
    assert.ok(trash('b.js', { root: p.project, cwd: p.project }).ok);
    assert.equal(runClaudeCodeHook(hookPre(p, 'cp a.js b.js'), { env: p.env }).verdict.decision, 'allow');
  });
  it('the notice names the newest three trashed items, then counts the rest, on one line', () => {
    const p = proj();
    const names = ['a.js', 'b.js', 'c.js', 'd.js', 'e\nf.js'];
    for (const n of names.slice(1)) writeFileSync(join(p.project, n), 'x');
    runClaudeCodeHook(hookPrompt(p, 'start'), { env: p.env });
    for (const n of names) assert.ok(trash(n, { root: p.project, cwd: p.project }).ok, n);
    const line = String(out(runClaudeCodeHook(hookPrompt(p, 'next'), { env: p.env }).stdout)['systemMessage']);
    const m = /^openmorals: 5 items moved to this project's trash since this session began \(([^,()]+), ([^,()]+), ([^,()]+) and 2 more\); nothing is deleted until you purge \(openmorals trash --list\)\.$/.exec(line);
    assert.ok(m !== null, line);
    const shownNames = names.map((n) => n.replace('\n', '?'));
    for (const n of m.slice(1)) assert.ok(shownNames.includes(n), n);
    assert.ok(!/[\r\n]/.test(line));
    const q = proj();
    writeFileSync(join(q.project, 'e\nf.js'), 'x');
    runClaudeCodeHook(hookPrompt(q, 'start'), { env: q.env });
    assert.ok(trash('e\nf.js', { root: q.project, cwd: q.project }).ok);
    assert.match(String(out(runClaudeCodeHook(hookPrompt(q, 'next'), { env: q.env }).stdout)['systemMessage']), /began \(e\?f\.js\); nothing/);
  });
});

describe('delete guard: the trash command and the folders an agent or git reads (0.40.0)', () => {
  const only = [deleteGuard];
  it('asks with its own rule about the bylaws file, .claude, .git and a folder holding them, with the delete guard alone', () => {
    for (const [cmd, files] of [
      ['openmorals trash openmorals.yaml', { 'openmorals.yaml': 'version: 1\n' }],
      ['openmorals trash .claude', { '.claude/settings.json': '{}\n' }],
      ['cd .claude && openmorals trash settings.json', { '.claude/settings.json': '{}\n' }],
      ['openmorals trash .git', { '.git/HEAD': 'x\n' }],
      ['openmorals trash .gemini/settings.json', { '.gemini/settings.json': '{}\n' }],
    ] as const) {
      const v = judge(bash(cmd), files, null, only);
      assert.equal(v.decision, 'ask', cmd);
      assert.equal(v.rule, 'delete.protected', cmd);
      assert.match(v.reason, /asked even though the trash could restore it/, cmd);
    }
    assert.equal(judge(bash('openmorals trash src/a.js'), { 'src/a.js': CODE }, null, only).decision, 'allow');
  });
  it("asks about openmorals' config folder inside the project, and a folder that holds it", () => {
    const f = caseFiles({ 'state/om/audit.jsonl': 'x\n', 'state/notes.md': CODE }, CASE_CWD, CASE_HOME);
    assert.ok(f.ok);
    const where = makeWhere({ home: CASE_HOME, cwd: CASE_CWD, configDir: `${CASE_CWD}/state/om`, realpath: (p) => p, exists: () => true, readFile: f.value }, {});
    const v = decideCall('Bash', bash('openmorals trash state'), DEFAULT_BYLAWS, EMPTY_STATE, [deleteGuard], where);
    assert.equal(v.rule, 'delete.protected');
    assert.match(v.reason, /a folder that holds openmorals' config folder/);
    assert.equal(decideCall('Bash', bash('openmorals trash state/notes.md'), DEFAULT_BYLAWS, EMPTY_STATE, [deleteGuard], where).decision, 'allow');
  });
  it('asks about a tilde word the shell expands at run time', () => {
    for (const cmd of ['openmorals trash ~+/../x', 'openmorals trash ~-/x', 'openmorals trash ~2/x', 'openmorals trash ~bob/x']) {
      assert.equal(judge(bash(cmd), {}, null, only).rule, 'delete.ask', cmd);
    }
  });
});

/** Whether a folder made by the tests is under a system temp folder (it is on macOS and Linux; the guard is lexical). */
function isTempLike(dir: string): boolean {
  return /^(\/private)?\/(var\/)?tmp\/|^(\/private)?\/var\/folders\//.test(dir.replace(/\\/g, '/'));
}
