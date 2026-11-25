// `openmorals audit sample`, the pure half: which finished runs (or sessions) the audit record holds, which of them a
// draw picks for a close read, and what the draws and verdicts recorded so far add up to. Nothing here reads a file,
// writes a file or calls a model.
//
// The draw: every unit (a run id, or a session) is considered once, in the first draw after it finished. A fresh 32-byte
// seed comes from the operating system's random source when the person runs the command; a unit is picked when the
// first 48 bits of HMAC-SHA256(seed, unit id), read as a fraction of 2^48, are below 1/N. The seed does not exist when
// any record is written, so no id, order, timing or field the agent wrote changes a unit's chance of being picked, and
// the draw can be recomputed later from the seed, the population and N, all of which are recorded.
import { createHmac } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type { AuditRecord, AuditSampleData } from '../audit.js';
import { parseAuditLine } from '../audit.js';
import type { VerifyFinding, VerifyProblemKind, VerifyResult } from '../audit-verify.js';
import { chainKey } from '../audit-verify.js';
import type { Decision } from '../types.js';

export type SampleBy = 'run' | 'session';
export const SAMPLE_BYS: readonly SampleBy[] = ['run', 'session'];
export type SampleVerdict = 'clean' | 'escape';
export const SAMPLE_VERDICTS: readonly SampleVerdict[] = ['clean', 'escape'];

/** The session the sample's own records are chained under. */
export const SAMPLE_SESSION = 'audit-sample';
/** Rule names of the sample's own records. */
export const SAMPLE_RULES = { draw: 'audit.sample.draw', verdict: 'audit.sample.verdict', change: 'audit.sample.change' } as const;
/** How a pick is computed from the seed, recorded with every draw so a later reader can recompute it. */
export const SAMPLE_METHOD = 'hmac-sha256-48';

export interface SampleSettings {
  /** N: read 1 in N units. 1 reads everything. */
  rate: number;
  /** K: after an escape or a declared change, read everything in the draws that consider the next K units. */
  read_all_next: number;
  /** The unit drawn when the command does not say. */
  by: SampleBy;
  /** A unit with a record in the last this-many minutes may still be running: it waits for a later draw. */
  settle_minutes: number;
}

export const DEFAULT_SAMPLE_SETTINGS: Readonly<SampleSettings> = { rate: 10, read_all_next: 5, by: 'run', settle_minutes: 30 };
export const SAMPLE_RATE_MAX = 1000;
export const SAMPLE_READ_ALL_MAX = 1000;
export const SAMPLE_SETTLE_MAX = 10080;

/** What the output says it cannot know. Printed with every result, text or JSON. */
export const SAMPLE_LIMITS: readonly string[] = [
  'A sample finds what a reader notices, not everything.',
  'It covers only sessions on hosts that call openmorals: work done where the hook did not run left no record and is never drawn.',
  'The record names actions, not the quality of the work: read the work itself.',
  'A clean read lowers no other check: every ask and deny stands.',
];

/** Parses the user-level settings file. An unknown key or a value out of range is an error, never a silent default. */
export function parseSampleSettings(text: string): { ok: true; settings: SampleSettings } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = parseYaml(text, { strict: true, uniqueKeys: true, maxAliasCount: 0 });
  } catch (err: unknown) {
    return { ok: false, error: `YAML parse error: ${err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err)}` };
  }
  const s: SampleSettings = { ...DEFAULT_SAMPLE_SETTINGS };
  if (raw === null || raw === undefined) return { ok: true, settings: s };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'the file must hold a mapping (rate, read_all_next, by, settle_minutes)' };
  const o = raw as Record<string, unknown>;
  const errors: string[] = [];
  for (const k of Object.keys(o)) if (!['rate', 'read_all_next', 'by', 'settle_minutes'].includes(k)) errors.push(`unknown key ${k}`);
  const int = (k: 'rate' | 'read_all_next' | 'settle_minutes', min: number, max: number): void => {
    const v = o[k];
    if (v === undefined) return;
    if (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max) s[k] = v;
    else errors.push(`${k} must be a whole number from ${min} to ${max}`);
  };
  int('rate', 1, SAMPLE_RATE_MAX);
  int('read_all_next', 0, SAMPLE_READ_ALL_MAX);
  int('settle_minutes', 0, SAMPLE_SETTLE_MAX);
  const by = o['by'];
  if (by !== undefined) {
    if (by === 'run' || by === 'session') s.by = by;
    else errors.push('by must be run or session');
  }
  return errors.length > 0 ? { ok: false, error: errors.join('; ') } : { ok: true, settings: s };
}

