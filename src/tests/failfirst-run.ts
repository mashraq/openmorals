import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { compileGlob } from '../diffclass/glob.js';
import { SNAPSHOT_GLOBS, TEST_GLOBS } from '../diffclass/integrity.js';
import { configDir } from '../paths.js';
import { approvedOrderTestIds } from '../order/store.js';
import { scrubEnv } from '../sandbox/run.js';
import { judgeFailFirst } from './failfirst.js';
import type { FailFirstJudgement, FailFirstRow } from './failfirst.js';
import { MAX_REPORT_BYTES } from './command.js';
import { parseTestReport } from './report.js';
import { FAIL_FIRST_DEFAULT_TIMEOUT_S, FAIL_FIRST_SETTINGS_FILE, FAIL_FIRST_USAGE } from './failfirst-usage.js';

export { FAIL_FIRST_DEFAULT_TIMEOUT_S, FAIL_FIRST_SETTINGS_FILE, FAIL_FIRST_USAGE };
import type { ReportFormat, TestReport } from './report.js';

export const FAIL_FIRST_MAX_TIMEOUT_S = 86400;
/** Exit codes. 0 and 1 are judgements; every other code means nothing was judged. */
export const FAIL_FIRST_EXIT = { ok: 0, block: 1, cannotCheck: 2, notConfigured: 3, usage: 64 } as const;
const GIT_TIMEOUT_MS = 120000;
const KILL_GRACE_MS = 3000;
const TAIL_BYTES = 16384;
const MAX_COMMAND = 4096;
export const TEMP_PREFIX = 'openmorals-fail-first-';

/** File names a runner is given to run; other changed test files (helpers, fixtures, snapshots) are copied, not passed. */
export const RUN_GLOBS: readonly string[] = ['*.test.*', '*.spec.*', '*_test.*', 'test_*.py', '*_spec.rb'];

export const FAIL_FIRST_LIMITS: readonly string[] = [
  'This is evidence only when your own gate runs it, outside the agent\'s session, with your test command. An agent saying it saw a test fail first, or a run the agent made, is not evidence.',
  'A test that fails on base shows the change is needed for it to pass. It does not show that the test checks the right thing.',
  'Only the test files the change added or changed are run (as your command uses the file list). Other tests are not looked at; run tests compare for those.',
  '"Red for the wrong reason" is read from the report: an error class, an <error> element or a result field. Where a runner shows none of these, the line says "cannot tell".',
  'It runs your test command on code from the change, which executes project code. Run it on a gate machine or inside a sandbox, never from a hook.',
];


export interface FailFirstSettings {
  command: string;
  timeoutS: number | null;
  file: string;
}

export function parseFailFirstSettings(text: string, file: string): { ok: true; settings: FailFirstSettings } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = parseYaml(text, { strict: true, uniqueKeys: true, maxAliasCount: 0 });
  } catch (e: unknown) {
    return { ok: false, error: `${file}: YAML parse error: ${e instanceof Error ? e.message.split('\n')[0] ?? '' : String(e)}` };
  }
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObj(raw)) return { ok: false, error: `${file}: must be a mapping with a fail_first section` };
  for (const k of Object.keys(raw)) if (k !== 'fail_first') return { ok: false, error: `${file}: unknown key ${k} (allowed: fail_first)` };
  const ff = raw['fail_first'];
  if (!isObj(ff)) return { ok: false, error: `${file}: fail_first must be a mapping with a command` };
  for (const k of Object.keys(ff)) if (k !== 'command' && k !== 'timeout_s') return { ok: false, error: `${file}: unknown key fail_first.${k} (allowed: command, timeout_s)` };
  const cmd = ff['command'];
  if (typeof cmd !== 'string' || cmd.trim() === '') return { ok: false, error: `${file}: fail_first.command must be a non-empty string` };
  if (cmd.length > MAX_COMMAND) return { ok: false, error: `${file}: fail_first.command is longer than ${MAX_COMMAND} characters` };
  if (cmd.includes('\u0000')) return { ok: false, error: `${file}: fail_first.command holds a NUL character` };
  const t = ff['timeout_s'];
  if (t !== undefined && (typeof t !== 'number' || !Number.isInteger(t) || t < 1 || t > FAIL_FIRST_MAX_TIMEOUT_S)) return { ok: false, error: `${file}: fail_first.timeout_s must be a whole number of seconds from 1 to ${FAIL_FIRST_MAX_TIMEOUT_S}` };
  return { ok: true, settings: { command: cmd, timeoutS: typeof t === 'number' ? t : null, file } };
}

