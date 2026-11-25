import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { decideCall, runClaudeCodeHook, toActions } from '../src/adapters/claude-code.js';
import { DEFAULT_BYLAWS, DEFAULT_BYLAWS_YAML, parseBylaws, resolveBylaws, validateBylaws } from '../src/bylaws.js';
import { isDeferrableRule } from '../src/defer/index.js';
import { BUILTIN_GUARDS, decide } from '../src/engine.js';
import { caseBylaws } from '../src/eval/cases.js';
import { makeWhere } from '../src/guard.js';
import { REPLACE_HASH_MAX_BYTES, replaceGuard, replacementsOf, underGit } from '../src/guards/replace.js';
import { handlePostTool } from '../src/inbound/record.js';
import { loosenings } from '../src/packs/compare.js';
import { parseMemory } from '../src/session.js';
import { parseCommand } from '../src/shell.js';
import { loadSession } from '../src/state.js';
import type { Action, Bylaws, BylawsLoad, Verdict } from '../src/types.js';
import { EMPTY_STATE } from '../src/types.js';
import { keepCopy, list, parseEntry, purge, restore, trash, trashNotice } from '../src/undo/index.js';
import { loadCaseFiles } from './case-loader.js';
import { REPO_ROOT, tempDir } from './helpers.js';

const CLI = join(REPO_ROOT, 'dist', 'src', 'cli.js');
const CSV = 'name,amount\nrent,1200\nfood,300\n';
const KEEP = 'version: 1\nguards:\n  replace:\n    steer: keep\n';
const WITHOUT = BUILTIN_GUARDS.filter((g) => g !== replaceGuard);

function keepBylaws(): Bylaws {
  const r = parseBylaws(KEEP);
  assert.ok(r.ok);
  return r.bylaws;
}

interface Proj {
  root: string;
  project: string;
  home: string;
  env: NodeJS.ProcessEnv;
}

/** A project folder with no .git above it, and an openmorals home whose user file switches `keep` on (or not). */
function proj(keep = true, userFile: string | null = null): Proj {
  const root = tempDir('replace');
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'data.csv'), CSV);
  if (userFile !== null) writeFileSync(join(home, 'openmorals.yaml'), userFile);
  else if (keep) writeFileSync(join(home, 'openmorals.yaml'), KEEP);
  return { root, project, home, env: { OPENMORALS_HOME: home } };
}

let calls = 0;
function pre(p: Proj, tool: string, input: Record<string, unknown>, session = 's1'): { payload: string; id: string } {
  const id = `toolu_${++calls}`;
  return { payload: JSON.stringify({ session_id: session, cwd: p.project, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: id }), id };
}

function post(p: Proj, tool: string, input: Record<string, unknown>, id: string, session = 's1'): string {
  return JSON.stringify({ session_id: session, cwd: p.project, hook_event_name: 'PostToolUse', tool_name: tool, tool_input: input, tool_use_id: id, tool_response: { ok: true } });
}

/** One call through the hook: judged, and when allowed, run here (the file written) and its post-tool event sent. */
function call(p: Proj, tool: string, input: Record<string, unknown>, run: () => void, session = 's1'): Verdict {
  const { payload, id } = pre(p, tool, input, session);
  const v = runClaudeCodeHook(payload, { env: p.env }).verdict;
  if (v.decision === 'allow') {
    run();
    runClaudeCodeHook(post(p, tool, input, id, session), { env: p.env });
  }
  return v;
}