/** The chance-number of one unit under one seed: a fraction in [0, 1). */
export function pickNumber(seedHex: string, unit: string): number {
  const h = createHmac('sha256', Buffer.from(seedHex, 'hex')).update(unit, 'utf8').digest();
  return h.readUIntBE(0, 6) / 2 ** 48;
}

/** The units a draw picks: the same for any order of `population`, governed by the seed alone. */
export function drawPicks(population: readonly string[], rate: number, seedHex: string): string[] {
  return [...new Set(population)].sort().filter((u) => pickNumber(seedHex, u) < 1 / rate);
}

export interface SampleItem {
  line: number;
  ts: string;
  session: string | null;
  tool: string;
  decision: Decision;
  rule: string;
  action: string;
}

/** What the record holds about one unit, for a reader looking for the work. */
export interface UnitSummary {
  by: SampleBy;
  id: string;
  records: number;
  first: string;
  last: string;
  sessions: string[];
  cwds: string[];
  allowed: number;
  asked: number;
  denied: number;
  approved_asks: number;
  taint_marks: number;
  loosening_notes: number;
  denies: SampleItem[];
  asks: SampleItem[];
  /** The distinct commands and files the records name, first ones first. */
  actions: string[];
}

const MAX_ITEMS = 20;
const MAX_ACTIONS = 20;
const MAX_ACTION_CHARS = 200;
const MAX_CWDS = 5;

function cut(s: string): string {
  return s.length > MAX_ACTION_CHARS ? `${s.slice(0, MAX_ACTION_CHARS)}…` : s;
}

export interface DrawEvent {
  kind: 'draw';
  line: number;
  ts: string;
  by: SampleBy;
  rate: number;
  read_all: boolean;
  seed: string;
  method: string;
  population: string[];
  picks: string[];
  forced: string[];
  active: string[];
}

export interface VerdictEvent {
  kind: 'verdict';
  line: number;
  ts: string;
  by: SampleBy;
  unit: string;
  verdict: SampleVerdict;
  note: string;
}

export interface ChangeEvent {
  kind: 'change';
  line: number;
  ts: string;
  what: string;
}

export type SampleEvent = DrawEvent | VerdictEvent | ChangeEvent;

/** A sample record that cannot be read, or a draw that does not recompute from its own seed. */
export interface SampleProblem {
  line: number;
  detail: string;
}

export interface LogScan {
  units: Map<string, UnitSummary>;
  /** Records outside any run (run mode only): they are in no run's population. */
  outside: { records: number; sessions: number };
  events: SampleEvent[];
  problems: SampleProblem[];
}

const HEX64 = /^[0-9a-f]{64}$/;

function strList(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
}

function isSampleRecord(r: AuditRecord): boolean {
  return r.rule.startsWith('audit.sample.');
}

/** Reads one sample record's payload; a malformed one is a problem, never skipped quietly. */
export function readSampleEvent(r: AuditRecord, line: number): SampleEvent | SampleProblem {
  const s: AuditSampleData | undefined = r.v === 2 ? r.sample : undefined;
  if (s === undefined) return { line, detail: `a ${r.rule} record without its sample data` };
  const by = s['by'];
  if (r.rule === SAMPLE_RULES.draw) {
    const population = strList(s['population']);
    const picks = strList(s['picks']);
    const forced = strList(s['forced']);
    const active = strList(s['active']);
    const rate = s['rate'];
    const seed = s['seed'];
    const method = s['method'];
    const readAll = s['read_all'];
    if ((by !== 'run' && by !== 'session') || population === null || picks === null || forced === null || active === null || typeof rate !== 'number' || !Number.isInteger(rate) || rate < 1 || typeof seed !== 'string' || !HEX64.test(seed) || typeof method !== 'string' || typeof readAll !== 'boolean') {
      return { line, detail: 'a draw record with missing or mistyped fields' };
    }
    return { kind: 'draw', line, ts: r.ts, by, rate, read_all: readAll, seed, method, population, picks, forced, active };
  }
  if (r.rule === SAMPLE_RULES.verdict) {
    const unit = s['unit'];
    const verdict = s['verdict'];
    if ((by !== 'run' && by !== 'session') || typeof unit !== 'string' || (verdict !== 'clean' && verdict !== 'escape')) return { line, detail: 'a verdict record with missing or mistyped fields' };
    return { kind: 'verdict', line, ts: r.ts, by, unit, verdict, note: r.reason };
  }
  if (r.rule === SAMPLE_RULES.change) return { kind: 'change', line, ts: r.ts, what: r.reason };
  return { line, detail: `an unknown sample record ${r.rule}` };
}

