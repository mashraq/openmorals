import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Finding, Guard, GuardContext, Where } from '../guard.js';
import { makeWhere } from '../guard.js';
import type { SimpleCommand } from '../shell.js';
import type { Action, Bylaws, DeleteBylaws } from '../types.js';
import { destructiveCommandHit, gitSub } from './destructive.js';
import { DELETERS, documentOwns, documentPath, expandedPath, pathFrom, positional } from './document.js';
import type { Place } from './folders.js';
import { commandPlaces } from './folders.js';
import { sensitiveLabel } from './secrets.js';

export function defaultDeleteBylaws(): DeleteBylaws {
  return { decision: 'ask', steer: 'trash' };
}

/** The rule ids this guard reports. */
export type DeleteRule = 'delete.trash' | 'delete.ask' | 'delete.blind';

/** The command a refusal names: the one way to the agent's goal that keeps the file recoverable. */
export const TRASH_COMMAND = 'openmorals trash';

/** The most targets of one command (or one call) the guard looks at; past it the rest are not judged one by one. */
const MAX_TARGETS = 64;

const BYLAWS_NAMES = ['openmorals.yaml', 'openmorals.yml'];
const STATE_DIR = '.openmorals';

/** Words in a tool name that say it deletes a file (an MCP or plugin tool that names a path). */
const DELETE_TOOL_WORDS = new Set(['delete', 'remove', 'rm', 'unlink', 'erase']);

/** A word whose value is only known when the shell runs it: `...`, $(...), %VAR%, $env:VAR (a $VAR openmorals cannot expand is found by `documentPath`). */
const RUNTIME = /`|\$\(|%[A-Za-z_][A-Za-z0-9_]*%|\$env:/i;

/** The system's temporary folders, where a file can be left for the system to clear. */
const TEMP = /^(\/private)?\/tmp\/|^(\/private)?\/var\/folders\/|\/appdata\/local\/temp\//;

function toolWords(tool: string): string[] {
  return tool
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '');
}

function bytesText(n: number): string {
  return `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} byte${n === 1 ? '' : 's'}`;
}

function relationOf(parent: string, child: string): 'equal' | 'inside' | 'outside' {
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
function whyNotTrash(abs: string, root: string, where: Where): string | null {
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

/** How a target is shown in a reason: from the project folder when inside it, else as given; a long one keeps its end. */
function shown(abs: string, where: Where): string {
  const rel = relative(resolve(where.cwd), abs);
  const t = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : abs;
  return `'${t.length > 80 ? `…${t.slice(t.length - 79)}` : t}'`;
}

/** A word as it can be pasted into the trash command, or null when it cannot be shown safely. */
function shellWord(w: string): string | null {
  if (/^[A-Za-z0-9_./~@%+=:,-]+$/.test(w) && !w.startsWith('-')) return w;
  if (!/["$`\\\r\n]/.test(w) && w.length <= 120) return `"${w}"`;
  return null;
}

interface Target {
  /** The word as the action names it (relative to the agent's folder, or absolute). */
  word: string;
  abs: string;
  bytes: number | null;
  error: string | null;
}

interface Judged {
  blind: string[];
  /** Relative words after a change of folder openmorals cannot follow (0.21.1), with why. */
  lost: { word: string; why: string }[];
  trash: Target[];
  ask: { t: Target; why: string }[];
}

interface JudgeCtx {
  bylaws: Bylaws;
  where: Where;
  root: string;
  place: Place;
  /** `git rm -r`: a folder is a target too (0.21.1). */
  folders: boolean;
}

/** The absolute paths a word may name: from each folder the command may run in (a `cd` earlier in the call), or the one path when it is absolute. */
function candidates(e: string, place: Place): string[] {
  return isAbsolute(e) ? [resolve(e)] : [...new Set(place.dirs.map((d) => resolve(d, e)))];
}

/** The word for the trash command, from the agent's working folder. */
function wordFor(w: string, abs: string, where: Where): string {
  if (abs === documentPath(w, where)) return w;
  const rel = relative(resolve(where.cwd), abs);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : abs;
}

