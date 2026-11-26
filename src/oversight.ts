/**
 * `openmorals audit oversight` (0.38.0): what one person's audit log shows about their oversight of their agents.
 *
 * It reads the log and changes nothing. It counts the agent's calls, the asks, the asks whose call then ran (the
 * `ask.approved` outcome lines written on a post-tool event), the asks with no outcome line, the denies, the calls
 * refused because the session was stopped, and the person's own stops and clears (session `stop`, written by
 * `openmorals stop` from 0.38.0). It prints reasons to look, never a pass: the log is evidence of what the hook saw,
 * not proof that any law or standard is met.
 */
import { readFileSync } from 'node:fs';
import { parseAuditLine, type AuditRecord } from './audit.js';
import { ORDER_SESSION, type VerifyResult } from './audit-verify.js';
import { SAMPLE_SESSION } from './sample/draw.js';
import { STOP_CLEAR_RULE, STOP_SESSION, STOP_SET_RULE, STOPPED_RULE } from './tokens/stop.js';
/** The outcome line of an ask whose call ran. */
export const APPROVED_RULE = 'ask.approved';
/** Post-tool events by host: a session with none of them can record no outcome for an ask. */
export const POST_TOOL_EVENTS: readonly string[] = ['PostToolUse', 'PostToolUseFailure', 'AfterTool', 'after_tool_call', 'tool.execute.after'];
/** At least this many asks of one rule before its approval rate is read as a pattern. */
export const MIN_ASKS_FOR_RATE = 20;
/** A rule whose asks are approved at least this often is shown as a candidate for an allow; it never changes on its own (ADR 0019). */
export const MOSTLY_APPROVED = 0.95;
/** The friction mark: asks per 100 calls above this, over at least `MIN_CALLS_FOR_MARK` calls, is a reason to look. */
export const ASKS_PER_100_MARK = 1;
export const MIN_CALLS_FOR_MARK = 100;

export interface OversightWindow {
  /** Inclusive, ISO time. */
  since?: string;
  /** Exclusive, ISO time. */
  until?: string;
}

export interface OversightRule {
  rule: string;
  asks: number;
  approved: number;
  approval_rate: number | null;
}

export type OversightNoteKind = 'record-not-verified' | 'unchained-records' | 'asks-without-outcome' | 'mostly-approved-rule' | 'over-friction-mark' | 'still-stopped' | 'stops-not-recorded' | 'no-records';

export interface OversightNote {
  kind: OversightNoteKind;
  detail: string;
}

export interface OversightSummary {
  window: OversightWindow;
  first: string | null;
  last: string | null;
  calls: number;
  allowed: number;
  asks: number;
  approved: number;
  no_outcome: number;
  approval_rate: number | null;
  asks_per_100: number | null;
  denies: number;
  stopped_refusals: number;
  stops_set: number;
  stops_cleared: number;
  /** Records of a person's or a script's own acts (order, audit sample, stop), not counted as calls. */
  person_records: number;
  sessions: number;
  sessions_without_outcomes: number;
  unreadable_lines: number;
  rules: OversightRule[];
  record: { ok: boolean; problems: number; unchained: number };
  notes: OversightNote[];
}

