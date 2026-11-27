// `openmorals audit touched <glob>` (0.40.0): which recorded calls named a path under a glob, read back from the audit
// log. A report only: it reads the log and changes nothing, and it is never an ask.
import { isAbsolute, relative } from 'node:path';
import type { AuditRecord } from './audit.js';
import { readAudit } from './audit.js';
import { compileGlob, globProblem } from './diffclass/glob.js';
import { auditLogPath, configDir } from './paths.js';

export interface TouchedResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const TOUCHED_USAGE = `  openmorals audit touched <GLOB> [--run ID] [--session ID] [--file FILE] [--json]
      Lists every audit record whose action (a path, a command's text, a search),
      or whose list of test files written, names a path under GLOB, grouped by run
      and session; and every content search whose folder holds GLOB. GLOB is
      relative to each record's working folder (holdout/**, test/fixtures/**).
      Ends with what the hook cannot see. A report, never an ask. Exit 1 when
      anything is listed, 0 when nothing is, 2 when the log cannot be read, 64
      usage error.`;

/** What a report cannot see, printed under every report and in `--json` as `not_seen`. */
export const TOUCHED_NOT_SEEN: readonly string[] = [
  'Reads by a script, a test runner or an interpreter: `python scripts/peek.py` or `npm test` that opens the files itself is recorded as its command only, and the command does not name them.',
  'Work where no hook ran: a host without openmorals, a CI job, a cloud agent, your own editor or shell.',
  'Records from before the hook was installed, and records in another config folder or on another machine.',
  'What one agent told another: a handoff record keeps a fingerprint of the text, never the text.',
  'A name built at run time (a variable, `$(ls)`, a path in a file the command reads), and a pattern that only overlaps GLOB (`**/*.yaml`).',
  'A content search with no folder recorded by an openmorals older than 0.40.0 (its record names no folder and no pattern).',
];

export type TouchedHow = 'named' | 'test-file' | 'searched-folder';

export interface TouchedItem {
  /** 1-based index of the record among the records read. */
  record: number;
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
const SEARCH_NOTE = /\[search ("(?:[^"\\]|\\.)*")( in the working folder)?\]$/;
const SPLIT = /[\s;|&<>()'"`=,]+/;

/** The record's text as a path relative to its working folder, POSIX style; null when it cannot be one. */
function relPath(token: string, cwd: string | null): string {
  let t = token.replace(/\\/g, '/');
  if (cwd !== null && isAbsolute(t)) {
    const r = relative(cwd, t).replace(/\\/g, '/');
    if (r !== '' && !r.startsWith('../') && r !== '..' && !isAbsolute(r)) t = r;
  }
  t = t.replace(/^(\.\/)+/, '');
  return t.replace(/^\/+/, '');
}

/** The fixed folder part of an anchored glob (`holdout` for `holdout/**`), or null for a glob matched at any depth. */
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

/** True when a search over `folder` (relative, '' for the working folder) reads files the glob covers. */
function folderHolds(folder: string, prefix: string | null): boolean {
  const f = folder.replace(/\/+$/, '');
  if (f === '' || f === '.') return true;
  if (prefix === null) return false;
  return prefix.toLowerCase() === f.toLowerCase() || prefix.toLowerCase().startsWith(`${f.toLowerCase()}/`);
}

function matchOf(r: AuditRecord, test: (p: string) => boolean, prefix: string | null): { how: TouchedHow; matched: string } | null {
  const cwd = r.cwd;
  for (const t of r.tests ?? []) {
    if (test(relPath(t, cwd))) return { how: 'test-file', matched: t };
  }
  const note = SEARCH_NOTE.exec(r.action);
  const body = note !== null ? r.action.slice(0, note.index) : r.action;
  for (const tok of body.split(SPLIT)) {
    if (tok === '' || tok === r.tool) continue;
    const p = relPath(tok, cwd);
    if (p !== '' && test(p)) return { how: 'named', matched: tok };
  }
  if (note !== null) {
    let pattern = '';
    try {
      pattern = JSON.parse(note[1] as string) as string;
    } catch {
      pattern = '';
    }
    for (const tok of pattern.split(SPLIT)) {
      const p = relPath(tok, cwd);
      if (p !== '' && test(p)) return { how: 'named', matched: tok };
    }
    const folderTokens = body.split(/\s+/).filter((x) => x !== '' && x !== r.tool);
    const folder = note[2] !== undefined ? '' : relPath(folderTokens[0] ?? '', cwd);
    if (note[2] !== undefined || folderTokens.length > 0) {
      if (folderHolds(folder, prefix)) return { how: 'searched-folder', matched: note[2] !== undefined ? 'the working folder' : (folderTokens[0] as string) };
    }
  }
  return null;
}

/** The touched report over audit records, oldest first as the log holds them. Pure. */
export function touchedReport(records: readonly AuditRecord[], glob: string, filter: TouchedFilter = {}): TouchedReport {
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
    g.items.push({ record: i + 1, ts: r.ts, source: r.source, tool: r.tool, decision: r.decision, rule: r.rule, how: m.how, matched: m.matched, action: r.action.length > MAX_ACTION ? `${r.action.slice(0, MAX_ACTION)}…` : r.action });
    groups.set(key, g);
    listed++;
  });
  const sorted = [...groups.values()].sort((a, b) => (a.run ?? '').localeCompare(b.run ?? '') || (a.session ?? '').localeCompare(b.session ?? ''));
  return { glob, recordsRead: records.length, listed, groups: sorted };
}

const HOW_TEXT: Readonly<Record<TouchedHow, string>> = { named: 'names it', 'test-file': 'wrote it as a test file', 'searched-folder': 'searched a folder holding it' };

function format(r: TouchedReport, log: string): string {
  const out: string[] = [];
  if (r.listed === 0) out.push(`No record names a path under ${r.glob} (${r.recordsRead} records read from ${log}).`);
  else {
    out.push(`${r.listed} record${r.listed === 1 ? '' : 's'} name a path under ${r.glob} (${r.recordsRead} records read from ${log}):`);
    for (const g of r.groups) {
      out.push('', `run ${g.run ?? '(none)'}, session ${g.session ?? 'unknown'}:`);
      for (const i of g.items) out.push(`  ${i.ts}  ${i.decision.toUpperCase().padEnd(5)} ${i.source} ${i.tool}: ${HOW_TEXT[i.how]} (${i.matched}): ${i.action.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
  }
  out.push('', 'Not seen by this report:', ...TOUCHED_NOT_SEEN.map((l) => `  ${l}`));
  return `${out.join('\n')}\n`;
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
  const read = readAudit(log);
  if (read.status === 'unreadable') return { exitCode: 2, stdout: '', stderr: `openmorals audit touched: ${read.errors[0]?.error ?? 'cannot read the audit log'}\n` };
  const r = touchedReport(read.records, glob, { ...(run !== undefined ? { run } : {}), ...(session !== undefined ? { session } : {}) });
  const exitCode = r.listed > 0 ? 1 : 0;
  const skipped = read.errors.length > 0 ? `${read.errors.length} audit line(s) could not be read and were skipped.\n` : '';
  if (json) return { exitCode, stdout: `${JSON.stringify({ exitCode, log, logStatus: read.status, badLines: read.errors.length, ...r, not_seen: TOUCHED_NOT_SEEN }, null, 2)}\n`, stderr: '' };
  return { exitCode, stdout: (read.status === 'missing' ? `No audit log at ${log}.\n` : '') + format(r, log) + skipped, stderr: '' };
}
