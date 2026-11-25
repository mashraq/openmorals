import { readFileSync } from 'node:fs';
import { readReport } from './read.js';
import { heldSet, readQuarantine } from './quarantine.js';
import { join } from 'node:path';
import { configDir } from '../paths.js';
import { compareTests, parseApprovals } from './compare.js';
import type { Approval, Comparison, Loss } from './compare.js';
import { REPORT_FORMATS, isReportFormat } from './report.js';
import { FAIL_FIRST_USAGE as FAIL_FIRST_USAGE_TEXT } from './failfirst-usage.js';
import { PROVENANCE_USAGE, provenanceCommand } from './provenance-command.js';
import { CLAIM_USAGE, claimCommand } from './claim-command.js';
import { COVERAGE_USAGE, coverageCommand } from './coverage-command.js';
import type { ReportFormat, TestReport } from './report.js';

export const APPROVAL_FILE = 'tests-approved.txt';
/** Exit code for a report or approval file that cannot be read: the result is unknown, so it is read as "review". */
export const UNREADABLE_EXIT = 2;
export { MAX_REPORT_BYTES } from './read.js';

/** What the output says it cannot know. Printed with every result, text or JSON. */
export const LIMITS: readonly string[] = [
  'It cannot tell which of these tests the agent could edit; a test the agent wrote or changed can pass without showing anything.',
  'A renamed test shows as one gone and one new.',
  'These lists say nothing about tests that check little.',
  'A report is only as trustworthy as the run that made it: make both reports with your own gate, not the agent\'s.',
];

export interface TestsCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const TESTS_COMPARE_USAGE = `  openmorals tests compare <before> <after> [--json] [--format ${REPORT_FORMATS.join('|')}]
                  [--before-root DIR] [--after-root DIR] [--before-repeat FILE]... [--after-repeat FILE]...
      Compare two test reports by test name: tests that failed (or were absent) before
      and pass after, and tests that passed before and now fail, are gone or are
      skipped. Reads JUnit XML (also node --test --test-reporter=junit), Jest or Vitest
      JSON, go test -json and flutter test --machine (dart test --reporter json).
      Never runs tests and writes nothing. --before-root and --after-root strip a
      folder from file paths in the names, for reports made in two different folders;
      --before-repeat and --after-repeat add more runs of the same code to find flaky
      tests. Approve an expected loss with a line "fails|gone|skipped <test name>" in
      ${APPROVAL_FILE} in the config directory. Exit code: 0 no unapproved loss, 1 a test
      that passed is failing, gone or skipped and is not approved, 2 a report or the
      approval file cannot be read, 64 usage error. Totals never decide the exit code.`;

export const TESTS_USAGE = `${TESTS_COMPARE_USAGE}
${FAIL_FIRST_USAGE_TEXT}
${PROVENANCE_USAGE}
${CLAIM_USAGE}
${COVERAGE_USAGE}`;

interface Parsed {
  before: string;
  after: string;
  json: boolean;
  format: ReportFormat | undefined;
  beforeRoot: string | undefined;
  afterRoot: string | undefined;
  beforeRepeats: string[];
  afterRepeats: string[];
}

const VALUE_OPTS = new Set(['--format', '--before-root', '--after-root', '--before-repeat', '--after-repeat']);

function parse(argv: readonly string[]): { ok: true; p: Parsed } | { ok: false; error: string } {
  const pos: string[] = [];
  const p: Parsed = { before: '', after: '', json: false, format: undefined, beforeRoot: undefined, afterRoot: undefined, beforeRepeats: [], afterRepeats: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a === '--json') {
      p.json = true;
      continue;
    }
    if (a.startsWith('-') && a !== '-') {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      if (!VALUE_OPTS.has(name)) return { ok: false, error: `unknown option ${name}` };
      const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (value === undefined || value === '') return { ok: false, error: `${name} needs a value` };
      if (name === '--format') {
        if (!isReportFormat(value)) return { ok: false, error: `--format must be one of ${REPORT_FORMATS.join(', ')}` };
        p.format = value;
      } else if (name === '--before-root') p.beforeRoot = value;
      else if (name === '--after-root') p.afterRoot = value;
      else if (name === '--before-repeat') p.beforeRepeats.push(value);
      else p.afterRepeats.push(value);
      continue;
    }
    pos.push(a);
  }
  if (pos.length !== 2) return { ok: false, error: pos.length < 2 ? 'needs a before report and an after report' : `unexpected argument ${JSON.stringify(pos[2])}` };
  p.before = pos[0] ?? '';
  p.after = pos[1] ?? '';
  return { ok: true, p };
}

