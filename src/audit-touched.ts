// `openmorals audit touched <glob>` (0.40.0): which recorded calls named a path under a glob, read back from the audit
// log. A report only: it reads the log and changes nothing, and it is never an ask.
import { readFileSync } from 'node:fs';
import { isAbsolute, posix, relative } from 'node:path';
import type { AuditRecord } from './audit.js';
import { parseAuditLine } from './audit.js';
import { verifyAudit } from './audit-verify.js';
import { compileGlob, globProblem } from './diffclass/glob.js';
import { auditLogPath, configDir } from './paths.js';

export interface TouchedResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const TOUCHED_USAGE = `  openmorals audit touched <GLOB> [--run ID] [--session ID] [--file FILE] [--json]
      Lists the audit records that name a path under GLOB or a folder holding it
      (a path a tool read or wrote, a word of a command, a search's folder or
      pattern, a test file written), and the searches (a search tool, or rg,
      grep -r, git grep, ag, ack in a command) over a folder that holds or may
      hold it, grouped by run and session. GLOB is relative to each record's
      working folder (holdout/**). Ends with what it cannot see. A report, never
      an ask. Exit 1 when anything is listed; 0 when nothing is and the log
      verifies; 2 when it cannot tell (no log, no readable record, a log that
      does not verify, a log that cannot be read); 64 usage error.`;

/** What a report cannot see, printed under every report and in `--json` as `not_seen`. */
export const TOUCHED_NOT_SEEN: readonly string[] = [
  'Reads by a script, a test runner or an interpreter: `python scripts/peek.py` or `npm test` that opens the files itself is recorded as its command only, and the command does not name them.',
  'Work where no hook ran: a host without openmorals, a CI job, a cloud agent, your own editor or shell.',
  'Records from before the hook was installed, and records in another config folder or on another machine.',
  'What one agent told another: a handoff record keeps a fingerprint of the text, never the text.',
  'A name built at run time (a variable, `$(ls)`, a path in a file the command reads), a command run after `cd` into another folder, and a pattern that only overlaps GLOB (`**/*.yaml`).',
  'A path that leaves the working folder once `..` is resolved, and an absolute path in a record with no working folder: they are not matched.',
  'A shell search other than rg, grep -r, git grep, ag or ack (find -exec, a script), and a search tool with no folder recorded by an openmorals older than 0.40.0 (its record names no folder and no pattern).',
];

export type TouchedHow = 'named' | 'named-folder' | 'test-file' | 'searched-folder' | 'searched-folder-maybe';

export interface TouchedItem {
  /** 1-based index of the record among the records read. */
  record: number;
  /** 1-based line of the record in the log, or null when the caller gave none. */
  line: number | null;
  ts: string;
  source: string;
  tool: string;
  decision: string;
  rule: string;
  how: TouchedHow;
  /** The path or token that matched, as the record holds it. */
  matched: string;
  action: string;
}

export interface TouchedGroup {
  run: string | null;
  session: string | null;
  items: TouchedItem[];
}

export interface TouchedReport {
  glob: string;
  recordsRead: number;
  listed: number;
  groups: TouchedGroup[];
}

export interface TouchedFilter {
  run?: string;
  session?: string;
}