export interface FailFirstResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Lets a caller stop a run: the running test command's process group is killed and the temporary folder removed. */
export class FailFirstController {
  cancelled: string | null = null;
  private kill: (() => void) | null = null;
  cancel(signal: string): void {
    if (this.cancelled === null) this.cancelled = signal;
    this.kill?.();
  }
  /** @internal */
  setKill(k: (() => void) | null): void {
    this.kill = k;
  }
}

export interface FailFirstDeps {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  platform?: NodeJS.Platform;
  /** Folder the temporary checkouts are made in (default the OS temp folder). */
  tmpBase?: string;
  controller?: FailFirstController;
}

interface Args {
  base: string;
  head: string;
  expect: string[];
  timeoutS: number | null;
  repo: string | null;
  reports: string | null;
  order: string | null;
  json: boolean;
}

const VALUE = new Set(['--base', '--head', '--expect-red', '--timeout', '--repo', '--reports', '--order']);

function parseArgs(argv: readonly string[]): { ok: true; a: Args } | { ok: false; error: string } {
  const a: Args = { base: '', head: 'HEAD', expect: [], timeoutS: null, repo: null, reports: null, order: null, json: false };
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const s = argv[i] ?? '';
    if (s === '--json') {
      a.json = true;
      continue;
    }
    if (!s.startsWith('--')) return { ok: false, error: `unexpected argument ${JSON.stringify(s)}` };
    const eq = s.indexOf('=');
    const name = eq === -1 ? s : s.slice(0, eq);
    if (!VALUE.has(name)) return { ok: false, error: `unknown option ${name}` };
    const value = eq === -1 ? argv[++i] : s.slice(eq + 1);
    if (value === undefined || value === '') return { ok: false, error: `${name} needs a value` };
    if (name !== '--expect-red' && seen.has(name)) return { ok: false, error: `${name} given twice` };
    seen.add(name);
    if (name === '--base') a.base = value;
    else if (name === '--head') a.head = value;
    else if (name === '--expect-red') a.expect.push(value);
    else if (name === '--repo') a.repo = value;
    else if (name === '--reports') a.reports = value;
    else if (name === '--order') a.order = value;
    else {
      if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > FAIL_FIRST_MAX_TIMEOUT_S) return { ok: false, error: `--timeout must be a whole number of seconds from 1 to ${FAIL_FIRST_MAX_TIMEOUT_S}` };
      a.timeoutS = Number(value);
    }
  }
  if (a.base === '') return { ok: false, error: 'needs --base REV (the commit the change starts from, for example $(git merge-base main HEAD))' };
  for (const r of [a.base, a.head]) if (r.startsWith('-')) return { ok: false, error: `a revision may not start with - (${JSON.stringify(r)})` };
  return { ok: true, a };
}

class CannotCheck extends Error {}
class Cancelled extends Error {}

/** Variables that would point git, or the test command's own git calls, at the person's repository or index. */
function cleanEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(scrubEnv(env))) if (!k.startsWith('GIT_') && k !== 'NODE_TEST_CONTEXT') out[k] = v;
  return out;
}

interface Git {
  run(args: readonly string[], cwd: string, input?: string): Buffer;
}

