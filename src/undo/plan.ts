import * as path from 'node:path';

export type PathFlavor = 'posix' | 'win32';

export type ItemKind = 'file' | 'dir' | 'symlink' | 'other';

export type UndoErrorCode =
  | 'invalid-path'
  | 'invalid-id'
  | 'invalid-argument'
  | 'not-found'
  | 'outside-root'
  | 'is-root'
  | 'root-too-broad'
  | 'protected'
  | 'trash-escapes'
  | 'not-trashed'
  | 'missing-from-trash'
  | 'occupied'
  | 'log-tampered'
  | 'confirm-required'
  | 'cross-device'
  | 'io-error';

export type UndoResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: UndoErrorCode; message: string };

export function fail<T>(code: UndoErrorCode, message: string): UndoResult<T> {
  return { ok: false, code, message };
}

export function ok<T>(value: T): UndoResult<T> {
  return { ok: true, value };
}

export type UndoOp = 'trash' | 'abort' | 'restore' | 'purge';

export interface UndoEntry {
  v: 1;
  op: UndoOp;
  id: string;
  time: string;
  path?: string;
  trashPath?: string;
  kind?: ItemKind;
  size?: number;
  sizeComplete?: boolean;
  session?: string;
}

export interface UndoLayout {
  root: string;
  stateDir: string;
  trashDir: string;
  logFile: string;
}

export const STATE_DIR_NAME = '.openmorals';
export const TRASH_DIR_NAME = 'trash';
export const LOG_FILE_NAME = 'undo.jsonl';
export const ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z-]{0,63}$/;

export function api(flavor: PathFlavor): path.PlatformPath {
  return flavor === 'win32' ? path.win32 : path.posix;
}

export function layoutFor(rootReal: string, flavor: PathFlavor): UndoLayout {
  const p = api(flavor);
  const stateDir = p.join(rootReal, STATE_DIR_NAME);
  return {
    root: rootReal,
    stateDir,
    trashDir: p.join(stateDir, TRASH_DIR_NAME),
    logFile: p.join(stateDir, LOG_FILE_NAME),
  };
}

export function relationOf(
  parent: string,
  child: string,
  flavor: PathFlavor,
  foldCase: boolean,
): 'equal' | 'inside' | 'outside' {
  const p = api(flavor);
  const a = foldCase ? parent.toLowerCase() : parent;
  const b = foldCase ? child.toLowerCase() : child;
  const rel = p.relative(p.resolve(a), p.resolve(b));
  if (rel === '') return 'equal';
  if (rel === '..' || rel.startsWith('..' + p.sep) || p.isAbsolute(rel)) return 'outside';
  return 'inside';
}

export function isStrictlyInside(parent: string, child: string, flavor: PathFlavor, foldCase: boolean): boolean {
  return relationOf(parent, child, flavor, foldCase) === 'inside';
}

export function isFilesystemRoot(p: string, flavor: PathFlavor): boolean {
  const a = api(flavor);
  const resolved = a.resolve(p);
  return a.dirname(resolved) === resolved;
}

function badPathText(p: string): boolean {
  return p.length === 0 || p.includes('\0');
}

export function toPortable(rel: string, flavor: PathFlavor): string {
  return rel.split(api(flavor).sep).join('/');
}

export function fromPortable(rel: string, flavor: PathFlavor): string {
  return rel.split('/').join(api(flavor).sep);
}

export interface RootFacts {
  rootReal: string;
  homeReal: string | null;
}

export function checkRoot(facts: RootFacts, flavor: PathFlavor): UndoResult<UndoLayout> {
  if (badPathText(facts.rootReal)) return fail('invalid-path', 'project root is empty or malformed');
  if (isFilesystemRoot(facts.rootReal, flavor)) {
    return fail('root-too-broad', 'refusing to use a filesystem root as the project root');
  }
  if (facts.homeReal !== null && relationOf(facts.rootReal, facts.homeReal, flavor, true) !== 'outside') {
    return fail('root-too-broad', 'refusing to use the home directory or one of its ancestors as the project root');
  }
  return ok(layoutFor(facts.rootReal, flavor));
}