/** Reads the log text once: the units of one kind, and the sample's own records in line order. */
export function scanLog(text: string, by: SampleBy): LogScan {
  const units = new Map<string, UnitSummary>();
  const events: SampleEvent[] = [];
  const problems: SampleProblem[] = [];
  let outsideRecords = 0;
  const outsideSessions = new Set<string>();
  text.split('\n').forEach((raw, i) => {
    if (raw.trim() === '') return;
    const n = i + 1;
    const r = parseAuditLine(raw);
    if ('error' in r) return;
    if (isSampleRecord(r)) {
      const e = readSampleEvent(r, n);
      if ('kind' in e) events.push(e);
      else problems.push(e);
      return;
    }
    const session = chainKey(r);
    if (session === SAMPLE_SESSION) return;
    let id: string;
    if (by === 'run') {
      if (r.v !== 2 || r.run === undefined) {
        outsideRecords++;
        outsideSessions.add(session);
        return;
      }
      id = r.run;
    } else id = session;
    let u = units.get(id);
    if (u === undefined) {
      u = { by, id, records: 0, first: r.ts, last: r.ts, sessions: [], cwds: [], allowed: 0, asked: 0, denied: 0, approved_asks: 0, taint_marks: 0, loosening_notes: 0, denies: [], asks: [], actions: [] };
      units.set(id, u);
    }
    u.records++;
    if (r.ts < u.first) u.first = r.ts;
    if (r.ts > u.last) u.last = r.ts;
    if (!u.sessions.includes(session)) u.sessions.push(session);
    if (r.cwd !== null && !u.cwds.includes(r.cwd) && u.cwds.length < MAX_CWDS) u.cwds.push(r.cwd);
    const item: SampleItem = { line: n, ts: r.ts, session: r.session, tool: r.tool, decision: r.decision, rule: r.rule, action: cut(r.action) };
    if (r.decision === 'deny') {
      u.denied++;
      if (u.denies.length < MAX_ITEMS) u.denies.push(item);
    } else if (r.decision === 'ask') u.asked++;
    else u.allowed++;
    if (r.rule === 'ask.approved') u.approved_asks++;
    else if (r.action.startsWith('inbound ')) u.taint_marks++;
    else if (r.decision === 'ask' && u.asks.length < MAX_ITEMS) u.asks.push(item);
    if (r.reason.includes('bylaws.loosening-ignored')) u.loosening_notes++;
    const a = cut(r.action.replace(/\s+/g, ' ').trim());
    if (a !== '' && !a.startsWith('inbound ') && u.actions.length < MAX_ACTIONS && !u.actions.includes(a)) u.actions.push(a);
  });
  for (const u of units.values()) u.sessions.sort();
  return { units, outside: { records: outsideRecords, sessions: outsideSessions.size }, events, problems };
}

/** Where the rate stands: N from the settings, or 1 while units after the latest escape or declared change are fewer than K. */
export interface RateState {
  rate: number;
  read_all: boolean;
  /** Units still to read in full; 0 when sampling at N. */
  remaining: number;
  /** What started reading everything: the latest escape or declared change, or null. */
  since: { kind: 'escape' | 'change'; line: number; ts: string; detail: string } | null;
}

