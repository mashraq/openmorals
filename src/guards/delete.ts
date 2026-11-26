import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { Finding, Guard, GuardContext, Where } from '../guard.js';
import { makeWhere } from '../guard.js';
import type { SimpleCommand } from '../shell.js';
import type { Bylaws, Decision, DeleteBylaws } from '../types.js';
import { strictest } from '../types.js';
import { destructiveCommandHit, gitSub } from './destructive.js';
import { DELETERS, documentDecision, documentOwns, documentPath, expandedPath, pathFrom, positional } from './document.js';
import type { Place } from './folders.js';
import { commandPlaces } from './folders.js';
import type { MoveShape } from './moves.js';
import { NULL_DEVICES, moveShape } from './moves.js';
import { isTempDestination, isTempPath, relationOf, trashRoot, whyNotTrash, writeDeletes } from './reach.js';
import { sensitiveLabel } from './secrets.js';

export { trashRoot } from './reach.js';

export function defaultDeleteBylaws(): DeleteBylaws {
  return { decision: 'ask', steer: 'trash' };
}

/** The rule ids this guard reports. */
export type DeleteRule = 'delete.trash' | 'delete.ask' | 'delete.blind';

/** The command a refusal names: the one way to the agent's goal that keeps the file recoverable. */
export const TRASH_COMMAND = 'openmorals trash';

/** The most targets of one command (or one call) the guard looks at; past it the rest are not judged one by one. */
const MAX_TARGETS = 64;

/** A word whose value is only known when the shell runs it: `...`, $(...), %VAR%, $env:VAR (a $VAR openmorals cannot expand is found by `documentPath`). */
const RUNTIME = /`|\$\(|%[A-Za-z_][A-Za-z0-9_]*%|\$env:/i;

function bytesText(n: number): string {
  return `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} byte${n === 1 ? '' : 's'}`;
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

/**
 * What a call does to the targets judged together (0.22.0): deletes them (`rm`, `git rm`, a patch or tool delete),
 * moves them into a temp folder, or replaces them with `mv`/`cp` (the target is the file replaced).
 */
type Kind = 'delete' | 'temp' | 'over';

interface Target {
  /** The word as the action names it (relative to the agent's folder, or absolute). */
  word: string;
  abs: string;
  bytes: number | null;
  error: string | null;
  /** The document guard's decision when the target is one of its documents, else allow (0.22.0). */
  doc: Decision;
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
  /** `git rm -r`, a move into a temp folder: a folder is a target too (0.21.1). */
  folders: boolean;
  kind: Kind;
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
  // A plain delete of a document the trash cannot take stays the document guard's ask (0.21.0); one it can take is refused here (0.22.0).
  if (ctx.kind === 'delete' && documentOwns(abs, ctx.bylaws, ctx.where, ctx.root)) return;
  // A file already in a temp folder outside the project is not lost by moving it to another.
  if (ctx.kind === 'temp' && isTempPath(abs) && relationOf(ctx.root, abs) === 'outside') return;
  const p = ctx.where.readFile(abs, 0);
  const word = wordFor(w, abs, ctx.where);
  if (p.kind === 'missing' || (p.kind === 'other' && !ctx.folders)) return;
  const doc = documentDecision(abs, ctx.bylaws, ctx.where);
  if (p.kind === 'error') {
    out.ask.push({ t: { word, abs, bytes: null, error: p.error, doc }, why: `openmorals cannot read it (${p.error})` });
    return;
  }
  const t: Target = { word, abs, bytes: p.kind === 'file' ? p.bytes : null, error: null, doc };
  const secret = sensitiveLabel(abs);
  if (secret !== null) {
    out.ask.push({ t, why: `it is ${secret}: the trash would keep the secret on disk` });
    return;
  }
  const why = whyNotTrash(abs, ctx.root, ctx.where);
  if (why !== null) out.ask.push({ t, why });
  else out.trash.push(t);
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

/** An ask's decision: the delete setting, or the document setting when a target is a document and that is stricter (0.22.0), so neither setting can weaken the other. */
function askDecision(cfg: DeleteBylaws, targets: readonly Target[]): Decision {
  return targets.reduce((d: Decision, t) => strictest(d, t.doc), cfg.decision);
}

function findings(j: Judged, verb: string, cfg: DeleteBylaws, where: Where, git: boolean, folders = false, kind: Kind = 'delete'): Finding[] {
  const out: Finding[] = [];
  const into = kind === 'temp' ? ' into a temp folder' : '';
  const first = j.blind[0];
  if (first !== undefined) {
    const w = first.length <= 60 && !/[\s"'\r\n]/.test(first) ? first : '<the same path>';
    out.push({ decision: 'deny', rule: 'delete.blind', reason: `${verb} ${kind === 'temp' ? 'moves a path built at run time into a temp folder' : 'names a path built at run time'}, so openmorals cannot see what it deletes: not run. Write the path out, or use \`${TRASH_COMMAND} ${w}\`` });
  }
  const lost = j.lost[0];
  if (lost !== undefined) {
    out.push({ decision: 'deny', rule: 'delete.blind', reason: `${verb} ${kind === 'temp' ? 'moves' : 'deletes'} '${lost.word.length > 60 ? `${lost.word.slice(0, 59)}…` : lost.word}'${into} after ${lost.why}, so openmorals cannot see which file it is: not run. Name it from the project folder, or use \`${TRASH_COMMAND} <path>\`` });
  }
  const t0 = j.trash[0];
  if (t0 !== undefined) {
    const what = j.trash.length === 1 ? `${shown(t0.abs, where)} (${sizeOf(j.trash)})` : `${shown(t0.abs, where)} and ${j.trash.length - 1} more (${sizeOf(j.trash)})`;
    const cmd = trashCommand(j.trash, git, folders);
    const thing = j.trash.some((t) => t.bytes === null) ? 'folder' : 'file';
    if (cfg.steer === 'trash') {
      const reason =
        kind === 'over'
          ? `${verb} would overwrite ${what}: not run. Run \`${cmd}\` first, then the ${verb} (the old file is moved aside; the person can restore it, and only they can purge it). Carry on.`
          : `${verb} would ${kind === 'temp' ? 'move' : 'delete'} ${what}${kind === 'temp' ? ' into a temp folder, which does not keep files' : ''}: not run. Use \`${cmd}\` instead (the ${thing} is moved aside; the person can restore it, and only they can purge it). Carry on.`;
      out.push({ decision: 'deny', rule: 'delete.trash', reason });
    } else {
      const reason =
        kind === 'over'
          ? `${verb} overwrites ${what}; running \`${cmd}\` first would keep the old file recoverable`
          : `${verb} ${kind === 'temp' ? 'moves' : 'deletes'} ${what}${kind === 'temp' ? ' into a temp folder, which does not keep files' : ''}; \`${cmd}\` would keep it recoverable`;
      out.push({ decision: askDecision(cfg, j.trash), rule: 'delete.ask', reason });
    }
  }
  const a0 = j.ask[0];
  if (a0 !== undefined) {
    const size = a0.t.bytes !== null ? ` (${bytesText(a0.t.bytes)})` : '';
    const more = j.ask.length > 1 ? ` and ${j.ask.length - 1} more` : '';
    const temp = kind !== 'temp' && isTempPath(a0.t.abs) ? '; a temp file can be left for the system to clear' : '';
    const does = kind === 'over' ? 'overwrites' : kind === 'temp' ? 'moves' : 'deletes';
    out.push({ decision: askDecision(cfg, j.ask.map((x) => x.t)), rule: 'delete.ask', reason: `${verb} ${does} ${shown(a0.t.abs, where)}${size}${more}${into}: ${a0.why}${temp}` });
  }
  return out;
}

