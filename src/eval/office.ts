// The shape of `openmorals eval`'s office before-after rows (Q8, 0.30.0) and how they print. Types and text only: the
// corpus and the readers live in src/office/, which the CLI loads only when eval runs (ruling R3).

/**
 * The false-alarm threshold of the office before-after check: at most this share of the clean before-after pairs may
 * fail. Set in the build log before the checks or the corpus were measured, and not moved after (ruling Q8's kill
 * criterion). eval reports the measured rate against it; it does not tune it.
 */
export const OFFICE_FALSE_ALARM_THRESHOLD = 0.05;

export interface OfficeEvalRow {
  id: string;
  format: 'xlsx' | 'docx';
  kind: 'clean' | 'damaged' | 'not-computed' | 'malformed';
  expect: 'pass' | 'fail' | 'not computed';
  check: string | null;
  got: 'pass' | 'fail' | 'not computed' | 'crash';
  /** The checks that did not pass. */
  failing: string[];
  right: boolean;
  /** The first line that did not pass, or a crash's message. */
  first: string;
  label: string;
  ms: number;
}

export interface OfficeEvalScore {
  rows: number;
  /** Clean before-after pairs: the check must pass them. */
  clean: number;
  cleanXlsx: number;
  cleanDocx: number;
  /** Clean pairs that did not pass. */
  falseAlarms: number;
  falseAlarmRate: number | null;
  threshold: number;
  damaged: number;
  /** Damaged pairs that failed on the expected check. */
  caught: number;
  notComputed: number;
  saidNotComputed: number;
  malformed: number;
  /** Malformed or hostile files that gave "could not read" and a failed check. */
  unreadable: number;
  crashes: number;
  wrong: OfficeEvalRow[];
  p50Ms: number | null;
  p95Ms: number | null;
}

function pct(r: number | null): string {
  return r === null ? '-' : `${(r * 100).toFixed(1)}%`;
}

/** The office lines of the eval text. */
export function formatOfficeText(o: OfficeEvalScore): string[] {
  const out: string[] = [];
  const within = o.falseAlarmRate === null ? 'no clean pair' : o.falseAlarmRate <= o.threshold ? 'within it' : 'ABOVE IT';
  out.push(
    `office before-after (order check, built from a seeded corpus, not in the total): ${o.rows} rows; damaged caught ${o.caught}/${o.damaged}; clean pairs failed (false alarms) ${o.falseAlarms}/${o.clean} (${pct(o.falseAlarmRate)}; ${o.cleanXlsx} workbooks, ${o.cleanDocx} documents), threshold ${pct(o.threshold)} set before measuring: ${within}; not recalculated said "not computed" ${o.saidNotComputed}/${o.notComputed}; malformed or hostile said "could not read" ${o.unreadable}/${o.malformed}; crashes ${o.crashes}; p50 ${o.p50Ms === null ? '-' : o.p50Ms.toFixed(1)} ms, p95 ${o.p95Ms === null ? '-' : o.p95Ms.toFixed(1)} ms per pair`,
  );
  for (const w of o.wrong) out.push(`  office ${w.id}: expected ${w.expect}${w.check !== null ? ` (${w.check})` : ''}, got ${w.got}${w.failing.length > 0 ? ` [${w.failing.join(', ')}]` : ''}: ${w.label}${w.first !== '' ? `: ${w.first.slice(0, 160)}` : ''}`);
  return out;
}
