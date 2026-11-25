import { isAbsolute, relative, resolve } from 'node:path';
import { compileGlob } from '../diffclass/glob.js';
import type { FileProbe, Finding, Guard, GuardContext, Where } from '../guard.js';
import { makeWhere, quoteForReason } from '../guard.js';
import type { SimpleCommand } from '../shell.js';
import type { ActionText, Action, Bylaws, DocumentBylaws, WriteChange } from '../types.js';
import { destructiveCommandHit, gitSub, trashHint } from './destructive.js';

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

/** The absolute form of a path an action names: `~` and `$HOME`-style folder variables expanded, then made absolute from the working directory. Null when it is empty or still holds an unexpanded variable. */
export function documentPath(p: string, where: Where): string | null {
  const raw = stripQuotes(p.trim());
  if (raw === '' || raw.length > 4096 || /[\r\n\0]/.test(raw) || raw.includes('://')) return null;
  const tilde = /^~(?=$|[/\\])/.test(raw) ? `${where.home}${raw.slice(1)}` : raw;
  let unknown = false;
  const expanded = tilde.replace(VAR, (m: string, a?: string, b?: string) => {
    const v = where.vars[(a ?? b ?? '').toLowerCase()];
    if (v === undefined) unknown = true;
    return v ?? m;
  });
  if (unknown) return null;
  return isAbsolute(expanded) ? resolve(expanded) : resolve(where.cwd, expanded);
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
  if (change?.kind === 'delete') return doc ? { rule: 'document.delete', reason: `deletes the document ${shown} (${bytesText(size)})` } : null;
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

function finding(cfg: DocumentBylaws, j: Judged): Finding {
  return { decision: cfg.decision, rule: j.rule, reason: j.reason };
}

function judgeWriteAction(action: Extract<Action, { kind: 'write' }>, cfg: DocumentBylaws, where: Where): Finding[] {
  const abs = documentPath(action.path, where);
  if (abs === null || excludedBy(abs, cfg, where) !== null) return [];
  const doc = isDocument(abs, cfg);
  if (!doc && !mayEmpty(action)) return [];
  const p = probeOf(abs, where);
  const shown = quoteForReason(action.path);
  if (p.kind === 'missing' || p.kind === 'other') return [];
  if (p.kind === 'error') return [finding(cfg, { rule: 'document.unreadable', reason: `cannot read ${doc ? 'the document ' : ''}${shown} (${p.error}), so openmorals cannot tell how much this write removes` })];
  const j = judgeWrite(action, shown, abs, p.bytes, doc, cfg, where);
  return j === null ? [] : [finding(cfg, j)];
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

const DELETERS = new Set(['rm', 'unlink', 'del', 'erase', 'remove-item', 'ri']);
const MOVES = new Set(['mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item', 'rni']);
const COPIES = new Set(['cp', 'copy', 'copy-item', 'cpi', 'install', 'ditto']);
const CLEARERS = new Set(['clear-content', 'clc']);
const DEST_FLAGS = new Set(['-t', '--target-directory', '-destination', '-dest']);
const NULL_DEVICES = new Set(['/dev/null', 'nul', '$null']);

function isOptionWord(w: string, shell: SimpleCommand['shell']): boolean {
  if (w.startsWith('-') && w !== '-') return true;
  return shell === 'cmd' && /^\/[A-Za-z0-9?]{1,4}(:.*)?$/.test(w);
}

/** The positional words of a command after options (and after `--`). */
function positional(args: readonly string[], shell: SimpleCommand['shell']): string[] {
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

function moveParts(c: SimpleCommand): { dest: string | null; sources: string[] } {
  let dest: string | null = null;
  const pos: string[] = [];
  for (let i = 0; i < c.args.length; i++) {
    const w = c.args[i] ?? '';
    const lower = w.toLowerCase();
    const eq = lower.indexOf('=');
    if (eq > 0 && DEST_FLAGS.has(lower.slice(0, eq))) {
      dest = w.slice(eq + 1);
      continue;
    }
    if (DEST_FLAGS.has(lower) && i + 1 < c.args.length) {
      dest = c.args[i + 1] ?? null;
      i++;
      continue;
    }
    if (!isOptionWord(w, c.shell)) pos.push(w);
  }
  if (dest === null && pos.length >= 2) dest = pos.pop() ?? null;
  return { dest, sources: pos };
}

/** A command whose only output is nothing (or one newline), so a `>` redirect from it empties the target. */
function emptier(c: SimpleCommand): boolean {
  const n = c.name;
  const a = c.args;
  if (n === '' || n === ':' || n === 'true') return true;
  if (n === 'echo') return a.length === 0 || a.every((x) => x === '-n' || x === '');
  if (n === 'printf') return a.length === 0 || (a.length === 1 && a[0] === '');
  if (n === 'cat' || n === 'type' || n === 'get-content') return a.length === 1 && NULL_DEVICES.has((a[0] ?? '').toLowerCase());
  return false;
}

function isOverwrite(op: string): boolean {
  return op.includes('>') && !op.includes('>>') && !op.endsWith('>&') && op !== '<>';
}

/** Findings for one shell command: deletes, moves out of the project, overwrites and emptying of existing documents. */
function judgeCommand(c: SimpleCommand, cfg: DocumentBylaws, bylaws: Bylaws, where: Where): Judged[] {
  const out: Judged[] = [];
  const existing = (word: string): { abs: string; size: number; doc: boolean } | { error: string; abs: string; doc: boolean } | null => {
    const abs = documentPath(word, where);
    if (abs === null || excludedBy(abs, cfg, where) !== null) return null;
    const p = probeOf(abs, where);
    const doc = isDocument(abs, cfg);
    if (p.kind === 'error') return { error: p.error, abs, doc };
    if (p.kind !== 'file') return null;
    return { abs, size: p.bytes, doc };
  };
  const destructiveOwns = bylaws.guards.destructive.decision !== 'allow' && destructiveCommandHit(c) !== null;
  const name = c.name;
  const deleteTargets: string[] = [];
  if (DELETERS.has(name) && !destructiveOwns) deleteTargets.push(...positional(c.args, c.shell));
  if (name === 'git' && !destructiveOwns) {
    const g = gitSub(c.args);
    if (g !== null && g.sub === 'rm' && !g.rest.includes('--cached')) deleteTargets.push(...positional(g.rest, c.shell));
  }
  for (const t of deleteTargets.slice(0, 64)) {
    const e = existing(t);
    if (e === null || !e.doc) continue;
    if ('error' in e) out.push({ rule: 'document.unreadable', reason: `cannot read the document ${quoteForReason(t)} (${e.error}), and ${name} would delete it` });
    else out.push({ rule: 'document.delete', reason: `${name === 'git' ? 'git rm' : name} deletes the document ${quoteForReason(t)} (${bytesText(e.size)})${trashHint([t])}` });
  }
  if (CLEARERS.has(name)) {
    for (const t of positional(c.args, c.shell).slice(0, 64)) {
      const e = existing(t);
      if (e === null || 'error' in e) continue;
      if (e.size > 0) out.push({ rule: 'document.empty', reason: `${name} leaves ${e.doc ? 'the document ' : ''}${quoteForReason(t)} empty (it holds ${bytesText(e.size)})` });
    }
  }
  if ((MOVES.has(name) || COPIES.has(name)) && !destructiveOwns) {
    const { dest, sources } = moveParts(c);
    if (dest !== null && !NULL_DEVICES.has(dest.toLowerCase())) {
      const fromNull = sources.length === 1 && NULL_DEVICES.has((sources[0] ?? '').toLowerCase());
      const d = existing(dest);
      if (d !== null && !('error' in d)) {
        if (fromNull && d.size > 0) out.push({ rule: 'document.empty', reason: `${name} ${sources[0] ?? ''} leaves ${d.doc ? 'the document ' : ''}${quoteForReason(dest)} empty (it holds ${bytesText(d.size)})` });
        else if (d.doc && !fromNull) out.push({ rule: 'document.unknown', reason: `${name} replaces the document ${quoteForReason(dest)} (${bytesText(d.size)}) with another file, so openmorals cannot tell how much of it is removed` });
      }
      if (MOVES.has(name)) {
        const destAbs = documentPath(dest, where);
        for (const s of sources.slice(0, 64)) {
          const e = existing(s);
          if (e === null || !e.doc || 'error' in e || destAbs === null) continue;
          const destProbe = probeOf(destAbs, where);
          const finalAbs = destProbe.kind === 'other' ? resolve(destAbs, e.abs.split(/[\\/]/).pop() ?? '') : destAbs;
          if (outsideProject(finalAbs, where) && !outsideProject(e.abs, where)) out.push({ rule: 'document.delete', reason: `${name} moves the document ${quoteForReason(s)} (${bytesText(e.size)}) out of the project folder to ${quoteForReason(dest)}` });
        }
      }
    }
  }
  for (const r of c.redirects.slice(0, 64)) {
    if (!isOverwrite(r.op) || /^\d+$/.test(r.target) || NULL_DEVICES.has(r.target.toLowerCase())) continue;
    const e = existing(r.target);
    if (e === null || 'error' in e) continue;
    if (emptier(c)) {
      if (e.size > 0) out.push({ rule: 'document.empty', reason: `the redirect ${r.op} leaves ${e.doc ? 'the document ' : ''}${quoteForReason(r.target)} empty (it holds ${bytesText(e.size)})` });
    } else if (e.doc) {
      out.push({ rule: 'document.unknown', reason: `the redirect ${r.op} replaces the document ${quoteForReason(r.target)} (${bytesText(e.size)}) with output openmorals cannot see, so it cannot tell how much is removed; use the agent's file-edit tool so the change can be checked, or >> to append` });
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
    if (a.kind === 'write') return judgeWriteAction(a, cfg, where);
    if (a.kind !== 'exec' || ctx.parsed === null) return [];
    const out: Finding[] = [];
    for (const c of ctx.parsed.commands.slice(0, 64)) for (const j of judgeCommand(c, cfg, ctx.bylaws, where)) out.push(finding(cfg, j));
    return out;
  },
};
