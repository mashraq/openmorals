import { readFileSync, statSync } from 'node:fs';
import { compareCoverage, parseCoverage } from './coverage.js';
import type { CoverageComparison, FileCoverage } from './coverage.js';
import { MAX_REPORT_BYTES } from './read.js';
import type { SubResult } from './provenance-command.js';

export const COVERAGE_USAGE = `  openmorals tests coverage <before> <after> [--min-drop POINTS] [--before-root DIR] [--after-root DIR] [--json]
      Compares two coverage reports (lcov tracefile or Cobertura XML) file by file. Lists each file whose share of
      covered lines fell by at least POINTS percentage points (default 1), and each file that had covered lines and
      is gone from the after report. One line per file, worst first; the totals are shown and decide nothing.
      Exit 0 when no file dropped, 1 when one did, 2 when a report cannot be read, 64 usage error.`;

export const COVERAGE_LIMITS: readonly string[] = [
  'Coverage says a line ran, not that a test checked what it did.',
  'A file whose lines moved is compared by share, not line by line.',
  'Make both reports with your own gate: a report the agent produced is its claim, not a measurement.',
];

function read(file: string, root: string | undefined): { ok: true; files: FileCoverage[]; format: string } | { ok: false; error: string } {
  let text: string;
  try {
    const st = statSync(file);
    if (!st.isFile()) return { ok: false, error: `${file} is not a file` };
    if (st.size > MAX_REPORT_BYTES) return { ok: false, error: `${file} is larger than ${MAX_REPORT_BYTES} bytes` };
    text = readFileSync(file, 'utf8');
  } catch (e: unknown) {
    return { ok: false, error: `cannot read ${file}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const r = parseCoverage(text, root);
  return r.ok ? { ok: true, files: r.files, format: r.format } : { ok: false, error: `${file}: ${r.error}` };
}

function format(c: CoverageComparison, before: string, after: string, minDrop: number): string {
  const L: string[] = [];
  const tot = (t: { lines: number; covered: number }): string => `${t.covered} of ${t.lines} lines (${t.lines === 0 ? 100 : Math.round((t.covered / t.lines) * 1000) / 10}%)`;
  L.push(c.drops.length === 0 ? `No file lost ${minDrop} or more points of coverage.` : `${c.drops.length} file${c.drops.length === 1 ? '' : 's'} lost coverage:`);
  for (const d of c.drops) L.push(d.why === 'gone-from-report' ? `  ${d.file}: ${d.before}% before, gone from the after report (its tests may no longer run)` : `  ${d.file}: ${d.before}% to ${d.after}% (${d.coveredBefore} to ${d.coveredAfter} covered lines)`);
  if (c.newUncovered.length > 0) L.push(`New files no test runs: ${c.newUncovered.join(', ')}`);
  L.push(`Totals (shown only): before ${before} ${tot(c.totals.before)}; after ${after} ${tot(c.totals.after)}`);
  L.push('', ...COVERAGE_LIMITS.map((l) => `Not checked: ${l}`));
  return `${L.join('\n')}\n`;
}

export function coverageCommand(argv: readonly string[]): SubResult {
  const usage = (why: string): SubResult => ({ exitCode: 64, stdout: '', stderr: `openmorals tests coverage: ${why}; nothing was done\n\nUsage:\n${COVERAGE_USAGE}\n` });
  const pos: string[] = [];
  let minDrop = 1;
  let beforeRoot: string | undefined;
  let afterRoot: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--json') json = true;
    else if (a === '--min-drop' || a === '--before-root' || a === '--after-root') {
      const v = argv[++i];
      if (v === undefined || v === '') return usage(`${a} needs a value`);
      if (a === '--min-drop') {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0 || n > 100) return usage('--min-drop must be a number of points above 0 and at most 100');
        minDrop = n;
      } else if (a === '--before-root') beforeRoot = v;
      else afterRoot = v;
    } else if (a.startsWith('--')) return usage(`unknown option ${a}`);
    else pos.push(a);
  }
  if (pos.length !== 2) return usage(pos.length < 2 ? 'needs a before report and an after report' : `unexpected argument ${JSON.stringify(pos[2])}`);
  const [bf, af] = pos as [string, string];
  const fail = (error: string): SubResult => ({ exitCode: 2, stdout: json ? `${JSON.stringify({ exitCode: 2, error })}\n` : '', stderr: `openmorals tests coverage: ${error}. Nothing was compared; read this as "needs review".\n` });
  const b = read(bf, beforeRoot);
  if (!b.ok) return fail(b.error);
  const a = read(af, afterRoot);
  if (!a.ok) return fail(a.error);
  const c = compareCoverage(b.files, a.files, minDrop);
  const exitCode = c.drops.length > 0 ? 1 : 0;
  if (json) return { exitCode, stdout: `${JSON.stringify({ exitCode, formats: { before: b.format, after: a.format }, minDrop, ...c, limits: COVERAGE_LIMITS }, null, 2)}\n`, stderr: '' };
  return { exitCode, stdout: format(c, bf, af, minDrop), stderr: '' };
}
