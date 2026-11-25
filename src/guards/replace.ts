import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Finding, Guard, GuardContext, HashProbe, Where } from '../guard.js';
import { makeWhere } from '../guard.js';
import type { ParsedCommand, SimpleCommand } from '../shell.js';
import type { Action, Bylaws, Decision } from '../types.js';
import { strictest } from '../types.js';
import { layoutFor, replayLog, resolveItemPaths } from '../undo/plan.js';
import { destructiveCommandHit } from './destructive.js';
import { documentJudges, documentPath, emptier, isOverwrite, pathFrom, positional, readsFile } from './document.js';
import { commandPlaces } from './folders.js';
import { NULL_DEVICES } from './moves.js';
import { relationOf, trashRoot, whyNotTrash } from './reach.js';
import { sensitiveLabel } from './secrets.js';

/**
 * The replace guard (0.24.0), off unless `guards.replace.steer` is `keep`. A call that would replace the whole content of
 * an existing, non-empty file with no `.git` above it is refused once, naming `openmorals trash --copy <path>`: a copy
 * of the file goes to the project trash and the file stays. The same call then passes, because a live copy of the
 * file's current bytes is in the trash log, or because this session itself put those bytes there whole. A file the
 * trash cannot take is asked about instead. Ordinary edits (the Edit tool, a patch, an append) are never judged.
 */

export type ReplaceRule = 'replace.keep' | 'replace.ask';

/** The command a refusal names: it copies the file into the project trash and leaves it in place. */
export const KEEP_COMMAND = 'openmorals trash --copy';

/** The most bytes the guard hashes to check a file against its kept copy; a larger file is asked about. */
export const REPLACE_HASH_MAX_BYTES = 64 * 1024 * 1024;

/** The most of the project's undo log the guard reads; a larger log is asked about. */
export const UNDO_LOG_MAX_BYTES = 4 * 1024 * 1024;

/** The most targets of one call the guard looks at. */
const MAX_TARGETS = 64;

const STATE_DIR = '.openmorals';
const LOG_FILE = 'undo.jsonl';

/** One whole replacement a call makes: how a reason names it, the word naming the file, and the folders it may be read from. */
export interface Replacement {
  verb: string;
  word: string;
  dirs: readonly string[];
  /** An in-place rewriter (`sed -i`, `perl -i`): the result still holds the old content, so it is never noted as the session's own. */
  inPlace: boolean;
  /** Emptying or self-emptying, which the document guard asks about when it judges the path. */
  empties: boolean;
}

/** `tee` without `-a`/`--append` writes each file it names whole. */
function teeTargets(c: SimpleCommand): string[] {
  if (c.args.some((a) => a === '--append' || /^-[A-Za-z]*a[A-Za-z]*$/.test(a))) return [];
  return positional(c.args, c.shell);
}

/**
 * The files `sed -i` rewrites in place, or none when it keeps a backup (`-i.bak`, `-i .bak`, `--in-place=.bak`, and
 * GNU's `-ie`, whose `e` is the suffix). The script is the first word unless `-e`/`-f` names it.
 */
function sedTargets(args: readonly string[]): string[] {
  let inPlace = false;
  let backup = false;
  let script = false;
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--') {
      pos.push(...args.slice(i + 1));
      break;
    }
    if (a === '--in-place') inPlace = true;
    else if (a.startsWith('--in-place=')) {
      inPlace = true;
      backup ||= a.length > '--in-place='.length;
    } else if (a === '--expression' || a === '--file' || a === '--line-length') {
      script ||= a !== '--line-length';
      i++;
    } else if (a.startsWith('--expression=') || a.startsWith('--file=')) script = true;
    else if (a.startsWith('--')) continue;
    else if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        if (ch === 'i') {
          inPlace = true;
          const rest = a.slice(k + 1);
          if (rest !== '') backup = true;
          else if (k === a.length - 1 && i + 1 < args.length && (args[i + 1] === '' || /^[.~_][\w.~-]{0,15}$/.test(args[i + 1] ?? ''))) {
            backup ||= args[i + 1] !== '';
            i++;
          }
          break;
        }
        if (ch === 'e' || ch === 'f' || ch === 'l') {
          script ||= ch !== 'l';
          if (k === a.length - 1) i++;
          break;
        }
      }
    } else pos.push(a);
  }
  if (!inPlace || backup) return [];
  return script ? pos : pos.slice(1);
}