function readApprovals(file: string): { ok: true; approvals: Approval[]; present: boolean } | { ok: false; error: string } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e: unknown) {
    if (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOENT') return { ok: true, approvals: [], present: false };
    return { ok: false, error: `cannot read the approval file ${file}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const r = parseApprovals(text);
  return r.ok ? { ok: true, approvals: r.approvals, present: true } : { ok: false, error: `the approval file ${file}: ${r.error}` };
}

function unreadable(error: string, json: boolean): TestsCommandResult {
  const msg = `openmorals tests compare: ${error}. Nothing was compared; read this as "needs review", not as "no damage".`;
  return { exitCode: UNREADABLE_EXIT, stdout: json ? `${JSON.stringify({ exitCode: UNREADABLE_EXIT, error })}\n` : '', stderr: `${msg}\n` };
}

function lossLine(l: Loss): string {
  return `${l.kind.padEnd(7)} ${l.id}${l.flaky ? '   (flaky)' : ''}${l.approvedBy !== null ? `   (approved, line ${l.approvedBy})` : ''}${l.held === true && l.approvedBy === null ? '   (on hold, does not block)' : ''}`;
}

function formatText(c: Comparison, ctx: { before: string; after: string; formats: string; approvalFile: string; skippedLines: number; noCommonIds: boolean }, exitCode: number): string {
  const L: string[] = [];
  const t = (x: Comparison['totals']['before']): string => `${x.tests} tests: ${x.pass} pass, ${x.fail} fail, ${x.skip} skipped`;
  L.push(`openmorals tests compare (${ctx.formats})`);
  L.push(`  before ${ctx.before}: ${t(c.totals.before)}`);
  L.push(`  after  ${ctx.after}: ${t(c.totals.after)}`);
  L.push('  (totals are shown only; they never decide the result)');
  if (ctx.skippedLines > 0) L.push(`  ${ctx.skippedLines} line(s) that were not JSON events were skipped`);
  L.push('');
  L.push(`Failed or absent before, pass after: ${c.failToPass.length}`);
  for (const g of c.failToPass) L.push(`  + ${g.id}   (${g.was === 'new' ? 'new test' : `was ${g.was}`})${g.flaky ? '   (flaky)' : ''}${g.held === true ? '   (on hold: not counted as proof)' : ''}`);
  const losses = [...c.passToFail, ...c.gone, ...c.newlySkipped];
  L.push(`Passed before, now failing, gone or skipped: ${losses.length} (${c.passToFail.length} failing, ${c.gone.length} gone, ${c.newlySkipped.length} skipped)`);
  for (const l of losses) L.push(`  - ${lossLine(l)}`);
  if (c.likelyRenames.length > 0) {
    L.push('Likely renames (gone and new in the same file; each gone test still needs approval):');
    for (const g of c.likelyRenames) L.push(`  ${g.file}: gone ${g.gone.map((s) => JSON.stringify(s)).join(', ')}; new ${g.added.map((s) => JSON.stringify(s)).join(', ')}`);
  }
  if (c.flaky.length > 0) {
    L.push(`Flaky (outcome differs between runs of one side): ${c.flaky.length}`);
    for (const id of c.flaky) L.push(`  ~ ${id}`);
  }
  if (c.failingGone.length > 0) {
    L.push(`Failing before and now gone (not counted as a loss; worth a look): ${c.failingGone.length}`);
    for (const id of c.failingGone) L.push(`  ? ${id}`);
  }
  if (c.unusedApprovals.length > 0) L.push(`Approval lines that matched nothing this time: ${c.unusedApprovals.map((a) => a.line).join(', ')} (remove them when the change has landed)`);
  if (ctx.noCommonIds) L.push('No test name is in both reports. If they were made in two different folders, pass --before-root and --after-root.');
  L.push('');
  if (exitCode === 0) L.push('Result: no test that passed before is failing, gone or skipped without approval (exit 0).');
  else {
    L.push(`Result: ${c.blocking} test(s) that passed before are failing, gone or skipped without approval (exit 1).`);
    L.push(`To approve one, add its line to ${ctx.approvalFile}:`);
    for (const l of losses) if (l.approvedBy === null && l.held !== true) L.push(`  ${l.kind} ${l.id}`);
  }
  L.push('');
  L.push('What this cannot tell you:');
  for (const s of LIMITS) L.push(`  ${s}`);
  return `${L.join('\n')}\n`;
}

/** `openmorals tests <subcommand> ...`. Reads the named reports and the user-level approval file; writes nothing. */
export function testsCommand(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): TestsCommandResult {
  const sub = argv[0];
  if (sub === 'fail-first') return { exitCode: 64, stdout: '', stderr: 'openmorals tests fail-first runs your test command and is asynchronous: call failFirstCommand; nothing was done\n' };
  if (sub === 'provenance') return provenanceCommand(argv.slice(1), env);
  if (sub === 'claim') return claimCommand(argv.slice(1), env);
  if (sub === 'coverage') return coverageCommand(argv.slice(1));
  if (sub !== 'compare') return { exitCode: 64, stdout: '', stderr: `openmorals tests: ${sub === undefined ? 'needs a subcommand' : `unknown subcommand ${sub}`}; nothing was done\n\nUsage:\n${TESTS_USAGE}\n` };
  const parsed = parse(argv.slice(1));
  if (!parsed.ok) return { exitCode: 64, stdout: '', stderr: `openmorals tests compare: ${parsed.error}; nothing was done\n\nUsage:\n${TESTS_USAGE}\n` };
  const p = parsed.p;
  const before: TestReport[] = [];
  const after: TestReport[] = [];
  for (const [file, side, root] of [
    [p.before, before, p.beforeRoot],
    ...p.beforeRepeats.map((f) => [f, before, p.beforeRoot] as const),
    [p.after, after, p.afterRoot],
    ...p.afterRepeats.map((f) => [f, after, p.afterRoot] as const),
  ] as const) {
    const r = readReport(file, p.format, root);
    if (!r.ok) return unreadable(r.error, p.json);
    side.push(r.report);
  }
  const approvalFile = join(configDir(env), APPROVAL_FILE);
  const ap = readApprovals(approvalFile);
  if (!ap.ok) return unreadable(ap.error, p.json);
  const q = readQuarantine(env);
  if (!q.ok) return unreadable(q.error, p.json);
  const c = compareTests(before, after, ap.approvals, heldSet(q.holds));
  const exitCode = c.blocking > 0 ? 1 : 0;
  const beforeIds = new Set(before.flatMap((r) => r.tests.map((t) => t.id)));
  const noCommonIds = !after.some((r) => r.tests.some((t) => beforeIds.has(t.id)));
  const formats = [...new Set([...before, ...after].map((r) => r.format))].join(', ');
  const skippedLines = [...before, ...after].reduce((n, r) => n + r.skippedLines, 0);
  if (p.json) {
    const body = {
      exitCode,
      blocking: c.blocking,
      formats: { before: before.map((r) => r.format), after: after.map((r) => r.format) },
      totals: c.totals,
      failToPass: c.failToPass,
      passToFail: c.passToFail,
      gone: c.gone,
      newlySkipped: c.newlySkipped,
      likelyRenames: c.likelyRenames,
      flaky: c.flaky,
      failingGone: c.failingGone,
      approvalFile,
      approvalFilePresent: ap.present,
      unusedApprovals: c.unusedApprovals,
      ...(q.holds.length > 0 ? { holdFile: q.file, held: q.holds.map((h) => h.id) } : {}),
      noCommonIds,
      skippedLines,
      editable: 'unknown',
      limits: LIMITS,
    };
    return { exitCode, stdout: `${JSON.stringify(body, null, 2)}\n`, stderr: '' };
  }
  return { exitCode, stdout: formatText(c, { before: p.before, after: p.after, formats, approvalFile, skippedLines, noCommonIds }, exitCode), stderr: '' };
}
