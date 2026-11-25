import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import {
  checkLogFileKind,
  checkRoot,
  checkTrashDirReal,
  fail,
  newId,
  ok,
  planPurge,
  planRestore,
  planTrash,
  relationOf,
  replayLog,
  resolveItemPaths,
  type ItemKind,
  type ItemState,
  type LogReplay,
  type PathFlavor,
  type StatFact,
  type UndoEntry,
  type UndoLayout,
  type UndoResult,
} from './plan.js';

export interface UndoOptions {
  root: string;
  cwd?: string;
  session?: string;
  clock?: () => Date;
  random?: () => string;
}

export interface TrashedItem {
  id: string;
  path: string;
  trashPath: string;
  kind: ItemKind;
  size: number;
  sizeComplete: boolean;
}

export interface ListedItem {
  id: string;
  state: ItemState;
  path: string;
  trashPath: string;
  kind: ItemKind;
  size: number;
  time: string;
  changedAt: string;
  session?: string;
  /** A kept copy (0.24.0): the file was copied, not moved, so it may still be in place. */
  copy?: boolean;
}

export interface ListResult {
  items: ListedItem[];
  badLines: number[];
}

export interface PurgeResult {
  purged: string[];
  failed: { id: string; message: string }[];
}

const FLAVOR: PathFlavor = process.platform === 'win32' ? 'win32' : 'posix';
const SIZE_ENTRY_CAP = 100_000;
const STATE_GITIGNORE = '.openmorals/.gitignore';

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function errCode(e: unknown): string | undefined {
  if (typeof e === 'object' && e !== null && 'code' in e) {
    const c = (e as { code: unknown }).code;
    return typeof c === 'string' ? c : undefined;
  }
  return undefined;
}

function realOrNull(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}

function kindOf(p: string): ItemKind | null {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return 'symlink';
    if (st.isDirectory()) return 'dir';
    if (st.isFile()) return 'file';
    return 'other';
  } catch {
    return null;
  }
}

function measure(p: string): StatFact | null {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return { kind: 'symlink', size: 0, sizeComplete: true };
  if (st.isFile()) return { kind: 'file', size: st.size, sizeComplete: true };
  if (!st.isDirectory()) return { kind: 'other', size: 0, sizeComplete: true };
  let size = 0;
  let seen = 0;
  const stack: string[] = [p];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return { kind: 'dir', size, sizeComplete: false };
    }
    for (const name of names) {
      seen += 1;
      if (seen > SIZE_ENTRY_CAP) return { kind: 'dir', size, sizeComplete: false };
      const child = path.join(dir, name);
      try {
        const cs = fs.lstatSync(child);
        if (cs.isDirectory()) stack.push(child);
        else if (cs.isFile()) size += cs.size;
      } catch {
        return { kind: 'dir', size, sizeComplete: false };
      }
    }
  }
  return { kind: 'dir', size, sizeComplete: true };
}

interface RootInfo {
  rootGiven: string;
  rootReal: string;
  homeReal: string | null;
  layout: UndoLayout;
}

function rootInfo(opts: UndoOptions): UndoResult<RootInfo> {
  if (typeof opts.root !== 'string' || opts.root.length === 0) return fail('invalid-path', 'a project root is required');
  const rootGiven = path.resolve(opts.root);
  if (kindOf(rootGiven) === null) return fail('not-found', 'project root does not exist');
  const rootReal = realOrNull(rootGiven);
  if (rootReal === null || kindOf(rootReal) !== 'dir') return fail('invalid-path', 'project root is not a directory');
  const homeReal = realOrNull(os.homedir());
  const checked = checkRoot({ rootReal, homeReal }, FLAVOR);
  if (!checked.ok) return checked;
  return ok({ rootGiven, rootReal, homeReal, layout: checked.value });
}

function nowIso(opts: UndoOptions): string {
  return (opts.clock ?? (() => new Date()))().toISOString();
}

