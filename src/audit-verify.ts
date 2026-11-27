// `openmorals audit verify` and `openmorals audit --run <id>`: read the log and the session files, never write.
//
// What this proves, and what it does not: each session's records are numbered and each line carries the hash of the
// one before it, and the session file keeps the newest number and hash. So an edited line, a deleted line, a cut-off
// tail, a session whose state was reset, and a declared run with no record show up here. A program running as the same
// user can still rewrite the log and recompute every hash and the session file with it; nothing here can see that.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AuditRecord, AuditRecordV2, AuditStatus, ChainHead } from './audit.js';
import { AUDIT_GENESIS, auditLineHash, parseAuditLine } from './audit.js';
import { safeSessionId } from './paths.js';
import { parseChain } from './session.js';
import { readNodes, readRunFile, sumNodes } from './tokens/run.js';
import { readStop } from './tokens/stop.js';
import type { Decision } from './types.js';

/** A finding that fails verification (non-zero exit). */
export type VerifyProblemKind =
  /** The log exists but could not be read. */
  | 'unreadable-log'
  /** A line that is not a record (not JSON, an unknown version, a missing field): it was edited or corrupted. */
  | 'unreadable-line'
  /** The file does not end with a newline: its last line was cut off (or edited). */
  | 'truncated'
  /** A record does not link to the record before it in its session: that one, or this link, was changed. */
  | 'edited'
  /** Numbers are missing in a session: lines were deleted. */
  | 'gap'
  /** A session's numbering went back: its saved state was reset or replaced with an older copy. */
  | 'restart'
  /** The session file says the session reached a number the log does not hold: lines were removed from the end. */
  | 'tail-missing'
  /** A version 1 line after the chain began: an older openmorals still writes here, or a line was inserted. */
  | 'unchained'
  /** A run id was declared and there is no log. */
  | 'missing-log'
  /** A run id was declared and no record carries it. */
  | 'run-missing';

/** A fact worth knowing that does not fail verification. */
export type VerifyNoteKind =
  /** Version 1 lines from before 0.8.0, which carry no chain and cannot be checked. */
  | 'legacy'
  /** Two records with the same number linking to the same record: two calls of one session were judged at once. */
  | 'fork'
  /** The session file is behind its newest record (it was saved by the slower of two concurrent calls). */
  | 'behind'
  /** A session file whose chain head could not be read; its tail cannot be checked. */
  | 'session-unreadable'
  /** There is no log, and no run id was declared. */
  | 'no-log';

export interface VerifyFinding<K extends string> {
  kind: K;
  /** 1-based line number in the log, or null for a finding about a whole session or file. */
  line: number | null;
  /** The session file the finding concerns (`safeSessionId` of the record's session), or null. */
  session: string | null;
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  status: AuditStatus;
  /** Non-blank lines read. */
  lines: number;
  v1: number;
  v2: number;
  /** Sessions with at least one chained record. */
  sessions: number;
  run: string | null;
  /** Records carrying the declared run id, or null when none was declared. */
  runRecords: number | null;
  problems: VerifyFinding<VerifyProblemKind>[];
  notes: VerifyFinding<VerifyNoteKind>[];
}

export interface VerifyOptions {
  /** Session heads by session file name (without `.json`), as the session files hold them. */
  heads?: ReadonlyMap<string, ChainHead>;
  /** Session files whose chain could not be read. */
  unreadableHeads?: readonly string[];
  /** A declared run id: a missing log, or no record of it, fails. */
  run?: string | null;
}

interface SessionChain {
  /** Line hash -> seq of every record of this session seen so far (the genesis is seq 0). */
  known: Map<string, number>;
  /** Highest seq of the current branch (reset after a restart or gap, so one break is reported once). */
  tip: number;
  /** Highest seq seen at all. */
  highest: number;
  lineOfSeq: Map<number, number>;
}

/** The session file a record belongs to: the same key the writers use. */
export function chainKey(r: AuditRecord): string {
  return safeSessionId(r.session ?? 'unknown');
}

interface Line {
  n: number;
  text: string;
  partial: boolean;
}