function judgeTargets(words: readonly string[], ctx: JudgeCtx): Judged {
  const out: Judged = { blind: [], lost: [], trash: [], ask: [] };
  for (const w of words.slice(0, MAX_TARGETS)) {
    if (RUNTIME.test(w)) {
      out.blind.push(w);
      continue;
    }
    const e = expandedPath(w, ctx.where);
    if (e === null) {
      if (w.includes('$')) out.blind.push(w);
      continue;
    }
    if (!isAbsolute(e) && ctx.place.unknown !== null) {
      out.lost.push({ word: w, why: ctx.place.unknown });
      continue;
    }
    for (const abs of candidates(e, ctx.place)) judgeOne(w, abs, ctx, out);
  }
  return out;
}

function judgeOne(w: string, abs: string, ctx: JudgeCtx, out: Judged): void {
  {
    if (documentOwns(abs, ctx.bylaws, ctx.where)) return;
    const p = ctx.where.readFile(abs, 0);
    const word = wordFor(w, abs, ctx.where);
    if (p.kind === 'missing' || (p.kind === 'other' && !ctx.folders)) return;
    if (p.kind === 'error') {
      out.ask.push({ t: { word, abs, bytes: null, error: p.error }, why: `openmorals cannot read it (${p.error})` });
      return;
    }
    const t: Target = { word, abs, bytes: p.kind === 'file' ? p.bytes : null, error: null };
    const secret = sensitiveLabel(abs);
    if (secret !== null) {
      out.ask.push({ t, why: `it is ${secret}: the trash would keep the secret on disk` });
      return;
    }
    const why = whyNotTrash(abs, ctx.root, ctx.where);
    if (why !== null) out.ask.push({ t, why });
    else out.trash.push(t);
  }
}

function trashCommand(targets: readonly Target[], git: boolean, folders: boolean): string {
  const words = targets.length <= 3 ? targets.map((t) => shellWord(t.word)) : [null];
  const list = words.every((x): x is string => x !== null) ? words.join(' ') : '<path>';
  return git ? `${TRASH_COMMAND} ${list} && git rm${folders ? ' -r' : ''} -q --cached ${list}` : `${TRASH_COMMAND} ${list}`;
}

function sizeOf(targets: readonly Target[]): string {
  if (targets.some((t) => t.bytes === null)) return 'a folder';
  const total = targets.reduce((n, t) => n + (t.bytes ?? 0), 0);
  return bytesText(total);
}