export function rateState(events: readonly SampleEvent[], settings: SampleSettings): RateState {
  let since: RateState['since'] = null;
  let sinceIndex = -1;
  events.forEach((e, i) => {
    if (e.kind === 'verdict' && e.verdict === 'escape') {
      since = { kind: 'escape', line: e.line, ts: e.ts, detail: `${e.by}:${e.unit}` };
      sinceIndex = i;
    } else if (e.kind === 'change') {
      since = { kind: 'change', line: e.line, ts: e.ts, detail: e.what };
      sinceIndex = i;
    }
  });
  if (since === null || settings.read_all_next === 0) return { rate: settings.rate, read_all: false, remaining: 0, since };
  let considered = 0;
  for (const e of events.slice(sinceIndex + 1)) if (e.kind === 'draw') considered += e.population.length;
  const remaining = Math.max(0, settings.read_all_next - considered);
  return remaining > 0 ? { rate: 1, read_all: true, remaining, since } : { rate: settings.rate, read_all: false, remaining: 0, since };
}

export interface DrawPlan {
  by: SampleBy;
  rate: number;
  read_all: boolean;
  remaining_before: number;
  since: RateState['since'];
  seed: string;
  method: string;
  /** Units considered by this draw, sorted. */
  population: string[];
  /** Units picked by the seed. */
  drawn: string[];
  /** Units picked because a session of theirs does not verify, whatever the seed says. */
  forced: string[];
  /** drawn plus forced, sorted. */
  picks: string[];
  /** Units with a record in the settle window (or later than now): left for a later draw. */
  active: string[];
  /** Units already considered by an earlier draw of this kind. */
  earlier: number;
  outside: LogScan['outside'];
  /** Verify problems about a session of a unit in this population, by unit. */
  unitProblems: Map<string, VerifyFinding<VerifyProblemKind>[]>;
  summaries: UnitSummary[];
  sampleProblems: SampleProblem[];
}