function appendEntry(logFile: string, entry: UndoEntry): UndoResult<true> {
  const kind = checkLogFileKind(kindOf(logFile));
  if (!kind.ok) return kind;
  const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0);
  let fd: number | undefined;
  try {
    fd = fs.openSync(logFile, flags, 0o600);
    fs.writeSync(fd, JSON.stringify(entry) + '\n');
    return ok(true);
  } catch (e) {
    return fail('io-error', `could not write the undo log: ${errText(e)}`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readReplay(layout: UndoLayout): UndoResult<LogReplay> {
  const kind = kindOf(layout.logFile);
  if (kind === null) return ok({ items: new Map(), badLines: [] });
  const checked = checkLogFileKind(kind);
  if (!checked.ok) return checked;
  try {
    return ok(replayLog(fs.readFileSync(layout.logFile, 'utf8')));
  } catch (e) {
    return fail('io-error', `could not read the undo log: ${errText(e)}`);
  }
}

function ensureTrashDir(layout: UndoLayout): UndoResult<true> {
  try {
    fs.mkdirSync(layout.trashDir, { recursive: true, mode: 0o700 });
  } catch (e) {
    return fail('io-error', `could not create the trash folder: ${errText(e)}`);
  }
  try {
    fs.writeFileSync(path.join(layout.stateDir, '.gitignore'), '# openmorals trash and undo log: never commit them (the trash can hold secrets)\n*\n', { flag: 'wx', mode: 0o644 });
  } catch (e) {
    if (errCode(e) !== 'EEXIST') return fail('io-error', `could not write ${STATE_GITIGNORE}: ${errText(e)}`);
  }
  const real = realOrNull(layout.trashDir);
  if (real === null) return fail('io-error', 'trash folder vanished after creation');
  return checkTrashDirReal(layout, real, FLAVOR);
}

export function trash(target: string, opts: UndoOptions): UndoResult<TrashedItem> {
  const info = rootInfo(opts);
  if (!info.ok) return info;
  const { rootGiven, rootReal, homeReal, layout } = info.value;
  if (typeof target !== 'string' || target.length === 0) return fail('invalid-path', 'a target path is required');
  const abs = path.resolve(opts.cwd ?? rootGiven, target);
  const clock = opts.clock ?? (() => new Date());
  const now = clock();
  const random = opts.random ?? (() => randomBytes(4).toString('hex'));
  const facts = {
    rootGiven,
    rootReal,
    homeReal,
    target: abs,
    targetParentReal: realOrNull(path.dirname(abs)),
    targetStat: measure(abs),
    stateDirKind: kindOf(layout.stateDir),
    trashDirKind: kindOf(layout.trashDir),
    id: newId(now, random()),
    time: now.toISOString(),
    ...(opts.session !== undefined ? { session: opts.session } : {}),
  };
  const planned = planTrash(facts, FLAVOR);
  if (!planned.ok) return planned;
  const plan = planned.value;
  const dir = ensureTrashDir(layout);
  if (!dir.ok) return dir;
  try {
    fs.mkdirSync(plan.itemDir, { mode: 0o700 });
  } catch (e) {
    return fail('io-error', `could not create the trash slot: ${errText(e)}`);
  }
  const logged = appendEntry(layout.logFile, plan.entry);
  if (!logged.ok) {
    tryRmdir(plan.itemDir);
    return logged;
  }
  try {
    fs.renameSync(plan.from, plan.to);
  } catch (e) {
    appendEntry(layout.logFile, { v: 1, op: 'abort', id: plan.entry.id, time: nowIso(opts) });
    tryRmdir(plan.itemDir);
    if (errCode(e) === 'EXDEV') {
      return fail('cross-device', 'target is on a different volume from the project trash; nothing was moved');
    }
    return fail('io-error', `could not move the target into the trash: ${errText(e)}`);
  }
  return ok({
    id: plan.entry.id,
    path: plan.entry.path ?? '',
    trashPath: plan.entry.trashPath ?? '',
    kind: plan.entry.kind ?? 'other',
    size: plan.entry.size ?? 0,
    sizeComplete: plan.entry.sizeComplete !== false,
  });
}

/** The sha256 of a file's bytes, read in 1 MiB pieces. */
function sha256Of(p: string): { sha256: string; bytes: number } {
  const fd = fs.openSync(p, 'r');
  try {
    const h = createHash('sha256');
    const buf = Buffer.alloc(1 << 20);
    let bytes = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      bytes += n;
      h.update(buf.subarray(0, n));
    }
    return { sha256: h.digest('hex'), bytes };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Keeps a copy of a file in the project trash and leaves the file in place (0.24.0, `openmorals trash --copy`): the same
 * checks as `trash`, then the file is copied into its own trash slot and logged with `copy: true` and the sha256 of the
 * copied bytes, which the replace guard compares with the file before it lets a whole replacement through. `restore`
 * puts the copy back once the file is out of the way; `purge` deletes it for good, like any trashed item.
 */
export function keepCopy(target: string, opts: UndoOptions): UndoResult<TrashedItem> {
  const info = rootInfo(opts);
  if (!info.ok) return info;
  const { rootGiven, rootReal, homeReal, layout } = info.value;
  if (typeof target !== 'string' || target.length === 0) return fail('invalid-path', 'a target path is required');
  // A link is kept as the file it points to, under that file's path, which is the path the replace guard looks up.
  const named = path.resolve(opts.cwd ?? rootGiven, target);
  const linked = kindOf(named) === 'symlink' ? realOrNull(named) : null;
  const abs = linked === null ? named : relationOf(rootReal, linked, FLAVOR, false) === 'inside' ? path.resolve(rootGiven, path.relative(rootReal, linked)) : linked;
  let stat: StatFact | null;
  try {
    const st = fs.statSync(abs);
    stat = st.isFile() ? { kind: 'file', size: st.size, sizeComplete: true } : { kind: st.isDirectory() ? 'dir' : 'other', size: 0, sizeComplete: true };
  } catch {
    stat = null;
  }
  const now = (opts.clock ?? (() => new Date()))();
  const random = opts.random ?? (() => randomBytes(4).toString('hex'));
  const planned = planTrash(
    {
      rootGiven,
      rootReal,
      homeReal,
      target: abs,
      targetParentReal: realOrNull(path.dirname(abs)),
      targetStat: stat,
      stateDirKind: kindOf(layout.stateDir),
      trashDirKind: kindOf(layout.trashDir),
      id: newId(now, random()),
      time: now.toISOString(),
      ...(opts.session !== undefined ? { session: opts.session } : {}),
      copy: { sha256: '' },
    },
    FLAVOR,
  );
  if (!planned.ok) return planned;
  const plan = planned.value;
  const dir = ensureTrashDir(layout);
  if (!dir.ok) return dir;
  try {
    fs.mkdirSync(plan.itemDir, { mode: 0o700 });
  } catch (e) {
    return fail('io-error', `could not create the trash slot: ${errText(e)}`);
  }
  let kept: { sha256: string; bytes: number };
  try {
    fs.copyFileSync(plan.from, plan.to, fs.constants.COPYFILE_EXCL);
    kept = sha256Of(plan.to);
  } catch (e) {
    tryUnlink(plan.to);
    tryRmdir(plan.itemDir);
    return fail('io-error', `could not copy the file into the trash: ${errText(e)}`);
  }
  const entry: UndoEntry = { ...plan.entry, size: kept.bytes, sha256: kept.sha256 };
  const logged = appendEntry(layout.logFile, entry);
  if (!logged.ok) {
    tryUnlink(plan.to);
    tryRmdir(plan.itemDir);
    return logged;
  }
  return ok({ id: entry.id, path: entry.path ?? '', trashPath: entry.trashPath ?? '', kind: 'file', size: kept.bytes, sizeComplete: true });
}

function tryUnlink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch {
    return;
  }
}

function tryRmdir(dir: string): void {
  try {
    fs.rmdirSync(dir);
  } catch {
    return;
  }
}

function nearestExistingAncestorReal(p: string): string | null {
  let cur = p;
  for (;;) {
    if (kindOf(cur) !== null) return realOrNull(cur);
    const up = path.dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
}

export function restore(id: string, opts: UndoOptions): UndoResult<ListedItem> {
  const info = rootInfo(opts);
  if (!info.ok) return info;
  const { rootReal, homeReal, layout } = info.value;
  const replay = readReplay(layout);
  if (!replay.ok) return replay;
  const item = replay.value.items.get(id);
  let originalExists = false;
  let trashItemExists = false;
  let ancestor: string | null = null;
  if (item !== undefined && item.state === 'trashed') {
    const paths = resolveItemPaths(layout, item.entry, FLAVOR);
    if (!paths.ok) return paths;
    originalExists = kindOf(paths.value.original) !== null;
    const itemDirReal = realOrNull(paths.value.itemDir);
    trashItemExists =
      kindOf(paths.value.trashed) !== null &&
      itemDirReal !== null &&
      relationOf(paths.value.itemDir, itemDirReal, FLAVOR, false) === 'equal';
    ancestor = nearestExistingAncestorReal(path.dirname(paths.value.original));
  }
  const planned = planRestore(
    {
      rootReal,
      homeReal,
      item,
      id,
      originalExists,
      trashItemExists,
      nearestExistingAncestorReal: ancestor,
      time: nowIso(opts),
      ...(opts.session !== undefined ? { session: opts.session } : {}),
    },
    FLAVOR,
  );
  if (!planned.ok) return planned;
  const plan = planned.value;
  const parent = path.dirname(plan.to);
  try {
    fs.mkdirSync(parent, { recursive: true });
  } catch (e) {
    return fail('io-error', `could not recreate the original folder: ${errText(e)}`);
  }
  const parentReal = realOrNull(parent);
  if (parentReal === null || relationOf(rootReal, parentReal, FLAVOR, false) === 'outside') {
    return fail('outside-root', 'the original folder resolves outside the project root; nothing was moved');
  }
  try {
    fs.renameSync(plan.from, path.join(parentReal, path.basename(plan.to)));
  } catch (e) {
    return fail('io-error', `could not move the item back: ${errText(e)}`);
  }
  const logged = appendEntry(layout.logFile, plan.entry);
  tryRmdir(plan.itemDir);
  if (!logged.ok) return logged;
  const e = item?.entry;
  return ok({
    id,
    state: 'restored',
    path: e?.path ?? '',
    trashPath: e?.trashPath ?? '',
    kind: e?.kind ?? 'other',
    size: e?.size ?? 0,
    time: e?.time ?? '',
    changedAt: plan.entry.time,
    ...(e?.session !== undefined ? { session: e.session } : {}),
  });
}

export function list(opts: UndoOptions & { all?: boolean }): UndoResult<ListResult> {
  const info = rootInfo(opts);
  if (!info.ok) return info;
  const replay = readReplay(info.value.layout);
  if (!replay.ok) return replay;
  const items: ListedItem[] = [];
  for (const [id, it] of replay.value.items) {
    if (opts.all !== true && it.state !== 'trashed') continue;
    items.push({
      id,
      state: it.state,
      path: it.entry.path ?? '',
      trashPath: it.entry.trashPath ?? '',
      kind: it.entry.kind ?? 'other',
      size: it.entry.size ?? 0,
      time: it.entry.time,
      changedAt: it.changedAt,
      ...(it.entry.session !== undefined ? { session: it.entry.session } : {}),
      ...(it.entry.copy === true ? { copy: true } : {}),
    });
  }
  items.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.id.localeCompare(b.id)));
  return ok({ items, badLines: replay.value.badLines });
}

export interface PurgeOptions extends UndoOptions {
  olderThanDays: number;
  confirm: boolean;
  /** Only these trashed items (0.21.0); absent: every trashed item older than `olderThanDays`. */
  ids?: readonly string[];
}

/**
 * What `purge` would delete, deleting nothing (0.21.0): the trashed items older than `olderThanDays` (and among `ids`
 * when given), oldest first, so the person can be shown the list before saying yes.
 */
export function purgePreview(opts: Omit<PurgeOptions, 'confirm'>): UndoResult<ListedItem[]> {
  const info = rootInfo(opts);
  if (!info.ok) return info;
  const { rootReal, homeReal, layout } = info.value;
  const replay = readReplay(layout);
  if (!replay.ok) return replay;
  const planned = planPurge({ rootReal, homeReal, replay: replay.value, now: nowIso(opts), olderThanDays: opts.olderThanDays, confirm: true, ...(opts.ids !== undefined ? { ids: new Set(opts.ids) } : {}) }, FLAVOR);
  if (!planned.ok) return planned;
  const items: ListedItem[] = [];
  for (const t of planned.value.targets) {
    const it = replay.value.items.get(t.id);
    if (it === undefined) continue;
    items.push({ id: t.id, state: it.state, path: it.entry.path ?? '', trashPath: it.entry.trashPath ?? '', kind: it.entry.kind ?? 'other', size: it.entry.size ?? 0, time: it.entry.time, changedAt: it.changedAt, ...(it.entry.session !== undefined ? { session: it.entry.session } : {}) });
  }
  items.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.id.localeCompare(b.id)));
  return ok(items);
}

