import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  LOG_FILE_NAME,
  STATE_DIR_NAME,
  list,
  planPurge,
  planRestore,
  planTrash,
  purge,
  replayLog,
  restore,
  trash,
  type LoggedItem,
  type UndoEntry,
} from '../../src/undo/index.js';
import { TRASH_CASES, factsFor } from './undo.cases.js';

const TMP_PREFIX = 'omx-undo-';
const created: string[] = [];

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
  created.push(dir);
  return dir;
}

after(() => {
  const tmpReal = fs.realpathSync(os.tmpdir());
  for (const dir of created) {
    const real = fs.realpathSync(dir);
    if (path.dirname(real) === tmpReal && path.basename(real).startsWith(TMP_PREFIX)) {
      fs.rmSync(real, { recursive: true, force: true });
    }
  }
});

function write(p: string, text: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

function fixedClock(iso: string): () => Date {
  return () => new Date(iso);
}

describe('undo: planTrash case table', () => {
  for (const c of TRASH_CASES) {
    it(`${c.flavor}: ${c.name} -> ${c.expect}`, () => {
      const r = planTrash(factsFor(c), c.flavor);
      assert.equal(r.ok ? 'ok' : r.code, c.expect, r.ok ? '' : r.message);
    });
  }
  it('has at least 30 cases', () => {
    assert.ok(TRASH_CASES.length >= 30);
  });
  it('stores paths relative to the root with forward slashes', () => {
    const r = planTrash(factsFor({ name: '', flavor: 'win32', facts: { target: 'C:\\work\\proj\\a\\b.txt', targetParentReal: 'C:\\work\\proj\\a' }, expect: 'ok' }), 'win32');
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.value.entry.path, 'a/b.txt');
    assert.equal(r.value.entry.trashPath, `.openmorals/trash/${r.value.entry.id}/b.txt`);
  });
});

const ID = '20261120T000000Z-aaaa0000';

function item(entry: Partial<UndoEntry>, state: LoggedItem['state'] = 'trashed'): LoggedItem {
  const e: UndoEntry = { v: 1, op: 'trash', id: ID, time: '2026-11-20T00:00:00.000Z', path: 'a.txt', trashPath: `.openmorals/trash/${ID}/a.txt`, kind: 'file', size: 1, ...entry };
  return { entry: e, state, changedAt: e.time };
}

const restoreBase = {
  rootReal: '/work/proj',
  homeReal: '/home/dev',
  id: ID,
  originalExists: false,
  trashItemExists: true,
  nearestExistingAncestorReal: '/work/proj',
  time: '2026-11-21T00:00:00.000Z',
};

describe('undo: planRestore case table', () => {
  const cases: { name: string; item: LoggedItem | undefined; over?: Partial<typeof restoreBase>; expect: string }[] = [
    { name: 'plain restore', item: item({}), expect: 'ok' },
    { name: 'unknown id', item: undefined, expect: 'not-found' },
    { name: 'already restored', item: item({}, 'restored'), expect: 'not-trashed' },
    { name: 'already purged', item: item({}, 'purged'), expect: 'not-trashed' },
    { name: 'log points outside the root', item: item({ path: '../../etc/passwd' }), expect: 'log-tampered' },
    { name: 'log holds an absolute path', item: item({ path: '/etc/passwd' }), expect: 'log-tampered' },
    { name: 'log points into the undo log', item: item({ path: `${STATE_DIR_NAME}/${LOG_FILE_NAME}` }), expect: 'log-tampered' },
    { name: 'trash path outside its own slot', item: item({ trashPath: '.openmorals/trash/other/a.txt' }), expect: 'log-tampered' },
    { name: 'trash path outside the trash', item: item({ trashPath: 'src/a.txt' }), expect: 'log-tampered' },
    { name: 'item missing from the trash', item: item({}), over: { trashItemExists: false }, expect: 'missing-from-trash' },
    { name: 'original location occupied', item: item({}), over: { originalExists: true }, expect: 'occupied' },
    { name: 'original folder now a symlink out of the root', item: item({ path: 'd/a.txt' }), over: { nearestExistingAncestorReal: '/etc' }, expect: 'outside-root' },
    { name: 'malformed id', item: item({}), over: { id: '../x' }, expect: 'invalid-id' },
  ];
  for (const c of cases) {
    it(`${c.name} -> ${c.expect}`, () => {
      const r = planRestore({ ...restoreBase, ...c.over, item: c.item }, 'posix');
      assert.equal(r.ok ? 'ok' : r.code, c.expect, r.ok ? '' : r.message);
    });
  }
});