/** The words a shell command deletes, and its verb, or null when it is not a plain delete this guard judges. `folders`: `git rm -r`, whose targets may be folders (0.21.1). */
function commandTargets(c: SimpleCommand): { verb: string; words: string[]; git: boolean; folders: boolean } | null {
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

/** Whether a move's destination is a temp folder outside the project, from any folder the command may run in (0.22.0). */
function movesToTemp(m: MoveShape, ctx: JudgeCtx): boolean {
  const e = expandedPath(m.dest, ctx.where);
  if (e === null) return isTempDestination(m.dest, null, ctx.root);
  if (!isAbsolute(e) && ctx.place.unknown !== null) return false;
  return candidates(e, ctx.place).some((abs) => isTempDestination(m.dest, abs, ctx.root));
}

/**
 * The existing files a move or copy replaces (0.22.0): the destination when it is a file, or the file of the same name
 * inside a destination folder. Not judged: a destination openmorals cannot resolve, a source that does not exist or is
 * a folder, a copy from the null device (the document guard's emptying).
 */
function replacedFiles(m: MoveShape, ctx: JudgeCtx, out: Judged): void {
  if (!m.overwrites || NULL_DEVICES.has(m.dest.toLowerCase()) || m.sources.some((s) => NULL_DEVICES.has(s.toLowerCase()))) return;
  const e = expandedPath(m.dest, ctx.where);
  if (e === null || RUNTIME.test(m.dest) || (!isAbsolute(e) && ctx.place.unknown !== null)) return;
  const seen = new Set<string>();
  for (const dir of ctx.place.dirs) {
    const from: Where = { ...ctx.where, cwd: dir };
    const destAbs = documentPath(m.dest, from);
    if (destAbs === null) continue;
    const dp = ctx.where.readFile(destAbs, 0);
    for (const s of m.sources.slice(0, MAX_TARGETS)) {
      const known = RUNTIME.test(s) ? null : documentPath(s, from);
      const sp = known !== null ? ctx.where.readFile(known, 0) : null;
      if (sp !== null && sp.kind !== 'file') continue;
      let target: string;
      if (dp.kind === 'file') {
        if (m.sources.length !== 1) continue;
        target = destAbs;
      } else if (dp.kind === 'other') {
        if (known === null) continue;
        target = join(destAbs, basename(known));
      } else continue;
      if (target === known || seen.has(target)) continue;
      seen.add(target);
      judgeOne(target, target, ctx, out);
    }
  }
}

/** A target replaced by a move or copy as the trash command names it: from the agent's folder when inside it. */
function relWord(out: Judged, where: Where): Judged {
  const fix = (t: Target): Target => {
    const rel = relative(resolve(where.cwd), t.abs);
    return { ...t, word: rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : t.abs };
  };
  return { ...out, trash: out.trash.map(fix), ask: out.ask.map((a) => ({ ...a, t: fix(a.t) })) };
}

/**
 * A call of `openmorals trash` the project trash may not cover: `--root` names another trash
 * root, a target is outside the project (or is the project folder itself), resolves outside it, is inside openmorals'
 * own folders, or is built at run time, or the call runs from a folder openmorals cannot know. `init` allows the trash
 * command in Claude Code so a recoverable delete inside the project needs no second prompt; this keeps every other
 * trash call an ask. The trash itself also refuses a path outside its root.
 */
function trashScope(c: SimpleCommand, place: Place, root: string, where: Where): string | null {
  if (c.args.some((a) => a === '--list')) return null;
  if (c.args.some((a) => a === '--root' || a.startsWith('--root='))) return 'openmorals trash with --root moves files into the trash of another folder than this project';
  if (place.unknown !== null) return `openmorals trash runs from a folder openmorals cannot know (${place.unknown})`;
  const words = positional(c.args, c.shell).filter((w, i) => !(i === 0 && w === 'trash'));
  for (const w of words.slice(0, MAX_TARGETS)) {
    if (RUNTIME.test(w)) return `openmorals trash names a path built at run time (${w.length > 60 ? `${w.slice(0, 59)}…` : w})`;
    for (const dir of place.dirs) {
      const abs = documentPath(w, { ...where, cwd: dir });
      if (abs === null) return `openmorals trash names a path built at run time (${w.length > 60 ? `${w.slice(0, 59)}…` : w})`;
      // openmorals' own folders are the self-protect guard's, which asks about them with its own reason.
      if (relationOf(where.configDir, abs) !== 'outside' || relationOf(join(root, '.openmorals'), abs) !== 'outside') continue;
      const why = whyNotTrash(abs, root, where);
      if (why !== null) return `openmorals trash ${shown(abs, where)}: ${why}`;
    }
  }
  return null;
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
    const env = (place: Place = here, folders = false, kind: Kind = 'delete'): JudgeCtx => ({ bylaws: ctx.bylaws, where, root: (root ??= trashRoot(where)), place, folders, kind });
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
      if (ctx.bylaws.guards.destructive.decision !== 'allow' && destructiveCommandHit(c) !== null) continue;
      const place = places[i] ?? here;
      if (c.name === 'openmorals' && c.args.find((x) => !x.startsWith('-')) === 'trash') {
        const why = trashScope(c, place, (root ??= trashRoot(where)), where);
        if (why !== null) out.push({ decision: cfg.decision === 'deny' ? 'deny' : 'ask', rule: 'delete.ask', reason: `${why}; inside this project the trash keeps a copy you can restore, here it may not` });
        continue;
      }
      const t = commandTargets(c);
      if (t !== null && t.words.length > 0) out.push(...findings(judgeTargets(t.words, env(place, t.folders)), t.verb, cfg, where, t.git, t.folders));
      const m = moveShape(c);
      if (m === null) continue;
      // A move into a temp folder deletes its sources (0.22.0); any other move keeps the file and is not judged here.
      const temp = env(place, true, 'temp');
      if (m.relocates && movesToTemp(m, temp)) out.push(...findings(judgeTargets(m.sources, temp), m.verb, cfg, where, false, true, 'temp'));
      // A move or copy onto an existing file deletes that file (0.22.0).
      const replaced: Judged = { blind: [], lost: [], trash: [], ask: [] };
      replacedFiles(m, env(place, false, 'over'), replaced);
      out.push(...findings(relWord(replaced, where), m.verb, cfg, where, m.git, false, 'over'));
    }
    return out;
  },
};

