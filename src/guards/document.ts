import { isAbsolute, relative, resolve } from 'node:path';
import { compileGlob } from '../diffclass/glob.js';
import type { FileProbe, Finding, Guard, GuardContext, Where } from '../guard.js';
import { makeWhere } from '../guard.js';
import type { SimpleCommand } from '../shell.js';
import type { ActionText, Action, Bylaws, Decision, DocumentBylaws, WriteChange } from '../types.js';
import { strictest } from '../types.js';
import { destructiveCommandHit, gitSub, trashHint } from './destructive.js';
import { commandPlaces, isHere } from './folders.js';
import { COPIES, MOVES, NULL_DEVICES, isOptionWord, moveParts } from './moves.js';
import { isTempDestination, steersToTrash, trashRoot, writeDeletes } from './reach.js';

/** File name extensions that make a file a document by default (0.18.0): prose and office formats, not code. */
export const DEFAULT_DOCUMENT_EXTENSIONS: readonly string[] = Object.freeze([
  'md',
  'markdown',
  'mdx',
  'txt',
  'text',
  'rst',
  'adoc',
  'asciidoc',
  'org',
  'tex',
  'rtf',
  'doc',
  'docx',
  'odt',
  'pages',
  'pdf',
  'xls',
  'xlsx',
  'ods',
  'numbers',
  'ppt',
  'pptx',
  'odp',
  'key',
]);

/** Folders the guard leaves alone by default: installed packages, build output and the git folder, at any depth. */
export const DEFAULT_DOCUMENT_EXCLUDE: readonly string[] = Object.freeze(['node_modules', 'vendor', 'dist', 'build', 'target', 'coverage', '.git', '.venv']);

export const DEFAULT_SHRINK_PERCENT = 25;
export const DEFAULT_MIN_REMOVED_BYTES = 512;

/** The most of a file's text the guard reads (to count its headings, or the places an edit replaces): the content cap. */
export const DOCUMENT_TEXT_MAX_BYTES = 262144;

export function defaultDocumentBylaws(): DocumentBylaws {
  return { decision: 'ask', shrink_percent: DEFAULT_SHRINK_PERCENT, min_removed_bytes: DEFAULT_MIN_REMOVED_BYTES, extensions: [...DEFAULT_DOCUMENT_EXTENSIONS], exclude: [...DEFAULT_DOCUMENT_EXCLUDE] };
}

/** The rule ids this guard reports. */
export type DocumentRule = 'document.delete' | 'document.empty' | 'document.shrink' | 'document.heading' | 'document.unknown' | 'document.unreadable';

type Syntax = 'markdown' | 'rst' | 'asciidoc' | 'org' | 'tex' | null;

function syntaxOf(ext: string): Syntax {
  if (ext === 'md' || ext === 'markdown' || ext === 'mdx') return 'markdown';
  if (ext === 'rst') return 'rst';
  if (ext === 'adoc' || ext === 'asciidoc') return 'asciidoc';
  if (ext === 'org') return 'org';
  if (ext === 'tex') return 'tex';
  return null;
}