function makeGit(env: Record<string, string>, noHooks: string): Git {
  const gitEnv = { ...env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_LITERAL_PATHSPECS: '1', GIT_OPTIONAL_LOCKS: '0' };
  const pre = ['-c', `core.hooksPath=${noHooks}`, '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always', '-c', 'core.quotePath=false', '-c', 'advice.detachedHead=false'];
  return {
    run(args, cwd, input) {
      const r = spawnSync('git', [...pre, ...args], { cwd, env: gitEnv, timeout: GIT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, ...(input !== undefined ? { input } : {}), stdio: ['pipe', 'pipe', 'pipe'] });
      if (r.error !== undefined) throw new CannotCheck(`git ${args[0] ?? ''} could not run: ${r.error.message}`);
      if (r.status !== 0) {
        const msg = (r.stderr?.toString('utf8') ?? '').split('\n').find((l) => l.trim() !== '') ?? `exit ${r.status ?? r.signal ?? '?'}`;
        throw new CannotCheck(`git ${args[0] ?? ''} failed: ${msg.trim()}`);
      }
      return r.stdout ?? Buffer.alloc(0);
    },
  };
}

interface ChangedFiles {
  applied: string[];
  run: string[];
  deleted: string[];
}

function changedTestFiles(git: Git, root: string, base: string, head: string): ChangedFiles {
  const out = git.run(['diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', base, head, '--'], root).toString('utf8');
  const parts = out.split('\u0000');
  const isTest = TEST_GLOBS.map(compileGlob);
  const isRun = RUN_GLOBS.map(compileGlob);
  const isSnap = SNAPSHOT_GLOBS.map(compileGlob);
  const c: ChangedFiles = { applied: [], run: [], deleted: [] };
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i] ?? '';
    const path = parts[i + 1] ?? '';
    if (path === '' || !isTest.some((t) => t(path))) continue;
    if (/[\u0000-\u001f\u007f]/.test(path)) throw new CannotCheck(`a test file name in the change holds a control character (${JSON.stringify(path)})`);
    if (status.startsWith('D')) c.deleted.push(path);
    else {
      c.applied.push(path);
      if (isRun.some((t) => t(path)) && !isSnap.some((t) => t(path))) c.run.push(path);
    }
  }
  return c;
}

function existsAt(git: Git, root: string, rev: string, paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  const out = git.run(['cat-file', '--batch-check=%(objecttype)'], root, paths.map((p) => `${rev}:${p}\n`).join('')).toString('utf8').split('\n');
  return paths.filter((_, i) => (out[i] ?? '').trim() === 'blob' || (out[i] ?? '').trim() === 'commit');
}

interface SideRun {
  side: 'base' | 'head' | 'before';
  files: string[];
  report: TestReport | null;
  note: string | null;
}

interface CommandOutcome {
  code: number | null;
  signal: string | null;
  timedOut: boolean;
  tail: string;
  spawnError: string | null;
}

function runCommand(command: string, files: readonly string[], cwd: string, env: Record<string, string>, timeoutMs: number, controller: FailFirstController): Promise<CommandOutcome> {
  return new Promise((resolveRun) => {
    let tail = '';
    let timedOut = false;
    let settled = false;
    const child = spawn('/bin/sh', ['-c', command, 'openmorals-fail-first', ...files], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (b: Buffer): void => {
      tail = (tail + b.toString('utf8')).slice(-TAIL_BYTES);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const killGroup = (sig: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        // the group is already gone
      }
    };
    let hard: NodeJS.Timeout | null = null;
    const stop = (): void => {
      killGroup('SIGTERM');
      hard ??= setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
    };
    controller.setKill(stop);
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const finish = (o: Omit<CommandOutcome, 'tail' | 'timedOut'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hard !== null) clearTimeout(hard);
      killGroup('SIGKILL');
      controller.setKill(null);
      child.stdout?.removeAllListeners('data');
      child.stderr?.removeAllListeners('data');
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolveRun({ ...o, tail, timedOut });
    };
    child.once('error', (e) => finish({ code: null, signal: null, spawnError: e.message }));
    child.once('exit', (code, signal) => finish({ code, signal, spawnError: null }));
    if (controller.cancelled !== null) stop();
  });
}

function lastLines(s: string, n: number): string {
  const lines = s.split(/\r?\n/).filter((l) => l.trim() !== '');
  return lines.slice(-n).map((l) => `    | ${l.length > 300 ? `${l.slice(0, 297)}...` : l}`).join('\n');
}