export interface StatFact {
  kind: ItemKind;
  size: number;
  sizeComplete: boolean;
}

export interface TrashFacts {
  rootGiven: string;
  rootReal: string;
  homeReal: string | null;
  target: string;
  targetParentReal: string | null;
  targetStat: StatFact | null;
  stateDirKind: ItemKind | null;
  trashDirKind: ItemKind | null;
  id: string;
  time: string;
  session?: string;
}

export interface TrashPlan {
  layout: UndoLayout;
  from: string;
  itemDir: string;
  to: string;
  entry: UndoEntry;
}

function checkStateDirs(stateDirKind: ItemKind | null, trashDirKind: ItemKind | null): UndoResult<true> {
  if (stateDirKind !== null && stateDirKind !== 'dir') {
    return fail('trash-escapes', `${STATE_DIR_NAME} exists but is not a plain directory (a symlink here could move files outside the project)`);
  }
  if (trashDirKind !== null && trashDirKind !== 'dir') {
    return fail('trash-escapes', `${STATE_DIR_NAME}/${TRASH_DIR_NAME} exists but is not a plain directory`);
  }
  return ok(true);
}

function checkProtected(layout: UndoLayout, abs: string, flavor: PathFlavor): UndoResult<true> {
  const toState = relationOf(layout.stateDir, abs, flavor, true);
  if (toState !== 'outside') {
    return fail('protected', `refusing to trash the ${STATE_DIR_NAME} folder, its trash or its undo log`);
  }
  if (relationOf(abs, layout.stateDir, flavor, true) !== 'outside') {
    return fail('protected', 'refusing to trash a folder that contains the trash itself');
  }
  return ok(true);
}

export function planTrash(facts: TrashFacts, flavor: PathFlavor): UndoResult<TrashPlan> {
  const p = api(flavor);
  if (badPathText(facts.target)) return fail('invalid-path', 'target path is empty or malformed');
  if (!ID_PATTERN.test(facts.id)) return fail('invalid-id', 'generated id is malformed');
  const root = checkRoot({ rootReal: facts.rootReal, homeReal: facts.homeReal }, flavor);
  if (!root.ok) return root;
  const layout = root.value;
  if (!p.isAbsolute(facts.target)) return fail('invalid-path', 'target must be resolved to an absolute path before planning');
  const target = p.resolve(facts.target);
  const base = p.basename(target);
  if (base === '' || base === '.' || base === '..') return fail('invalid-path', 'target has no file name');
  if (facts.targetParentReal === null || facts.targetStat === null) {
    return fail('not-found', 'target does not exist');
  }
  const real = p.join(facts.targetParentReal, base);
  const lexical = relationOf(p.resolve(facts.rootGiven), target, flavor, false);
  const physical = relationOf(facts.rootReal, real, flavor, false);
  if (lexical === 'equal' || physical === 'equal') return fail('is-root', 'refusing to trash the project root itself');
  if (lexical !== 'inside') return fail('outside-root', 'target is outside the project root');
  if (physical !== 'inside') {
    return fail('outside-root', 'target resolves outside the project root through a symlinked folder');
  }
  const prot = checkProtected(layout, real, flavor);
  if (!prot.ok) return prot;
  const dirs = checkStateDirs(facts.stateDirKind, facts.trashDirKind);
  if (!dirs.ok) return dirs;
  const itemDir = p.join(layout.trashDir, facts.id);
  const to = p.join(itemDir, base);
  const entry: UndoEntry = {
    v: 1,
    op: 'trash',
    id: facts.id,
    time: facts.time,
    path: toPortable(p.relative(facts.rootReal, real), flavor),
    trashPath: toPortable(p.relative(facts.rootReal, to), flavor),
    kind: facts.targetStat.kind,
    size: facts.targetStat.size,
    sizeComplete: facts.targetStat.sizeComplete,
  };
  if (facts.session !== undefined) entry.session = facts.session;
  return ok({ layout, from: real, itemDir, to, entry });
}