describe('undo: planPurge and replayLog', () => {
  const log = [
    JSON.stringify({ v: 1, op: 'trash', id: 'old-1', time: '2026-11-01T00:00:00.000Z', path: 'a', trashPath: '.openmorals/trash/old-1/a', kind: 'file', size: 1 }),
    JSON.stringify({ v: 1, op: 'trash', id: 'new-1', time: '2026-11-22T00:00:00.000Z', path: 'b', trashPath: '.openmorals/trash/new-1/b', kind: 'file', size: 1 }),
    JSON.stringify({ v: 1, op: 'trash', id: 'old-2', time: '2026-11-01T00:00:00.000Z', path: 'c', trashPath: '.openmorals/trash/old-2/c', kind: 'file', size: 1 }),
    JSON.stringify({ v: 1, op: 'restore', id: 'old-2', time: '2026-11-02T00:00:00.000Z' }),
    'not json',
    JSON.stringify({ v: 1, op: 'restore', id: 'never-trashed', time: '2026-11-02T00:00:00.000Z' }),
    JSON.stringify({ v: 1, op: 'trash', id: 'old-1', time: '2026-11-03T00:00:00.000Z', path: 'x', trashPath: '.openmorals/trash/old-1/x', kind: 'file', size: 1 }),
    JSON.stringify({ v: 1, op: 'trash', id: '../up', time: '2026-11-01T00:00:00.000Z', path: 'a', trashPath: 'a', kind: 'file', size: 1 }),
    '',
  ].join('\n');
  const replay = replayLog(log);
  const base = { rootReal: '/work/proj', homeReal: '/home/dev', replay, now: '2026-11-23T00:00:00.000Z' };

  it('replay keeps valid entries and reports bad lines', () => {
    assert.deepEqual([...replay.items.keys()].sort(), ['new-1', 'old-1', 'old-2']);
    assert.equal(replay.items.get('old-2')?.state, 'restored');
    assert.equal(replay.items.get('old-1')?.entry.path, 'a');
    assert.deepEqual(replay.badLines, [5, 6, 7, 8]);
  });
  const cases: { name: string; days: number; confirm: unknown; expect: string; ids?: string[] }[] = [
    { name: 'no confirm', days: 7, confirm: undefined, expect: 'confirm-required' },
    { name: 'confirm as a string', days: 7, confirm: 'yes', expect: 'confirm-required' },
    { name: 'confirm false', days: 7, confirm: false, expect: 'confirm-required' },
    { name: 'negative days', days: -1, confirm: true, expect: 'invalid-argument' },
    { name: 'NaN days', days: Number.NaN, confirm: true, expect: 'invalid-argument' },
    { name: 'older than 7 days', days: 7, confirm: true, expect: 'ok', ids: ['old-1'] },
    { name: 'older than 0 days', days: 0, confirm: true, expect: 'ok', ids: ['new-1', 'old-1'] },
    { name: 'older than 60 days', days: 60, confirm: true, expect: 'ok', ids: [] },
  ];
  for (const c of cases) {
    it(`purge ${c.name} -> ${c.expect}`, () => {
      const r = planPurge({ ...base, olderThanDays: c.days, confirm: c.confirm }, 'posix');
      assert.equal(r.ok ? 'ok' : r.code, c.expect);
      if (r.ok && c.ids !== undefined) assert.deepEqual(r.value.targets.map((t) => t.id).sort(), c.ids);
    });
  }
});