/** The files `perl -i` rewrites in place, or none when it keeps a backup (`-i.bak`, `-pi.bak`; `-pie` is suffix `e`). */
function perlTargets(args: readonly string[]): string[] {
  let inPlace = false;
  let backup = false;
  let script = false;
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '--') {
      pos.push(...args.slice(i + 1));
      break;
    }
    if (pos.length > 0 || !a.startsWith('-') || a === '-') {
      pos.push(a);
      continue;
    }
    for (let k = 1; k < a.length; k++) {
      const ch = a[k];
      if (ch === 'i') {
        inPlace = true;
        if (a.slice(k + 1) !== '') backup = true;
        break;
      }
      if (ch === 'e' || ch === 'E') {
        script = true;
        if (k === a.length - 1) i++;
        break;
      }
      if (ch === 'I' || ch === 'M' || ch === 'm' || ch === 'x' || ch === 'C' || ch === 'd' || ch === 'D') break;
      if (ch === 'l' || ch === '0') break;
    }
  }
  if (!inPlace || backup) return [];
  return script ? pos : pos.slice(1);
}

/** Whether a command is the one the guard leaves to the destructive guard (it owns `rm -rf`, `truncate`, ...). */
function destructiveOwns(c: SimpleCommand, bylaws: Bylaws): boolean {
  return bylaws.guards.destructive.decision !== 'allow' && destructiveCommandHit(c) !== null;
}

/**
 * The whole replacements an action makes (0.24.0): the Write tool's whole new content, a `>` redirect, `tee`, and the
 * in-place rewriters `sed -i` and `perl -i`. Paths are not checked here; see `judgeReplacement`.
 */
export function replacementsOf(action: Action, parsed: ParsedCommand | null, where: Where, bylaws: Bylaws): Replacement[] {
  if (action.kind === 'write') {
    if (action.change?.kind !== 'whole' || action.content === undefined) return [];
    const empties = !action.content.cut && action.content.text.trim() === '';
    return [{ verb: action.tool, word: action.path, dirs: [resolve(where.cwd)], inPlace: false, empties }];
  }
  if (action.kind !== 'exec' || parsed === null) return [];
  const out: Replacement[] = [];
  const commands = parsed.commands.slice(0, MAX_TARGETS);
  const places = commandPlaces(commands, where, pathFrom(where));
  commands.forEach((c, i) => {
    const place = places[i];
    if (place === undefined) return;
    if (destructiveOwns(c, bylaws)) return;
    const feeders: SimpleCommand[] = [];
    for (let j = i; j > 0 && commands[j]?.pipeIn === true; j--) {
      const f = commands[j - 1];
      if (f !== undefined) feeders.push(f);
    }
    const add = (verb: string, word: string, inPlace: boolean, empties: boolean): void => {
      if (out.length >= MAX_TARGETS || NULL_DEVICES.has(word.toLowerCase())) return;
      // A relative path after a change of folder openmorals cannot follow is not judged (see docs/delete.md, not seen).
      if (place.unknown !== null && !isAbsolute(word) && !/^~(?=$|[/\\])/.test(word)) return;
      out.push({ verb, word, dirs: place.dirs, inPlace, empties });
    };
    for (const r of c.redirects) {
      if (!isOverwrite(r.op) || /^\d+$/.test(r.target)) continue;
      const selfRead = (abs: string, from: Where): boolean => [c, ...feeders].some((f) => readsFile(f, abs, from));
      add(`the redirect ${r.op}`, r.target, false, emptier(c) || place.dirs.some((d) => {
        const abs = documentPath(r.target, { ...where, cwd: d });
        return abs !== null && selfRead(abs, { ...where, cwd: d });
      }));
    }
    if (c.name === 'tee') for (const w of teeTargets(c)) add('tee', w, false, false);
    if (c.name === 'sed' || c.name === 'gsed') for (const w of sedTargets(c.args)) add('sed -i', w, true, false);
    if (/^perl[\d.]*$/.test(c.name)) for (const w of perlTargets(c.args)) add('perl -i', w, true, false);
  });
  return out;
}