function splitLines(text: string): Line[] {
  const parts = text.split('\n');
  const partial = text.length > 0 && !text.endsWith('\n');
  const out: Line[] = [];
  parts.forEach((t, i) => {
    if (t.trim() === '') return;
    out.push({ n: i + 1, text: t, partial: partial && i === parts.length - 1 });
  });
  return out;
}

/** Checks the chain of every session in the log text. Pure; `heads` brings in what the session files say. */
export function verifyAuditText(text: string, opts: VerifyOptions = {}, status: AuditStatus = text.trim() === '' ? 'empty' : 'ok'): VerifyResult {
  const problems: VerifyFinding<VerifyProblemKind>[] = [];
  const notes: VerifyFinding<VerifyNoteKind>[] = [];
  const chains = new Map<string, SessionChain>();
  const run = opts.run ?? null;
  let v1 = 0;
  let v2 = 0;
  let legacy = 0;
  let runRecords = 0;
  const lines = splitLines(text);
  for (const ln of lines) {
    if (ln.partial) problems.push({ kind: 'truncated', line: ln.n, session: null, detail: 'the log does not end with a newline: its last line was cut off or edited' });
    const r = parseAuditLine(ln.text);
    if ('error' in r) {
      if (!ln.partial) problems.push({ kind: 'unreadable-line', line: ln.n, session: null, detail: `${r.error}: the line was edited or corrupted` });
      continue;
    }
    if (r.v === 1) {
      v1++;
      if (v2 > 0) problems.push({ kind: 'unchained', line: ln.n, session: chainKey(r), detail: 'a version 1 line after the chain began carries no chain and cannot be checked: an older openmorals is still writing to this folder (upgrade every install), or the line was inserted' });
      else legacy++;
      continue;
    }
    v2++;
    if (run !== null && r.run === run) runRecords++;
    link(r, ln.n, auditLineHash(ln.text), chains, problems, notes);
  }
  if (legacy > 0) notes.push({ kind: 'legacy', line: null, session: null, detail: `${legacy} line${legacy === 1 ? '' : 's'} from before 0.8.0 carry no chain and cannot be checked` });
  checkHeads(chains, opts, problems, notes);
  if (status === 'missing') {
    if (run !== null) problems.push({ kind: 'missing-log', line: null, session: null, detail: `run ${run} was declared, and there is no audit log` });
    else notes.push({ kind: 'no-log', line: null, session: null, detail: 'there is no audit log: nothing has been recorded here, or it was removed (declare a run with --run to make this fail)' });
  } else if (run !== null && runRecords === 0) {
    problems.push({ kind: 'run-missing', line: null, session: null, detail: `run ${run} was declared, and no record in the log carries it` });
  }
  return { ok: problems.length === 0, status, lines: lines.length, v1, v2, sessions: chains.size, run, runRecords: run === null ? null : runRecords, problems, notes };
}

function link(r: AuditRecordV2, line: number, hash: string, chains: Map<string, SessionChain>, problems: VerifyFinding<VerifyProblemKind>[], notes: VerifyFinding<VerifyNoteKind>[]): void {
  const key = chainKey(r);
  let c = chains.get(key);
  if (c === undefined) {
    c = { known: new Map([[AUDIT_GENESIS, 0]]), tip: 0, highest: 0, lineOfSeq: new Map() };
    chains.set(key, c);
  }
  const linked = c.known.get(r.prev);
  if (linked !== undefined && linked === r.seq - 1) {
    if (r.seq === c.tip && r.seq <= c.highest) {
      notes.push({ kind: 'fork', line, session: key, detail: `a second record with seq ${r.seq}, linked to the same record as the first: two calls of this session were judged at once` });
    } else if (r.seq < c.tip) {
      problems.push({ kind: 'restart', line, session: key, detail: `seq ${r.seq} after seq ${c.tip}: the session's saved state was reset or replaced with an older copy` });
      c.tip = r.seq;
    } else c.tip = r.seq;
  } else if (linked !== undefined) {
    problems.push({ kind: 'edited', line, session: key, detail: `seq ${r.seq} links to the record with seq ${linked}: a number or a link was changed` });
    c.tip = Math.max(c.tip, r.seq);
  } else if (r.seq > c.tip + 1) {
    const from = c.tip + 1;
    const to = r.seq - 1;
    problems.push({ kind: 'gap', line, session: key, detail: `seq ${from === to ? from : `${from} to ${to}`} of this session ${from === to ? 'is' : 'are'} missing before seq ${r.seq}: lines were deleted` });
    c.tip = r.seq;
  } else {
    const before = c.lineOfSeq.get(r.seq - 1);
    problems.push({ kind: 'edited', line: before ?? line, session: key, detail: before !== undefined ? `line ${before} (seq ${r.seq - 1}) was changed after it was written: line ${line} (seq ${r.seq}) holds a different hash for it` : `seq ${r.seq} does not link to any record of this session: a line or its link was changed` });
    c.tip = Math.max(c.tip, r.seq);
  }
  c.known.set(hash, r.seq);
  c.highest = Math.max(c.highest, r.seq);
  c.lineOfSeq.set(r.seq, line);
}