describe('undo: filesystem round trips in fresh temp folders', () => {
  it('trashes a file and restores it byte for byte', () => {
    const root = tempRoot();
    write(path.join(root, 'notes', 'a.txt'), 'hello');
    const t = trash('notes/a.txt', { root, session: 's1' });
    assert.ok(t.ok, t.ok ? '' : t.message);
    if (!t.ok) return;
    assert.equal(fs.existsSync(path.join(root, 'notes', 'a.txt')), false);
    assert.equal(fs.readFileSync(path.join(root, t.value.trashPath), 'utf8'), 'hello');
    assert.equal(t.value.path, 'notes/a.txt');
    assert.equal(t.value.size, 5);
    const logText = fs.readFileSync(path.join(root, STATE_DIR_NAME, LOG_FILE_NAME), 'utf8');
    assert.ok(!logText.includes(root) && !logText.includes(fs.realpathSync(root)), 'log holds no absolute paths');
    const l = list({ root });
    assert.ok(l.ok);
    if (!l.ok) return;
    assert.equal(l.value.items.length, 1);
    assert.equal(l.value.items[0]?.session, 's1');
    const r = restore(t.value.id, { root });
    assert.ok(r.ok, r.ok ? '' : r.message);
    assert.equal(fs.readFileSync(path.join(root, 'notes', 'a.txt'), 'utf8'), 'hello');
    const l2 = list({ root });
    assert.ok(l2.ok && l2.value.items.length === 0);
    const all = list({ root, all: true });
    assert.ok(all.ok && all.value.items[0]?.state === 'restored');
    const again = restore(t.value.id, { root });
    assert.equal(again.ok ? 'ok' : again.code, 'not-trashed');
  });

  it('trashes a folder tree and restores it, recreating a removed parent', () => {
    const root = tempRoot();
    write(path.join(root, 'out', 'build', 'x.js'), 'abc');
    write(path.join(root, 'out', 'build', 'deep', 'y.js'), 'defg');
    const t = trash(path.join(root, 'out', 'build'), { root });
    assert.ok(t.ok, t.ok ? '' : t.message);
    if (!t.ok) return;
    assert.equal(t.value.kind, 'dir');
    assert.equal(t.value.size, 7);
    fs.rmdirSync(path.join(root, 'out'));
    const r = restore(t.value.id, { root });
    assert.ok(r.ok, r.ok ? '' : r.message);
    assert.equal(fs.readFileSync(path.join(root, 'out', 'build', 'deep', 'y.js'), 'utf8'), 'defg');
  });

  it('refuses a file outside the project and leaves it alone', () => {
    const root = tempRoot();
    const other = tempRoot();
    write(path.join(other, 'keep.txt'), 'keep');
    const t = trash(path.join(other, 'keep.txt'), { root });
    assert.equal(t.ok ? 'ok' : t.code, 'outside-root');
    assert.equal(fs.readFileSync(path.join(other, 'keep.txt'), 'utf8'), 'keep');
  });

  it('refuses a path that escapes through a symlinked folder, but moves the link itself', () => {
    const root = tempRoot();
    const other = tempRoot();
    write(path.join(other, 'secret.txt'), 'outside');
    fs.symlinkSync(other, path.join(root, 'link'), 'dir');
    const t = trash('link/secret.txt', { root });
    assert.equal(t.ok ? 'ok' : t.code, 'outside-root');
    assert.equal(fs.readFileSync(path.join(other, 'secret.txt'), 'utf8'), 'outside');
    const l = trash('link', { root });
    assert.ok(l.ok, l.ok ? '' : l.message);
    assert.equal(fs.readFileSync(path.join(other, 'secret.txt'), 'utf8'), 'outside');
    if (!l.ok) return;
    assert.equal(l.value.kind, 'symlink');
    const r = restore(l.value.id, { root });
    assert.ok(r.ok);
    assert.ok(fs.lstatSync(path.join(root, 'link')).isSymbolicLink());
  });

  it('refuses the state folder, the root and missing paths', () => {
    const root = tempRoot();
    write(path.join(root, 'a.txt'), 'a');
    const t = trash('a.txt', { root });
    assert.ok(t.ok);
    for (const [target, code] of [
      [STATE_DIR_NAME, 'protected'],
      [path.join(STATE_DIR_NAME, LOG_FILE_NAME), 'protected'],
      ['.', 'is-root'],
      ['nope.txt', 'not-found'],
    ] as const) {
      const r = trash(target, { root });
      assert.equal(r.ok ? 'ok' : r.code, code, target);
    }
    assert.ok(fs.existsSync(path.join(root, STATE_DIR_NAME, LOG_FILE_NAME)));
  });

  it('refuses when the state folder is a symlink out of the project', () => {
    const root = tempRoot();
    const other = tempRoot();
    write(path.join(root, 'a.txt'), 'a');
    fs.symlinkSync(other, path.join(root, STATE_DIR_NAME), 'dir');
    const t = trash('a.txt', { root });
    assert.equal(t.ok ? 'ok' : t.code, 'trash-escapes');
    assert.ok(fs.existsSync(path.join(root, 'a.txt')));
    assert.deepEqual(fs.readdirSync(other), []);
  });

  it('never overwrites on restore', () => {
    const root = tempRoot();
    write(path.join(root, 'a.txt'), 'old');
    const t = trash('a.txt', { root });
    assert.ok(t.ok);
    if (!t.ok) return;
    write(path.join(root, 'a.txt'), 'new');
    const r = restore(t.value.id, { root });
    assert.equal(r.ok ? 'ok' : r.code, 'occupied');
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'new');
    assert.equal(fs.readFileSync(path.join(root, t.value.trashPath), 'utf8'), 'old');
  });

  it('refuses a tampered undo log that points outside the project', () => {
    const root = tempRoot();
    const other = tempRoot();
    write(path.join(other, 'victim.txt'), 'v');
    write(path.join(root, 'a.txt'), 'a');
    assert.ok(trash('a.txt', { root }).ok);
    const rel = path.relative(fs.realpathSync(root), path.join(fs.realpathSync(other), 'victim.txt')).split(path.sep).join('/');
    const forged = { v: 1, op: 'trash', id: 'forged-1', time: '2026-11-01T00:00:00.000Z', path: 'a2.txt', trashPath: rel, kind: 'file', size: 1 };
    fs.appendFileSync(path.join(root, STATE_DIR_NAME, LOG_FILE_NAME), JSON.stringify(forged) + '\n');
    const r = restore('forged-1', { root });
    assert.equal(r.ok ? 'ok' : r.code, 'log-tampered');
    assert.ok(fs.existsSync(path.join(other, 'victim.txt')));
    assert.equal(fs.existsSync(path.join(root, 'a2.txt')), false);
  });

  it('purge needs confirm, honours the age cut-off, and deletes only inside the trash', () => {
    const root = tempRoot();
    write(path.join(root, 'a.txt'), 'a');
    write(path.join(root, 'b.txt'), 'b');
    const ta = trash('a.txt', { root, clock: fixedClock('2026-11-01T00:00:00.000Z') });
    const tb = trash('b.txt', { root, clock: fixedClock('2026-11-22T00:00:00.000Z') });
    assert.ok(ta.ok && tb.ok);
    if (!ta.ok || !tb.ok) return;
    const noConfirm = purge({ root, olderThanDays: 0, confirm: false });
    assert.equal(noConfirm.ok ? 'ok' : noConfirm.code, 'confirm-required');
    assert.ok(fs.existsSync(path.join(root, ta.value.trashPath)));
    const p = purge({ root, olderThanDays: 7, confirm: true, clock: fixedClock('2026-11-23T00:00:00.000Z') });
    assert.ok(p.ok, p.ok ? '' : p.message);
    if (!p.ok) return;
    assert.deepEqual(p.value.purged, [ta.value.id]);
    assert.equal(fs.existsSync(path.join(root, ta.value.trashPath)), false);
    assert.ok(fs.existsSync(path.join(root, tb.value.trashPath)));
    const r = restore(ta.value.id, { root });
    assert.equal(r.ok ? 'ok' : r.code, 'not-trashed');
    const all = list({ root, all: true });
    assert.ok(all.ok);
    if (!all.ok) return;
    assert.deepEqual(all.value.items.map((i) => i.state), ['purged', 'trashed']);
  });
});
