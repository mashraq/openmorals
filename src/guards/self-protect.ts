import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { Finding, Guard, GuardContext, Where } from '../guard.js';
import { makeWhere, normalizePath, quoteForReason } from '../guard.js';
import type { SimpleCommand } from '../shell.js';

/**
 * Git hook files and the files of hook managers (0.32.0): what git runs before a commit or a push. In the default list, so
 * an agent asks before it edits, moves or removes the checks it is judged by.
 */
export const GIT_HOOK_FILES: readonly RegExp[] = [
  /(^|\/)\.git\/hooks(\/|$)/,
  /(^|\/)\.husky(\/|$)/,
  /(^|\/)\.githooks(\/|$)/,
  /(^|\/)\.pre-commit-config\.ya?ml$/,
  /(^|\/)\.?lefthook(-local)?\.ya?ml$/,
  /(^|\/)\.?lefthook(-local)?\.(json|toml)$/,
  /(^|\/)\.simple-git-hooks\.(c?js|json)$/,
  /(^|\/)\.overcommit\.yml$/,
];

const PROTECTED = [
  /(^|\/)openmorals\.ya?ml$/,
  /(^|\/)\.claude\/settings(\.local)?\.json$/,
  /(^|\/)openmorals\/(audit\.jsonl|sessions|orders|order-templates)(\/|$)/,
  /(^|\/)\.openmorals(\/|$)/,
  // the config directory at its default places, whatever the environment of the hook says
  /(^|\/)(\.config|appdata\/roaming)\/openmorals(\/|$)/,
  // the hook and plugin configuration of the other hosts (Codex, Gemini CLI, opencode)
  /(^|\/)\.codex\/(hooks\.json|config\.toml|requirements\.toml)$/,
  /(^|\/)codex\/(hooks\.json|requirements\.toml)$/,
  /(^|\/)\.gemini\/settings\.json$/,
  /(^|\/)gemini-cli\/settings\.json$/,
  /(^|\/)\.?opencode\/plugins?(\/|$)/,
  /(^|\/)opencode\.jsonc?$/,
  /(^|\/)\.?openclaw\/(plugins|extensions)(\/|$)/,
  /(^|\/)openclaw\.json$/,
  // git hooks and hook managers (0.32.0): the checks git runs before a commit or push are a gate the agent must not edit
  ...GIT_HOOK_FILES,
];

const READ_ONLY = new Set([
  'cat', 'less', 'more', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'bat', 'wc', 'diff', 'ls', 'stat', 'file', 'jq',
  'get-content', 'gc', 'type', 'select-string', 'sls', 'test', '[', 'echo', 'readlink', 'realpath', 'md5sum', 'sha256sum', 'shasum',
  'cd', 'pushd', 'popd', 'chdir', 'pwd', 'du', 'tree', 'nl', 'od', 'xxd', 'hexdump', 'strings', 'cksum', 'sha1sum', 'sha512sum', 'b2sum',
  'set-location', 'sl', 'get-childitem', 'gci', 'dir', 'get-item', 'gi', 'test-path', 'resolve-path', 'get-filehash',
]);

/** Commands that move or rename: a source that is the config directory's ancestor takes the directory with it. */
const MOVES = new Set(['mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item', 'rni']);
/** Commands that copy onto a destination: only what lands under the destination matters. */
const COPIES = new Set(['cp', 'copy', 'copy-item', 'cpi', 'install', 'ditto']);
/** Commands where any ancestor argument may reach the config directory. */
const REACHES = new Set([
  'rm', 'rmdir', 'unlink', 'del', 'erase', 'rd', 'remove-item', 'ri', 'shred', 'srm', 'trash', 'trash-put', 'gio',
  'chmod', 'chown', 'chgrp', 'chattr', 'chflags', 'setfacl', 'icacls', 'cacls', 'takeown', 'attrib', 'set-acl', 'clear-content', 'clc',
  'truncate', 'mount', 'umount',
  'ln', 'link', 'mklink', 'new-item', 'ni',
  'rsync', 'robocopy', 'xcopy',
  'unzip', '7z', '7za', 'expand-archive', 'cpio',
]);
const ARCHIVERS = new Set(['tar', 'bsdtar', 'gtar']);
const LINKERS = new Set(['ln', 'link', 'mklink', 'new-item', 'ni']);
const INTERPRETER = /^(python|py|node|nodejs|perl|ruby|php|bun|deno|lua|rscript|osascript)[\d.]*$/;
const FIND_ACTIONS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fls']);
const DEST_FLAGS = new Set(['-t', '--target-directory', '-destination', '-dest']);