export function purge(opts: PurgeOptions): UndoResult<PurgeResult> {
  if (opts.confirm !== true) {
    return fail('confirm-required', 'purge permanently deletes files; pass confirm: true to proceed');
  }
  const info = rootInfo(opts);
  if (!info.ok) return info;
  const { rootReal, homeReal, layout } = info.value;
  const replay = readReplay(layout);
  if (!replay.ok) return replay;
  const planned = planPurge(
    { rootReal, homeReal, replay: replay.value, now: nowIso(opts), olderThanDays: opts.olderThanDays, confirm: opts.confirm, ...(opts.ids !== undefined ? { ids: new Set(opts.ids) } : {}) },
    FLAVOR,
  );
  if (!planned.ok) return planned;
  const result: PurgeResult = { purged: [], failed: [] };
  if (planned.value.targets.length === 0) return ok(result);
  const trashReal = realOrNull(layout.trashDir);
  if (trashReal === null) return ok(result);
  const trashOk = checkTrashDirReal(layout, trashReal, FLAVOR);
  if (!trashOk.ok) return trashOk;
  for (const t of planned.value.targets) {
    const real = realOrNull(t.itemDir);
    if (real === null) {
      result.failed.push({ id: t.id, message: 'trash slot is missing' });
      continue;
    }
    if (relationOf(t.itemDir, real, FLAVOR, false) !== 'equal' || kindOf(t.itemDir) !== 'dir') {
      result.failed.push({ id: t.id, message: 'trash slot is not a plain folder inside the trash; left alone' });
      continue;
    }
    try {
      fs.rmSync(t.itemDir, { recursive: true, force: false });
    } catch (e) {
      result.failed.push({ id: t.id, message: errText(e) });
      continue;
    }
    const logged = appendEntry(layout.logFile, { v: 1, op: 'purge', id: t.id, time: nowIso(opts) });
    if (!logged.ok) result.failed.push({ id: t.id, message: logged.message });
    result.purged.push(t.id);
  }
  return ok(result);
}