const EXT: Readonly<Record<ReportFormat, string>> = { junit: 'xml', jest: 'json', 'go-json': 'jsonl', 'dart-json': 'jsonl' };

function short(sha: string): string {
  return sha.slice(0, 12);
}

function cannot(error: string, json: boolean, extra = ''): FailFirstResult {
  const msg = `openmorals tests fail-first: ${error}. Nothing was judged: read this as "needs review", never as a pass.${extra !== '' ? `\n${extra}` : ''}`;
  return { exitCode: FAIL_FIRST_EXIT.cannotCheck, stdout: json ? `${JSON.stringify({ exitCode: FAIL_FIRST_EXIT.cannotCheck, error })}\n` : '', stderr: `${msg}\n` };
}

function usage(error: string): FailFirstResult {
  return { exitCode: FAIL_FIRST_EXIT.usage, stdout: '', stderr: `openmorals tests fail-first: ${error}; nothing was done\n\nUsage:\n${FAIL_FIRST_USAGE}\n` };
}

function notConfigured(file: string, json: boolean): FailFirstResult {
  const error = `no test command is set in ${file}`;
  const text = [
    `openmorals tests fail-first: ${error}. Nothing was run, and nothing was judged: read this as "needs review", never as a pass.`,
    `Put your own command there, for example (the change's test files arrive as "$@"; the report goes to $OPENMORALS_REPORT):`,
    '  fail_first:',
    '    command: node --test --test-reporter=junit --test-reporter-destination="$OPENMORALS_REPORT" "$@"',
    `    timeout_s: ${FAIL_FIRST_DEFAULT_TIMEOUT_S}`,
    'openmorals never takes the test command from the project, its package scripts or the change.',
  ].join('\n');
  return { exitCode: FAIL_FIRST_EXIT.notConfigured, stdout: json ? `${JSON.stringify({ exitCode: FAIL_FIRST_EXIT.notConfigured, error, settingsFile: file })}\n` : '', stderr: `${text}\n` };
}

function rowLine(r: FailFirstRow): string {
  const base = r.base === 'fails-assertion' ? `fails on base by assertion (${r.baseWhy ?? ''})`
    : r.base === 'fails-error' ? `red for the wrong reason on base (${r.baseWhy ?? 'an error'})`
      : r.base === 'load-error' ? `red for the wrong reason on base: ${r.baseWhy ?? 'its file did not load'}`
        : r.base === 'fails-unknown' ? `fails on base, cannot tell why (${r.baseWhy ?? 'no reason shown'})`
          : r.base === 'passes' ? 'passes on base' : r.base === 'skipped' ? 'skipped on base' : 'did not run on base';
  const head = r.head === 'pass' ? 'passes at head' : r.head === 'fail' ? 'fails at head' : r.head === 'skip' ? 'skipped at head' : 'not in the head run';
  return `${r.id}   ${base}; ${head}`;
}

function totals(r: TestReport | null): string {
  if (r === null) return 'not run';
  const n = (s: string): number => r.tests.filter((t) => t.status === s && t.failure?.load !== true).length;
  const loads = r.tests.filter((t) => t.failure?.load === true).length + (r.loadErrors?.length ?? 0);
  const all = n('pass') + n('fail') + n('skip');
  return `${r.format}, ${all} test${all === 1 ? '' : 's'} (${n('pass')} pass, ${n('fail')} fail, ${n('skip')} skipped)${loads > 0 ? `, ${loads} file(s) did not load` : ''}`;
}

interface Context {
  base: string;
  head: string;
  settingsFile: string;
  timeoutS: number;
  files: ChangedFiles;
  runs: SideRun[];
  notes: string[];
  reportsDir: string | null;
  copied: Record<string, string>;
  /** The checkout folder each run's report names in its file paths (removed by now; for --before-root and --after-root). */
  roots: Record<string, string>;
}

