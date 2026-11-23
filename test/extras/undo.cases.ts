import type { PathFlavor, TrashFacts, UndoErrorCode } from '../../src/undo/index.js';

export interface TrashCase {
  name: string;
  flavor: PathFlavor;
  facts: Partial<TrashFacts>;
  expect: 'ok' | UndoErrorCode;
}

const posixBase: TrashFacts = {
  rootGiven: '/work/proj',
  rootReal: '/work/proj',
  homeReal: '/home/dev',
  target: '/work/proj/build',
  targetParentReal: '/work/proj',
  targetStat: { kind: 'dir', size: 10, sizeComplete: true },
  stateDirKind: null,
  trashDirKind: null,
  id: '20261123T120000Z-abcd1234',
  time: '2026-11-23T12:00:00.000Z',
};

const winBase: TrashFacts = {
  ...posixBase,
  rootGiven: 'C:\\work\\proj',
  rootReal: 'C:\\work\\proj',
  homeReal: 'C:\\Users\\dev',
  target: 'C:\\work\\proj\\build',
  targetParentReal: 'C:\\work\\proj',
};

export function factsFor(c: TrashCase): TrashFacts {
  return { ...(c.flavor === 'win32' ? winBase : posixBase), ...c.facts };
}

export const TRASH_CASES: TrashCase[] = [
  { name: 'folder inside the project', flavor: 'posix', facts: {}, expect: 'ok' },
  { name: 'file inside the project', flavor: 'posix', facts: { target: '/work/proj/a.txt', targetStat: { kind: 'file', size: 3, sizeComplete: true } }, expect: 'ok' },
  { name: 'nested file', flavor: 'posix', facts: { target: '/work/proj/src/x/y.ts', targetParentReal: '/work/proj/src/x' }, expect: 'ok' },
  { name: 'a symlink itself is moved, not its target', flavor: 'posix', facts: { target: '/work/proj/link', targetStat: { kind: 'symlink', size: 0, sizeComplete: true } }, expect: 'ok' },
  { name: 'macOS-style alias: given /tmp, real /private/tmp', flavor: 'posix', facts: { rootGiven: '/tmp/p', rootReal: '/private/tmp/p', target: '/tmp/p/f', targetParentReal: '/private/tmp/p', homeReal: '/Users/dev' }, expect: 'ok' },
  { name: 'the project root itself', flavor: 'posix', facts: { target: '/work/proj', targetParentReal: '/work' }, expect: 'is-root' },
  { name: 'root given with a trailing slash', flavor: 'posix', facts: { target: '/work/proj/', targetParentReal: '/work' }, expect: 'is-root' },
  { name: 'outside the project', flavor: 'posix', facts: { target: '/work/other/x', targetParentReal: '/work/other' }, expect: 'outside-root' },
  { name: 'dot-dot traversal out of the project', flavor: 'posix', facts: { target: '/work/proj/../other', targetParentReal: '/work' }, expect: 'outside-root' },
  { name: 'sibling folder sharing a name prefix', flavor: 'posix', facts: { target: '/work/proj2/x', targetParentReal: '/work/proj2' }, expect: 'outside-root' },
  { name: 'symlinked parent folder escapes the project', flavor: 'posix', facts: { target: '/work/proj/link/passwd', targetParentReal: '/etc' }, expect: 'outside-root' },
  { name: 'path outside that resolves inside is still refused', flavor: 'posix', facts: { target: '/elsewhere/link/f', targetParentReal: '/work/proj' }, expect: 'outside-root' },
  { name: 'the state folder', flavor: 'posix', facts: { target: '/work/proj/.openmorals' }, expect: 'protected' },
  { name: 'the trash folder', flavor: 'posix', facts: { target: '/work/proj/.openmorals/trash', targetParentReal: '/work/proj/.openmorals' }, expect: 'protected' },
  { name: 'an item inside the trash', flavor: 'posix', facts: { target: '/work/proj/.openmorals/trash/id/x', targetParentReal: '/work/proj/.openmorals/trash/id' }, expect: 'protected' },
  { name: 'the undo log', flavor: 'posix', facts: { target: '/work/proj/.openmorals/undo.jsonl', targetParentReal: '/work/proj/.openmorals', targetStat: { kind: 'file', size: 1, sizeComplete: true } }, expect: 'protected' },
  { name: 'case variant of the state folder', flavor: 'posix', facts: { target: '/work/proj/.OpenMorals/TRASH', targetParentReal: '/work/proj/.OpenMorals' }, expect: 'protected' },
  { name: 'target does not exist', flavor: 'posix', facts: { targetStat: null }, expect: 'not-found' },
  { name: 'parent folder does not exist', flavor: 'posix', facts: { targetParentReal: null }, expect: 'not-found' },
  { name: 'state folder is a symlink', flavor: 'posix', facts: { stateDirKind: 'symlink' }, expect: 'trash-escapes' },
  { name: 'trash folder is a regular file', flavor: 'posix', facts: { stateDirKind: 'dir', trashDirKind: 'file' }, expect: 'trash-escapes' },
  { name: 'filesystem root as project root', flavor: 'posix', facts: { rootGiven: '/', rootReal: '/', target: '/etc', targetParentReal: '/' }, expect: 'root-too-broad' },
  { name: 'home folder as project root', flavor: 'posix', facts: { rootGiven: '/home/dev', rootReal: '/home/dev', target: '/home/dev/x', targetParentReal: '/home/dev' }, expect: 'root-too-broad' },
  { name: 'ancestor of home as project root', flavor: 'posix', facts: { rootGiven: '/home', rootReal: '/home', target: '/home/x', targetParentReal: '/home' }, expect: 'root-too-broad' },
  { name: 'relative target not resolved', flavor: 'posix', facts: { target: 'build' }, expect: 'invalid-path' },
  { name: 'NUL byte in target', flavor: 'posix', facts: { target: '/work/proj/a\0b' }, expect: 'invalid-path' },
  { name: 'empty target', flavor: 'posix', facts: { target: '' }, expect: 'invalid-path' },
  { name: 'id with traversal', flavor: 'posix', facts: { id: '../evil' }, expect: 'invalid-id' },
  { name: 'Windows folder inside the project', flavor: 'win32', facts: {}, expect: 'ok' },
  { name: 'Windows mixed-case path inside the project', flavor: 'win32', facts: { target: 'c:\\WORK\\Proj\\build', targetParentReal: 'C:\\work\\proj' }, expect: 'ok' },
  { name: 'Windows drive root as project root', flavor: 'win32', facts: { rootGiven: 'C:\\', rootReal: 'C:\\', target: 'C:\\Windows', targetParentReal: 'C:\\' }, expect: 'root-too-broad' },
  { name: 'Windows other drive', flavor: 'win32', facts: { target: 'D:\\data\\x', targetParentReal: 'D:\\data' }, expect: 'outside-root' },
  { name: 'Windows UNC share', flavor: 'win32', facts: { target: '\\\\server\\share\\x', targetParentReal: '\\\\server\\share' }, expect: 'outside-root' },
  { name: 'Windows trash in another case', flavor: 'win32', facts: { target: 'C:\\work\\proj\\.OPENMORALS\\Trash\\x', targetParentReal: 'C:\\work\\proj\\.OPENMORALS\\Trash' }, expect: 'protected' },
  { name: 'Windows home as project root', flavor: 'win32', facts: { rootGiven: 'C:\\Users\\dev', rootReal: 'C:\\Users\\dev', target: 'C:\\Users\\dev\\x', targetParentReal: 'C:\\Users\\dev' }, expect: 'root-too-broad' },
];