/** Plans one draw from the log text, its verification, the settings, the time and a seed. Pure. */
export function planDraw(text: string, verified: VerifyResult, settings: SampleSettings, by: SampleBy, now: Date, seedHex: string): DrawPlan {
  const scan = scanLog(text, by);
  const state = rateState(scan.events, settings);
  const earlierSet = new Set<string>();
  for (const e of scan.events) if (e.kind === 'draw' && e.by === by) for (const u of e.population) earlierSet.add(u);
  const settledBefore = new Date(now.getTime() - settings.settle_minutes * 60_000).toISOString();
  const population: string[] = [];
  const active: string[] = [];
  let earlier = 0;
  for (const u of [...scan.units.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (earlierSet.has(u.id)) {
      earlier++;
      continue;
    }
    if (u.last > settledBefore) active.push(u.id);
    else population.push(u.id);
  }
  const unitProblems = new Map<string, VerifyFinding<VerifyProblemKind>[]>();
  for (const id of population) {
    const sessions = new Set(scan.units.get(id)?.sessions ?? []);
    const ps = verified.problems.filter((p) => p.session !== null && sessions.has(p.session));
    if (ps.length > 0) unitProblems.set(id, ps);
  }
  const drawn = drawPicks(population, state.rate, seedHex);
  const forced = [...unitProblems.keys()].filter((u) => !drawn.includes(u)).sort();
  const picks = [...new Set([...drawn, ...forced])].sort();
  const summaries = picks.map((id) => scan.units.get(id)).filter((u): u is UnitSummary => u !== undefined);
  return { by, rate: state.rate, read_all: state.read_all, remaining_before: state.remaining, since: state.since, seed: seedHex, method: SAMPLE_METHOD, population, drawn, forced, picks, active, earlier, outside: scan.outside, unitProblems, summaries, sampleProblems: scan.problems };
}

/** The `sample` object a draw record carries. */
export function drawData(p: DrawPlan): AuditSampleData {
  return { by: p.by, rate: p.rate, read_all: p.read_all, seed: p.seed, method: p.method, population: p.population, picks: p.picks, forced: p.forced, active: p.active };
}

export interface TallyPick {
  by: SampleBy;
  unit: string;
  drawn_at: string;
  draw_line: number;
  forced: boolean;
  verdict: SampleVerdict | null;
  note: string | null;
  verdict_at: string | null;
}

export interface Tally {
  draws: number;
  by: Record<SampleBy, number>;
  considered: number;
  picked: number;
  forced: number;
  verdicts: { total: number; clean: number; escape: number };
  /** Picks with a verdict, over picks; null when nothing was picked. */
  verdict_share: number | null;
  /** Escapes over verdicts; null when no verdict was recorded. */
  escape_rate: number | null;
  open: TallyPick[];
  picks: TallyPick[];
  changes: ChangeEvent[];
  next: RateState;
  /** Draws that do not recompute from their own seed, verdicts for units never picked, unreadable sample records. */
  problems: SampleProblem[];
}

/** Adds up the draws and verdicts in the log. Recomputes every draw from its seed. Pure. */
export function tallySamples(text: string, settings: SampleSettings): Tally {
  const scan = scanLog(text, settings.by);
  const problems = [...scan.problems];
  const picks = new Map<string, TallyPick>();
  const by: Record<SampleBy, number> = { run: 0, session: 0 };
  let draws = 0;
  let considered = 0;
  for (const e of scan.events) {
    if (e.kind === 'draw') {
      draws++;
      by[e.by]++;
      considered += e.population.length;
      if (e.method !== SAMPLE_METHOD) problems.push({ line: e.line, detail: `a draw made by an unknown method ${e.method}; it cannot be recomputed` });
      else {
        const again = drawPicks(e.population, e.rate, e.seed);
        const want = [...new Set([...again, ...e.forced])].sort();
        if (want.join('\n') !== [...e.picks].sort().join('\n')) problems.push({ line: e.line, detail: 'the picks recorded for this draw are not the ones its seed, population and rate give: the line was edited' });
      }
      for (const u of e.picks) {
        const key = `${e.by}:${u}`;
        if (!picks.has(key)) picks.set(key, { by: e.by, unit: u, drawn_at: e.ts, draw_line: e.line, forced: e.forced.includes(u), verdict: null, note: null, verdict_at: null });
      }
    } else if (e.kind === 'verdict') {
      const p = picks.get(`${e.by}:${e.unit}`);
      if (p === undefined) {
        problems.push({ line: e.line, detail: `a verdict for ${e.by}:${e.unit}, which no earlier draw picked; it is not counted` });
        continue;
      }
      p.verdict = e.verdict;
      p.note = e.note;
      p.verdict_at = e.ts;
    }
  }
  const all = [...picks.values()];
  const judged = all.filter((p) => p.verdict !== null);
  const escape = judged.filter((p) => p.verdict === 'escape').length;
  return {
    draws,
    by,
    considered,
    picked: all.length,
    forced: all.filter((p) => p.forced).length,
    verdicts: { total: judged.length, clean: judged.length - escape, escape },
    verdict_share: all.length === 0 ? null : judged.length / all.length,
    escape_rate: judged.length === 0 ? null : escape / judged.length,
    open: all.filter((p) => p.verdict === null),
    picks: all,
    changes: scan.events.filter((e): e is ChangeEvent => e.kind === 'change'),
    next: rateState(scan.events, settings),
    problems,
  };
}

/** Finds the pick a verdict names: `run:ID`, `session:ID`, or a bare id that only one pick carries. */
export function findPick(events: readonly SampleEvent[], name: string): { ok: true; by: SampleBy; unit: string } | { ok: false; error: string; usage: boolean } {
  const m = /^(run|session):(.+)$/.exec(name);
  const candidates = new Set<string>();
  for (const e of events) {
    if (e.kind !== 'draw') continue;
    for (const u of e.picks) {
      if (m !== null ? e.by === m[1] && u === m[2] : u === name) candidates.add(`${e.by}:${u}`);
    }
  }
  if (candidates.size === 0) return { ok: false, error: `${name} was not picked by any draw: only a drawn unit gets a verdict, so the tally stays a sample`, usage: false };
  if (candidates.size > 1) return { ok: false, error: `${name} names more than one pick (${[...candidates].sort().join(', ')}): say run:${name} or session:${name}`, usage: true };
  const [only] = [...candidates];
  const i = (only ?? '').indexOf(':');
  return { ok: true, by: (only ?? '').slice(0, i) as SampleBy, unit: (only ?? '').slice(i + 1) };
}