/** A date (`2026-11-01`, read as UTC midnight) or an ISO time, as an ISO time; null when it is neither. */
export function parseOversightTime(v: string): string | null {
  const s = v.trim();
  const t = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00.000Z`) : /^\d{4}-\d{2}-\d{2}T/.test(s) ? Date.parse(s) : Number.NaN;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** What `openmorals stop` records name: a session id, `--all`, `run <id>`, or null for a clear of every stop. */
function stopTarget(action: string): string | null {
  const words = action.trim().split(/\s+/).filter((w) => w !== '' && w !== 'stop' && w !== '--clear');
  if (words[0] === '--run') return words[1] === undefined ? null : `run ${words[1]}`;
  return words[0] ?? null;
}

function isPersonRecord(r: AuditRecord): boolean {
  return r.source === 'openmorals' && (r.session === STOP_SESSION || r.session === ORDER_SESSION || r.session === SAMPLE_SESSION);
}

const rate = (n: number, d: number): number | null => (d === 0 ? null : n / d);
const pct = (x: number): string => `${Math.round(x * 1000) / 10}%`;

/** Summarises the log text (pure). `verified` is `verifyAuditText` or `verifyAudit` over the same text, whole. */
export function summarizeOversightText(text: string, verified: VerifyResult, w: OversightWindow = {}): OversightSummary {
  const s: OversightSummary = { window: w, first: null, last: null, calls: 0, allowed: 0, asks: 0, approved: 0, no_outcome: 0, approval_rate: null, asks_per_100: null, denies: 0, stopped_refusals: 0, stops_set: 0, stops_cleared: 0, person_records: 0, sessions: 0, sessions_without_outcomes: 0, unreadable_lines: 0, rules: [], record: { ok: verified.ok, problems: verified.problems.length, unchained: verified.v1 }, notes: [] };
  const recs: AuditRecord[] = [];
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    const r = parseAuditLine(raw);
    if ('error' in r) {
      s.unreadable_lines++;
      continue;
    }
    if (w.since !== undefined && r.ts < w.since) continue;
    if (w.until !== undefined && r.ts >= w.until) continue;
    recs.push(r);
  }
  recs.sort((a, b) => a.ts.localeCompare(b.ts));
  const stopped = new Set<string>();
  const asksBySession = new Map<string, number>();
  const postSessions = new Set<string>();
  const byRule = new Map<string, { asks: number; approved: number }>();
  const ruleRow = (rule: string): { asks: number; approved: number } => {
    let x = byRule.get(rule);
    if (x === undefined) byRule.set(rule, (x = { asks: 0, approved: 0 }));
    return x;
  };
  const sessions = new Set<string>();
  for (const r of recs) {
    s.first ??= r.ts;
    s.last = r.ts;
    if (r.source === 'openmorals' && r.session === STOP_SESSION) {
      s.person_records++;
      const target = stopTarget(r.action);
      if (r.rule === STOP_SET_RULE) {
        s.stops_set++;
        stopped.add(target ?? '--all');
      } else if (r.rule === STOP_CLEAR_RULE) {
        s.stops_cleared++;
        if (target === null) stopped.clear();
        else stopped.delete(target);
      }
      continue;
    }
    if (isPersonRecord(r)) {
      s.person_records++;
      continue;
    }
    const key = `${r.source}\u0000${r.session ?? ''}`;
    sessions.add(key);
    const event = r.v === 2 ? r.event : undefined;
    if (event !== undefined && POST_TOOL_EVENTS.includes(event)) postSessions.add(key);
    if (r.rule === APPROVED_RULE) {
      s.approved++;
      const m = /asked \[([^\]\s]+)\]/.exec(r.reason);
      if (m?.[1] !== undefined) ruleRow(m[1]).approved++;
      continue;
    }
    if (r.action.startsWith('inbound ')) continue;
    if (event !== undefined && POST_TOOL_EVENTS.includes(event)) continue;
    s.calls++;
    if (r.decision === 'allow') s.allowed++;
    else if (r.decision === 'ask') {
      s.asks++;
      ruleRow(r.rule).asks++;
      asksBySession.set(key, (asksBySession.get(key) ?? 0) + 1);
    } else {
      s.denies++;
      if (r.rule === STOPPED_RULE) s.stopped_refusals++;
    }
  }
  s.sessions = sessions.size;
  s.sessions_without_outcomes = [...asksBySession.keys()].filter((k) => !postSessions.has(k)).length;
  s.no_outcome = Math.max(0, s.asks - s.approved);
  s.approval_rate = rate(Math.min(s.approved, s.asks), s.asks);
  s.asks_per_100 = s.calls === 0 ? null : (s.asks * 100) / s.calls;
  s.rules = [...byRule.entries()]
    .filter(([, x]) => x.asks > 0)
    .map(([rule, x]) => ({ rule, asks: x.asks, approved: x.approved, approval_rate: rate(Math.min(x.approved, x.asks), x.asks) }))
    .sort((a, b) => b.asks - a.asks || a.rule.localeCompare(b.rule));
  const n = s.notes;
  if (!verified.ok) n.push({ kind: 'record-not-verified', detail: `${verified.problems.length} problem${verified.problems.length === 1 ? '' : 's'} in the chain: run openmorals audit verify` });
  if (verified.v1 > 0) n.push({ kind: 'unchained-records', detail: `${verified.v1} record${verified.v1 === 1 ? ' is' : 's are'} from before the chain (version 1) and cannot be checked` });
  if (s.no_outcome > 0) n.push({ kind: 'asks-without-outcome', detail: `${s.no_outcome} ask${s.no_outcome === 1 ? '' : 's'} with no outcome line: refused, still waiting, or on a host or install without post-tool hooks; the log cannot tell which${s.sessions_without_outcomes > 0 ? ` (${s.sessions_without_outcomes} session${s.sessions_without_outcomes === 1 ? '' : 's'} with asks recorded no post-tool event at all)` : ''}` });
  for (const r of s.rules) {
    if (r.asks >= MIN_ASKS_FOR_RATE && r.approval_rate !== null && r.approval_rate >= MOSTLY_APPROVED) n.push({ kind: 'mostly-approved-rule', detail: `${r.rule}: ${r.approved} of ${r.asks} asks approved (${pct(r.approval_rate)}); a candidate for an allow, if you choose to make it one; nothing changes on its own, and a high approval rate is no reason to refuse` });
  }
  if (s.calls >= MIN_CALLS_FOR_MARK && s.asks_per_100 !== null && s.asks_per_100 > ASKS_PER_100_MARK) n.push({ kind: 'over-friction-mark', detail: `${Math.round(s.asks_per_100 * 10) / 10} asks per 100 calls, above ${ASKS_PER_100_MARK}` });
  if (stopped.size > 0) n.push({ kind: 'still-stopped', detail: `still stopped at the end of the period: ${[...stopped].sort().join(', ')}` });
  if (s.stopped_refusals > 0 && s.stops_set === 0) n.push({ kind: 'stops-not-recorded', detail: `${s.stopped_refusals} call${s.stopped_refusals === 1 ? ' was' : 's were'} refused as stopped but no stop is recorded in the period: set before it, or by an openmorals older than 0.38.0` });
  if (recs.length === 0) n.push({ kind: 'no-records', detail: 'no records in the period' });
  return s;
}

/** Reads the log and summarises it. Never throws and never writes. */
export function summarizeOversight(file: string, verified: VerifyResult, w: OversightWindow = {}): OversightSummary {
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    text = '';
  }
  return summarizeOversightText(text, verified, w);
}

export const OVERSIGHT_LIMITS = 'Evidence, not compliance: this counts what your audit log holds, only for calls the host sent through the hook. A stop halts further calls and undoes nothing. A program running as you can rewrite the whole log consistently; keep a copy of the chain head elsewhere if that matters.';

export function formatOversight(file: string, s: OversightSummary): string {
  const out: string[] = [];
  const period = s.window.since !== undefined || s.window.until !== undefined ? ` from ${s.window.since ?? 'the start'} to ${s.window.until ?? 'now'}` : '';
  out.push(`oversight: ${file}${period}`);
  out.push(`  ${s.first ?? '-'} to ${s.last ?? '-'}, ${s.sessions} session${s.sessions === 1 ? '' : 's'}`);
  out.push(`  ${s.calls} agent calls: ${s.allowed} allowed, ${s.asks} asked, ${s.denies} denied (${s.stopped_refusals} as stopped)`);
  out.push(`  asks: ${s.approved} approved, ${s.no_outcome} with no outcome; approval ${s.approval_rate === null ? '-' : pct(s.approval_rate)}; ${s.asks_per_100 === null ? '-' : Math.round(s.asks_per_100 * 10) / 10} asks per 100 calls`);
  out.push(`  stops: ${s.stops_set} set, ${s.stops_cleared} cleared`);
  out.push(`  not counted as calls: ${s.person_records} record${s.person_records === 1 ? '' : 's'} of your own acts (stop, order, audit sample)${s.unreadable_lines > 0 ? `; ${s.unreadable_lines} unreadable line${s.unreadable_lines === 1 ? '' : 's'}` : ''}`);
  out.push(`  record: ${s.record.ok ? (s.record.unchained > 0 ? 'verified (with unchained version 1 records)' : 'verified') : `NOT verified (${s.record.problems} problem${s.record.problems === 1 ? '' : 's'})`}`);
  if (s.rules.length > 0) {
    out.push('rules asked:');
    for (const r of s.rules.slice(0, 10)) out.push(`  ${r.rule.padEnd(36)} ${String(r.asks).padStart(5)} asked ${String(r.approved).padStart(5)} approved ${r.approval_rate === null ? '' : pct(r.approval_rate)}`);
  }
  if (s.notes.length > 0) {
    out.push('reasons to look:');
    for (const x of s.notes) out.push(`  ${x.kind}: ${x.detail}`);
  }
  out.push(OVERSIGHT_LIMITS);
  return `${out.join('\n')}\n`;
}