const MAX_ACTION = 200;
// Tolerates a pattern the audit's redaction rewrote (its quotes are then broken).
const SEARCH_NOTE = /\[search (.*?)( in the working folder)?\]$/;
const SPLIT = /[\s;|&<>()'"`=,]+/;

type Place = { kind: 'in'; rel: string } | { kind: 'ancestor' } | { kind: 'outside' };

/** Where a token of a record is, relative to the record's working folder: `..` resolved, POSIX style. */
function place(token: string, cwd: string | null): Place {
  const t = token.replace(/\\/g, '/');
  let rel: string;
  if (isAbsolute(t) || /^[A-Za-z]:\//.test(t)) {
    if (cwd === null) return { kind: 'outside' };
    rel = relative(cwd, t).replace(/\\/g, '/');
    if (rel === '') return { kind: 'in', rel: '.' };
    if (isAbsolute(rel)) return { kind: 'outside' };
  } else rel = t;
  const n = posix.normalize(rel).replace(/\/+$/, '');
  if (n === '..' || /^(\.\.\/)+\.\.$/.test(n)) return { kind: 'ancestor' };
  if (n.startsWith('../')) return { kind: 'outside' };
  return { kind: 'in', rel: n === '' ? '.' : n };
}

/** The fixed folder part of an anchored glob (`holdout` for `holdout/**`, `''` for `**\/x`), or null for a glob matched at any depth. */
function fixedPrefix(glob: string): string | null {
  const g = glob.replace(/\/+$/, '');
  if (!g.includes('/')) return null;
  const out: string[] = [];
  for (const s of g.split('/')) {
    if (/[*?]/.test(s)) break;
    out.push(s);
  }
  return out.join('/');
}

/** A path with its trailing filter segments cut (`src/*.ts` -> `src`, `*.json` -> `.`). */
function folderPart(rel: string): string {
  const out: string[] = [];
  for (const s of rel.split('/')) {
    if (/[*?]/.test(s)) break;
    out.push(s);
  }
  return out.length === 0 ? '.' : out.join('/');
}

const lower = (s: string): string => s.toLowerCase();
const within = (inner: string, outer: string): boolean => lower(inner) === lower(outer) || lower(inner).startsWith(`${lower(outer)}/`);

/** Whether a search over a folder reads files the glob covers: yes, maybe (it cannot tell), or no. */
function searchReach(token: string, cwd: string | null, test: (p: string) => boolean, prefix: string | null): 'holds' | 'may' | 'no' {
  const p = token === '' ? ({ kind: 'in', rel: '.' } as Place) : place(token, cwd);
  if (p.kind === 'ancestor') return 'holds';
  if (p.kind === 'outside') return 'no';
  const f = folderPart(p.rel);
  if (f === '.') return 'holds';
  if (test(f)) return 'holds';
  if (prefix === null || prefix === '') return 'may';
  if (within(prefix, f)) return 'holds';
  if (within(f, prefix)) return 'may';
  return 'no';
}

/** One shell word list per command of a command line (split at unquoted `;`, `&&`, `||`, `|`, newline), with whether it reads a pipe. */
function shellCommands(text: string): { words: string[]; piped: boolean }[] {
  const out: { words: string[]; piped: boolean }[] = [];
  let words: string[] = [];
  let cur = '';
  let has = false;
  let quote: string | null = null;
  let piped = false;
  const endWord = (): void => {
    if (has) words.push(cur);
    cur = '';
    has = false;
  };
  const endCmd = (nextPiped: boolean): void => {
    endWord();
    if (words.length > 0) out.push({ words, piped });
    words = [];
    piped = nextPiped;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote !== null) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < text.length) cur += text[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === '\\' && i + 1 < text.length) {
      cur += text[++i];
      has = true;
    } else if (c === ' ' || c === '\t') endWord();
    else if (c === ';' || c === '\n') endCmd(false);
    else if (c === '&' && text[i + 1] === '&') {
      i++;
      endCmd(false);
    } else if (c === '|' && text[i + 1] === '|') {
      i++;
      endCmd(false);
    } else if (c === '|') endCmd(true);
    else {
      cur += c;
      has = true;
    }
  }
  endCmd(false);
  return out;
}

