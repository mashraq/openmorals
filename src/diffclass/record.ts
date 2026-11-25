import type { RunSummary } from '../audit-verify.js';
import type { Reason } from './types.js';

/**
 * The parts of a run summary (`openmorals audit --run ID --json`) the verdict reads. Every field can only add a
 * reason; a clean summary adds none and so changes nothing (ADR 0013).
 */
export interface RecordFacts {
  run: string;
  status: string;
  records: number;
  denies: number;
  asks: number;
  approvedAsks: number;
  taintMarks: number;
  looseningNotes: number;
  recordOk: boolean;
  problems: number;
}

export function factsOf(s: RunSummary): RecordFacts {
  return {
    run: s.run,
    status: s.status,
    records: s.records,
    denies: s.denies.length,
    asks: s.asks.length,
    approvedAsks: s.approved_asks.length,
    taintMarks: s.taint_marks.length,
    looseningNotes: s.loosening_notes.length,
    recordOk: s.record.ok,
    problems: s.record.problems.length,
  };
}

/** Reads a saved run summary (JSON). Any field missing or of the wrong type makes it unreadable. */
export function parseSummary(text: string): { ok: true; facts: RecordFacts } | { ok: false; error: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, error: 'the run summary is not JSON (give the output of openmorals audit --run ID --json)' };
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, error: 'the run summary is not a JSON object' };
  const o = v as Record<string, unknown>;
  const list = (k: string): number | null => (Array.isArray(o[k]) ? (o[k] as unknown[]).length : null);
  const rec = o['record'];
  const recOk = typeof rec === 'object' && rec !== null ? (rec as Record<string, unknown>)['ok'] : undefined;
  const recProblems = typeof rec === 'object' && rec !== null ? (rec as Record<string, unknown>)['problems'] : undefined;
  const run = o['run'];
  const status = o['status'];
  const records = o['records'];
  const counts = ['denies', 'asks', 'approved_asks', 'taint_marks', 'loosening_notes'].map(list);
  if (typeof run !== 'string' || typeof status !== 'string' || typeof records !== 'number' || !Number.isInteger(records) || records < 0 || counts.some((c) => c === null) || typeof recOk !== 'boolean' || !Array.isArray(recProblems)) {
    return { ok: false, error: 'the run summary lacks run, status, records, denies, asks, approved_asks, taint_marks, loosening_notes or record (give the output of openmorals audit --run ID --json)' };
  }
  const [denies, asks, approvedAsks, taintMarks, looseningNotes] = counts.map((c) => c ?? 0);
  return { ok: true, facts: { run, status, records, denies: denies ?? 0, asks: asks ?? 0, approvedAsks: approvedAsks ?? 0, taintMarks: taintMarks ?? 0, looseningNotes: looseningNotes ?? 0, recordOk: recOk, problems: recProblems.length } };
}

function n(k: number, one: string, many: string): string {
  return `${k} ${k === 1 ? one : many}`;
}

/**
 * The reasons a run's record raises. Any ask counts, not only an approved one: where the host sends no post-tool event
 * a refused ask and an approved one look the same.
 */
export function recordReasons(f: RecordFacts, declaredRun: string | null): Reason[] {
  const out: Reason[] = [];
  const r = (rule: string, text: string): void => {
    out.push({ rule, path: null, text });
  };
  if (declaredRun !== null && f.run !== declaredRun) r('record.other-run', `the summary is for run ${f.run}, not the declared run ${declaredRun}`);
  if (f.status === 'missing') r('record.missing', `no audit log was found for run ${f.run}`);
  else if (f.status !== 'ok' && f.status !== 'empty') r('record.unreadable', `the audit log for run ${f.run} could not be read (${f.status})`);
  if (f.records === 0 && f.status !== 'missing') r('record.missing', `run ${f.run} was declared and has no record`);
  if (f.denies > 0) r('record.deny', `run ${f.run}: ${n(f.denies, 'action was', 'actions were')} denied`);
  if (f.approvedAsks > 0) r('record.approved-ask', `run ${f.run}: ${n(f.approvedAsks, 'ask was', 'asks were')} approved by a person`);
  if (f.asks > 0) r('record.ask', `run ${f.run}: openmorals asked ${n(f.asks, 'time', 'times')} (an ask whose outcome is not recorded may have been approved)`);
  if (f.taintMarks > 0) r('record.taint', `run ${f.run}: ${n(f.taintMarks, 'taint or injection mark', 'taint or injection marks')}`);
  if (f.looseningNotes > 0) r('record.loosening', `run ${f.run}: a project file tried to loosen the bylaws (${n(f.looseningNotes, 'note', 'notes')})`);
  if (!f.recordOk) r('record.unverified', `run ${f.run}: the record does not verify (${n(f.problems, 'problem', 'problems')}: an edited, missing or cut-off line, or a reset session)`);
  return out;
}
