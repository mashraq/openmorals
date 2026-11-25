import { resolve } from 'node:path';
import type { Where } from '../guard.js';
import type { SimpleCommand } from '../shell.js';

/**
 * The folder a command of a call runs in (0.21.1), as far as the call's own words show: every folder it may be in
 * (`dirs`, the working folder first), and why it cannot be known when a change of folder named something openmorals
 * cannot follow (`unknown`). A `cd` may sit in a subshell or behind `||`, so the folders before it stay candidates.
 */
export interface Place {
  dirs: readonly string[];
  unknown: string | null;
}

/** Resolves a word naming a folder or file from a folder: `~` and known folder variables expanded; null when it holds a variable openmorals cannot expand. */
export type ResolveFrom = (word: string, from: string) => string | null;

const CHANGERS = new Set(['cd', 'chdir', 'set-location', 'sl', 'pushd', 'push-location']);
const PUSHERS = new Set(['pushd', 'push-location']);
const POPPERS = new Set(['popd', 'pop-location']);
const RUNTIME = /`|\$\(|%[A-Za-z_][A-Za-z0-9_]*%|\$env:/i;
const MAX_DIRS = 8;

function isOptionWord(w: string, shell: SimpleCommand['shell']): boolean {
  if (w.startsWith('-') && w !== '-') return true;
  return shell === 'cmd' && /^\/[A-Za-z]$/.test(w);
}

/** The folder a `cd`-like command names: a word, `-` (the previous folder), or null when it names none. */
function folderWord(c: SimpleCommand): string | null {
  let end = false;
  for (const a of c.args) {
    if (!end && a === '--') {
      end = true;
      continue;
    }
    if (!end && a !== '-' && isOptionWord(a, c.shell)) continue;
    return a;
  }
  return null;
}

function moved(cur: Place, word: string | null, c: SimpleCommand, where: Where, from: ResolveFrom, replace: boolean): Place {
  if (cur.unknown !== null) return cur;
  if (word === null) {
    if (c.shell === 'cmd' && c.name !== 'pushd') return cur;
    if (PUSHERS.has(c.name)) return { dirs: cur.dirs, unknown: `${c.name} with no folder swaps to one openmorals did not see` };
    word = where.home;
  }
  if (word === '-') return { dirs: cur.dirs, unknown: `${c.name} - returns to a folder openmorals did not see` };
  if (RUNTIME.test(word)) return { dirs: cur.dirs, unknown: `${c.name} goes to a folder built at run time` };
  const next: string[] = [];
  for (const d of cur.dirs) {
    const to = from(word, d);
    if (to === null) return { dirs: cur.dirs, unknown: `${c.name} goes to a folder named by a variable` };
    next.push(to);
  }
  const all = [...new Set(replace ? next : [...cur.dirs, ...next])];
  if (all.length > MAX_DIRS) return { dirs: cur.dirs, unknown: 'the call changes folder too many times to follow' };
  return { dirs: all, unknown: null };
}

/** `git -C <dir>` (repeatable): the folder that one git command runs in. */
function gitPlace(c: SimpleCommand, cur: Place, where: Where, from: ResolveFrom): Place {
  let p = cur;
  for (let i = 0; i < c.args.length; i++) {
    const a = c.args[i] ?? '';
    if (a === '-C') {
      p = moved(p, c.args[i + 1] ?? null, c, where, from, true);
      i++;
    } else if (!a.startsWith('-')) break;
  }
  return p;
}

/** The place of each command of a call, in order (see `Place`). A call with no change of folder gives the working folder for every command. */
export function commandPlaces(commands: readonly SimpleCommand[], where: Where, from: ResolveFrom): Place[] {
  let cur: Place = { dirs: [resolve(where.cwd)], unknown: null };
  const stack: Place[] = [];
  const out: Place[] = [];
  for (const c of commands) {
    out.push(c.name === 'git' ? gitPlace(c, cur, where, from) : cur);
    if (CHANGERS.has(c.name)) {
      if (PUSHERS.has(c.name)) stack.push(cur);
      cur = moved(cur, folderWord(c), c, where, from, false);
    } else if (POPPERS.has(c.name) && stack.pop() === undefined && cur.unknown === null) {
      cur = { dirs: cur.dirs, unknown: `${c.name} returns to a folder openmorals did not see` };
    }
  }
  return out;
}

/** Whether a place is just the working folder (the judgement every guard made before 0.21.1). */
export function isHere(p: Place, where: Where): boolean {
  return p.unknown === null && p.dirs.length === 1 && p.dirs[0] === resolve(where.cwd);
}