const SEARCH_VALUE_OPTS: Readonly<Record<string, ReadonlySet<string>>> = {
  rg: new Set(['-e', '--regexp', '-f', '--file', '-g', '--glob', '--iglob', '-t', '--type', '-T', '--type-not', '-A', '-B', '-C', '--after-context', '--before-context', '--context', '-m', '--max-count', '-j', '--threads', '-M', '--max-columns', '-r', '--replace', '-d', '--max-depth', '--type-add', '--pre', '--sort', '--sortr', '-E', '--encoding']),
  grep: new Set(['-e', '--regexp', '-f', '--file', '-A', '-B', '-C', '-m', '--max-count', '--include', '--exclude', '--exclude-dir', '-d', '--directories', '--label', '--color', '--colour']),
  'git grep': new Set(['-e', '-f', '-A', '-B', '-C', '-m', '--max-count', '--max-depth', '--threads', '-O', '--open-files-in-pager']),
  ag: new Set(['-G', '--file-search-regex', '--ignore', '--ignore-dir', '-A', '-B', '-C', '-m', '--max-count', '--depth']),
  ack: new Set(['--type', '--ignore-dir', '--ignore-file', '-A', '-B', '-C', '-m', '--max-count', '-g']),
};

/**
 * The folders each recognised shell search of a command line reads (rg, grep -r, git grep, ag, ack), `['']` (the
 * working folder) when it names none. A search that reads a pipe reads no folder and is left out. A heuristic.
 */
export function shellSearchFolders(command: string): string[][] {
  const found: string[][] = [];
  for (const { words, piped } of shellCommands(command)) {
    let w = words;
    while (w.length > 0 && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0] as string) || ['sudo', 'env', 'exec', 'time', 'command', 'nice'].includes(w[0] as string))) w = w.slice(1);
    const head = (w[0] ?? '').replace(/^.*\//, '');
    let kind: string | null = null;
    let rest: string[] = [];
    if (head === 'git' && w[1] === 'grep') {
      kind = 'git grep';
      rest = w.slice(2);
    } else if (head === 'rg' || head === 'ag' || head === 'ack' || head === 'grep' || head === 'egrep' || head === 'fgrep') {
      kind = head === 'egrep' || head === 'fgrep' ? 'grep' : head;
      rest = w.slice(1);
    }
    if (kind === null) continue;
    const values = SEARCH_VALUE_OPTS[kind] as ReadonlySet<string>;
    const positional: string[] = [];
    let patternGiven = false;
    let recursive = kind !== 'grep';
    let afterDashes = false;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i] as string;
      if (afterDashes || !a.startsWith('-') || a === '-') {
        positional.push(a);
        continue;
      }
      if (a === '--') {
        afterDashes = true;
        continue;
      }
      if (kind === 'grep' && /^-[A-Za-z]*[rR]/.test(a) && !a.startsWith('--')) recursive = true;
      if (kind === 'grep' && (a === '--recursive' || a === '--dereference-recursive' || a === '--directories=recurse' || (a === '-d' && rest[i + 1] === 'recurse'))) recursive = true;
      const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
      if (name === '-e' || name === '--regexp' || name === '-f' || name === '--file') patternGiven = true;
      if (values.has(a)) i++;
    }
    if (!recursive || piped) continue;
    const folders = patternGiven ? positional : positional.slice(1);
    found.push(folders.length === 0 ? [''] : folders);
  }
  return found;
}