function formatText(j: FailFirstJudgement, ctx: Context): string {
  const L: string[] = [];
  L.push(`openmorals tests fail-first: base ${short(ctx.base)}, head ${short(ctx.head)}; test command from ${ctx.settingsFile}`);
  L.push(`  test files the change added or changed: ${ctx.files.run.length} run${ctx.files.applied.length > ctx.files.run.length ? `, ${ctx.files.applied.length - ctx.files.run.length} more copied (helpers, fixtures, snapshots)` : ''}`);
  for (const r of ctx.runs) L.push(`  ${r.side === 'base' ? 'base with the change\'s tests' : r.side === 'head' ? 'head' : 'base as it was'}: ${totals(r.report)}${r.note !== null ? ` (${r.note})` : ''}`);
  L.push(`  (each run bounded by ${ctx.timeoutS} s; totals are shown only and never decide the result)`);
  L.push('');
  const named = j.rows.filter((r) => r.named !== null);
  L.push(`Named acceptance tests: ${named.length + j.problems.filter((p) => p.id === null).length}`);
  for (const r of named) L.push(`  ${j.problems.some((p) => p.id === r.id) ? 'FAIL' : 'ok  '} ${rowLine(r)}`);
  for (const p of j.problems) if (p.id === null) L.push(`  FAIL ${p.named}   ${p.text}`);
  const section = (title: string, rows: FailFirstRow[], mark: string): void => {
    L.push(`${title}: ${rows.length}`);
    for (const r of rows) L.push(`  ${mark} ${rowLine(r)}`);
  };
  section('New tests that fail on base by assertion', j.newRedByAssertion, '+');
  section('Red for the wrong reason on base (an error, not an assertion)', [...j.namedRedWrongReason, ...j.newRedWrongReason], '!');
  section('Red on base, cannot tell why', [...j.namedRedCannotTell, ...j.newRedCannotTell], '?');
  section('New tests that pass on base (pointer lines: a refactor or characterisation test passes on base by design; a test meant to show the change is needed does not)', j.newPassingOnBase, '>');
  if (j.newSkippedOrAbsentOnBase.length > 0) section('New tests skipped or not run on base', j.newSkippedOrAbsentOnBase, '~');
  if (j.newNotPassingAtHead.length > 0) section('New tests not passing at head (shown only; tests compare judges the head)', j.newNotPassingAtHead, '-');
  if (ctx.notes.length > 0) {
    L.push('Notes:');
    for (const n of ctx.notes) L.push(`  ${n}`);
  }
  if (ctx.reportsDir !== null) {
    L.push(`Reports copied to ${ctx.reportsDir}: ${Object.values(ctx.copied).join(', ')}`);
    if (ctx.copied['base'] !== undefined && ctx.copied['head'] !== undefined) {
      L.push(`  by test name (the paths in the reports name the removed checkouts, so strip them):`);
      L.push(`  openmorals tests compare ${join(ctx.reportsDir, ctx.copied['base'])} ${join(ctx.reportsDir, ctx.copied['head'])} --before-root ${ctx.roots['base'] ?? ''} --after-root ${ctx.roots['head'] ?? ''}`);
    }
  }
  L.push('');
  const soft = j.namedRedWrongReason.length + j.namedRedCannotTell.length;
  if (j.exitCode === 0) {
    L.push(j.rows.some((r) => r.named !== null)
      ? `Result: every named acceptance test fails on base and passes at head (exit 0)${soft > 0 ? `; ${soft} of them only by an error or for a reason the report does not show (listed above)` : ''}.`
      : 'Result: no acceptance test was named, so nothing here can fail the check; the lists above are for reading (exit 0).');
  }
  else {
    L.push(`Result: ${j.problems.length} problem(s) with named acceptance tests (exit 1):`);
    for (const p of j.problems) L.push(`  ${p.id ?? p.named}: ${p.text}`);
  }
  L.push('');
  L.push('What this cannot tell you:');
  for (const s of FAIL_FIRST_LIMITS) L.push(`  ${s}`);
  return `${L.join('\n')}\n`;
}