function write(p: Proj, content: string, file = 'data.csv', session = 's1'): Verdict {
  const path = join(p.project, file);
  return call(p, 'Write', { file_path: path, content }, () => writeFileSync(path, content), session);
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('the setting: off by default, any file may switch it on, a project may never switch it off', () => {
  it('the defaults carry no replace section, so the default policy object is unchanged', () => {
    assert.equal(DEFAULT_BYLAWS.guards.replace, undefined);
    const t = parseBylaws(DEFAULT_BYLAWS_YAML);
    assert.ok(t.ok);
    assert.equal(t.bylaws.guards.replace, undefined, 'the template only shows it in a comment');
  });
  it('reads off and keep, and refuses anything else', () => {
    const on = parseBylaws(KEEP);
    assert.ok(on.ok && on.bylaws.guards.replace?.steer === 'keep');
    const off = parseBylaws('version: 1\nguards:\n  replace:\n    steer: off\n');
    assert.ok(off.ok && off.bylaws.guards.replace?.steer === 'off');
    const bad = parseBylaws('version: 1\nguards:\n  replace:\n    steer: always\n');
    assert.ok(!bad.ok);
    assert.match(bad.error, /guards\.replace\.steer: must be off or keep \(got "always"\)/);
    assert.ok(!parseBylaws('version: 1\nguards:\n  replace:\n    keep: true\n').ok, 'unknown key');
  });
  it('a project file may switch it on, and its off under a user keep is a loosening, named and dropped', () => {
    const p = proj(false);
    writeFileSync(join(p.project, 'openmorals.yaml'), KEEP);
    const on = resolveBylaws(p.project, p.env);
    assert.ok(on.ok && on.bylaws.guards.replace?.steer === 'keep');
    const q = proj(true);
    writeFileSync(join(q.project, 'openmorals.yaml'), 'version: 1\nguards:\n  replace:\n    steer: off\n');
    const kept = resolveBylaws(q.project, q.env);
    assert.ok(kept.ok && kept.bylaws.guards.replace?.steer === 'keep');
    assert.deepEqual(kept.ignored?.map((l) => l.field), ['guards.replace.steer']);
    const offB = parseBylaws('version: 1\nguards:\n  replace:\n    steer: off\n');
    assert.ok(offB.ok);
    assert.deepEqual(loosenings(offB.bylaws, keepBylaws()), [{ field: 'guards.replace.steer', candidate: 'off', baseline: 'keep' }]);
    assert.deepEqual(loosenings(DEFAULT_BYLAWS, keepBylaws()), [{ field: 'guards.replace.steer', candidate: 'off', baseline: 'keep' }], 'absent counts as off');
    assert.deepEqual(loosenings(keepBylaws(), DEFAULT_BYLAWS), []);
  });
});

describe('with the default, no decision anywhere changes', () => {
  it('every row of every case file decides the same (decision, rule and reason) with and without the replace guard', () => {
    let rows = 0;
    for (const f of loadCaseFiles()) {
      for (const c of f.cases) {
        const load = caseBylaws(c, f.file);
        if (load.ok && load.bylaws.guards.replace?.steer === 'keep') continue;
        const a = decideCall(c.tool, c.actions, load, c.state, BUILTIN_GUARDS, c.where);
        const b = decideCall(c.tool, c.actions, load, c.state, WITHOUT, c.where);
        assert.deepEqual(a, b, `${f.file}:${c.line ?? '?'} ${c.label}`);
        rows++;
      }
    }
    assert.ok(rows >= 770, `only ${rows} rows`);
  });
  it('the guard reads nothing when off: no file probe, no hash', () => {
    let reads = 0;
    const where = makeWhere({ cwd: '/work/app', readFile: () => (reads++, { kind: 'file', bytes: 10 }), hash: () => (reads++, { kind: 'hash', bytes: 10, sha256: sha('x') }) }, {});
    const action = toActions('Write', { file_path: '/work/app/data.csv', content: 'x' })[0] as Action;
    assert.deepEqual(replaceGuard.evaluate({ action, parsed: null, bylaws: DEFAULT_BYLAWS, state: EMPTY_STATE, where }), []);
    assert.equal(reads, 0);
  });
  it('through the hook with no user file: a whole replacement outside git stays silent and nothing is noted', () => {
    const p = proj(false);
    assert.equal(write(p, 'a,b\n').decision, 'allow');
    assert.equal(loadSession('s1', p.home).memory.wrote, undefined);
  });
});

describe('what is judged', () => {
  const where = makeWhere({ cwd: '/work/app' }, {});
  const words = (cmd: string): string[] => replacementsOf({ kind: 'exec', command: cmd, shell: 'posix', tool: 'Bash' }, parseCommand(cmd, 'posix'), where, DEFAULT_BYLAWS).map((r) => `${r.verb}:${r.word}`);
  const TABLE: [string, string[]][] = [
    ['echo hi > a.csv', ['the redirect >:a.csv']],
    ['echo hi >> a.csv', []],
    ['echo hi > a.csv 2>&1', ['the redirect >:a.csv']],
    ['cmd | tee a.csv b.csv', ['tee:a.csv', 'tee:b.csv']],
    ['cmd | tee -a a.csv', []],
    ['cmd | tee --append a.csv', []],
    ["sed -i 's/a/b/' a.csv b.csv", ['sed -i:a.csv', 'sed -i:b.csv']],
    ["sed -i '' 's/a/b/' a.csv", ['sed -i:a.csv']],
    ["sed -i .bak 's/a/b/' a.csv", []],
    ["sed -i.bak 's/a/b/' a.csv", []],
    ["sed -ie 's/a/b/' a.csv", []],
    ["sed -Ei 's/a/b/' a.csv", ['sed -i:a.csv']],
    ["sed -n -i -e 's/a/b/p' -e 's/c/d/' a.csv", ['sed -i:a.csv']],
    ["sed --in-place 's/a/b/' a.csv", ['sed -i:a.csv']],
    ["sed --in-place=.orig 's/a/b/' a.csv", []],
    ["sed 's/a/b/' a.csv", []],
    ["perl -pi -e 's/a/b/' a.csv", ['perl -i:a.csv']],
    ["perl -i -pe 's/a/b/' a.csv", ['perl -i:a.csv']],
    ["perl -i.bak -pe 's/a/b/' a.csv", []],
    ["perl -pe 's/a/b/' a.csv", []],
  ];
  for (const [cmd, want] of TABLE) it(cmd, () => assert.deepEqual(words(cmd), want));
  it('the Edit tool, a patch and a write with no content are never whole replacements', () => {
    for (const [tool, input] of [
      ['Edit', { file_path: '/work/app/a.csv', old_string: 'a', new_string: 'b' }],
      ['MultiEdit', { file_path: '/work/app/a.csv', edits: [{ old_string: 'a', new_string: 'b' }] }],
    ] as const) {
      for (const a of toActions(tool, input as Record<string, unknown>)) assert.deepEqual(replacementsOf(a, null, where, DEFAULT_BYLAWS), [], tool);
    }
  });
  it('.git is found by stat alone, a .git file counts, and a .git in the home folder does not for a file inside home', () => {
    const files = new Set(['/srv/p/.git', '/home/u/.git', '/w/wt/.git']);
    const w = makeWhere({ home: '/home/u', cwd: '/', readFile: (p: string) => (files.has(p) ? { kind: 'other' } : { kind: 'missing' }) }, {});
    assert.equal(underGit('/srv/p/a/b/c.csv', w), true);
    assert.equal(underGit('/srv/q/c.csv', w), false);
    assert.equal(underGit('/w/wt/c.csv', w), true);
    assert.equal(underGit('/home/u/Documents/c.csv', w), false);
  });
});

describe('a kept copy: across processes, not forgeable without an ask, bound to the content', () => {
  it('holds across processes: hook refuses, the CLI keeps a copy, a new hook process lets the same Write through', () => {
    const p = proj();
    const input = { file_path: join(p.project, 'data.csv'), content: 'a,b\n' };
    const run = (args: string[], stdin?: string): { code: number | null; stdout: string; stderr: string } => {
      const r = spawnSync(process.execPath, [CLI, ...args], { cwd: p.project, input: stdin, encoding: 'utf8', env: { ...process.env, OPENMORALS_HOME: p.home, OPENMORALS_UNATTENDED: '' } });
      return { code: r.status, stdout: r.stdout, stderr: r.stderr };
    };
    const first = run(['hook', 'claude-code'], pre(p, 'Write', input).payload);
    assert.match(first.stdout, /"permissionDecision":"deny"/);
    assert.match(first.stdout, /openmorals trash --copy data\.csv/);
    const kept = run(['trash', '--copy', 'data.csv']);
    assert.equal(kept.code, 0, kept.stderr);
    assert.match(kept.stdout, /^kept a copy of data\.csv \(31 B\) as \S+; the file is unchanged/);
    assert.equal(readFileSync(join(p.project, 'data.csv'), 'utf8'), CSV, 'the file stays');
    const second = run(['hook', 'claude-code'], pre(p, 'Write', input).payload);
    assert.equal(second.code, 0);
    assert.doesNotMatch(second.stdout, /deny|"ask"/, second.stdout);
  });
  it('is not forgeable by writing where the agent may write without an ask', () => {
    const p = proj();
    // The places a copy is recorded are the guard's own records: writing there asks.
    const log = join(p.project, '.openmorals', 'undo.jsonl');
    const forged = `{"v":1,"op":"trash","id":"20260101T000000Z-aa11bb22","time":"2026-01-01T00:00:00.000Z","path":"data.csv","trashPath":".openmorals/trash/20260101T000000Z-aa11bb22/data.csv","kind":"file","size":31,"sizeComplete":true,"copy":true,"sha256":"${sha(CSV)}"}\n`;
    for (const [tool, input] of [
      ['Write', { file_path: log, content: forged }],
      ['Write', { file_path: join(p.project, '.openmorals', 'trash', '20260101T000000Z-aa11bb22', 'data.csv'), content: CSV }],
      ['Write', { file_path: join(p.home, 'sessions', 's1.json'), content: '{}' }],
      ['Bash', { command: `printf '%s' '${forged.trim()}' >> .openmorals/undo.jsonl` }],
      ['Bash', { command: 'cp data.csv .openmorals/trash/x/data.csv' }],
    ] as const) {
      const v = runClaudeCodeHook(pre(p, tool, input as Record<string, unknown>).payload, { env: p.env }).verdict;
      assert.notEqual(v.decision, 'allow', `${tool} ${JSON.stringify(input).slice(0, 80)}`);
    }
    // A copy or a log the agent may write freely, outside openmorals' folders, licenses nothing.
    writeFileSync(join(p.project, 'data.csv.bak'), CSV);
    mkdirSync(join(p.project, 'notes'), { recursive: true });
    writeFileSync(join(p.project, 'notes', 'undo.jsonl'), forged);
    assert.equal(write(p, 'a,b\n').rule, 'replace.keep');
    // A log line with no copy in its slot licenses nothing either (written here by the test, as only the person could).
    mkdirSync(join(p.project, '.openmorals'), { recursive: true });
    writeFileSync(log, forged);
    assert.equal(write(p, 'a,b\n').rule, 'replace.keep');
    // Nor does a session note naming the hash, written into a session file the agent was refused above.
    const v = decide(toActions('Write', { file_path: join(p.project, 'data.csv'), content: 'x' })[0] as Action, keepBylaws(), EMPTY_STATE, BUILTIN_GUARDS, { cwd: p.project, wrote: [{ p: join(p.project, 'other.csv'), h: sha(CSV) }] });
    assert.equal(v.rule, 'replace.keep', 'a note for another path does not count');
  });
  it('is bound to the content: a copy of an older version does not license replacing a newer one', () => {
    const p = proj();
    assert.equal(write(p, 'a,b\n').rule, 'replace.keep');
    assert.ok(keepCopy('data.csv', { root: p.project, cwd: p.project }).ok);
    writeFileSync(join(p.project, 'data.csv'), CSV.replace('1200', '1250'));
    const v = write(p, 'a,b\n');
    assert.equal(v.rule, 'replace.keep', 'changed by hand since the copy');
    assert.ok(keepCopy('data.csv', { root: p.project, cwd: p.project }).ok);
    assert.equal(write(p, 'a,b\n').decision, 'allow');
    assert.equal(readFileSync(join(p.project, 'data.csv'), 'utf8'), 'a,b\n');
  });
});

describe("the session's own output", () => {
  it('a Write that ran is noted, so rewriting it passes; a change by hand is refused again', () => {
    const p = proj();
    assert.equal(write(p, 'a,b\n').rule, 'replace.keep');
    assert.ok(keepCopy('data.csv', { root: p.project, cwd: p.project }).ok);
    assert.equal(write(p, 'a,b\n').decision, 'allow');
    const wrote = loadSession('s1', p.home).memory.wrote ?? [];
    assert.deepEqual(wrote, [{ p: join(p.project, 'data.csv'), h: sha('a,b\n') }]);
    assert.equal(write(p, 'a,b,c\n').decision, 'allow', 'its own output, no second copy');
    assert.equal(write(p, 'a,b,c,d\n').decision, 'allow');
    writeFileSync(join(p.project, 'data.csv'), 'typed by the person\n');
    assert.equal(write(p, 'x\n').rule, 'replace.keep', 'the person changed it');
    assert.equal(write(p, 'x\n', 'data.csv', 's2').rule, 'replace.keep', 'another session never saw the note… and the file is the person\'s now anyway');
  });
  it('a new file the session made by redirect is noted; a later rewrite passes', () => {
    const p = proj();
    const cmd = 'python3 gen.py > out.json';
    const first = call(p, 'Bash', { command: cmd }, () => writeFileSync(join(p.project, 'out.json'), '{"a":1}'));
    assert.equal(first.decision, 'allow', 'a new file');
    const again = call(p, 'Bash', { command: cmd }, () => writeFileSync(join(p.project, 'out.json'), '{"a":2}'));
    assert.equal(again.decision, 'allow');
  });
  it('an Edit, sed -i, a failed call, a call never judged, and an ambiguous folder are never noted', () => {
    const p = proj();
    assert.ok(keepCopy('data.csv', { root: p.project, cwd: p.project }).ok);
    const sedCmd = "sed -i 's/rent/Rent/' data.csv";
    assert.equal(call(p, 'Bash', { command: sedCmd }, () => writeFileSync(join(p.project, 'data.csv'), CSV.replace('rent', 'Rent'))).decision, 'allow');
    assert.equal(loadSession('s1', p.home).memory.wrote, undefined, 'sed -i keeps the person\'s content');
    assert.equal(write(p, 'x\n').rule, 'replace.keep');
    const path = join(p.project, 'data.csv');
    const edit = { file_path: path, old_string: 'food', new_string: 'Food' };
    assert.equal(call(p, 'Edit', edit, () => writeFileSync(path, readFileSync(path, 'utf8').replace('food', 'Food'))).decision, 'allow');
    assert.equal(loadSession('s1', p.home).memory.wrote, undefined, 'an edit is never noted');
    const failed = JSON.stringify({ session_id: 's1', cwd: p.project, hook_event_name: 'PostToolUseFailure', tool_name: 'Write', tool_input: { file_path: path, content: 'x' }, tool_use_id: 'toolu_f', error: 'boom' });
    runClaudeCodeHook(failed, { env: p.env });
    runClaudeCodeHook(post(p, 'Write', { file_path: path, content: 'x' }, 'toolu_never_judged'), { env: p.env });
    assert.equal(loadSession('s1', p.home).memory.wrote, undefined, 'failed, or never judged');
    mkdirSync(join(p.project, 'sub'), { recursive: true });
    const amb = '(cd sub && echo x > data.csv); echo y > other.csv';
    const { payload, id } = pre(p, 'Bash', { command: amb });
    runClaudeCodeHook(payload, { env: p.env });
    runClaudeCodeHook(post(p, 'Bash', { command: amb }, id), { env: p.env });
    assert.ok(!(loadSession('s1', p.home).memory.wrote ?? []).some((w) => w.p === path), 'data.csv may be in either folder: neither is noted');
  });
  it('with the setting off, the post-tool event notes nothing', () => {
    const p = proj(false);
    const r = handlePostTool({ source: 'claude-code', session: 's1', cwd: p.project, tool: 'Write', actions: toActions('Write', { file_path: join(p.project, 'data.csv'), content: 'x' }), outcome: { ok: true }, id: null, content: null });
    assert.ok(r);
    assert.equal(loadSession('s1', p.home).memory.wrote, undefined);
  });
  it('the saved note is read back only in its exact shape, at most 64 paths', () => {
    const m = parseMemory({ history: [], wrote: [{ p: '/a', h: sha('x') }, { p: '/b', h: 'nothex' }, { p: 3, h: sha('y') }, ...Array.from({ length: 70 }, (_, i) => ({ p: `/f${i}`, h: sha(String(i)) }))] });
    assert.equal(m.wrote?.length, 64);
    assert.ok(!m.wrote?.some((w) => w.p === '/b'));
  });
});

describe('openmorals trash --copy, restore, purge, list and the notice', () => {
  it('keeps a copy and leaves the file; restore waits until the file is out of the way; purge deletes the copy', () => {
    const p = proj();
    const k = keepCopy('data.csv', { root: p.project, cwd: p.project });
    assert.ok(k.ok);
    assert.equal(readFileSync(join(p.project, 'data.csv'), 'utf8'), CSV);
    assert.equal(readFileSync(join(p.project, k.value.trashPath), 'utf8'), CSV);
    const logged = readFileSync(join(p.project, '.openmorals', 'undo.jsonl'), 'utf8');
    assert.match(logged, new RegExp(`"copy":true,"sha256":"${sha(CSV)}"`));
    const l = list({ root: p.project });
    assert.ok(l.ok && l.value.items[0]?.copy === true);
    writeFileSync(join(p.project, 'data.csv'), 'replaced\n');
    const blocked = restore(k.value.id, { root: p.project });
    assert.ok(!blocked.ok);
    assert.equal(blocked.code, 'occupied');
    assert.match(blocked.message, /is still there \(this item is a kept copy\); put it aside first with openmorals trash data\.csv/);
    const t = trash('data.csv', { root: p.project, cwd: p.project });
    assert.ok(t.ok);
    assert.ok(restore(k.value.id, { root: p.project }).ok);
    assert.equal(readFileSync(join(p.project, 'data.csv'), 'utf8'), CSV, 'the kept version is back');
    const k2 = keepCopy('data.csv', { root: p.project, cwd: p.project });
    assert.ok(k2.ok);
    const g = purge({ root: p.project, olderThanDays: 0, confirm: true, ids: [k2.value.id] });
    assert.ok(g.ok && g.value.purged.length === 1);
    assert.ok(!existsSync(join(p.project, k2.value.trashPath)));
    assert.ok(existsSync(join(p.project, 'data.csv')));
  });
  it('a log line that says copy is read only with a file kind and a 64-hex sha256', () => {
    const line = (extra: string): string => `{"v":1,"op":"trash","id":"20260101T000000Z-aa11bb22","time":"2026-01-01T00:00:00.000Z","path":"data.csv","trashPath":".openmorals/trash/20260101T000000Z-aa11bb22/data.csv","kind":"file","size":31${extra}}`;
    assert.equal(parseEntry(line(`,"copy":true,"sha256":"${sha(CSV)}"`))?.copy, true);
    assert.equal(parseEntry(line(',"copy":true')), null, 'no sha256');
    assert.equal(parseEntry(line(',"copy":true,"sha256":"abc"')), null, 'not a sha256');
    assert.equal(parseEntry(line(`,"copy":true,"sha256":"${sha(CSV)}"`).replace('"kind":"file"', '"kind":"dir"')), null, 'a folder copy');
    assert.equal(parseEntry(line(''))?.copy, undefined, 'a plain trash entry');
  });
  it('refuses a folder, a missing file and a file outside the project; keeps a link as the file it points to', () => {
    const p = proj();
    mkdirSync(join(p.project, 'dir'));
    for (const t of ['dir', 'missing.csv', join(p.root, 'home', 'openmorals.yaml')]) assert.ok(!keepCopy(t, { root: p.project, cwd: p.project }).ok, t);
    symlinkSync(join(p.project, 'data.csv'), join(p.project, 'link.csv'));
    const k = keepCopy('link.csv', { root: p.project, cwd: p.project });
    assert.ok(k.ok);
    assert.equal(k.value.path, 'data.csv');
    assert.equal(write(p, 'x\n', 'link.csv').decision, 'allow', 'the copy of the file the link points to counts');
  });
  it('the notice counts kept copies apart, and keeps its 0.22.0 words when there are none', () => {
    const p = proj();
    writeFileSync(join(p.project, 'b.js'), 'x');
    const start = trashNotice(p.project, undefined, new Date(Date.now() - 1000));
    assert.ok(keepCopy('data.csv', { root: p.project, cwd: p.project }).ok);
    const one = trashNotice(p.project, start.note);
    assert.equal(one.line, "openmorals: 1 copy of file kept in this project's trash since this session began (data.csv); nothing is deleted until you purge (openmorals trash --list).");
    assert.ok(trash('b.js', { root: p.project, cwd: p.project }).ok);
    const two = trashNotice(p.project, one.note);
    assert.match(two.line ?? '', /^openmorals: 1 item moved to and 1 copy kept in this project's trash since this session began \((b\.js, data\.csv|data\.csv, b\.js)\);/, 'two in one millisecond come in either order');
  });
  it('the CLI: --copy runs for an agent with no ask; purge still asks', () => {
    const p = proj();
    const v = runClaudeCodeHook(pre(p, 'Bash', { command: 'openmorals trash --copy data.csv' }).payload, { env: p.env }).verdict;
    assert.equal(v.decision, 'allow');
    const g = runClaudeCodeHook(pre(p, 'Bash', { command: 'openmorals purge --older-than 0 --yes' }).payload, { env: p.env }).verdict;
    assert.equal(g.rule, 'self-protect.write');
  });
});

describe('asks: files the trash cannot take', () => {
  it('outside the project: asked, and held for the person when nobody can answer', () => {
    const p = proj();
    const outside = join(p.root, 'outside.csv');
    writeFileSync(outside, CSV);
    const attended = runClaudeCodeHook(pre(p, 'Bash', { command: `echo x > ${outside}` }).payload, { env: p.env }).verdict;
    assert.equal(attended.decision, 'ask');
    assert.equal(attended.rule, 'replace.ask');
    assert.ok(isDeferrableRule('replace.ask'));
    assert.ok(!isDeferrableRule('replace.keep'));
    const held = runClaudeCodeHook(pre(p, 'Bash', { command: `echo x > ${outside}` }, 's-u').payload, { env: { ...p.env, OPENMORALS_UNATTENDED: '1' } }).verdict;
    assert.equal(held.decision, 'deny');
    assert.match(held.reason, /queued as D-[0-9A-Z]{4}/);
  });
  it('a file over the hash limit is asked about without reading it', () => {
    const where = makeWhere({ cwd: '/work/app', readFile: (p: string) => (p === '/work/app/big.mov' ? { kind: 'file', bytes: REPLACE_HASH_MAX_BYTES + 1 } : { kind: 'missing' }), hash: () => ({ kind: 'large', bytes: REPLACE_HASH_MAX_BYTES + 1 }) }, {});
    const action = toActions('Write', { file_path: '/work/app/big.mov', content: 'x' })[0] as Action;
    const f = replaceGuard.evaluate({ action, parsed: null, bylaws: keepBylaws(), state: EMPTY_STATE, where });
    assert.equal(f[0]?.rule, 'replace.ask');
    assert.match(f[0]?.reason ?? '', /over 64 MiB/);
  });
});

describe('an invalid user file', () => {
  it('fails closed on the defaults: the guard is off there, and every call asks bylaws.invalid', () => {
    const p = proj(false, 'version: 1\nguards:\n  replace:\n    steer: always\n');
    const load: BylawsLoad = resolveBylaws(p.project, p.env);
    assert.ok(!load.ok);
    const v = write(p, 'x\n');
    assert.equal(v.decision, 'ask');
    assert.equal(v.rule, 'bylaws.invalid');
    assert.ok(validateBylaws({ version: 1, guards: { replace: { steer: 'keep' } } }).ok);
  });
});
