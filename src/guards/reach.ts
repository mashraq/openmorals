import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Where } from '../guard.js';
import type { Action, Bylaws } from '../types.js';
import { sensitiveLabel } from './secrets.js';

/**
 * What the project trash can reach (0.22.0, moved here from the delete guard so the document guard can ask the same
 * question): the project root, why a path is out of its reach, whether the delete guard steers a path to it, and which
 * folders are the system's temporary folders.
 */

const BYLAWS_NAMES = ['openmorals.yaml', 'openmorals.yml'];
const STATE_DIR = '.openmorals';

export function relationOf(parent: string, child: string): 'equal' | 'inside' | 'outside' {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === '') return 'equal';
  return rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel) ? 'outside' : 'inside';
}

/** The folder `openmorals trash` takes as the project root: the nearest one above the working folder holding openmorals.yaml, else the working folder. */
export function trashRoot(where: Where): string {
  let dir = resolve(where.cwd);
  for (let i = 0; i < 64; i++) {
    for (const name of BYLAWS_NAMES) if (where.readFile(join(dir, name), 0).kind !== 'missing') return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return resolve(where.cwd);
}

/** Why `openmorals trash` cannot take this file, or null when it can (the same tests the trash makes, from one stat each). */
export function whyNotTrash(abs: string, root: string, where: Where): string | null {
  if (dirname(root) === root || relationOf(root, where.home) !== 'outside') return 'the project folder is your home folder or above it, where openmorals trash does not work';
  if (relationOf(root, abs) !== 'inside') return 'it is outside the project folder, where openmorals trash cannot take it';
  const real = join(where.realpath(dirname(abs)), basename(abs));
  if (relationOf(where.realpath(root), real) !== 'inside') return 'it resolves outside the project folder, where openmorals trash cannot take it';
  if (relationOf(join(root, STATE_DIR), abs) !== 'outside' || relationOf(where.configDir, abs) !== 'outside') return "it is inside openmorals' own folders";
  const v = where.volume?.(abs) ?? null;
  const r = where.volume?.(root) ?? null;
  if (v !== null && r !== null && v !== r) return 'it is on another volume than the project, so openmorals trash cannot move it';
  return null;
}

/**
 * Whether the delete guard refuses a delete of this existing path with the trash command named (0.22.0): the guard is
 * on with `steer: trash`, the path is not a secret file, and the trash can take it. The document guard reads this so a
 * document the trash can take is judged once, by the delete guard.
 */
export function steersToTrash(abs: string, bylaws: Bylaws, where: Where, root: string): boolean {
  const cfg = bylaws.guards.delete ?? { decision: 'ask', steer: 'trash' };
  return cfg.decision !== 'allow' && cfg.steer === 'trash' && sensitiveLabel(abs) === null && whyNotTrash(abs, root, where) === null;
}

/**
 * The system's temporary folders (0.22.0), as absolute paths with forward slashes: macOS `/tmp`, `/var/tmp`,
 * `/var/folders` (each also under `/private`); Linux `/tmp`, `/var/tmp`, `/dev/shm`; Windows `<drive>:\Windows\Temp`
 * and any `\AppData\Local\Temp`. The system or its cleaners remove files there on a schedule or at restart.
 */
const TEMP_POSIX = /^(\/private)?\/(var\/)?tmp(\/|$)|^(\/private)?\/var\/folders(\/|$)|^\/dev\/shm(\/|$)/;
const TEMP_WINDOWS = /^[a-z]:\/windows\/temp(\/|$)|\/appdata\/local\/temp(\/|$)/;
/** A word that starts with the temp-folder variable of a shell: $TMPDIR, $TMP, $TEMP, ${...}, %TEMP%, %TMP%, $env:TEMP, $env:TMP. */
const TEMP_VAR = /^(\$\{?(tmpdir|tmp|temp)\}?|%(tmp|temp)%|\$env:(tmp|temp))([\\/]|$)/i;

/** Whether an absolute path (or a Windows path written with a drive letter) is in a system temp folder. */
export function isTempPath(p: string): boolean {
  const f = p.replace(/\\/g, '/');
  return TEMP_POSIX.test(f) || TEMP_WINDOWS.test(f.toLowerCase());
}

/**
 * Whether the destination of a move is a temp folder outside the project (0.22.0): a word naming a temp-folder
 * variable, a Windows temp path, or a path that resolves into a temp folder and outside the project root (a project that
 * itself lives in a temp folder keeps its own folders).
 */
export function isTempDestination(word: string, abs: string | null, root: string): boolean {
  const w = word.replace(/^["']|["']$/g, '');
  if (TEMP_VAR.test(w)) return true;
  if (/^[a-z]:[\\/]/i.test(w)) return TEMP_WINDOWS.test(w.replace(/\\/g, '/').toLowerCase());
  return abs !== null && isTempPath(abs) && relationOf(root, abs) === 'outside';
}

/** Words in a tool name that say it deletes a file (an MCP or plugin tool that names a path). */
const DELETE_TOOL_WORDS = new Set(['delete', 'remove', 'rm', 'unlink', 'erase']);

function toolWords(tool: string): string[] {
  return tool
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '');
}

/** Whether a write action is a file delete: a patch's delete, or a tool whose name says it deletes and that names this path. */
export function writeDeletes(a: Extract<Action, { kind: 'write' }>): boolean {
  if (a.change?.kind === 'delete') return true;
  return a.change === undefined && a.content === undefined && toolWords(a.tool).some((w) => DELETE_TOOL_WORDS.has(w));
}