export function checkTrashDirReal(layout: UndoLayout, trashDirReal: string, flavor: PathFlavor): UndoResult<true> {
  if (relationOf(layout.trashDir, trashDirReal, flavor, false) !== 'equal') {
    return fail('trash-escapes', 'the trash folder resolves somewhere other than inside the project');
  }
  return ok(true);
}

export type ItemState = 'trashed' | 'restored' | 'purged' | 'aborted';

export interface LoggedItem {
  entry: UndoEntry;
  state: ItemState;
  changedAt: string;
}

export interface LogReplay {
  items: Map<string, LoggedItem>;
  badLines: number[];
}

const OPS: readonly UndoOp[] = ['trash', 'abort', 'restore', 'purge'];
const KINDS: readonly ItemKind[] = ['file', 'dir', 'symlink', 'other'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseEntry(line: string): UndoEntry | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const { v, op, id, time } = raw;
  if (v !== 1 || typeof op !== 'string' || !(OPS as readonly string[]).includes(op)) return null;
  if (typeof id !== 'string' || !ID_PATTERN.test(id) || typeof time !== 'string' || Number.isNaN(Date.parse(time))) return null;
  const entry: UndoEntry = { v: 1, op: op as UndoOp, id, time };
  if (typeof raw.session === 'string') entry.session = raw.session;
  if (op === 'trash') {
    const { path: p, trashPath, kind, size } = raw;
    if (typeof p !== 'string' || typeof trashPath !== 'string' || p.length === 0 || trashPath.length === 0) return null;
    if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) return null;
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return null;
    entry.path = p;
    entry.trashPath = trashPath;
    entry.kind = kind as ItemKind;
    entry.size = size;
    entry.sizeComplete = raw.sizeComplete !== false;
  }
  return entry;
}

export function replayLog(text: string): LogReplay {
  const items = new Map<string, LoggedItem>();
  const badLines: number[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    const e = parseEntry(line);
    if (e === null) {
      badLines.push(i + 1);
      return;
    }
    const cur = items.get(e.id);
    if (e.op === 'trash') {
      if (cur !== undefined) {
        badLines.push(i + 1);
        return;
      }
      items.set(e.id, { entry: e, state: 'trashed', changedAt: e.time });
      return;
    }
    if (cur === undefined || cur.state !== 'trashed') {
      badLines.push(i + 1);
      return;
    }
    const next: ItemState = e.op === 'abort' ? 'aborted' : e.op === 'restore' ? 'restored' : 'purged';
    items.set(e.id, { entry: cur.entry, state: next, changedAt: e.time });
  });
  return { items, badLines };
}

export interface RestoreFacts {
  rootReal: string;
  homeReal: string | null;
  item: LoggedItem | undefined;
  id: string;
  originalExists: boolean;
  trashItemExists: boolean;
  nearestExistingAncestorReal: string | null;
  time: string;
  session?: string;
}

export interface RestorePlan {
  layout: UndoLayout;
  from: string;
  to: string;
  itemDir: string;
  entry: UndoEntry;
}

export interface ResolvedItemPaths {
  original: string;
  trashed: string;
  itemDir: string;
}

export function resolveItemPaths(layout: UndoLayout, entry: UndoEntry, flavor: PathFlavor): UndoResult<ResolvedItemPaths> {
  const p = api(flavor);
  if (entry.path === undefined || entry.trashPath === undefined) {
    return fail('log-tampered', 'undo log entry has no paths');
  }
  if (p.isAbsolute(entry.path) || p.isAbsolute(entry.trashPath) || entry.path.includes('\0') || entry.trashPath.includes('\0')) {
    return fail('log-tampered', 'undo log entry holds an absolute or malformed path');
  }
  const original = p.resolve(layout.root, fromPortable(entry.path, flavor));
  const trashed = p.resolve(layout.root, fromPortable(entry.trashPath, flavor));
  const itemDir = p.join(layout.trashDir, entry.id);
  if (relationOf(layout.root, original, flavor, false) !== 'inside') {
    return fail('log-tampered', 'undo log entry points outside the project root');
  }
  if (!checkProtected(layout, original, flavor).ok) {
    return fail('log-tampered', 'undo log entry points into the trash or the undo log');
  }
  if (p.dirname(trashed) !== itemDir || relationOf(itemDir, trashed, flavor, false) !== 'inside') {
    return fail('log-tampered', 'undo log entry points outside its own trash folder');
  }
  return ok({ original, trashed, itemDir });
}