function jsonBody(j: FailFirstJudgement, ctx: Context): string {
  const ids = (rows: FailFirstRow[]): string[] => rows.map((r) => r.id);
  const body = {
    exitCode: j.exitCode,
    base: ctx.base,
    head: ctx.head,
    settingsFile: ctx.settingsFile,
    timeoutSeconds: ctx.timeoutS,
    testFiles: ctx.files.run,
    copiedFiles: ctx.files.applied.filter((f) => !ctx.files.run.includes(f)),
    deletedTestFiles: ctx.files.deleted,
    runs: Object.fromEntries(ctx.runs.map((r) => [r.side, { ran: r.report !== null, format: r.report?.format ?? null, files: r.files, note: r.note }])),
    rows: j.rows,
    problems: j.problems,
    newRedByAssertion: ids(j.newRedByAssertion),
    redWrongReason: ids([...j.namedRedWrongReason, ...j.newRedWrongReason]),
    redCannotTell: ids([...j.namedRedCannotTell, ...j.newRedCannotTell]),
    newPassingOnBase: ids(j.newPassingOnBase),
    newSkippedOrAbsentOnBase: ids(j.newSkippedOrAbsentOnBase),
    newNotPassingAtHead: ids(j.newNotPassingAtHead),
    notes: ctx.notes,
    reports: ctx.reportsDir !== null ? Object.fromEntries(Object.entries(ctx.copied).map(([k, v]) => [k, join(ctx.reportsDir ?? '', v)])) : null,
    reportRoots: ctx.reportsDir !== null ? ctx.roots : null,
    limits: FAIL_FIRST_LIMITS,
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

function inside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** The real path of p, or of its nearest existing parent with the rest appended (so a folder still to be made is compared by where it would land). */
function realOrResolved(p: string): string {
  const abs = resolve(p);
  let head = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync(head), ...rest.reverse());
    } catch {
      const up = dirname(head);
      if (up === head) return abs;
      rest.push(basename(head));
      head = up;
    }
  }
}

/**
 * `openmorals tests fail-first ...`. Runs the person's own test command (from the user-level file only) in temporary
 * shared clones and judges with `judgeFailFirst`. Writes nothing into the repository's working tree, index or `.git`;
 * the temporary folder is removed on every exit path a process can catch.
 */