/** Whether a `.git` (folder or file) sits in the file's folder or above it; stops below the home folder for a file inside it. */
export function underGit(abs: string, where: Where): boolean {
  const home = resolve(where.home);
  const inHome = relative(home, abs) !== '' && !relative(home, abs).startsWith('..') && !isAbsolute(relative(home, abs));
  let dir = dirname(abs);
  for (let i = 0; i < 64; i++) {
    if (inHome && resolve(dir) === home) return false;
    if (where.readFile(join(dir, '.git'), 0).kind !== 'missing') return true;
    const up = dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
  return false;
}

/** The project's undo log as the guard reads it: the live kept copies, or why it cannot be read. */
type KeptCopies = { ok: true; copies: { path: string; sha256: string; trashed: string; size: number }[] } | { ok: false; why: string };

function keptCopies(root: string, where: Where): KeptCopies {
  const rootReal = where.realpath(root);
  const p = where.readFile(join(rootReal, STATE_DIR, LOG_FILE), UNDO_LOG_MAX_BYTES);
  if (p.kind === 'missing') return { ok: true, copies: [] };
  if (p.kind === 'error') return { ok: false, why: `openmorals cannot read the project trash log (${p.error}) to look for a kept copy` };
  if (p.kind === 'other') return { ok: false, why: 'the project trash log is not a file, so openmorals cannot look for a kept copy' };
  if (p.text === undefined) return { ok: false, why: `the project trash log is over ${UNDO_LOG_MAX_BYTES / 1048576} MiB, more than openmorals reads to look for a kept copy` };
  const layout = layoutFor(rootReal, sep === '\\' ? 'win32' : 'posix');
  const copies: { path: string; sha256: string; trashed: string; size: number }[] = [];
  for (const it of replayLog(p.text).items.values()) {
    const e = it.entry;
    if (it.state !== 'trashed' || e.copy !== true || e.sha256 === undefined || e.path === undefined) continue;
    const paths = resolveItemPaths(layout, e, sep === '\\' ? 'win32' : 'posix');
    if (!paths.ok) continue;
    copies.push({ path: e.path, sha256: e.sha256, trashed: paths.value.trashed, size: e.size ?? -1 });
  }
  return { ok: true, copies };
}

/** The real path of a file (links resolved, as `openmorals trash --copy` keeps a link's file) from the real project root, with `/`. */
function loggedPath(real: string, root: string, where: Where): string {
  return relative(where.realpath(root), real).split(sep).join('/');
}

function samePath(a: string, b: string): boolean {
  return a === b || (process.platform !== 'linux' && a.toLowerCase() === b.toLowerCase());
}

/** What the guard makes of one target: nothing to judge (null), a refusal toward a kept copy, or an ask with why. */
export type TargetJudgement = { kind: 'keep'; abs: string; bytes: number } | { kind: 'ask'; abs: string; bytes: number | null; why: string };

interface Judging {
  where: Where;
  bylaws: Bylaws;
  root: () => string;
  copies: () => KeptCopies;
}

function judgeTarget(r: Replacement, abs: string, j: Judging): TargetJudgement | null {
  const p = j.where.readFile(abs, 0);
  if (p.kind === 'missing' || p.kind === 'other') return null;
  if (r.empties && documentJudges(abs, j.bylaws, j.where)) return null;
  if (sensitiveLabel(abs) !== null) return null;
  if (p.kind === 'error') return { kind: 'ask', abs, bytes: null, why: `openmorals cannot read it (${p.error})` };
  if (p.bytes === 0) return null;
  if (underGit(abs, j.where)) return null;
  const h: HashProbe = (j.where.hash ?? (() => ({ kind: 'error', error: 'no hash function' }) as HashProbe))(abs, REPLACE_HASH_MAX_BYTES);
  if (h.kind === 'missing' || h.kind === 'other') return null;
  if (h.kind === 'large') return { kind: 'ask', abs, bytes: h.bytes, why: `it is over ${REPLACE_HASH_MAX_BYTES / 1048576} MiB, more than openmorals reads to check for a kept copy` };
  if (h.kind === 'error') return { kind: 'ask', abs, bytes: p.bytes, why: `openmorals cannot read it (${h.error}) to check for a kept copy` };
  if ((j.where.wrote ?? []).some((w) => w.p === abs && w.h === h.sha256)) return null;
  const real = j.where.realpath(abs);
  const why = whyNotTrash(abs, j.root(), j.where) ?? (relationOf(j.where.realpath(j.root()), real) !== 'inside' ? 'it is a link to a file outside the project folder, where openmorals trash cannot keep a copy' : null);
  if (why !== null) return { kind: 'ask', abs, bytes: h.bytes, why: why.replace('openmorals trash cannot take it', 'openmorals trash cannot keep a copy').replace('openmorals trash cannot move it', 'openmorals trash cannot keep a copy') };
  const kept = j.copies();
  if (!kept.ok) return { kind: 'ask', abs, bytes: h.bytes, why: kept.why };
  const rel = loggedPath(real, j.root(), j.where);
  const found = kept.copies.some((c) => c.sha256 === h.sha256 && samePath(c.path, rel) && c.size === h.bytes && (() => {
    const t = j.where.readFile(c.trashed, 0);
    return t.kind === 'file' && t.bytes === h.bytes;
  })());
  return found ? null : { kind: 'keep', abs, bytes: h.bytes };
}

function bytesText(n: number): string {
  return `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} byte${n === 1 ? '' : 's'}`;
}

/** A path as a reason shows it and as the copy command takes it: from the agent's folder when inside it, else absolute. */
function shownWord(abs: string, where: Where): string {
  const rel = relative(resolve(where.cwd), abs);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : abs;
}

function shown(abs: string, where: Where): string {
  const t = shownWord(abs, where);
  return `'${t.length > 80 ? `…${t.slice(t.length - 79)}` : t}'`;
}

function shellWord(w: string): string | null {
  if (/^[A-Za-z0-9_./~@%+=:,-]+$/.test(w) && !w.startsWith('-')) return w;
  if (!/["$`\\\r\n]/.test(w) && w.length <= 120) return `"${w}"`;
  return null;
}

/** The decision of an ask: ask, or deny when the delete guard's setting is deny (neither setting can weaken the other). */
function askDecision(bylaws: Bylaws): Decision {
  return strictest('ask', bylaws.guards.delete?.decision ?? 'ask');
}

export const replaceGuard: Guard = {
  id: 'replace',
  isHard: () => false,
  evaluate(ctx: GuardContext): Finding[] {
    if (ctx.bylaws.guards.replace?.steer !== 'keep') return [];
    const where = ctx.where ?? makeWhere();
    const reps = replacementsOf(ctx.action, ctx.parsed, where, ctx.bylaws);
    if (reps.length === 0) return [];
    let root: string | null = null;
    let copies: KeptCopies | null = null;
    const j: Judging = { where, bylaws: ctx.bylaws, root: () => (root ??= trashRoot(where)), copies: () => (copies ??= keptCopies(root ?? (root = trashRoot(where)), where)) };
    const keep: { verb: string; t: TargetJudgement }[] = [];
    const ask: { verb: string; t: Extract<TargetJudgement, { kind: 'ask' }> }[] = [];
    const seen = new Set<string>();
    for (const r of reps) {
      for (const d of r.dirs) {
        const abs = documentPath(r.word, { ...where, cwd: d });
        if (abs === null || seen.has(abs)) continue;
        seen.add(abs);
        const t = judgeTarget(r, abs, j);
        if (t === null) continue;
        if (t.kind === 'keep') keep.push({ verb: r.verb, t });
        else ask.push({ verb: r.verb, t });
      }
    }
    const out: Finding[] = [];
    const again = ctx.action.kind === 'write' ? `the ${ctx.action.tool}` : 'the command';
    const k0 = keep[0];
    if (k0 !== undefined) {
      const total = keep.reduce((n, k) => n + (k.t.bytes ?? 0), 0);
      const what = keep.length === 1 ? `${shown(k0.t.abs, where)} (${bytesText(total)})` : `${shown(k0.t.abs, where)} and ${keep.length - 1} more (${bytesText(total)})`;
      const words = keep.length <= 3 ? keep.map((k) => shellWord(shownWord(k.t.abs, where))) : [null];
      const list = words.every((x): x is string => x !== null) ? words.join(' ') : '<path>';
      out.push({ decision: 'deny', rule: 'replace.keep', reason: `${k0.verb} would replace ${what} whole, with no .git above it: not run. Run \`${KEEP_COMMAND} ${list}\` (it keeps a copy in the project trash the person can restore; the file stays), then repeat ${again}. Carry on.` });
    }
    const a0 = ask[0];
    if (a0 !== undefined) {
      const size = a0.t.bytes !== null ? ` (${bytesText(a0.t.bytes)})` : '';
      const more = ask.length > 1 ? ` and ${ask.length - 1} more` : '';
      out.push({ decision: askDecision(ctx.bylaws), rule: 'replace.ask', reason: `${a0.verb} replaces ${shown(a0.t.abs, where)}${size}${more} whole, with no .git above it: ${a0.t.why}` });
    }
    return out;
  },
};

/**
 * The files a call that ran put new content in whole (0.24.0, for the post-tool event): the Write tool, a redirect and
 * `tee`, never an in-place rewriter (its result still holds the person's content). Each with no `.git` above it, as
 * absolute paths.
 */
export function wholeWritten(action: Action, parsed: ParsedCommand | null, where: Where, bylaws: Bylaws): string[] {
  const out: string[] = [];
  for (const r of replacementsOf(action, parsed, where, bylaws)) {
    // After a change of folder the call may have written either of two files; neither is noted, so neither is licensed.
    if (r.inPlace || r.dirs.length !== 1) continue;
    const abs = documentPath(r.word, { ...where, cwd: r.dirs[0] ?? where.cwd });
    if (abs !== null && !out.includes(abs) && !underGit(abs, where)) out.push(abs);
  }
  return out;
}