function checkHeads(chains: ReadonlyMap<string, SessionChain>, opts: VerifyOptions, problems: VerifyFinding<VerifyProblemKind>[], notes: VerifyFinding<VerifyNoteKind>[]): void {
  for (const s of opts.unreadableHeads ?? []) notes.push({ kind: 'session-unreadable', line: null, session: s, detail: 'the session file or its chain head could not be read, so the end of this session cannot be checked' });
  for (const [key, head] of [...(opts.heads ?? new Map<string, ChainHead>())].sort(([a], [b]) => a.localeCompare(b))) {
    const c = chains.get(key);
    if (c === undefined) {
      problems.push({ kind: 'tail-missing', line: null, session: key, detail: `the session file says ${head.seq} record${head.seq === 1 ? ' was' : 's were'} written; the log holds none of them` });
    } else if (c.known.has(head.head)) {
      if (head.seq < c.highest) notes.push({ kind: 'behind', line: null, session: key, detail: `the session file stops at seq ${head.seq}; the log goes on to seq ${c.highest} (saved by the slower of two concurrent calls)` });
    } else if (head.seq > c.highest) {
      problems.push({ kind: 'tail-missing', line: null, session: key, detail: `the session file says seq ${head.seq}; the log's last record for this session is seq ${c.highest}: lines were removed from the end` });
    } else {
      problems.push({ kind: 'edited', line: c.lineOfSeq.get(head.seq) ?? null, session: key, detail: `the record with seq ${head.seq} is not in the log as it was written: the session's newest line was changed or replaced` });
    }
  }
}

/** The chain heads of every session file in a folder, keyed by file name without `.json`. Unreadable files are listed, not thrown. */
export function readSessionHeads(dir: string): { heads: Map<string, ChainHead>; unreadable: string[] } {
  const heads = new Map<string, ChainHead>();
  const unreadable: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return { heads, unreadable };
  }
  for (const f of names) {
    const key = f.slice(0, -'.json'.length);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    } catch {
      unreadable.push(key);
      continue;
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      unreadable.push(key);
      continue;
    }
    const o = raw as Record<string, unknown>;
    if (o['chain'] === undefined) continue;
    const head = parseChain(o['chain']);
    if (head === undefined) unreadable.push(key);
    else heads.set(key, head);
  }
  return { heads, unreadable };
}