export async function failFirstCommand(argv: readonly string[], deps: FailFirstDeps = {}): Promise<FailFirstResult> {
  const env = deps.env ?? process.env;
  const parsed = parseArgs(argv);
  if (!parsed.ok) return usage(parsed.error);
  const a = parsed.a;
  const platform = deps.platform ?? process.platform;
  if (platform === 'win32') return cannot('it runs the test command with /bin/sh and is not built for Windows yet', a.json);
  if (a.order !== null) {
    const named = approvedOrderTestIds(a.order, env, deps.cwd ?? process.cwd());
    if (!named.ok) return cannot(named.error, a.json);
    for (const id of named.ids) if (!a.expect.includes(id)) a.expect.push(id);
  }
  const settingsFile = join(configDir(env), FAIL_FIRST_SETTINGS_FILE);
  let settingsText: string;
  try {
    settingsText = readFileSync(settingsFile, 'utf8');
  } catch (e: unknown) {
    if (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOENT') return notConfigured(settingsFile, a.json);
    return cannot(`cannot read ${settingsFile}: ${e instanceof Error ? e.message : String(e)}`, a.json);
  }
  const st = parseFailFirstSettings(settingsText, settingsFile);
  if (!st.ok) return cannot(st.error, a.json);
  const timeoutS = a.timeoutS ?? st.settings.timeoutS ?? FAIL_FIRST_DEFAULT_TIMEOUT_S;
  const controller = deps.controller ?? new FailFirstController();
  const childEnv = cleanEnv(env);
  const cwd = deps.cwd ?? process.cwd();
  let tmpRoot: string | null = null;
  try {
    tmpRoot = realpathSync(mkdtempSync(join(deps.tmpBase ?? tmpdir(), TEMP_PREFIX)));
    const noHooks = join(tmpRoot, 'no-hooks');
    mkdirSync(noHooks);
    const git = makeGit(childEnv, noHooks);
    const repoDir = resolve(cwd, a.repo ?? '.');
    if (!existsSync(repoDir)) throw new CannotCheck(`${repoDir} does not exist`);
    const top = git.run(['rev-parse', '--show-toplevel'], repoDir).toString('utf8').trim();
    if (top === '') throw new CannotCheck(`${repoDir} is not inside a git working tree (a bare repository is not read)`);
    const root = realOrResolved(top);
    const rev = (r: string, what: string): string => {
      try {
        return git.run(['rev-parse', '--verify', '--quiet', '--end-of-options', `${r}^{commit}`], root).toString('utf8').trim();
      } catch {
        throw new CannotCheck(`${what} ${JSON.stringify(r)} is not a commit in this repository (a typo, a branch that is not here, or a shallow clone without it)`);
      }
    };
    const base = rev(a.base, 'base');
    const head = rev(a.head, 'head');
    let reportsDir: string | null = null;
    if (a.reports !== null) {
      reportsDir = resolve(cwd, a.reports);
      if (inside(realOrResolved(reportsDir), root)) return usage(`--reports ${a.reports} is inside the repository; it must be a folder outside it, so nothing is written into the working tree`);
    }
    const files = changedTestFiles(git, root, base, head);
    const notes: string[] = [];
    if (base === head) notes.push('base and head are the same commit, so the change has no test files.');
    const dirty = git.run(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=normal'], root).toString('utf8').split('\u0000').filter((s) => s !== '').length;
    if (dirty > 0) notes.push(`${dirty} uncommitted change(s) in the working tree are not part of this check: it reads the commits base and head only.`);
    if (files.deleted.length > 0) notes.push(`test files the change deletes (not run): ${files.deleted.join(', ')}`);
    if (existsSync(join(root, '.gitmodules'))) notes.push('submodules are not checked out in the temporary checkouts.');
    if (files.run.length === 0 && a.expect.length === 0) {
      const j = judgeFailFirst({ before: null, base: { format: 'junit', tests: [], skippedLines: 0 }, head: { format: 'junit', tests: [], skippedLines: 0 }, acceptance: [] });
      const ctx: Context = { base, head, settingsFile, timeoutS, files, runs: [], notes: [...notes, 'the change adds or changes no test file and no acceptance test was named, so nothing was run.'], reportsDir: null, copied: {}, roots: {} };
      return { exitCode: 0, stdout: a.json ? jsonBody(j, ctx) : formatText(j, ctx), stderr: '' };
    }
    const beforeFiles = existsAt(git, root, base, files.run);
    const plan: Array<{ side: SideRun['side']; files: string[] }> = [
      { side: 'base', files: files.run },
      { side: 'head', files: files.run },
    ];
    const runs: SideRun[] = [];
    // The base as it was is run only to learn which tests already existed; with none of the files there, all are new.
    if (beforeFiles.length > 0) plan.push({ side: 'before', files: beforeFiles });
    else runs.push({ side: 'before', files: [], report: null, note: 'not run: none of the change\'s test files existed on base, so every test in them is new' });
    const reportPaths: Record<string, { path: string; format: ReportFormat }> = {};
    for (const p of plan) {
      if (controller.cancelled !== null) throw new Cancelled();
      const dir = join(tmpRoot, p.side);
      git.run(['clone', '--shared', '--no-checkout', '--quiet', `--template=${noHooks}`, '--', root, dir], tmpRoot);
      git.run(['checkout', '--quiet', '--detach', p.side === 'head' ? head : base], dir);
      if (p.side === 'base' && files.applied.length > 0) git.run(['checkout', '--quiet', head, '--pathspec-from-file=-', '--pathspec-file-nul'], dir, files.applied.map((f) => `${f}\u0000`).join(''));
      const reportPath = join(tmpRoot, `${p.side}.report`);
      const runEnv = { ...childEnv, OPENMORALS_REPORT: reportPath, OPENMORALS_SIDE: p.side, OPENMORALS_REPO: root, OPENMORALS_BASE: base, OPENMORALS_HEAD: head };
      const o = await runCommand(st.settings.command, p.files, dir, runEnv, timeoutS * 1000, controller);
      if (controller.cancelled !== null) throw new Cancelled();
      const label = p.side === 'base' ? 'the base with the change\'s tests' : p.side === 'head' ? 'the head' : 'the base as it was';
      if (o.spawnError !== null) throw new CannotCheck(`the test command could not start on ${label}: ${o.spawnError}`);
      if (o.timedOut) throw new CannotCheck(`the test command on ${label} did not finish within ${timeoutS} s and was stopped`);
      let text: string | null = null;
      try {
        const s = statSync(reportPath);
        if (s.isFile() && s.size > MAX_REPORT_BYTES) throw new CannotCheck(`the report from ${label} is larger than ${MAX_REPORT_BYTES} bytes`);
        if (s.isFile() && s.size > 0) text = readFileSync(reportPath, 'utf8');
      } catch (e: unknown) {
        if (e instanceof CannotCheck) throw e;
      }
      const exitText = o.code !== null ? `exit ${o.code}` : `signal ${o.signal ?? '?'}`;
      if (text === null) {
        throw new CannotCheck(`the test command on ${label} wrote no report to $OPENMORALS_REPORT (${exitText})`, { cause: lastLines(o.tail, 20) });
      }
      const r = parseTestReport(text, { root: dir, loadErrorsOnly: true });
      if (!r.ok) {
        throw new CannotCheck(`the report from ${label} cannot be read: ${r.error}`, { cause: lastLines(o.tail, 20) });
      }
      runs.push({ side: p.side, files: p.files, report: r.report, note: `${exitText}` });
      reportPaths[p.side] = { path: reportPath, format: r.report.format };
    }
    runs.sort((x, y) => plan.findIndex((p) => p.side === x.side) - plan.findIndex((p) => p.side === y.side));
    const get = (s: SideRun['side']): TestReport | null => runs.find((r) => r.side === s)?.report ?? null;
    const baseReport = get('base');
    const headReport = get('head');
    if (baseReport === null || headReport === null) throw new CannotCheck('a run produced no report');
    const j = judgeFailFirst({ before: get('before'), base: baseReport, head: headReport, acceptance: a.expect });
    const copied: Record<string, string> = {};
    if (reportsDir !== null) {
      mkdirSync(reportsDir, { recursive: true });
      for (const [side, rp] of Object.entries(reportPaths)) {
        const name = `fail-first-${side}.${EXT[rp.format]}`;
        copyFileSync(rp.path, join(reportsDir, name));
        copied[side] = name;
      }
    }
    const roots = Object.fromEntries(Object.keys(reportPaths).map((side) => [side, join(tmpRoot ?? '', side)]));
    const ctx: Context = { base, head, settingsFile, timeoutS, files, runs, notes, reportsDir, copied, roots };
    return { exitCode: j.exitCode, stdout: a.json ? jsonBody(j, ctx) : formatText(j, ctx), stderr: '' };
  } catch (e: unknown) {
    if (e instanceof Cancelled || controller.cancelled !== null) {
      const sig = controller.cancelled ?? 'SIGTERM';
      const n = SIGNAL_NUMBERS[sig] ?? 15;
      return { exitCode: 128 + n, stdout: '', stderr: `openmorals tests fail-first: stopped by ${sig}; the test command was killed and the temporary checkouts removed. Nothing was judged.\n` };
    }
    if (e instanceof CannotCheck) {
      const cause = typeof e.cause === 'string' && e.cause !== '' ? `  last lines of the test command's output:\n${e.cause}` : '';
      return cannot(e.message, a.json, cause);
    }
    return cannot(`an unexpected error: ${e instanceof Error ? e.message : String(e)}`, a.json);
  } finally {
    if (tmpRoot !== null) rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

const SIGNAL_NUMBERS: Readonly<Record<string, number>> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGTERM: 15 };