const CHANGES_RECORDS = new Set(['init', 'purge']);
/** Subcommands that grant what only the person may grant (0.19.0): approving a held action, and the planned release and accept. */
const PERSON_ONLY = new Set(['approve', 'release', 'accept']);
/** The built entry point of the openmorals package, run by a script interpreter (`node .../openmorals/dist/src/cli.js`). */
const OPENMORALS_ENTRY = /(^|\/)openmorals(@[^/]*)?\/(dist\/)?src\/cli\.(m?js|ts)$|(^|\/)node_modules\/\.bin\/openmorals$/;
const SCRIPT_RUNNERS = /^(node|nodejs|bun|deno|tsx|ts-node)[\d.]*$/;

/** Link resolutions one decision may spend; past it the guard asks rather than judge what it did not resolve. */
export const MAX_RESOLVED = 512;

function canon(p: string): string {
  const n = normalizePath(p);
  return n.length > 1 ? n.replace(/\/+$/, '') || '/' : n;
}

function prefixOf(dir: string): string {
  return dir.endsWith('/') ? dir : `${dir}/`;
}

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}

export function isProtectedPath(path: string): boolean {
  const p = stripQuotes(normalizePath(path));
  return PROTECTED.some((re) => re.test(p));
}

const VAR = /\$env:([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_]*)%/g;

function expandFolders(s: string, w: Where): string {
  const t = /^~(?=$|[/\\])/.test(s) ? `${w.home}${s.slice(1)}` : s;
  return t.replace(VAR, (m: string, a?: string, b?: string, c?: string, d?: string) => w.vars[(a ?? b ?? c ?? d ?? '').toLowerCase()] ?? m);
}

const WIN_ABS = /^([A-Za-z]:[\\/]|\\\\)/;
/** A piece cut out of a longer word is resolved through links only when it looks like a path. */
const PATHISH = /[/\\]|^[~$%.]/;

/** Where the guard looks: the config directory as named and as resolved, and the home directory. */
interface Scope {
  where: Where;
  cfgs: string[];
  homes: string[];
  budget: { left: number };
  seen: Map<string, string[]>;
}

function scopeOf(where: Where): Scope {
  const budget = { left: MAX_RESOLVED };
  // On Windows a path such as `/srv/state` has no drive; resolve() gives it the one relative arguments get.
  const cfgAbs = WIN_ABS.test(where.configDir) ? where.configDir : resolve(where.configDir);
  const cfgs = [...new Set([canon(where.configDir), canon(cfgAbs), canon(where.realpath(cfgAbs))])];
  const homes = [...new Set([canon(where.home), canon(where.realpath(where.home))])];
  return { where, cfgs, homes, budget, seen: new Map<string, string[]>() };
}

class TooManyPaths extends Error {}

/** The forms one word may name: as written, with folder variables expanded, made absolute, and resolved through links. */
function forms(word: string, s: Scope, base?: string, links = true): string[] {
  const key = `${links ? 1 : 0}\0${base ?? ''}\0${word}`;
  const known = s.seen.get(key);
  if (known !== undefined) return known;
  const found = formsOf(word, s, base, links);
  s.seen.set(key, found);
  return found;
}

function formsOf(word: string, s: Scope, base: string | undefined, links: boolean): string[] {
  const raw = stripQuotes(word);
  if (raw === '' || raw.length > 4096 || /[\r\n\0]/.test(raw)) return raw === '' ? [] : [canon(raw)];
  const expanded = expandFolders(raw, s.where);
  const out = new Set([canon(raw), canon(expanded)]);
  if (expanded.includes('://')) return [...out];
  const winForm = WIN_ABS.test(expanded);
  if (winForm && process.platform !== 'win32') return [...out];
  const abs = isAbsolute(expanded) ? expanded : resolve(base ?? s.where.cwd, expanded);
  const bare = !isAbsolute(expanded) && !/^[.~]|[/\\]/.test(expanded);
  if (bare && !s.where.exists(abs)) return [...out];
  out.add(canon(abs));
  if (!links) return [...out];
  if (--s.budget.left < 0) throw new TooManyPaths();
  out.add(canon(s.where.realpath(abs)));
  return [...out];
}