function matchOf(r: AuditRecord, test: (p: string) => boolean, prefix: string | null): { how: TouchedHow; matched: string } | null {
  const cwd = r.cwd;
  for (const t of r.tests ?? []) {
    const p = place(t, cwd);
    if (p.kind === 'in' && test(p.rel)) return { how: 'test-file', matched: t };
  }
  const note = SEARCH_NOTE.exec(r.action);
  const body = note !== null ? r.action.slice(0, note.index) : r.action;
  let pattern = '';
  if (note !== null) {
    try {
      const v: unknown = JSON.parse(note[1] as string);
      pattern = typeof v === 'string' ? v : '';
    } catch {
      pattern = '';
    }
  }
  let folderNamed: string | null = null;
  for (const tok of [...body.split(SPLIT), ...pattern.split(SPLIT)]) {
    if (tok === '' || tok === r.tool) continue;
    const p = place(tok, cwd);
    if (p.kind !== 'in') continue;
    if (p.rel !== '.' && test(p.rel)) return { how: 'named', matched: tok };
    if (folderNamed === null && prefix !== null && prefix !== '' && p.rel !== '.' && !/[*?]/.test(p.rel) && within(prefix, p.rel)) folderNamed = tok;
  }
  if (folderNamed !== null) return { how: 'named-folder', matched: folderNamed };
  const reach: { r: 'holds' | 'may'; matched: string }[] = [];
  if (note !== null) {
    const folderTokens = body.split(/\s+/).filter((x) => x !== '' && x !== r.tool);
    const folder = note[2] !== undefined ? '' : (folderTokens[0] ?? '');
    const res = searchReach(folder, cwd, test, prefix);
    if (res !== 'no') reach.push({ r: res, matched: folder === '' ? 'the working folder' : folder });
  } else {
    for (const folders of shellSearchFolders(r.action)) {
      for (const f of folders) {
        const res = searchReach(f, cwd, test, prefix);
        if (res !== 'no') reach.push({ r: res, matched: f === '' ? 'the working folder' : f });
      }
    }
  }
  const holds = reach.find((x) => x.r === 'holds');
  if (holds !== undefined) return { how: 'searched-folder', matched: holds.matched };
  const may = reach[0];
  if (may !== undefined) return { how: 'searched-folder-maybe', matched: may.matched };
  return null;
}

/** The touched report over audit records, oldest first as the log holds them. Pure. `lines` gives each record's log line. */
export function touchedReport(records: readonly AuditRecord[], glob: string, filter: TouchedFilter = {}, lines: readonly number[] = []): TouchedReport {
  const test = compileGlob(glob);
  const prefix = fixedPrefix(glob);
  const groups = new Map<string, TouchedGroup>();
  let listed = 0;
  records.forEach((r, i) => {
    const run = r.v === 2 ? (r.run ?? null) : null;
    if (filter.run !== undefined && run !== filter.run) return;
    if (filter.session !== undefined && r.session !== filter.session) return;
    const m = matchOf(r, test, prefix);
    if (m === null) return;
    const key = JSON.stringify([run, r.session]);
    const g = groups.get(key) ?? { run, session: r.session, items: [] };
    g.items.push({ record: i + 1, line: lines[i] ?? null, ts: r.ts, source: r.source, tool: r.tool, decision: r.decision, rule: r.rule, how: m.how, matched: m.matched, action: r.action.length > MAX_ACTION ? `${r.action.slice(0, MAX_ACTION)}…` : r.action });
    groups.set(key, g);
    listed++;
  });
  const sorted = [...groups.values()].sort((a, b) => (a.run ?? '').localeCompare(b.run ?? '') || (a.session ?? '').localeCompare(b.session ?? ''));
  return { glob, recordsRead: records.length, listed, groups: sorted };
}

const HOW_TEXT: Readonly<Record<TouchedHow, string>> = {
  named: 'names it',
  'named-folder': 'names a folder holding it',
  'test-file': 'wrote it as a test file',
  'searched-folder': 'searched a folder holding it',
  'searched-folder-maybe': 'searched a folder that may hold matches',
};