export function planRestore(facts: RestoreFacts, flavor: PathFlavor): UndoResult<RestorePlan> {
  if (!ID_PATTERN.test(facts.id)) return fail('invalid-id', 'id is malformed');
  const root = checkRoot({ rootReal: facts.rootReal, homeReal: facts.homeReal }, flavor);
  if (!root.ok) return root;
  const layout = root.value;
  if (facts.item === undefined) return fail('not-found', `no trashed item with id ${facts.id}`);
  if (facts.item.state !== 'trashed') return fail('not-trashed', `item ${facts.id} is already ${facts.item.state}`);
  const paths = resolveItemPaths(layout, facts.item.entry, flavor);
  if (!paths.ok) return paths;
  if (!facts.trashItemExists) return fail('missing-from-trash', `item ${facts.id} is no longer in the trash folder`);
  if (facts.originalExists) {
    return fail('occupied', `something already exists at ${facts.item.entry.path ?? '?'}; move it away first, nothing was overwritten`);
  }
  if (facts.nearestExistingAncestorReal === null || relationOf(layout.root, facts.nearestExistingAncestorReal, flavor, false) === 'outside') {
    return fail('outside-root', 'the original location now resolves outside the project root');
  }
  const entry: UndoEntry = { v: 1, op: 'restore', id: facts.id, time: facts.time };
  if (facts.session !== undefined) entry.session = facts.session;
  return ok({ layout, from: paths.value.trashed, to: paths.value.original, itemDir: paths.value.itemDir, entry });
}

export interface PurgeFacts {
  rootReal: string;
  homeReal: string | null;
  replay: LogReplay;
  now: string;
  olderThanDays: number;
  confirm: unknown;
}

export interface PurgeTarget {
  id: string;
  itemDir: string;
}

export interface PurgePlan {
  layout: UndoLayout;
  targets: PurgeTarget[];
}

const DAY_MS = 86_400_000;

export function planPurge(facts: PurgeFacts, flavor: PathFlavor): UndoResult<PurgePlan> {
  if (facts.confirm !== true) {
    return fail('confirm-required', 'purge permanently deletes files; pass confirm: true to proceed');
  }
  if (!Number.isFinite(facts.olderThanDays) || facts.olderThanDays < 0) {
    return fail('invalid-argument', 'olderThanDays must be a finite number of days, zero or more');
  }
  const root = checkRoot({ rootReal: facts.rootReal, homeReal: facts.homeReal }, flavor);
  if (!root.ok) return root;
  const layout = root.value;
  const nowMs = Date.parse(facts.now);
  if (Number.isNaN(nowMs)) return fail('invalid-argument', 'now is not a valid time');
  const cutoff = nowMs - facts.olderThanDays * DAY_MS;
  const p = api(flavor);
  const targets: PurgeTarget[] = [];
  for (const [id, item] of facts.replay.items) {
    if (item.state !== 'trashed') continue;
    if (Date.parse(item.entry.time) > cutoff) continue;
    const itemDir = p.join(layout.trashDir, id);
    if (relationOf(layout.trashDir, itemDir, flavor, false) !== 'inside') continue;
    targets.push({ id, itemDir });
  }
  return ok({ layout, targets });
}

export function newId(now: Date, random: string): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${random}`;
}

export function checkLogFileKind(kind: ItemKind | null): UndoResult<true> {
  if (kind !== null && kind !== 'file') {
    return fail('trash-escapes', `${STATE_DIR_NAME}/${LOG_FILE_NAME} exists but is not a regular file`);
  }
  return ok(true);
}
