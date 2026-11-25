import type { SimpleCommand } from '../shell.js';
import { gitSub } from './destructive.js';

/** Commands that move or rename the files they name. */
export const MOVES: ReadonlySet<string> = new Set(['mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item', 'rni']);
/** Commands that copy files. */
export const COPIES: ReadonlySet<string> = new Set(['cp', 'copy', 'copy-item', 'cpi', 'install', 'ditto']);
/** The null devices: a copy from one empties its target, a move to one is not a file. */
export const NULL_DEVICES: ReadonlySet<string> = new Set(['/dev/null', 'nul', '$null']);
const DEST_FLAGS = new Set(['-t', '--target-directory', '-destination', '-dest']);
/** Moves that can put a file in another folder (a rename only changes the name, in place). */
const RELOCATORS = new Set(['mv', 'move', 'move-item', 'mi']);

export function isOptionWord(w: string, shell: SimpleCommand['shell']): boolean {
  if (w.startsWith('-') && w !== '-') return true;
  return shell === 'cmd' && /^\/[A-Za-z0-9?]{1,4}(:.*)?$/.test(w);
}

/** The destination and the sources of a move or copy: `-t`/`--target-directory`/`-Destination` when given, else the last word. */
export function moveParts(args: readonly string[], shell: SimpleCommand['shell']): { dest: string | null; sources: string[] } {
  let dest: string | null = null;
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i] ?? '';
    const lower = w.toLowerCase();
    const eq = lower.indexOf('=');
    if (eq > 0 && DEST_FLAGS.has(lower.slice(0, eq))) {
      dest = w.slice(eq + 1);
      continue;
    }
    if (DEST_FLAGS.has(lower) && i + 1 < args.length) {
      dest = args[i + 1] ?? null;
      i++;
      continue;
    }
    if (!isOptionWord(w, shell)) pos.push(w);
  }
  if (dest === null && pos.length >= 2) dest = pos.pop() ?? null;
  return { dest, sources: pos };
}

/** A move or copy as the delete guard judges it (0.22.0). */
export interface MoveShape {
  /** The command as a reason names it: `mv`, `cp`, `git mv`, `Move-Item` (lower case), ... */
  verb: string;
  dest: string;
  sources: string[];
  /** It can move its sources into another folder (a temp folder among them): mv, move, Move-Item. */
  relocates: boolean;
  /** It replaces an existing file at the destination: false for `-n`/`--no-clobber`, a kept backup, Move-Item without `-Force`, a rename, `git mv` without `-f`. */
  overwrites: boolean;
  git: boolean;
}

/**
 * Whether mv/cp would replace an existing destination: the last of `-f`, `-i`, `-n` decides (`-n`, `--no-clobber` and
 * `--update=none` do not replace); a backup (`-b`, `--backup`, `-S`) keeps the old file, so nothing is lost.
 */
function posixReplaces(args: readonly string[]): boolean {
  let last = 'f';
  for (const a of args) {
    if (a === '--') break;
    if (a === '--no-clobber' || a === '--update=none' || a === '--update=none-fail') last = 'n';
    else if (a === '--force' || a === '--interactive' || a === '--remove-destination') last = 'f';
    else if (a === '-b' || a.startsWith('--backup') || a === '-S' || a.startsWith('--suffix')) return false;
    else if (/^-[A-Za-z]+$/.test(a)) {
      for (const ch of a.slice(1)) {
        if (ch === 'f' || ch === 'i' || ch === 'n') last = ch;
        else if (ch === 'b') return false;
        else if (ch === 'S' || ch === 't') break;
      }
    }
  }
  return last !== 'n';
}

/** The move or copy a command makes, or null when it is neither (or names no destination). */
export function moveShape(c: SimpleCommand): MoveShape | null {
  if (c.name === 'git') {
    const g = gitSub(c.args);
    if (g === null || g.sub !== 'mv') return null;
    if (g.rest.some((a) => a === '-n' || a === '--dry-run' || /^-[a-z]*n[a-z]*$/.test(a))) return null;
    const { dest, sources } = moveParts(g.rest, c.shell);
    if (dest === null || sources.length === 0) return null;
    const force = g.rest.some((a) => a === '--force' || /^-[a-z]*f[a-z]*$/.test(a));
    return { verb: 'git mv', dest, sources, relocates: false, overwrites: force, git: true };
  }
  if (!MOVES.has(c.name) && !COPIES.has(c.name)) return null;
  const { dest, sources } = moveParts(c.args, c.shell);
  if (dest === null || sources.length === 0) return null;
  let overwrites: boolean;
  if (c.name === 'mv' || c.name === 'cp') overwrites = posixReplaces(c.args);
  else if (c.name === 'move-item' || c.name === 'mi') overwrites = c.args.some((a) => a.toLowerCase() === '-force');
  else overwrites = !(c.name === 'ren' || c.name === 'rename' || c.name === 'rename-item' || c.name === 'rni');
  return { verb: c.name, dest, sources, relocates: RELOCATORS.has(c.name), overwrites, git: false };
}