function format(r: TouchedReport, log: string): string {
  const out: string[] = [];
  if (r.listed === 0) out.push(`No record names a path under ${r.glob} (${r.recordsRead} records read from ${log}).`);
  else {
    out.push(`${r.listed} record${r.listed === 1 ? '' : 's'} name a path under ${r.glob} or search a folder that may hold it (${r.recordsRead} records read from ${log}):`);
    for (const g of r.groups) {
      out.push('', `run ${g.run ?? '(none)'}, session ${g.session ?? 'unknown'}:`);
      for (const i of g.items) out.push(`  ${i.line !== null ? `line ${i.line}  ` : ''}${i.ts}  ${i.decision.toUpperCase().padEnd(5)} ${i.source} ${i.tool}: ${HOW_TEXT[i.how]} (${i.matched}): ${i.action.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
  }
  out.push('', 'Not seen by this report:', ...TOUCHED_NOT_SEEN.map((l) => `  ${l}`));
  return `${out.join('\n')}\n`;
}

interface LogRead {
  status: 'ok' | 'missing' | 'unreadable';
  records: AuditRecord[];
  lines: number[];
  bad: number;
  error: string | null;
}

function readLog(file: string): LogRead {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err: unknown) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
    if (code === 'ENOENT') return { status: 'missing', records: [], lines: [], bad: 0, error: null };
    return { status: 'unreadable', records: [], lines: [], bad: 0, error: `cannot read ${file}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const records: AuditRecord[] = [];
  const lines: number[] = [];
  let bad = 0;
  text.split('\n').forEach((t, i) => {
    if (t.trim() === '') return;
    const r = parseAuditLine(t);
    if ('error' in r) bad++;
    else {
      records.push(r);
      lines.push(i + 1);
    }
  });
  return { status: 'ok', records, lines, bad, error: null };
}

export function touchedCommand(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): TouchedResult {
  const usage = (why: string): TouchedResult => ({ exitCode: 64, stdout: '', stderr: `openmorals audit touched: ${why}; nothing was done\n\nUsage:\n${TOUCHED_USAGE}\n` });
  let glob: string | undefined;
  let run: string | undefined;
  let session: string | undefined;
  let file: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--json') json = true;
    else if (a === '--run' || a === '--session' || a === '--file') {
      const v = argv[i + 1];
      i++;
      if (v === undefined || v.startsWith('--') || v === '') return usage(`${a} needs a value`);
      if (a === '--run') run = v;
      else if (a === '--session') session = v;
      else file = v;
    } else if (a.startsWith('-')) return usage(`unknown argument ${a}`);
    else if (glob === undefined) glob = a;
    else return usage('give one glob');
  }
  if (glob === undefined) return usage('give a glob, relative to the working folder (holdout/**)');
  const bad = globProblem(glob);
  if (bad !== null) return usage(`the glob ${JSON.stringify(glob)} ${bad}`);
  const log = file ?? auditLogPath(configDir(env));
  const read = readLog(log);
  const cannotTell = (why: string): TouchedResult => {
    const text = `openmorals audit touched: ${why}, so it cannot tell whether anything touched ${glob}\n`;
    return json ? { exitCode: 2, stdout: `${JSON.stringify({ exitCode: 2, log, logStatus: read.status, badLines: read.bad, error: why, not_seen: TOUCHED_NOT_SEEN }, null, 2)}\n`, stderr: text } : { exitCode: 2, stdout: '', stderr: text };
  };
  if (read.status === 'unreadable') return cannotTell(read.error ?? `cannot read ${log}`);
  if (read.status === 'missing') return cannotTell(`there is no audit log at ${log}`);
  if (read.records.length === 0) return cannotTell(`${log} holds no readable record${read.bad > 0 ? ` (${read.bad} line${read.bad === 1 ? '' : 's'} could not be read)` : ''}`);
  const r = touchedReport(read.records, glob, { ...(run !== undefined ? { run } : {}), ...(session !== undefined ? { session } : {}) }, read.lines);
  const v = verifyAudit(log);
  const verified = { ok: v.ok, problems: v.problems.length };
  const chainLine = v.ok ? '' : `The log does NOT verify (${v.problems.length} problem${v.problems.length === 1 ? '' : 's'}: lines may be missing or edited); run openmorals audit verify.\n`;
  const exitCode = r.listed > 0 ? 1 : v.ok ? 0 : 2;
  const skipped = read.bad > 0 ? `${read.bad} audit line(s) could not be read and were skipped.\n` : '';
  if (json) return { exitCode, stdout: `${JSON.stringify({ exitCode, log, logStatus: read.status, badLines: read.bad, verified, ...r, not_seen: TOUCHED_NOT_SEEN }, null, 2)}\n`, stderr: '' };
  return { exitCode, stdout: format(r, log) + skipped + chainLine, stderr: '' };
}
