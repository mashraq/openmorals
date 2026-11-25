// Scores the seeded office corpus for `openmorals eval` (0.30.0). Loaded by the CLI only when eval runs, never by a hook.
import type { OfficeEvalRow, OfficeEvalScore } from '../eval/office.js';
import { OFFICE_FALSE_ALARM_THRESHOLD } from '../eval/office.js';
import type { OfficeRow } from './corpus.js';
import { officeRows } from './corpus.js';
import { compareOffice } from './index.js';

function judge(row: OfficeRow): OfficeEvalRow {
  const t0 = performance.now();
  let got: OfficeEvalRow['got'];
  let failing: string[] = [];
  let first = '';
  try {
    const { before, after } = row.build();
    const r = compareOffice(row.format, before, after, { ...(row.inputs !== undefined ? { inputs: row.inputs } : {}), ...(row.redline === true ? { redline: true } : {}) });
    got = r.status;
    failing = r.lines.filter((l) => l.outcome !== 'pass').map((l) => l.check);
    first = r.lines.find((l) => l.outcome !== 'pass')?.text ?? '';
  } catch (e: unknown) {
    got = 'crash';
    first = e instanceof Error ? e.message : String(e);
  }
  const ms = performance.now() - t0;
  let right: boolean;
  if (row.expect === 'pass') right = got === 'pass';
  else if (row.expect === 'not computed') right = got === 'not computed' && failing.every((c) => c === (row.check ?? 'computed'));
  else right = got === 'fail' && (row.check === undefined || failing.includes(row.check));
  return { id: row.id, format: row.format, kind: row.kind, expect: row.expect, check: row.check ?? null, got, failing, right, first: first.slice(0, 200), label: row.label, ms };
}

/** Builds and judges every office row. */
export function scoreOffice(): OfficeEvalScore {
  const rows = officeRows().map(judge);
  const clean = rows.filter((r) => r.kind === 'clean');
  const falseAlarms = clean.filter((r) => r.got !== 'pass').length;
  const damaged = rows.filter((r) => r.kind === 'damaged');
  const nc = rows.filter((r) => r.kind === 'not-computed');
  const bad = rows.filter((r) => r.kind === 'malformed');
  const times = rows.map((r) => r.ms).sort((a, b) => a - b);
  const at = (q: number): number | null => (times.length === 0 ? null : (times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? null));
  return {
    rows: rows.length,
    clean: clean.length,
    cleanXlsx: clean.filter((r) => r.format === 'xlsx').length,
    cleanDocx: clean.filter((r) => r.format === 'docx').length,
    falseAlarms,
    falseAlarmRate: clean.length === 0 ? null : falseAlarms / clean.length,
    threshold: OFFICE_FALSE_ALARM_THRESHOLD,
    damaged: damaged.length,
    caught: damaged.filter((r) => r.right).length,
    notComputed: nc.length,
    saidNotComputed: nc.filter((r) => r.got === 'not computed').length,
    malformed: bad.length,
    unreadable: bad.filter((r) => r.right).length,
    crashes: rows.filter((r) => r.got === 'crash').length,
    wrong: rows.filter((r) => !r.right),
    p50Ms: at(0.5),
    p95Ms: at(0.95),
  };
}
