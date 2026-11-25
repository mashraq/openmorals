import { readFileSync, statSync } from 'node:fs';
import { checkClaim, parseClaimList, passingIds } from './claim.js';
import type { ClaimResult } from './claim.js';
import { heldSet, readQuarantine } from './quarantine.js';
import { MAX_REPORT_BYTES, readReport } from './read.js';
import { REPORT_FORMATS, isReportFormat, parseTestReport } from './report.js';
import type { ReportFormat } from './report.js';
import type { SubResult } from './provenance-command.js';

export const CLAIM_USAGE = `  openmorals tests claim <clean-report> [--claimed FILE] [--format ${REPORT_FORMATS.join('|')}] [--root DIR] [--json]
      Checks what the agent said passed against a run you made yourself. With --claimed, FILE is the agent's own
      test report (its passing tests are the claim) or a list of test ids or names, one per line; without it the
      claim is "every test passes". Each claimed test that fails, is skipped or did not run in the clean report is
      listed, and so are files that did not load. A test on hold (tests-quarantine.txt) is listed and does not
      decide the result. Exit 0 when the claim holds, 1 when it does not, 2 when a file cannot be read, 64 usage.`;

export const CLAIM_LIMITS: readonly string[] = [
  'The clean report is only as clean as the run that made it: run it with your own gate, in a fresh checkout, not in the agent\'s shell.',
  'A claim made in prose ("all green") is read as "every test passes"; a narrower claim needs --claimed.',
  'A test that passes can still check nothing; this says only whether it ran and passed.',
];

const MISS_TEXT: Record<string, string> = { fails: 'fails in the clean run', skipped: 'was skipped in the clean run', 'did-not-run': 'is not in the clean run', ambiguous: 'matches more than one test; give the full id' };

function format(r: ClaimResult, clean: string, holdFile: string): string {
  const out: string[] = [];
  out.push(r.blocking === 0 ? `The claim holds: ${r.confirmed} of ${r.checked} claimed test${r.checked === 1 ? '' : 's'} pass in ${clean}.` : `The claim does not hold: ${r.blocking} problem${r.blocking === 1 ? '' : 's'} against ${clean} (${r.confirmed} of ${r.checked} confirmed).`);
  for (const p of r.problems) out.push(`  ${p.claimed}${p.id !== null && p.id !== p.claimed ? ` (${p.id})` : ''} ${MISS_TEXT[p.miss] ?? p.miss}${p.held ? `, on hold in ${holdFile}` : ''}`);
  if (r.loadErrors.length > 0) out.push(`Did not load in the clean run: ${r.loadErrors.join(', ')}`);
  out.push('', ...CLAIM_LIMITS.map((l) => `Not checked: ${l}`));
  return `${out.join('\n')}\n`;
}

function readClaimed(file: string, format: ReportFormat | undefined): { ok: true; ids: string[]; kind: 'report' | 'list' } | { ok: false; error: string } {
  let text: string;
  try {
    const st = statSync(file);
    if (!st.isFile()) return { ok: false, error: `${file} is not a file` };
    if (st.size > MAX_REPORT_BYTES) return { ok: false, error: `${file} is larger than ${MAX_REPORT_BYTES} bytes` };
    text = readFileSync(file, 'utf8');
  } catch (e: unknown) {
    return { ok: false, error: `cannot read ${file}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const asReport = parseTestReport(text, format !== undefined ? { format } : {});
  if (asReport.ok) return { ok: true, ids: passingIds(asReport.report), kind: 'report' };
  const ids = parseClaimList(text);
  if (ids.length === 0) return { ok: false, error: `${file} names no test` };
  if (ids.some((l) => l.startsWith('<') || l.startsWith('{'))) return { ok: false, error: `${file} looks like a report this command could not read (${asReport.error})` };
  return { ok: true, ids, kind: 'list' };
}

export function claimCommand(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): SubResult {
  const usage = (why: string): SubResult => ({ exitCode: 64, stdout: '', stderr: `openmorals tests claim: ${why}; nothing was done\n\nUsage:\n${CLAIM_USAGE}\n` });
  const pos: string[] = [];
  let claimedFile: string | undefined;
  let fmt: ReportFormat | undefined;
  let root: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--json') json = true;
    else if (a === '--claimed' || a === '--format' || a === '--root') {
      const v = argv[++i];
      if (v === undefined || v === '') return usage(`${a} needs a value`);
      if (a === '--claimed') claimedFile = v;
      else if (a === '--root') root = v;
      else if (isReportFormat(v)) fmt = v;
      else return usage(`--format must be one of ${REPORT_FORMATS.join(', ')}`);
    } else if (a.startsWith('--')) return usage(`unknown option ${a}`);
    else pos.push(a);
  }
  if (pos.length !== 1) return usage(pos.length === 0 ? 'needs the clean report' : `unexpected argument ${JSON.stringify(pos[1])}`);
  const cleanFile = pos[0] as string;
  const fail = (error: string): SubResult => ({ exitCode: 2, stdout: json ? `${JSON.stringify({ exitCode: 2, error })}\n` : '', stderr: `openmorals tests claim: ${error}. Nothing was checked; read this as "needs review".\n` });
  const clean = readReport(cleanFile, fmt, root);
  if (!clean.ok) return fail(clean.error);
  const claimed = claimedFile === undefined ? null : readClaimed(claimedFile, fmt);
  if (claimed !== null && !claimed.ok) return fail(claimed.error);
  const q = readQuarantine(env);
  if (!q.ok) return fail(q.error);
  const r = checkClaim(clean.report, claimed === null ? null : claimed.ids, heldSet(q.holds));
  const exitCode = r.blocking > 0 ? 1 : 0;
  if (json) return { exitCode, stdout: `${JSON.stringify({ exitCode, clean: cleanFile, claimed: claimedFile ?? null, claimedAs: claimed === null ? 'all' : claimed.kind, ...r, holdFile: q.file, limits: CLAIM_LIMITS }, null, 2)}\n`, stderr: '' };
  return { exitCode, stdout: format(r, cleanFile, q.file), stderr: '' };
}