const MD_ATX = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const MD_FENCE = /^ {0,3}(`{3,}|~{3,})/;
const MD_SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const RST_UNDERLINE = /^([=\-~^"'`#*+:._])\1{2,}[ \t]*$/;
const ADOC = /^(?:={1,6}|#{1,6})[ \t]+\S/;
const ORG = /^\*+[ \t]+\S/;
const TEX = /\\(?:part|chapter|section|subsection|subsubsection|paragraph)\*?\s*[[{]/g;

/** How many headings a text holds in a document syntax: Markdown ATX and setext (outside code fences), reStructuredText underlines, AsciiDoc, Org, LaTeX sectioning. */
export function countHeadings(text: string, syntax: Syntax): number {
  if (syntax === null || text === '') return 0;
  if (syntax === 'tex') return (text.match(TEX) ?? []).length;
  const lines = text.split(/\r?\n/);
  let n = 0;
  let fence: string | null = null;
  let prev = '';
  let start = 0;
  if (syntax === 'markdown' && (lines[0] === '---' || lines[0] === '+++')) {
    const close = lines.indexOf(lines[0], 1);
    if (close > 0) start = close + 1;
  }
  for (const line of lines.slice(start)) {
    if (syntax === 'markdown') {
      const f = MD_FENCE.exec(line);
      if (fence !== null) {
        if (f !== null && (f[1] ?? '').startsWith(fence)) fence = null;
        prev = '';
        continue;
      }
      if (f !== null) {
        fence = (f[1] ?? '').slice(0, 3);
        prev = '';
        continue;
      }
      if (MD_ATX.test(line)) n++;
      else if (MD_SETEXT.test(line) && prev.trim() !== '' && !MD_ATX.test(prev) && !MD_SETEXT.test(prev) && !/^\s*([-*+]|\d+[.)])\s/.test(prev) && !prev.includes('|')) n++;
    } else if (syntax === 'rst') {
      if (RST_UNDERLINE.test(line) && prev.trim() !== '' && !RST_UNDERLINE.test(prev)) n++;
    } else if (syntax === 'asciidoc') {
      if (ADOC.test(line)) n++;
    } else if (ORG.test(line)) n++;
    prev = line;
  }
  return n;
}

function extOf(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}

const VAR = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** A path an action names with `~` and `$HOME`-style folder variables expanded, not yet made absolute (0.21.1). Null when it is empty or still holds an unexpanded variable. */
export function expandedPath(p: string, where: Where): string | null {
  const raw = stripQuotes(p.trim());
  if (raw === '' || raw.length > 4096 || /[\r\n\0]/.test(raw) || raw.includes('://')) return null;
  const tilde = /^~(?=$|[/\\])/.test(raw) ? `${where.home}${raw.slice(1)}` : raw;
  let unknown = false;
  const expanded = tilde.replace(VAR, (m: string, a?: string, b?: string) => {
    const v = where.vars[(a ?? b ?? '').toLowerCase()];
    if (v === undefined) unknown = true;
    return v ?? m;
  });
  return unknown ? null : expanded;
}

/** The absolute form of a path an action names: `~` and `$HOME`-style folder variables expanded, then made absolute from the working directory. Null when it is empty or still holds an unexpanded variable. */
export function documentPath(p: string, where: Where): string | null {
  const expanded = expandedPath(p, where);
  if (expanded === null) return null;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(where.cwd, expanded);
}

/** `documentPath` read from another folder (a `cd` earlier in the call, 0.21.1). */
export function pathFrom(where: Where): (word: string, from: string) => string | null {
  return (word: string, from: string) => documentPath(word, { ...where, cwd: from });
}

/** How a path is shown in a reason: from the project folder when inside it, else as given; a long one keeps its end (the file name). */
function shownPath(abs: string, where: Where): string {
  const t = outsideProject(abs, where) ? abs : relative(resolve(where.cwd), abs);
  return `'${t.length > 80 ? `…${t.slice(t.length - 79)}` : t}'`;
}

function outsideProject(abs: string, where: Where): boolean {
  const rel = relative(resolve(where.cwd), abs);
  return rel === '' ? false : rel.startsWith('..') || isAbsolute(rel);
}

function excludedBy(abs: string, cfg: DocumentBylaws, where: Where): string | null {
  if (cfg.exclude.length === 0) return null;
  const rel = outsideProject(abs, where) ? null : relative(resolve(where.cwd), abs).replace(/\\/g, '/');
  const flat = abs.replace(/\\/g, '/').replace(/^[a-z]:\//i, '').replace(/^\/+/, '');
  for (const g of cfg.exclude) {
    const anchored = g.replace(/\/+$/, '').includes('/');
    const test = compileGlob(g);
    if (rel !== null && rel !== '' && test(rel)) return g;
    if (rel === null && !anchored && test(flat)) return g;
  }
  return null;
}

function isDocument(abs: string, cfg: DocumentBylaws): boolean {
  const ext = extOf(abs);
  return ext !== '' && cfg.extensions.includes(ext);
}

/** Whether a path is a document by the guard's own settings (extension listed, not excluded), whatever its decision (0.29.0: read by the first-activity guidance; it decides nothing). */
export function documentShaped(abs: string, bylaws: Bylaws, where: Where): boolean {
  const cfg = bylaws.guards.document ?? defaultDocumentBylaws();
  return isDocument(abs, cfg) && excludedBy(abs, cfg, where) === null;
}

/**
 * Whether the document guard judges a plain delete of this path itself (0.21.0, read by the delete guard so that one
 * target is asked about once): the guard is on, the file is a document, no exclusion covers it, and (0.22.0) the delete
 * guard does not refuse it with the trash command named. A document the trash can take is the delete guard's, like any file.
 */
export function documentOwns(abs: string, bylaws: Bylaws, where: Where, root?: string): boolean {
  const cfg = bylaws.guards.document ?? defaultDocumentBylaws();
  return cfg.decision !== 'allow' && isDocument(abs, cfg) && excludedBy(abs, cfg, where) === null && !steersToTrash(abs, bylaws, where, root ?? trashRoot(where));
}

/** Whether the document guard judges writes to this path at all (on, not excluded): it then asks about emptying any file (0.24.0). The replace guard leaves an emptying to it only when its decision is deny (0.25.0). */
export function documentJudges(abs: string, bylaws: Bylaws, where: Where): boolean {
  const cfg = bylaws.guards.document ?? defaultDocumentBylaws();
  return cfg.decision !== 'allow' && excludedBy(abs, cfg, where) === null;
}

/** Whether the document guard counts this path as a document (on, extension listed, not excluded): the delete guard's asks about one take the stricter of the two decisions (0.22.0). */
export function documentDecision(abs: string, bylaws: Bylaws, where: Where): Decision {
  const cfg = bylaws.guards.document ?? defaultDocumentBylaws();
  return cfg.decision !== 'allow' && isDocument(abs, cfg) && excludedBy(abs, cfg, where) === null ? cfg.decision : 'allow';
}

/** The delete guard's decision when it is on, else allow: a document delete the document guard asks about takes the stricter (0.22.0). */
function deleteDecision(bylaws: Bylaws): Decision {
  return bylaws.guards.delete?.decision ?? 'ask';
}

function bytesText(n: number): string {
  return `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} byte${n === 1 ? '' : 's'}`;
}

function occurrences(text: string, needle: string): number {
  if (needle === '') return 0;
  let n = 0;
  let at = text.indexOf(needle);
  while (at >= 0) {
    n++;
    at = text.indexOf(needle, at + needle.length);
  }
  return n;
}

interface Judged {
  rule: DocumentRule;
  reason: string;
  /** A delete (0.22.0): the decision is the stricter of this guard's and the delete guard's, so neither setting can weaken it. */
  merge?: true;
}

/** Why a write cannot be judged, in the words of the reason. */
function unknownWhy(action: Extract<Action, { kind: 'write' }>, change: WriteChange | undefined): string {
  if (change === undefined) return action.content === undefined ? `${action.tool} gives no new content` : `${action.tool} does not say which text its content replaces`;
  return 'the text was over the 262,144-byte cap and was cut';
}

/**
 * The judgement of one write onto an existing file of `size` bytes. Null when the write is fine. `doc` says whether the
 * file is a document; for any other file only emptying it counts.
 */
function judgeWrite(action: Extract<Action, { kind: 'write' }>, shown: string, abs: string, size: number, doc: boolean, cfg: DocumentBylaws, where: Where): Judged | null {
  const change = action.change;
  const content: ActionText | undefined = action.content;
  const syntax = doc ? syntaxOf(extOf(abs)) : null;
  if (change?.kind === 'delete') return doc ? { rule: 'document.delete', reason: `deletes the document ${shown} (${bytesText(size)})`, merge: true } : null;
  if (change === undefined || (change.kind !== 'replace' && content === undefined)) {
    return doc ? { rule: 'document.unknown', reason: `${unknownWhy(action, change)}, so openmorals cannot tell how much of the document ${shown} (${bytesText(size)}) it removes` } : null;
  }
  const needsText = doc && ((change.kind === 'whole' && syntax !== null) || (change.kind === 'replace' && (syntax !== null || change.edits.some((e) => e.all))));
  let fileText: string | null = null;
  if (needsText) {
    const p = where.readFile(abs, DOCUMENT_TEXT_MAX_BYTES);
    if (p.kind === 'error') return { rule: 'document.unreadable', reason: `cannot read the document ${shown} (${p.error}), so openmorals cannot tell how much this write removes` };
    fileText = p.kind === 'file' && p.text !== undefined ? p.text : null;
  }
  let newBytes: number;
  let cut: boolean;
  let lost: number | null = null;
  if (change.kind === 'whole' && content !== undefined) {
    cut = content.cut;
    newBytes = !cut && content.text.trim() === '' ? 0 : content.bytes;
  } else if (change.kind === 'lines' && content !== undefined) {
    cut = change.removed.cut || content.cut;
    newBytes = Math.max(0, size - change.removed.bytes + content.bytes + (content.bytes > 0 ? 1 : 0));
    if (!cut) lost = countHeadings(change.removed.text, syntax) - countHeadings(content.text, syntax);
  } else if (change.kind === 'replace') {
    if (!doc && change.edits.some((e) => e.all)) return null;
    cut = change.edits.some((e) => e.old.cut || e.new.cut);
    let delta = 0;
    let headings = 0;
    // With the file's text, the edits are applied to it in memory (as the host would), so headings are counted on the
    // whole text before and after, code fences included; without it, on the replaced and replacing text alone.
    let after = fileText;
    for (const e of change.edits) {
      let n = 1;
      if (after !== null && !e.old.cut && !e.new.cut) {
        if (e.all) {
          n = occurrences(after, e.old.text);
          if (n > 0) after = after.split(e.old.text).join(e.new.text);
        } else {
          const at = e.old.text === '' ? -1 : after.indexOf(e.old.text);
          n = at < 0 ? 0 : 1;
          if (at >= 0) after = `${after.slice(0, at)}${e.new.text}${after.slice(at + e.old.text.length)}`;
        }
      } else {
        if (e.all) {
          return { rule: 'document.unknown', reason: `${action.tool} replaces every occurrence, and openmorals cannot count them in the document ${shown} (${bytesText(size)}; ${fileText === null ? 'it is over the 262,144 bytes openmorals reads' : 'the text to replace was cut'}), so it cannot tell how much is removed` };
        }
        after = null;
      }
      if (!e.old.cut && !e.new.cut) headings += n * (countHeadings(e.old.text, syntax) - countHeadings(e.new.text, syntax));
      delta += n * (e.new.bytes - e.old.bytes);
    }
    newBytes = Math.max(0, size + delta);
    lost = after !== null && fileText !== null ? countHeadings(fileText, syntax) - countHeadings(after, syntax) : headings;
  } else return null;
  if (size > 0 && newBytes === 0) return { rule: 'document.empty', reason: `leaves ${doc ? 'the document ' : ''}${shown} empty (it holds ${bytesText(size)})` };
  if (!doc) return null;
  const removed = size - newBytes;
  if (removed > 0 && removed >= cfg.min_removed_bytes && removed * 100 > cfg.shrink_percent * size) {
    const pct = Math.round((removed * 100) / size);
    return { rule: 'document.shrink', reason: `removes ${bytesText(removed)} of the ${bytesText(size)} in the document ${shown} (${pct}%; openmorals asks above ${cfg.shrink_percent}%)` };
  }
  if (change.kind === 'whole' && syntax !== null && !cut) {
    if (fileText === null) return { rule: 'document.unknown', reason: `the document ${shown} is over the 262,144 bytes openmorals reads, so it cannot tell whether this write removes a heading` };
    lost = countHeadings(fileText, syntax) - countHeadings(content?.text ?? '', syntax);
  }
  if (lost !== null && lost > 0) return { rule: 'document.heading', reason: `removes ${lost === 1 ? 'a heading' : `${lost} headings`} from the document ${shown}` };
  if (cut) return { rule: 'document.unknown', reason: `the text was over the 262,144-byte cap and was cut, so openmorals cannot judge this write to the document ${shown} from it` };
  return null;
}

function probeOf(abs: string, where: Where): FileProbe {
  return where.readFile(abs, 0);
}

function finding(cfg: DocumentBylaws, j: Judged, bylaws: Bylaws): Finding {
  return { decision: j.merge === true ? strictest(cfg.decision, deleteDecision(bylaws)) : cfg.decision, rule: j.rule, reason: j.reason };
}

function judgeWriteAction(action: Extract<Action, { kind: 'write' }>, cfg: DocumentBylaws, bylaws: Bylaws, where: Where): Finding[] {
  const abs = documentPath(action.path, where);
  if (abs === null || excludedBy(abs, cfg, where) !== null) return [];
  const doc = isDocument(abs, cfg);
  if (!doc && !mayEmpty(action)) return [];
  const p = probeOf(abs, where);
  const shown = shownPath(abs, where);
  if (p.kind === 'missing' || p.kind === 'other') return [];
  // A patch delete, or (with the delete guard on) a tool whose name says it deletes: the document the trash can take is
  // the delete guard's refusal, and one it cannot take is asked as a delete at the stricter of the two settings (0.22.0).
  const deletes = action.change?.kind === 'delete' || ((bylaws.guards.delete?.decision ?? 'ask') !== 'allow' && writeDeletes(action));
  if (deletes && doc && !documentOwns(abs, bylaws, where)) return [];
  if (p.kind === 'error') return [finding(cfg, { rule: 'document.unreadable', reason: `cannot read ${doc ? 'the document ' : ''}${shown} (${p.error}), so openmorals cannot tell how much this write removes`, ...(deletes ? { merge: true as const } : {}) }, bylaws)];
  if (deletes && doc) return [finding(cfg, { rule: 'document.delete', reason: `deletes the document ${shown} (${bytesText(p.bytes)})`, merge: true }, bylaws)];
  const j = judgeWrite(action, shown, abs, p.bytes, doc, cfg, where);
  return j === null ? [] : [finding(cfg, j, bylaws)];
}

/** Whether a write to a file that is not a document could leave it empty (the only case judged there). */
function mayEmpty(action: Extract<Action, { kind: 'write' }>): boolean {
  const c = action.change;
  const content = action.content;
  if (c === undefined) return false;
  if (c.kind === 'whole') return content !== undefined && !content.cut && content.text.trim() === '';
  if (c.kind === 'lines') return content !== undefined && content.bytes === 0;
  if (c.kind === 'replace') return c.edits.every((e) => !e.all && e.new.bytes === 0);
  return false;
}

/** The commands that delete the files they name (shared with the delete guard, 0.21.0). */
export const DELETERS: ReadonlySet<string> = new Set(['rm', 'unlink', 'del', 'erase', 'remove-item', 'ri']);
const CLEARERS = new Set(['clear-content', 'clc']);

/** The positional words of a command after options (and after `--`). */
export function positional(args: readonly string[], shell: SimpleCommand['shell']): string[] {
  const out: string[] = [];
  let end = false;
  for (const a of args) {
    if (!end && a === '--') {
      end = true;
      continue;
    }
    if (!end && isOptionWord(a, shell)) continue;
    out.push(a);
  }
  return out;
}

/** A command whose only output is nothing (or one newline), so a `>` redirect from it empties the target. */
export function emptier(c: SimpleCommand): boolean {
  const n = c.name;
  const a = c.args;
  if (n === '' || n === ':' || n === 'true') return true;
  if (n === 'echo') return a.length === 0 || a.every((x) => x === '-n' || x === '');
  if (n === 'printf') return a.length === 0 || (a.length === 1 && a[0] === '');
  if (n === 'cat' || n === 'type' || n === 'get-content') return a.length === 1 && NULL_DEVICES.has((a[0] ?? '').toLowerCase());
  return false;
}

/**
 * Commands that read the files they name and write what they make of them to standard output (0.22.0): with a `>`
 * redirect onto one of those files, the shell empties it before the command reads it (`sort f > f`).
 */
const FILTERS: ReadonlySet<string> = new Set([
  'cat', 'tac', 'nl', 'head', 'tail', 'sort', 'uniq', 'cut', 'paste', 'join', 'comm', 'grep', 'egrep', 'fgrep', 'rg',
  'sed', 'awk', 'gawk', 'mawk', 'nawk', 'jq', 'yq', 'fold', 'fmt', 'column', 'expand', 'unexpand', 'rev', 'iconv',
  'base64', 'xxd', 'od', 'hexdump', 'strings', 'wc', 'md5sum', 'sha1sum', 'sha256sum', 'shasum', 'cksum', 'diff',
  'type', 'get-content', 'gc', 'select-string', 'sls', 'findstr', 'more',
]);

/** Whether a command reads this file: named to a filter, or as its standard input (`< f`). */
export function readsFile(c: SimpleCommand, abs: string, from: Where): boolean {
  if (c.redirects.some((r) => r.op === '<' && documentPath(r.target, from) === abs)) return true;
  return FILTERS.has(c.name) && positional(c.args, c.shell).some((w) => documentPath(w, from) === abs);
}

export function isOverwrite(op: string): boolean {
  return op.includes('>') && !op.includes('>>') && !op.endsWith('>&') && op !== '<>';
}

/** The words a plain delete command names (`rm`, `unlink`, `del`, `erase`, `Remove-Item`, `git rm` without `--cached`), unless the destructive guard owns the command. */
function deletedWords(c: SimpleCommand, bylaws: Bylaws): string[] {
  if (bylaws.guards.destructive.decision !== 'allow' && destructiveCommandHit(c) !== null) return [];
  if (DELETERS.has(c.name)) return positional(c.args, c.shell);
  if (c.name === 'git') {
    const g = gitSub(c.args);
    if (g !== null && g.sub === 'rm' && !g.rest.includes('--cached')) return positional(g.rest, c.shell);
  }
  return [];
}

/** What one command's judgement needs from the rest of the call (0.22.0). */
interface Around {
  /** The project trash root, read once per call. */
  root: () => string;
  /** The delete guard is on: it judges moves into a temp folder and overwrites by mv/cp, documents included. */
  deleteOn: boolean;
  /** The earlier commands of the same pipeline (`cat f | sort > f`). */
  feeders: readonly SimpleCommand[];
}

type Existing = (word: string) => { abs: string; size: number; doc: boolean } | { error: string; abs: string; doc: boolean } | null;

/** Findings for one shell command: deletes, moves out of the project, overwrites and emptying of existing documents. */
function judgeCommand(c: SimpleCommand, cfg: DocumentBylaws, bylaws: Bylaws, where: Where, around: Around, at: string = resolve(where.cwd)): Judged[] {
  const out: Judged[] = [];
  const here = at === resolve(where.cwd);
  const from: Where = here ? where : { ...where, cwd: at };
  /** The word for the trash command, from the agent's working folder: the word itself unless a cd moved it. */
  const fromCwd = (word: string, abs: string): string => (here ? word : outsideProject(abs, where) ? abs : relative(resolve(where.cwd), abs));
  const existing: Existing = (word: string) => {
    const abs = documentPath(word, from);
    if (abs === null || excludedBy(abs, cfg, where) !== null) return null;
    const p = probeOf(abs, where);
    const doc = isDocument(abs, cfg);
    if (p.kind === 'error') return { error: p.error, abs, doc };
    if (p.kind !== 'file') return null;
    return { abs, size: p.bytes, doc };
  };
  const destructiveOwns = bylaws.guards.destructive.decision !== 'allow' && destructiveCommandHit(c) !== null;
  const name = c.name;
  const deleteTargets = deletedWords(c, bylaws);
  for (const t of deleteTargets.slice(0, 64)) {
    const e = existing(t);
    if (e === null || !e.doc) continue;
    // A document the trash can take is the delete guard's refusal, like any file (0.22.0).
    if (!documentOwns(e.abs, bylaws, where, around.root())) continue;
    if ('error' in e) out.push({ rule: 'document.unreadable', reason: `cannot read the document ${shownPath(e.abs, where)} (${e.error}), and ${name} would delete it`, merge: true });
    else out.push({ rule: 'document.delete', reason: `${name === 'git' ? 'git rm' : name} deletes the document ${shownPath(e.abs, where)} (${bytesText(e.size)})${trashHint([fromCwd(t, e.abs)])}`, merge: true });
  }
  if (CLEARERS.has(name)) {
    for (const t of positional(c.args, c.shell).slice(0, 64)) {
      const e = existing(t);
      if (e === null || 'error' in e) continue;
      if (e.size > 0) out.push({ rule: 'document.empty', reason: `${name} leaves ${e.doc ? 'the document ' : ''}${shownPath(e.abs, where)} empty (it holds ${bytesText(e.size)})` });
    }
  }
  if ((MOVES.has(name) || COPIES.has(name)) && !destructiveOwns) {
    const { dest, sources } = moveParts(c.args, c.shell);
    if (dest !== null && !NULL_DEVICES.has(dest.toLowerCase())) {
      const fromNull = sources.length === 1 && NULL_DEVICES.has((sources[0] ?? '').toLowerCase());
      const d = existing(dest);
      if (d !== null && !('error' in d)) {
        if (fromNull && d.size > 0) out.push({ rule: 'document.empty', reason: `${name} ${sources[0] ?? ''} leaves ${d.doc ? 'the document ' : ''}${shownPath(d.abs, where)} empty (it holds ${bytesText(d.size)})` });
        // With the delete guard on, a document replaced by mv or cp is its delete (0.22.0).
        else if (d.doc && !fromNull && !around.deleteOn) out.push({ rule: 'document.unknown', reason: `${name} replaces the document ${shownPath(d.abs, where)} (${bytesText(d.size)}) with another file, so openmorals cannot tell how much of it is removed` });
      }
      if (MOVES.has(name)) {
        const destAbs = documentPath(dest, from);
        // A move into a temp folder is the delete guard's delete of every file (0.22.0); any other move out keeps this ask.
        const toTemp = around.deleteOn && isTempDestination(dest, destAbs, around.root());
        for (const s of toTemp ? [] : sources.slice(0, 64)) {
          const e = existing(s);
          if (e === null || !e.doc || 'error' in e || destAbs === null) continue;
          const destProbe = probeOf(destAbs, where);
          const finalAbs = destProbe.kind === 'other' ? resolve(destAbs, e.abs.split(/[\\/]/).pop() ?? '') : destAbs;
          if (outsideProject(finalAbs, where) && !outsideProject(e.abs, where)) out.push({ rule: 'document.delete', reason: `${name} moves the document ${shownPath(e.abs, where)} (${bytesText(e.size)}) out of the project folder to ${shownPath(destAbs, where)}` });
        }
      }
    }
  }
  for (const r of c.redirects.slice(0, 64)) {
    if (!isOverwrite(r.op) || /^\d+$/.test(r.target) || NULL_DEVICES.has(r.target.toLowerCase())) continue;
    const e = existing(r.target);
    if (e === null || 'error' in e) continue;
    // A command that reads the file the redirect empties first (0.22.0): `sort f > f`, `cat f | sort > f`, `x < f > f`.
    const reader = e.size > 0 && !emptier(c) ? [c, ...around.feeders].find((f) => readsFile(f, e.abs, from)) : undefined;
    if (emptier(c)) {
      if (e.size > 0) out.push({ rule: 'document.empty', reason: `the redirect ${r.op} leaves ${e.doc ? 'the document ' : ''}${shownPath(e.abs, where)} empty (it holds ${bytesText(e.size)})` });
    } else if (reader !== undefined) {
      out.push({ rule: 'document.empty', reason: `the redirect ${r.op} empties ${e.doc ? 'the document ' : ''}${shownPath(e.abs, where)} (it holds ${bytesText(e.size)}) before ${reader.name} reads it, so its content is lost` });
    } else if (e.doc) {
      out.push({ rule: 'document.unknown', reason: `the redirect ${r.op} replaces the document ${shownPath(e.abs, where)} (${bytesText(e.size)}) with output openmorals cannot see, so it cannot tell how much is removed; use the agent's file-edit tool so the change can be checked, or >> to append` });
    }
  }
  return out;
}

export const documentGuard: Guard = {
  id: 'document',
  isHard: () => false,
  evaluate(ctx: GuardContext): Finding[] {
    // A policy object built without this section (older callers) gets the defaults, never nothing.
    const cfg = ctx.bylaws.guards.document ?? defaultDocumentBylaws();
    if (cfg.decision === 'allow') return [];
    const where = ctx.where ?? makeWhere();
    const a = ctx.action;
    if (a.kind === 'write') return judgeWriteAction(a, cfg, ctx.bylaws, where);
    if (a.kind !== 'exec' || ctx.parsed === null) return [];
    const out: Finding[] = [];
    const commands = ctx.parsed.commands.slice(0, 64);
    const places = commandPlaces(commands, where, pathFrom(where));
    let root: string | null = null;
    const deleteOn = (ctx.bylaws.guards.delete?.decision ?? 'ask') !== 'allow';
    commands.forEach((c, i) => {
      const place = places[i];
      const feeders: SimpleCommand[] = [];
      for (let j = i; j > 0 && commands[j]?.pipeIn === true; j--) {
        const f = commands[j - 1];
        if (f !== undefined) feeders.push(f);
      }
      const around: Around = { root: () => (root ??= trashRoot(where)), deleteOn, feeders };
      if (place === undefined || isHere(place, where)) {
        for (const j of judgeCommand(c, cfg, ctx.bylaws, where, around)) out.push(finding(cfg, j, ctx.bylaws));
        return;
      }
      // After a change of folder (0.21.1): each folder the command may run in, and an ask when one cannot be known.
      const seen = new Set<string>();
      for (const d of place.dirs) {
        for (const j of judgeCommand(c, cfg, ctx.bylaws, where, around, d)) {
          if (seen.has(j.reason)) continue;
          seen.add(j.reason);
          out.push(finding(cfg, j, ctx.bylaws));
        }
      }
      if (place.unknown !== null) {
        const doc = deletedWords(c, ctx.bylaws).find((w) => !isAbsolute(expandedPath(w, where) ?? '/') && isDocument(w, cfg));
        if (doc !== undefined) out.push(finding(cfg, { rule: 'document.unknown', reason: `${c.name === 'git' ? 'git rm' : c.name} deletes the document '${doc}' after ${place.unknown}, so openmorals cannot tell which file it is` }, ctx.bylaws));
      }
    });
    return out;
  },
};