function readLog(file: string): { status: AuditStatus; text: string; error: string | null } {
  try {
    const text = readFileSync(file, 'utf8');
    return { status: text.trim() === '' ? 'empty' : 'ok', text, error: null };
  } catch (err: unknown) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code: unknown }).code : null;
    if (code === 'ENOENT') return { status: 'missing', text: '', error: null };
    return { status: 'unreadable', text: '', error: `cannot read ${file}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface VerifyFileOptions {
  /** The folder of session files (default: `sessions` beside the log). */
  sessionsDir?: string;
  run?: string | null;
}

/** Verifies a log file against the session files beside it. Never throws and never writes. */
export function verifyAudit(file: string, opts: VerifyFileOptions = {}): VerifyResult {
  const log = readLog(file);
  const run = opts.run ?? null;
  if (log.status === 'unreadable') {
    return { ok: false, status: 'unreadable', lines: 0, v1: 0, v2: 0, sessions: 0, run, runRecords: run === null ? null : 0, problems: [{ kind: 'unreadable-log', line: null, session: null, detail: log.error ?? `cannot read ${file}` }], notes: [] };
  }
  const { heads, unreadable } = readSessionHeads(opts.sessionsDir ?? join(dirname(file), 'sessions'));
  return verifyAuditText(log.text, { heads, unreadableHeads: unreadable, run }, log.status);
}

export interface RunItem {
  line: number;
  ts: string;
  session: string | null;
  tool: string;
  decision: Decision;
  rule: string;
  action: string;
}

/** What one run's records say, for a reviewer or a CI verdict. Every list can only raise review; none lowers it. */
export interface RunSummary {
  run: string;
  status: AuditStatus;
  records: number;
  sessions: string[];
  /** Records the run was refused. */
  denies: RunItem[];
  /** Pre-tool asks (inbound notices are under `taint_marks`). An ask with no `approved_asks` line was refused, or its host sends no post-tool event. */
  asks: RunItem[];
  /** `ask.approved` lines: the call ran after openmorals asked. */
  approved_asks: RunItem[];
  /** Inbound findings: content the session read was marked untrusted, injected or private. */
  taint_marks: RunItem[];
  /** Records whose reason says a project file tried to loosen the user's floor (`bylaws.loosening-ignored`). */
  loosening_notes: RunItem[];
  /** `openmorals order check` results recorded with this run id (0.27.0), pass and fail; not counted as denies or asks. */
  order_checks: RunItem[];
  /** The work orders the run's records name (`OPENMORALS_ORDER` in the hook's environment, or the order checked), sorted. */
  orders: string[];
  /** Verification of the sessions the run touched, plus findings about the whole file. */
  record: { ok: boolean; problems: VerifyFinding<VerifyProblemKind>[] };
  /** Records of a write tool, or with test files written, that were not refused (0.40.0). */
  writes: number;
  /** The test files the run's records say were written (the `tests` field), sorted. */
  tests_written: string[];
  /** Commands that ran `git commit`, not refused. */
  commits: RunItem[];
  /** Order checks, and commands matching `check_patterns`, not refused: what this card counts as a check. */
  checks: RunItem[];
  /** True when the run wrote files and no check is in its records. A line to read: it never changes the exit code. */
  no_check: boolean;
  /** The names of the command patterns counted as a check. */
  check_patterns: string[];
  /** What the run used, from its run folder; absent when the caller gave no config folder. */
  counts?: RunCounts;
}

/** A run's counts from `<config>/runs/<id>/` (0.40.0), read only. */
export type RunCounts =
  | {
      /** The run has a limits file or session counts. */
      status: 'counted';
      tool_calls: number;
      tokens: number;
      spawns: number;
      sessions: number;
      /** True when the run has limits (`budget start`); false when it is counted only. */
      limits: boolean;
      /** Why the limits file could not be read, or null. */
      limits_error: string | null;
      /** Session count files that could not be read: the totals may be low. */
      unreadable_sessions: string[];
      /** Stopped by `stop --run`, `stop --all`; null when the stop file cannot be read. */
      stopped: boolean | null;
    }
  /** No limits file and no counts: nothing counted under this id (other hosts only tag records). */
  | { status: 'none'; stopped: boolean | null }
  | { status: 'unreadable'; error: string; stopped: boolean | null }
  /** The log was read from another place (`--file`) with no `runs` folder beside it: its run's counts are not here. */
  | { status: 'not-here'; log: string };

/**
 * Commands counted as a check on the run card (0.40.0). A heuristic over the command text: a check run under another
 * name (`make ci`, a script) is not recognised, and a recognised one says nothing about whether it passed.
 */
const CMD = String.raw`(?:^|[;&|(\n]\s*|\b(?:then|do|exec|time|sudo|env)\s+)(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*`;
const checkRe = (body: string): RegExp => new RegExp(String.raw`${CMD}(?:${body})(?=$|[\s;&|)])`, 'i');
export const CHECK_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: 'npm/pnpm/yarn/bun test or run test*', re: checkRe(String.raw`(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|t)(?::\S*)?|(?:npm|pnpm|yarn)\s+run\s+(?:check|verify|ci)(?::\S*)?`) },
  { name: 'npx/bunx vitest, jest, mocha, playwright test, ava, tap', re: checkRe(String.raw`(?:(?:npx|bunx|pnpm\s+exec|yarn)\s+)?(?:vitest|jest|mocha|ava|tap|playwright\s+test)`) },
  { name: 'node --test', re: checkRe(String.raw`node\s+(?:\S+\s+)*--test`) },
  { name: 'pytest, python -m pytest/unittest, tox, nox', re: checkRe(String.raw`pytest|py\.test|python[0-9.]*\s+-m\s+(?:pytest|unittest)|tox|nox|uv\s+run\s+pytest`) },
  { name: 'go test, cargo test/nextest', re: checkRe(String.raw`go\s+test|cargo\s+(?:test|nextest)`) },
  { name: 'mvn test/verify, gradle test/check, dotnet test', re: checkRe(String.raw`(?:mvn|\.?/?mvnw)\s+(?:\S+\s+)*(?:test|verify)|(?:gradle|\.?/?gradlew)\s+(?:\S+\s+)*(?:test|check)|dotnet\s+test`) },
  { name: 'flutter test, dart test, swift test, deno test, bun test', re: checkRe(String.raw`(?:flutter|dart|swift|deno|bun)\s+test`) },
  { name: 'rspec, rake test, mix test, phpunit, ctest', re: checkRe(String.raw`(?:bundle\s+exec\s+)?(?:rspec|rake\s+test)|mix\s+test|(?:\S*/)?phpunit|ctest`) },
  { name: 'make test/check', re: checkRe(String.raw`make\s+(?:\S+\s+)*(?:test|check)`) },
  { name: 'openmorals tests fail-first, diff-class, order check', re: checkRe(String.raw`(?:npx\s+)?openmorals\s+(?:tests\s+fail-first|diff-class|order\s+check)`) },
];

const COMMIT = new RegExp(String.raw`${CMD}git(?:\s+(?:-[cC]\s+\S+|--?[A-Za-z][\w-]*(?:=\S+)?))*\s+commit(?=$|[\s;&|)])`);

/** Tools whose call writes a file, across the hosts. A permission event (opencode's second event of a call) is left out. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'write_file', 'replace', 'write', 'edit', 'multiedit', 'apply_patch', 'patch']);

/** The text with quoted strings emptied, so a commit message or an `echo` is not read as a command. */
function unquoted(text: string): string {
  return text.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""');
}

/** True when the action text runs a command the card counts as a check (quoted text is not read). */
export function isCheckCommand(action: string): boolean {
  const t = unquoted(action);
  return CHECK_PATTERNS.some((p) => p.re.test(t));
}

/** True when the action text runs `git commit` (quoted text is not read). */
export function isGitCommit(action: string): boolean {
  return COMMIT.test(unquoted(action));
}

const MAX_ITEM_ACTION = 200;
/** The session name of `openmorals order` records (0.27.0). */
export const ORDER_SESSION = 'order';

/** Summarises one run from the log text (pure). `verified` is the verification of the same text. */
export function summarizeRunText(text: string, run: string, verified: VerifyResult): RunSummary {
  const s: RunSummary = { run, status: verified.status, records: 0, sessions: [], denies: [], asks: [], approved_asks: [], taint_marks: [], loosening_notes: [], order_checks: [], orders: [], record: { ok: true, problems: [] }, writes: 0, tests_written: [], commits: [], checks: [], no_check: false, check_patterns: CHECK_PATTERNS.map((p) => p.name) };
  const sessions = new Set<string>();
  const orders = new Set<string>();
  const tests = new Set<string>();
  for (const ln of splitLines(text)) {
    const r = parseAuditLine(ln.text);
    if ('error' in r || r.v !== 2 || r.run !== run) continue;
    s.records++;
    sessions.add(chainKey(r));
    const item: RunItem = { line: ln.n, ts: r.ts, session: r.session, tool: r.tool, decision: r.decision, rule: r.rule, action: r.action.length > MAX_ITEM_ACTION ? `${r.action.slice(0, MAX_ITEM_ACTION)}…` : r.action };
    if (r.order !== undefined) orders.add(r.order);
    if (r.session === ORDER_SESSION && r.rule.startsWith('order.check.')) {
      s.order_checks.push(item);
      s.checks.push(item);
      continue;
    }
    if (r.decision !== 'deny' && r.rule !== 'ask.approved') {
      for (const f of r.tests ?? []) tests.add(f);
      if (WRITE_TOOLS.has(r.tool) || (r.tests?.length ?? 0) > 0) s.writes++;
      if (isGitCommit(r.action)) s.commits.push(item);
      if (isCheckCommand(r.action)) s.checks.push(item);
    }
    const inbound = r.action.startsWith('inbound ');
    if (r.decision === 'deny') s.denies.push(item);
    if (r.rule === 'ask.approved') s.approved_asks.push(item);
    else if (inbound) s.taint_marks.push(item);
    else if (r.decision === 'ask') s.asks.push(item);
    if (r.reason.includes('bylaws.loosening-ignored')) s.loosening_notes.push(item);
  }
  s.sessions = [...sessions].sort();
  s.orders = [...orders].sort();
  s.tests_written = [...tests].sort();
  s.no_check = s.writes > 0 && s.checks.length === 0;
  const problems = verified.problems.filter((p) => p.session === null || sessions.has(p.session));
  s.record = { ok: problems.length === 0, problems };
  return s;
}

/** A run's counts from its folder under the config folder. Read only; never throws. */
export function readRunCounts(dir: string, run: string): RunCounts {
  let stopped: boolean | null;
  try {
    const st = readStop(dir);
    stopped = st === null ? false : 'error' in st ? null : st.all !== undefined || st.runs?.[run] !== undefined;
  } catch {
    stopped = null;
  }
  try {
    const limits = readRunFile(dir, run);
    const { nodes, unreadable } = readNodes(dir, run);
    if (limits === null && nodes.size === 0 && unreadable.length === 0) return { status: 'none', stopped };
    const t = sumNodes(nodes.values());
    return { status: 'counted', tool_calls: t.tool_calls, tokens: t.tokens, spawns: t.spawns, sessions: t.sessions, limits: limits !== null && !('error' in limits), limits_error: limits !== null && 'error' in limits ? limits.error : null, unreadable_sessions: [...unreadable].sort(), stopped };
  } catch (err: unknown) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : '';
    return { status: 'unreadable', error: `the run folder could not be read (${code !== '' ? code : err instanceof Error ? err.message : String(err)})`, stopped };
  }
}

export interface SummarizeRunOptions extends Omit<VerifyFileOptions, 'run'> {
  /** The config folder whose `runs/<id>/` holds the run's counts (0.40.0); without it the summary has no `counts`. */
  configDir?: string;
}

/** Reads the log and the session files beside it and summarises one run. Never throws and never writes. */
export function summarizeRun(file: string, run: string, opts: SummarizeRunOptions = {}): RunSummary {
  const { configDir, ...vopts } = opts;
  const verified = verifyAudit(file, { ...vopts, run });
  const log = verified.status === 'ok' ? readLog(file) : { text: '' };
  const s = summarizeRunText(log.text, run, verified);
  return configDir !== undefined ? { ...s, counts: readRunCounts(configDir, run) } : s;
}

function findingLine<K extends string>(f: VerifyFinding<K>): string {
  const where = [f.line !== null ? `line ${f.line}` : null, f.session !== null ? `session ${f.session}` : null].filter((x) => x !== null).join(', ');
  return `  ${f.kind}${where !== '' ? ` (${where})` : ''}: ${f.detail}`;
}

export function formatVerify(file: string, v: VerifyResult): string {
  const out: string[] = [];
  const head = `${v.ok ? 'verified' : 'NOT verified'}: ${file}: ${v.lines} line${v.lines === 1 ? '' : 's'} (${v.v2} chained, ${v.v1} version 1) in ${v.sessions} session${v.sessions === 1 ? '' : 's'}`;
  out.push(v.run !== null ? `${head}; run ${v.run}: ${v.runRecords ?? 0} record${v.runRecords === 1 ? '' : 's'}` : head);
  if (v.problems.length > 0) out.push(`${v.problems.length} problem${v.problems.length === 1 ? '' : 's'}:`, ...v.problems.map(findingLine));
  if (v.notes.length > 0) out.push('notes:', ...v.notes.map(findingLine));
  out.push('This shows lost, cut or edited lines and reset sessions. It cannot show a log that a program running as you rewrote with every hash recomputed.');
  return `${out.join('\n')}\n`;
}

function countsLine(c: RunCounts): string {
  if (c.status === 'not-here') return `counts: no counts for this log (read from ${c.log}, with no runs folder beside it; counts are kept in the config folder of the machine the run ran on)`;
  const stop = c.stopped === null ? 'stop file unreadable (every session is held as stopped)' : c.stopped ? 'STOPPED' : 'not stopped';
  if (c.status === 'none') return `counts: no counts for this run (no limits file and no session counts under this id: it was not started with openmorals budget start and no counting host ran under it); ${stop}`;
  if (c.status === 'unreadable') return `counts: unreadable: ${c.error}; ${stop}`;
  const fmt = (n: number): string => n.toLocaleString('en-US');
  const extra = [c.limits ? 'limits set' : c.limits_error !== null ? `limits unreadable: ${c.limits_error}` : 'no limits set (counted only)', ...(c.unreadable_sessions.length > 0 ? [`${c.unreadable_sessions.length} session count file${c.unreadable_sessions.length === 1 ? '' : 's'} unreadable, so the totals may be low`] : [])];
  return `counts: ${fmt(c.tool_calls)} tool calls, ${fmt(c.tokens)} tokens, ${fmt(c.spawns)} sub-agent runs in ${fmt(c.sessions)} session${c.sessions === 1 ? '' : 's'}; ${extra.join('; ')}; ${stop}`;
}

export function formatRunSummary(s: RunSummary): string {
  const out: string[] = [];
  out.push(`run ${s.run}: ${s.records} record${s.records === 1 ? '' : 's'} in ${s.sessions.length} session${s.sessions.length === 1 ? '' : 's'}; ${s.denies.length} denied, ${s.asks.length} asked, ${s.approved_asks.length} approved asks, ${s.taint_marks.length} taint marks, ${s.loosening_notes.length} loosening notes; record ${s.record.ok ? 'verified' : `NOT verified (${s.record.problems.length} problem${s.record.problems.length === 1 ? '' : 's'})`}`);
  const list = (title: string, items: readonly RunItem[]): void => {
    if (items.length === 0) return;
    out.push(`${title}:`);
    for (const i of items) out.push(`  line ${i.line}  ${i.ts}  ${i.decision.toUpperCase().padEnd(5)} ${i.rule}  ${i.tool}  ${i.action.replace(/\s+/g, ' ').slice(0, 100)}`);
  };
  list('denied', s.denies);
  list('asked', s.asks);
  list('approved asks', s.approved_asks);
  list('taint marks', s.taint_marks);
  list('loosening notes', s.loosening_notes);
  list('order checks', s.order_checks);
  if (s.orders.length > 0) out.push(`work orders named: ${s.orders.join(', ')}`);
  if (s.counts !== undefined) out.push(countsLine(s.counts));
  out.push(`wrote: ${s.writes} write${s.writes === 1 ? '' : 's'}; test files written: ${s.tests_written.length === 0 ? 'none' : s.tests_written.join(', ')}; git commits: ${s.commits.length}; checks: ${s.checks.length}`);
  list('git commits', s.commits);
  list('checks', s.checks.filter((c) => !s.order_checks.includes(c)));
  if (s.no_check) out.push('no check recorded: the run wrote files, and its records hold no order check, no test run and no diff-class or fail-first command (a line to read, not a failure; a check run under another name, or outside the run, is not seen: see docs/audit.md)');
  if (s.record.problems.length > 0) out.push('record problems:', ...s.record.problems.map(findingLine));
  return `${out.join('\n')}\n`;
}