function inConfig(p: string, s: Scope): boolean {
  return s.cfgs.some((c) => p === c || p.startsWith(prefixOf(c)));
}

function isAncestor(p: string, s: Scope): boolean {
  return s.cfgs.some((c) => p !== c && c.startsWith(prefixOf(p)));
}

/** An ancestor below the home folder (or two folders deep outside it): naming one in code is unusual enough to ask. */
function isDeepAncestor(p: string, s: Scope): boolean {
  if (!isAncestor(p, s)) return false;
  if (s.homes.some((h) => h === p || h.startsWith(prefixOf(p)))) return false;
  return p.replace(/^[a-z]:/, '').split('/').filter((x) => x !== '').length >= 2;
}

interface Hit {
  word: string;
  how: 'pattern' | 'config' | 'ancestor';
  resolved: string | null;
}

function protectedHit(word: string, s: Scope, base?: string, links = true): Hit | null {
  if (isProtectedPath(word)) return { word, how: 'pattern', resolved: null };
  const fs = forms(word, s, base, links);
  for (const f of fs) {
    if (PROTECTED.some((re) => re.test(f))) return { word, how: 'pattern', resolved: f };
    if (inConfig(f, s)) return { word, how: 'config', resolved: f };
  }
  return null;
}

function ancestorHit(word: string, s: Scope, deepOnly: boolean, base?: string, links = true): Hit | null {
  for (const f of forms(word, s, base, links)) {
    if (deepOnly ? isDeepAncestor(f, s) : isAncestor(f, s)) return { word, how: 'ancestor', resolved: f };
  }
  return null;
}