function findings(j: Judged, verb: string, cfg: DeleteBylaws, where: Where, git: boolean, folders = false): Finding[] {
  const out: Finding[] = [];
  const first = j.blind[0];
  if (first !== undefined) {
    const w = first.length <= 60 && !/[\s"'\r\n]/.test(first) ? first : '<the same path>';
    out.push({ decision: 'deny', rule: 'delete.blind', reason: `${verb} names a path built at run time, so openmorals cannot see what it deletes: not run. Write the path out, or use \`${TRASH_COMMAND} ${w}\`` });
  }
  const lost = j.lost[0];
  if (lost !== undefined) {
    out.push({ decision: 'deny', rule: 'delete.blind', reason: `${verb} deletes '${lost.word.length > 60 ? `${lost.word.slice(0, 59)}…` : lost.word}' after ${lost.why}, so openmorals cannot see which file it is: not run. Name it from the project folder, or use \`${TRASH_COMMAND} <path>\`` });
  }
  const t0 = j.trash[0];
  if (t0 !== undefined) {
    const what = j.trash.length === 1 ? `${shown(t0.abs, where)} (${sizeOf(j.trash)})` : `${shown(t0.abs, where)} and ${j.trash.length - 1} more (${sizeOf(j.trash)})`;
    const cmd = trashCommand(j.trash, git, folders);
    if (cfg.steer === 'trash') {
      out.push({ decision: 'deny', rule: 'delete.trash', reason: `${verb} would delete ${what}: not run. Use \`${cmd}\` instead (the ${j.trash.some((t) => t.bytes === null) ? 'folder' : 'file'} is moved aside; the person can restore it, and only they can purge it). Carry on.` });
    } else {
      out.push({ decision: cfg.decision, rule: 'delete.ask', reason: `${verb} deletes ${what}; \`${cmd}\` would keep it recoverable` });
    }
  }
  const a0 = j.ask[0];
  if (a0 !== undefined) {
    const size = a0.t.bytes !== null ? ` (${bytesText(a0.t.bytes)})` : '';
    const more = j.ask.length > 1 ? ` and ${j.ask.length - 1} more` : '';
    const temp = TEMP.test(a0.t.abs.replace(/\\/g, '/').toLowerCase()) ? '; a temp file can be left for the system to clear' : '';
    out.push({ decision: cfg.decision, rule: 'delete.ask', reason: `${verb} deletes ${shown(a0.t.abs, where)}${size}${more}: ${a0.why}${temp}` });
  }
  return out;
}

/** The words a shell command deletes, and its verb, or null when it is not a plain delete this guard judges. `folders`: `git rm -r`, whose targets may be folders (0.21.1). */
function commandTargets(c: SimpleCommand, bylaws: Bylaws): { verb: string; words: string[]; git: boolean; folders: boolean } | null {
  if (bylaws.guards.destructive.decision !== 'allow' && destructiveCommandHit(c) !== null) return null;
  if (DELETERS.has(c.name)) return { verb: c.name, words: positional(c.args, c.shell), git: false, folders: false };
  if (c.name === 'git') {
    const g = gitSub(c.args);
    if (g !== null && g.sub === 'rm' && !g.rest.includes('--cached')) {
      const recursive = g.rest.some((a) => a === '-r' || /^-[a-zA-Z]*r[a-zA-Z]*$/.test(a));
      return { verb: recursive ? 'git rm -r' : 'git rm', words: positional(g.rest, c.shell), git: true, folders: recursive };
    }
  }
  return null;
}

/** Whether a write action is a file delete: a patch's delete, or a tool whose name says it deletes and that names this path. */
function writeDeletes(a: Extract<Action, { kind: 'write' }>): boolean {
  if (a.change?.kind === 'delete') return true;
  return a.change === undefined && a.content === undefined && toolWords(a.tool).some((w) => DELETE_TOOL_WORDS.has(w));
}

export const deleteGuard: Guard = {
  id: 'delete',
  isHard: () => false,
  evaluate(ctx: GuardContext): Finding[] {
    const cfg = ctx.bylaws.guards.delete ?? defaultDeleteBylaws();
    if (cfg.decision === 'allow') return [];
    const where = ctx.where ?? makeWhere();
    const a = ctx.action;
    let root: string | null = null;
    const here: Place = { dirs: [resolve(where.cwd)], unknown: null };
    const env = (place: Place = here, folders = false): JudgeCtx => ({ bylaws: ctx.bylaws, where, root: (root ??= trashRoot(where)), place, folders });
    if (a.kind === 'write') {
      if (!writeDeletes(a)) return [];
      const abs = documentPath(a.path, where);
      const rel = abs !== null ? relative(resolve(where.cwd), abs) : '';
      const word = abs !== null && rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : a.path;
      return findings(judgeTargets([word], env()), a.tool, cfg, where, false);
    }
    if (a.kind !== 'exec' || ctx.parsed === null) return [];
    const out: Finding[] = [];
    const commands = ctx.parsed.commands.slice(0, MAX_TARGETS);
    const places = commandPlaces(commands, where, pathFrom(where));
    for (const [i, c] of commands.entries()) {
      const t = commandTargets(c, ctx.bylaws);
      if (t === null || t.words.length === 0) continue;
      out.push(...findings(judgeTargets(t.words, env(places[i] ?? here, t.folders)), t.verb, cfg, where, t.git, t.folders));
    }
    return out;
  },
};
