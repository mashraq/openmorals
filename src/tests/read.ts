import { readFileSync, statSync } from 'node:fs';
import { parseTestReport } from './report.js';
import type { ReportFormat, TestReport } from './report.js';

export const MAX_REPORT_BYTES = 256 * 1024 * 1024;

/** Reads and parses one test report file, refusing anything that is not a regular file or is too large. */
export function readReport(file: string, format: ReportFormat | undefined, root: string | undefined): { ok: true; report: TestReport } | { ok: false; error: string } {
  let text: string;
  try {
    const st = statSync(file);
    if (!st.isFile()) return { ok: false, error: `${file} is not a file` };
    if (st.size > MAX_REPORT_BYTES) return { ok: false, error: `${file} is larger than ${MAX_REPORT_BYTES} bytes` };
    text = readFileSync(file, 'utf8');
  } catch (e: unknown) {
    return { ok: false, error: `cannot read ${file}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const r = parseTestReport(text, { ...(format !== undefined ? { format } : {}), ...(root !== undefined ? { root } : {}) });
  return r.ok ? r : { ok: false, error: `${file}: ${r.error}` };
}