/** The parts of a word that may be paths: the word itself, then the pieces between quotes, spaces, brackets and similar. */
function pieces(word: string): string[] {
  const parts = word.split(/[\s'"`,;()[\]{}<>|&=+]+/).filter((x) => x !== '' && x !== word);
  return [word, ...parts];
}

function isOptionWord(w: string, shell: SimpleCommand['shell']): boolean {
  if (w.startsWith('-') && w !== '-') return true;
  return shell === 'cmd' && /^\/[A-Za-z0-9?]{1,4}(:.*)?$/.test(w);
}

function positionalOf(c: SimpleCommand): { dest: string | null; sources: string[] } {
  const positional: string[] = [];
  let dest: string | null = null;
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
    if (!isOptionWord(w, c.shell)) positional.push(w);
  }
  if (dest === null && positional.length >= 2) dest = positional.pop() ?? null;
  return { dest, sources: positional };
}

function tarChanges(c: SimpleCommand): boolean {
  const first = c.args[0] ?? '';
  return c.args.some((a) => /^-[A-Za-z]*x[A-Za-z]*$/.test(a) || ['--extract', '--get', '--delete', '--remove-files'].includes(a)) || /^[A-Za-z]*x[A-Za-z]*$/.test(first);
}

/** The ancestor of the config directory this command would move, remove, overwrite or link, if any. */
function ancestorUse(c: SimpleCommand, s: Scope): Hit | null {
  const name = c.name;
  const words = c.args.filter((a) => !isOptionWord(a, c.shell));
  if (MOVES.has(name) || COPIES.has(name)) {
    const { dest, sources } = positionalOf(c);
    if (MOVES.has(name)) {
      for (const src of sources) {
        const h = ancestorHit(src, s, false);
        if (h !== null) return h;
      }
    }
    if (dest !== null) {
      const d = ancestorHit(dest, s, false);
      if (d !== null) {
        if (sources.length === 0) return d;
        for (const src of sources) {
          const landed = join(d.resolved ?? dest, basename(stripQuotes(expandFolders(src, s.where))));
          const f = canon(landed);
          if (f === canon(d.resolved ?? dest) || isAncestor(f, s) || inConfig(f, s)) return { word: dest, how: 'ancestor', resolved: f };
        }
      }
    }
    return null;
  }
  const reaches =
    REACHES.has(name) ||
    (ARCHIVERS.has(name) && tarChanges(c)) ||
    (name === 'find' && c.args.some((a) => FIND_ACTIONS.has(a)));
  if (!reaches) return null;
  for (const w of words) {
    const h = ancestorHit(w, s, false);
    if (h !== null) return h;
  }
  return null;
}

/** For a link, a relative target is read from the link's folder, not from the working directory. */
function linkTargetHit(c: SimpleCommand, s: Scope): Hit | null {
  const words = c.args.filter((a) => !isOptionWord(a, c.shell)).map(stripQuotes);
  for (const t of words) {
    const e = expandFolders(t, s.where);
    if (isAbsolute(e) || WIN_ABS.test(e)) continue;
    for (const other of words) {
      if (other === t) continue;
      const at = resolve(s.where.cwd, expandFolders(other, s.where));
      for (const base of [dirname(at), at]) {
        const h = protectedHit(t, s, base) ?? ancestorHit(t, s, false, base);
        if (h !== null) return h;
      }
    }
  }
  return null;
}

/** Whether a path is a git hook or a hook manager's file (0.32.0). */
export function isGitHookPath(path: string): boolean {
  const p = stripQuotes(normalizePath(path));
  return GIT_HOOK_FILES.some((re) => re.test(p));
}

/** What a protected path is, for a reason: a git hook (0.32.0), or the guard's own configuration or records. */
function protectedWhat(...paths: readonly (string | null)[]): string {
  return paths.some((p) => p !== null && isGitHookPath(p)) ? 'a git hook or hook manager file, a check git runs before a commit or push' : "the guard's own configuration or records";
}

function hitReason(name: string, h: Hit): string {
  const via = h.resolved !== null && canon(stripQuotes(h.word)) !== h.resolved ? ` (it resolves to ${quoteForReason(h.resolved, 60)})` : '';
  if (h.how === 'ancestor') return `${name} may move, remove or replace ${quoteForReason(h.word, 60)}${via}, which holds the guard's own configuration directory`;
  return `${name} may change or remove ${quoteForReason(h.word, 60)}${via}, ${protectedWhat(h.word, h.resolved)}`;
}

/**
 * Pointing git at other hooks (0.32.0): `git config core.hooksPath <dir>` (any scope) or `git -c core.hooksPath=<dir> ...`
 * makes git skip the project's own hooks. Reading or unsetting the setting is not asked about.
 */
function hooksPathChange(c: SimpleCommand): string | null {
  if (c.name !== 'git') return null;
  const a = c.args.map((x) => stripQuotes(x));
  for (let i = 0; i < a.length; i++) {
    const w = a[i] ?? '';
    if (!w.startsWith('-')) break;
    const v = w === '-c' ? (a[i + 1] ?? '') : w.startsWith('-c') ? w.slice(2) : w.startsWith('--config-env=') ? w.slice(13) : '';
    if (/^core\.hookspath(=|$)/i.test(v)) return 'git -c core.hooksPath runs this command with other hooks than the project\'s own, so its commit and push checks would not run';
    if (w === '-c' || w === '-C' || w === '--git-dir' || w === '--work-tree' || w === '--namespace') i++;
  }
  let sub = -1;
  for (let i = 0; i < a.length; i++) {
    const w = a[i] ?? '';
    if (w === '-c' || w === '-C' || w === '--git-dir' || w === '--work-tree' || w === '--namespace') {
      i++;
      continue;
    }
    if (!w.startsWith('-') && w !== '') {
      sub = i;
      break;
    }
  }
  if (sub === -1 || a[sub] !== 'config') return null;
  const rest = a.slice(sub + 1);
  if (rest.some((x) => /^--(get|get-all|get-regexp|list|unset|unset-all|show-origin|show-scope)$|^-l$/.test(x) || x === 'get' || x === 'list' || x === 'unset')) return null;
  const key = rest.findIndex((x) => /^core\.hookspath$/i.test(x));
  if (key === -1) return null;
  const value = rest.slice(key + 1).find((x) => !x.startsWith('-'));
  if (value === undefined) return null;
  return `git config core.hooksPath points git at other hooks (${quoteForReason(value, 60)}), so the project's own commit and push checks would not run`;
}

const PACKAGE_RUNNERS = new Set(['npx', 'bunx', 'pnpx']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const PACKAGE_EXEC = new Set(['exec', 'x', 'dlx']);
const OPENMORALS_PACKAGE = /^openmorals(@[^\s/]*)?$/;

/**
 * The arguments of openmorals started through a package runner (`npx openmorals ...`, `npm exec openmorals ...`,
 * `pnpm dlx openmorals ...`) or as a Python module (`python -m openmorals ...`), or null. A direct `node <file>` is
 * not recognised, because every script file can be the command line: the limit a program running as the user always has.
 */
function launchedOpenmorals(c: SimpleCommand): readonly string[] | null {
  const a = c.args;
  if (SCRIPT_RUNNERS.test(c.name)) {
    const script = a.findIndex((w) => !w.startsWith('-'));
    const w = script === -1 ? '' : normalizePath(stripQuotes(a[script] ?? ''));
    if (OPENMORALS_ENTRY.test(w)) return a.slice(script + 1);
  }
  let from = -1;
  if (PACKAGE_RUNNERS.has(c.name)) from = 0;
  else if (PACKAGE_MANAGERS.has(c.name) && PACKAGE_EXEC.has(a[0] ?? '')) from = 1;
  else if (/^python[\d.]*$|^py$/.test(c.name)) {
    const m = a.indexOf('-m');
    return m !== -1 && a[m + 1] === 'openmorals' ? a.slice(m + 2) : null;
  }
  if (from === -1) return null;
  for (let i = from; i < a.length; i++) {
    const w = a[i] ?? '';
    if (w === '--') continue;
    if (OPENMORALS_PACKAGE.test(w)) {
      let rest = a.slice(i + 1);
      if (OPENMORALS_PACKAGE.test(rest[0] ?? '')) rest = rest.slice(1);
      return rest[0] === '--' ? rest.slice(1) : rest;
    }
    if (!w.startsWith('-')) return null;
  }
  return null;
}

/**
 * `openmorals audit sample` in any form that writes: a draw, `--record` or `--change`. `--tally` and help only read; they
 * count only before `--`, because the words after it are a verdict's note and the command still writes.
 */
function writesSample(args: readonly string[]): boolean {
  const end = args.indexOf('--');
  const head = end === -1 ? args : args.slice(0, end);
  const at = head.indexOf('audit');
  if (at === -1 || args[at + 1] !== 'sample') return false;
  return !head.some((a) => a === '--tally' || a === '--help' || a === '-h');
}

/**
 * `openmorals order approve` and `order baseline` (0.27.0): approving a work order, or recording the version
 * a check compares with, is the person's. Help only reads; `new` and `check` are anyone's.
 */
function personOnlyOrder(args: readonly string[]): string | null {
  const end = args.indexOf('--');
  const head = end === -1 ? args : args.slice(0, end);
  const at = head.indexOf('order');
  if (at === -1) return null;
  const sub = head.slice(at + 1).find((a) => !a.startsWith('-'));
  if (sub !== 'approve' && sub !== 'baseline') return null;
  return head.some((a) => a === '--help' || a === '-h') ? null : sub;
}

function isReadOnly(c: SimpleCommand): boolean {
  if (c.name === 'find') return !c.args.some((a) => FIND_ACTIONS.has(a));
  return READ_ONLY.has(c.name) && !c.args.some((x) => x === '-i' || x.startsWith('--in-place'));
}

function judgeCommand(c: SimpleCommand, s: Scope): string | null {
  for (const r of c.redirects) {
    if (r.op.includes('<')) continue;
    const h = protectedHit(r.target, s);
    if (h !== null) {
      const via = h.resolved !== null && canon(stripQuotes(r.target)) !== h.resolved ? ` (it resolves to ${quoteForReason(h.resolved, 60)})` : '';
      return `output is redirected onto ${quoteForReason(r.target, 60)}${via}, ${protectedWhat(r.target, h.resolved)}`;
    }
  }
  const om = c.name === 'openmorals' ? c.args : launchedOpenmorals(c);
  if (om !== null) {
    const sub = om.find((x) => !x.startsWith('-'));
    if (sub !== undefined && CHANGES_RECORDS.has(sub)) return `openmorals ${sub} changes the guard's own configuration, hook settings or trash`;
    if (sub !== undefined && PERSON_ONLY.has(sub)) return `openmorals ${sub} grants what only the person may grant; an agent cannot approve its own request`;
    if (sub === 'audit' && writesSample(om)) return "openmorals audit sample writes a draw, a verdict or a declared change into the guard's own records: drawing and judging a sample is the person's";
    const orderSub = sub === 'order' ? personOnlyOrder(om) : null;
    if (orderSub !== null) return `openmorals order ${orderSub} ${orderSub === 'approve' ? 'approves a work order' : 'records what a work order is checked against'}, which only the person may do; an agent cannot approve the order its own work is checked against`;
  }
  if (c.name === 'openmorals') {
    const sub = c.args.find((x) => !x.startsWith('-'));
    if (sub === 'trash') {
      for (const w of c.args.filter((a) => !a.startsWith('-') && a !== 'trash')) {
        const h = protectedHit(w, s) ?? ancestorHit(w, s, false);
        if (h !== null) return hitReason('openmorals trash', h);
      }
    }
    return null;
  }
  if (isReadOnly(c)) return null;
  const hooks = hooksPathChange(c);
  if (hooks !== null) return hooks;
  if (c.name === 'git' && ['diff', 'log', 'show', 'status', 'add', 'commit', 'blame'].includes(c.args.find((x) => !x.startsWith('-')) ?? '')) return null;
  const interpreter = INTERPRETER.test(c.name);
  for (const arg of c.args) {
    for (const p of pieces(arg)) {
      const links = p === arg || PATHISH.test(p);
      if (p !== arg || !isOptionWord(arg, c.shell)) {
        const h = protectedHit(p, s, undefined, links);
        if (h !== null) return hitReason(c.name, h);
      }
      if (interpreter && p !== arg) {
        const a = ancestorHit(p, s, true, undefined, links);
        if (a !== null) return hitReason(c.name, a);
      }
    }
  }
  const anc = ancestorUse(c, s);
  if (anc !== null) return hitReason(c.name, anc);
  if (LINKERS.has(c.name)) {
    const l = linkTargetHit(c, s);
    if (l !== null) return `${c.name} makes a link to ${quoteForReason(l.word, 60)}, which resolves to ${quoteForReason(l.resolved ?? l.word, 60)}, ${protectedWhat(l.word, l.resolved)}`;
  }
  return null;
}

export const selfProtectGuard: Guard = {
  id: 'self-protect',
  isHard: () => false,
  evaluate(ctx: GuardContext): Finding[] {
    const cfg = ctx.bylaws.guards['self-protect'];
    if (cfg.decision === 'allow') return [];
    const a = ctx.action;
    if (a.kind !== 'write' && (a.kind !== 'exec' || ctx.parsed === null)) return [];
    const s = scopeOf(ctx.where ?? makeWhere());
    try {
      if (a.kind === 'write') {
        const h = protectedHit(a.path, s);
        if (h === null) return [];
        const via = h.resolved !== null && canon(a.path) !== h.resolved && h.how === 'config' ? `, which resolves to ${quoteForReason(h.resolved, 60)}` : '';
        return [{ decision: cfg.decision, rule: 'self-protect.write', reason: `${a.tool} changes ${protectedWhat(a.path, h.resolved)} (${quoteForReason(a.path, 60)}${via})` }];
      }
      for (const c of ctx.parsed?.commands ?? []) {
        const why = judgeCommand(c, s);
        if (why !== null) return [{ decision: cfg.decision, rule: 'self-protect.write', reason: why }];
      }
    } catch (err: unknown) {
      if (!(err instanceof TooManyPaths)) throw err;
      return [{ decision: cfg.decision, rule: 'self-protect.write', reason: `the command names more than ${MAX_RESOLVED} paths, too many to check for links into the guard's own configuration or records` }];
    }
    return [];
  },
};
