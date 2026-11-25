// `openmorals audit sample`: the command half. Reads the audit log, the session files beside it and the user-level
// settings file; a draw, a verdict or a declared change is appended to the log as a chained record. Never calls a model.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AuditFields } from '../audit.js';
import type { VerifyFinding, VerifyProblemKind, VerifyResult } from '../audit-verify.js';
import { readSessionHeads, verifyAuditText } from '../audit-verify.js';
import { auditLogPath, configDir } from '../paths.js';
import { appendAuditForSession } from '../state.js';
import type { DrawPlan, SampleBy, SampleProblem, SampleSettings, SampleVerdict, Tally, TallyPick, UnitSummary } from './draw.js';
import { DEFAULT_SAMPLE_SETTINGS, SAMPLE_LIMITS, SAMPLE_RULES, SAMPLE_SESSION, drawData, findPick, parseSampleSettings, planDraw, scanLog, tallySamples } from './draw.js';

export const SAMPLE_SETTINGS_FILE = 'audit-sample.yaml';
/** The log, the session files or the settings file cannot be read, or the draw could not be recorded: nothing was drawn. */
export const SAMPLE_UNREADABLE_EXIT = 2;
/** Nothing to draw from: no log, or no finished unit that an earlier draw has not considered. Nothing was written. */
export const SAMPLE_EMPTY_EXIT = 3;
export const SAMPLE_USAGE_EXIT = 64;

export const SAMPLE_USAGE = `  openmorals audit sample [--by run|session] [--json]
      Draw finished runs (records written with OPENMORALS_RUN=ID; --by session draws
      sessions) for a close read: each one not drawn from before is picked with a
      chance of 1 in N, using a seed from the operating system's random source at the
      moment you run it. Prints what the record holds about each pick (times, counts
      of denies and asks, commands and files named) and records the draw (seed,
      population, N, picks) in the audit log. A unit whose record does not verify is
      always picked. N and the rest come from ${SAMPLE_SETTINGS_FILE} in the config
      directory (rate: 10, read_all_next: 5, by: run, settle_minutes: 30 when absent);
      after an escape or a declared change, the draws that consider the next
      read_all_next units read everything. Exit code: 0 drawn, 1 drawn and the record
      does not verify, 2 something could not be read or recorded (nothing drawn),
      3 nothing to draw from, 64 usage error.
  openmorals audit sample --record <run:ID|session:ID> clean|escape "<one line why>"
      Record your verdict on a pick: clean, or escape (something the checks missed).
      Only a drawn unit takes a verdict. A later verdict on the same pick replaces it.
  openmorals audit sample --change "<what changed: model, pack or host>"
      Declare a change: the draws that consider the next read_all_next units read
      everything, then sampling goes back to 1 in N.
  openmorals audit sample --tally [--json] [--file FILE]
      Count draws, picks, verdicts and escapes, list picks with no verdict yet, and
      recompute every draw from its seed. Writes nothing. Exit code: 0, 1 when the
      record does not verify or a draw does not recompute, 2 unreadable.
      A sample finds what a reader notices, not everything; it covers only sessions
      on hosts that call openmorals; the record names actions, not the quality of
      the work. A clean read lowers no other check.`;

export interface SampleCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface SampleCommandDeps {
  env: NodeJS.ProcessEnv;
  now: () => Date;
  /** The random source of a draw. The default is the operating system's (`crypto.randomBytes`). */
  random: (bytes: number) => Buffer;
}

type Mode = { kind: 'draw' } | { kind: 'tally' } | { kind: 'record'; name: string; verdict: SampleVerdict; note: string } | { kind: 'change'; what: string };

interface Parsed {
  mode: Mode;
  json: boolean;
  by: SampleBy | undefined;
  file: string | undefined;
}

const VALUE_OPTS = new Set(['--by', '--record', '--change', '--file']);

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function parse(argv: readonly string[]): { ok: true; p: Parsed } | { ok: false; error: string } {
  const pos: string[] = [];
  const values = new Map<string, string>();
  let json = false;
  let tally = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--') {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a === '--tally') {
      tally = true;
      continue;
    }
    if (a.startsWith('-') && a !== '-') {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      if (!VALUE_OPTS.has(name)) return { ok: false, error: `unknown option ${name}` };
      const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (value === undefined || value.trim() === '') return { ok: false, error: `${name} needs a value` };
      if (values.has(name)) return { ok: false, error: `${name} is given twice` };
      values.set(name, value);
      continue;
    }
    pos.push(a);
  }
  const acts = [tally ? '--tally' : null, values.has('--record') ? '--record' : null, values.has('--change') ? '--change' : null].filter((x) => x !== null);
  if (acts.length > 1) return { ok: false, error: `${acts.join(' and ')} cannot be combined` };
  const byRaw = values.get('--by');
  if (byRaw !== undefined && byRaw !== 'run' && byRaw !== 'session') return { ok: false, error: '--by must be run or session' };
  const by = byRaw as SampleBy | undefined;
  const file = values.get('--file');
  if (file !== undefined && !tally) return { ok: false, error: '--file only applies to --tally: a draw, a verdict and a change always use the log in the config directory' };
  if (by !== undefined && acts.length > 0) return { ok: false, error: '--by only applies to a draw' };
  const record = values.get('--record');
  if (record !== undefined) {
    if (json) return { ok: false, error: '--json does not apply to --record' };
    const [verdict, ...rest] = pos;
    if (verdict !== 'clean' && verdict !== 'escape') return { ok: false, error: '--record needs a verdict, clean or escape, then one line saying why' };
    const note = oneLine(rest.join(' '));
    if (note === '') return { ok: false, error: '--record needs one line saying why, in quotes' };
    return { ok: true, p: { mode: { kind: 'record', name: record, verdict, note }, json, by, file } };
  }
  if (pos.length > 0) return { ok: false, error: `unexpected argument ${JSON.stringify(pos[0])}` };
  const change = values.get('--change');
  if (change !== undefined) {
    if (json) return { ok: false, error: '--json does not apply to --change' };
    return { ok: true, p: { mode: { kind: 'change', what: oneLine(change) }, json, by, file } };
  }
  return { ok: true, p: { mode: tally ? { kind: 'tally' } : { kind: 'draw' }, json, by, file } };
}

function fail(exitCode: number, message: string): SampleCommandResult {
  return { exitCode, stdout: '', stderr: message.endsWith('\n') ? message : `${message}\n` };
}

function errCode(err: unknown): string | null {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : null;
}

function readSettings(dir: string): { ok: true; settings: SampleSettings; source: string } | { ok: false; error: string } {
  const file = join(dir, SAMPLE_SETTINGS_FILE);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err: unknown) {
    if (errCode(err) === 'ENOENT') return { ok: true, settings: { ...DEFAULT_SAMPLE_SETTINGS }, source: '<defaults>' };
    return { ok: false, error: `cannot read ${file}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const p = parseSampleSettings(text);
  return p.ok ? { ok: true, settings: p.settings, source: file } : { ok: false, error: `${file}: ${p.error}` };
}

type LogRead = { status: 'missing' } | { status: 'unreadable'; error: string } | { status: 'ok'; text: string };

function readLog(file: string): LogRead {
  try {
    return { status: 'ok', text: readFileSync(file, 'utf8') };
  } catch (err: unknown) {
    if (errCode(err) === 'ENOENT') return { status: 'missing' };
    return { status: 'unreadable', error: `cannot read ${file}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function verifyText(file: string, text: string): VerifyResult {
  const { heads, unreadable } = readSessionHeads(join(dirname(file), 'sessions'));
  return verifyAuditText(text, { heads, unreadableHeads: unreadable }, text.trim() === '' ? 'empty' : 'ok');
}

function pct(x: number | null): string {
  return x === null ? 'n/a' : `${Math.round(x * 100)}%`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function findingLine(f: VerifyFinding<VerifyProblemKind>): string {
  const where = [f.line !== null ? `line ${f.line}` : null, f.session !== null ? `session ${f.session}` : null].filter((x) => x !== null).join(', ');
  return `  ${f.kind}${where !== '' ? ` (${where})` : ''}: ${f.detail}`;
}

function limitsText(): string {
  return SAMPLE_LIMITS.join('\n');
}

function unitLines(u: UnitSummary, plan: DrawPlan): string[] {
  const out: string[] = [];
  out.push(`  ${u.by}:${u.id}  ${plural(u.records, 'record')} in ${plural(u.sessions.length, 'session')}, ${u.first} to ${u.last}; ${u.denied} denied, ${u.asked} asked, ${u.approved_asks} approved asks, ${u.taint_marks} taint marks, ${u.loosening_notes} loosening notes`);
  if (u.cwds.length > 0) out.push(`    in: ${u.cwds.join(', ')}`);
  for (const d of u.denies.slice(0, 5)) out.push(`    denied: line ${d.line}  ${d.rule}  ${d.tool}  ${d.action.replace(/\s+/g, ' ').slice(0, 100)}`);
  if (u.denies.length > 5) out.push(`    denied: ${u.denied - 5} more`);
  for (const a of u.asks.slice(0, 5)) out.push(`    asked: line ${a.line}  ${a.rule}  ${a.tool}  ${a.action.replace(/\s+/g, ' ').slice(0, 100)}`);
  if (u.asks.length > 5) out.push(`    asked: more (see --json)`);
  if (u.actions.length > 0) out.push(`    named: ${u.actions.slice(0, 8).map((a) => a.slice(0, 80)).join(' | ')}${u.actions.length > 8 ? ' | …' : ''}`);
  const ps = plan.unitProblems.get(u.id);
  if (ps !== undefined) {
    out.push(`    ${plan.forced.includes(u.id) ? 'picked because its record does not verify' : 'its record does not verify'}:`);
    for (const p of ps) out.push(`    ${findingLine(p)}`);
  }
  if (u.by === 'run') out.push(`    more: openmorals audit --run ${u.id}`);
  return out;
}

function drawText(file: string, plan: DrawPlan, verified: VerifyResult, settings: SampleSettings): string {
  const out: string[] = [];
  const noun = plan.by === 'run' ? 'finished runs' : 'finished sessions';
  out.push(`audit sample: picked ${plan.picks.length} of ${plan.population.length} ${noun} at 1 in ${plan.rate} (seed ${plan.seed.slice(0, 12)}…, recorded in ${file}); record ${verified.ok ? 'verified' : `NOT verified (${plural(verified.problems.length, 'problem')})`}`);
  if (plan.read_all && plan.since !== null) {
    out.push(`reading everything: ${plan.since.kind === 'escape' ? `an escape was recorded for ${plan.since.detail}` : `a change was declared (${plan.since.detail})`} at ${plan.since.ts}; ${plural(plan.remaining_before, 'more unit')} were to be read in full, then sampling goes back to 1 in ${settings.rate}`);
  }
  if (plan.forced.length > 0) out.push(`${plural(plan.forced.length, 'unit')} picked because the record does not verify, whatever the draw said`);
  if (plan.summaries.length > 0) out.push('picks:', ...plan.summaries.flatMap((u) => unitLines(u, plan)));
  else out.push(`no pick this time: each of the ${plural(plan.population.length, 'unit')} had a 1 in ${plan.rate} chance and none came up; they are recorded as considered and will not be drawn again`);
  if (plan.active.length > 0) out.push(`left for a later draw (a record in the last ${settings.settle_minutes} minutes): ${plan.active.map((u) => `${plan.by}:${u}`).join(', ')}`);
  if (plan.earlier > 0) out.push(`already considered by an earlier draw: ${plural(plan.earlier, plan.by)}`);
  if (plan.by === 'run' && plan.outside.records > 0) out.push(`in no run: ${plural(plan.outside.records, 'record')} in ${plural(plan.outside.sessions, 'session')} (draw sessions with --by session)`);
  const fileWide = verified.problems.filter((p) => p.session === null || !plan.population.some((u) => plan.unitProblems.get(u)?.includes(p) === true));
  if (fileWide.length > 0) out.push('record problems (a unit they belong to may be missing from this draw):', ...fileWide.map(findingLine));
  if (plan.sampleProblems.length > 0) out.push('sample record problems:', ...plan.sampleProblems.map((p) => `  line ${p.line}: ${p.detail}`));
  if (plan.picks.length > 0) out.push(`Record each read: openmorals audit sample --record ${plan.by}:<id> clean|escape "<one line why>"`);
  out.push(limitsText());
  return `${out.join('\n')}\n`;
}

function drawJson(file: string, plan: DrawPlan, verified: VerifyResult, drawnAt: string): string {
  return JSON.stringify({
    file,
    drawn_at: drawnAt,
    by: plan.by,
    rate: plan.rate,
    read_all: plan.read_all,
    read_all_remaining: plan.remaining_before,
    since: plan.since,
    seed: plan.seed,
    method: plan.method,
    population: plan.population,
    drawn: plan.drawn,
    forced: plan.forced,
    picks: plan.summaries.map((u) => ({ ...u, forced: plan.forced.includes(u.id), problems: plan.unitProblems.get(u.id) ?? [] })),
    active: plan.active,
    earlier: plan.earlier,
    outside_runs: plan.by === 'run' ? plan.outside : null,
    record: { ok: verified.ok, problems: verified.problems },
    sample_problems: plan.sampleProblems,
    limits: SAMPLE_LIMITS,
  });
}

function pickLine(p: TallyPick): string {
  const v = p.verdict === null ? 'no verdict yet' : `${p.verdict} (${p.verdict_at ?? ''}): ${p.note ?? ''}`;
  return `  ${p.by}:${p.unit}  drawn ${p.drawn_at}${p.forced ? ' (record did not verify)' : ''}  ${v}`;
}

function tallyText(file: string, t: Tally, verified: VerifyResult | null, settings: SampleSettings, missing: boolean): string {
  const out: string[] = [];
  out.push(`audit sample tally: ${file}${missing ? ' (no audit log: nothing has been recorded there yet, or it was removed)' : ''}`);
  out.push(`draws: ${t.draws} (${t.by.run} by run, ${t.by.session} by session); units considered: ${t.considered}; picked: ${t.picked}${t.forced > 0 ? ` (${t.forced} because the record did not verify)` : ''}`);
  out.push(`verdicts: ${t.verdicts.total} of ${plural(t.picked, 'pick')} (${pct(t.verdict_share)}): ${t.verdicts.clean} clean, ${t.verdicts.escape} escape`);
  out.push(`escapes: ${t.verdicts.escape} of ${plural(t.verdicts.total, 'verdict')} (${pct(t.escape_rate)})`);
  if (t.open.length > 0) out.push(`picks with no verdict yet: ${t.open.length}`, ...t.open.map(pickLine));
  const judged = t.picks.filter((p) => p.verdict !== null);
  if (judged.length > 0) out.push('verdicts recorded:', ...judged.map(pickLine));
  if (t.next.read_all && t.next.since !== null) out.push(`next draw: reads everything (${plural(t.next.remaining, 'more unit')} after ${t.next.since.kind === 'escape' ? `the escape recorded for ${t.next.since.detail}` : `the change declared: ${t.next.since.detail}`} at ${t.next.since.ts}), then 1 in ${settings.rate}`);
  else out.push(`next draw: 1 in ${t.next.rate} by ${settings.by}`);
  if (verified !== null) {
    out.push(`record: ${verified.ok ? 'verified' : `NOT verified (${plural(verified.problems.length, 'problem')})`}`);
    if (!verified.ok) out.push(...verified.problems.map(findingLine));
  }
  if (t.problems.length > 0) out.push('sample record problems:', ...t.problems.map((p) => `  line ${p.line}: ${p.detail}`));
  out.push(limitsText());
  return `${out.join('\n')}\n`;
}

function sampleRecord(rule: string, action: string, reason: string, sample: AuditFields['sample'], now: Date): AuditFields {
  return { ts: now.toISOString(), source: 'openmorals', session: SAMPLE_SESSION, tool: 'audit sample', action, decision: 'allow', rule, reason, cwd: null, budget: null, sample };
}

function write(dir: string, rec: AuditFields, now: Date): string | null {
  try {
    appendAuditForSession(SAMPLE_SESSION, [rec], {}, dir, now);
    return null;
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}

function problemLines(ps: readonly SampleProblem[]): string {
  return ps.map((p) => `  line ${p.line}: ${p.detail}`).join('\n');
}

/** Runs `openmorals audit sample` with the words after `sample`. Never throws for bad input; a failed write is exit 2. */
export function sampleCommand(argv: readonly string[], deps: Partial<SampleCommandDeps> = {}): SampleCommandResult {
  const env = deps.env ?? process.env;
  const now = (deps.now ?? (() => new Date()))();
  const random = deps.random ?? randomBytes;
  const parsed = parse(argv);
  if (!parsed.ok) return fail(SAMPLE_USAGE_EXIT, `openmorals audit sample: ${parsed.error}; nothing was done\nUsage:\n${SAMPLE_USAGE}`);
  const p = parsed.p;
  const dir = configDir(env);
  const settingsRead = readSettings(dir);
  if (!settingsRead.ok) return fail(SAMPLE_UNREADABLE_EXIT, `openmorals audit sample: ${settingsRead.error}; nothing was done`);
  const settings = settingsRead.settings;
  const file = p.file ?? auditLogPath(dir);
  const log = readLog(file);
  if (log.status === 'unreadable') return fail(SAMPLE_UNREADABLE_EXIT, `openmorals audit sample: ${log.error}; nothing was done`);
  const text = log.status === 'ok' ? log.text : '';

  if (p.mode.kind === 'tally') {
    const t = tallySamples(text, settings);
    const verified = log.status === 'ok' ? verifyText(file, text) : null;
    const ok = (verified === null || verified.ok) && t.problems.length === 0;
    const stdout = p.json
      ? `${JSON.stringify({ file, log: log.status, ...t, settings, record: verified === null ? null : { ok: verified.ok, problems: verified.problems }, limits: SAMPLE_LIMITS })}\n`
      : tallyText(file, t, verified, settings, log.status === 'missing');
    return { exitCode: ok ? 0 : 1, stdout, stderr: '' };
  }

  if (p.mode.kind === 'change') {
    const err = write(dir, sampleRecord(SAMPLE_RULES.change, `audit sample: change declared: ${p.mode.what}`, p.mode.what, {}, now), now);
    if (err !== null) return fail(SAMPLE_UNREADABLE_EXIT, `openmorals audit sample: could not record the change: ${err}`);
    const k = settings.read_all_next;
    return { exitCode: 0, stdout: `recorded: change declared (${p.mode.what}). ${k > 0 ? `The draws that consider the next ${plural(k, 'unit')} read everything, then sampling goes back to 1 in ${settings.rate}.` : `read_all_next is 0 in ${settingsRead.source}, so sampling stays at 1 in ${settings.rate}.`}\n`, stderr: '' };
  }

  if (p.mode.kind === 'record') {
    const scan = scanLog(text, settings.by);
    const found = findPick(scan.events, p.mode.name);
    if (!found.ok) return fail(found.usage ? SAMPLE_USAGE_EXIT : 1, `openmorals audit sample: ${found.error}; nothing was recorded`);
    const earlier = scan.events.filter((e) => e.kind === 'verdict' && e.by === found.by && e.unit === found.unit);
    const err = write(dir, sampleRecord(SAMPLE_RULES.verdict, `audit sample: verdict ${p.mode.verdict} for ${found.by}:${found.unit}`, p.mode.note, { by: found.by, unit: found.unit, verdict: p.mode.verdict }, now), now);
    if (err !== null) return fail(SAMPLE_UNREADABLE_EXIT, `openmorals audit sample: could not record the verdict: ${err}`);
    const lines = [`recorded: ${p.mode.verdict} for ${found.by}:${found.unit}${earlier.length > 0 ? ' (replaces the earlier verdict in the tally; both stay in the log)' : ''}`];
    if (p.mode.verdict === 'escape') lines.push(settings.read_all_next > 0 ? `The draws that consider the next ${plural(settings.read_all_next, 'unit')} read everything, then sampling goes back to 1 in ${settings.rate}. Turn the escape into a test or a rule.` : `read_all_next is 0 in ${settingsRead.source}, so sampling stays at 1 in ${settings.rate}.`);
    return { exitCode: 0, stdout: `${lines.join('\n')}\n`, stderr: '' };
  }

  const by = p.by ?? settings.by;
  if (log.status === 'missing') return fail(SAMPLE_EMPTY_EXIT, `audit sample: no audit log at ${file}: nothing to draw from; nothing was written`);
  const verified = verifyText(file, text);
  const seed = random(32).toString('hex');
  if (!/^[0-9a-f]{64}$/.test(seed)) return fail(SAMPLE_UNREADABLE_EXIT, 'openmorals audit sample: the random source gave fewer than 32 bytes; nothing was drawn');
  const plan = planDraw(text, verified, settings, by, now, seed);
  if (plan.population.length === 0) {
    const why = [
      plan.active.length > 0 ? `${plural(plan.active.length, by)} with a record in the last ${settings.settle_minutes} minutes, left for a later draw: ${plan.active.map((u) => `${by}:${u}`).join(', ')}` : null,
      plan.earlier > 0 ? `${plural(plan.earlier, by)} already considered by an earlier draw` : null,
      by === 'run' && plan.outside.records > 0 ? `records with no run id: ${plan.outside.records} in ${plural(plan.outside.sessions, 'session')} (draw sessions with --by session)` : null,
      verified.ok ? null : `the record does not verify (${plural(verified.problems.length, 'problem')}; run openmorals audit verify)`,
    ].filter((x) => x !== null);
    const msg = `audit sample: nothing to draw from: no finished ${by} in ${file} that an earlier draw has not considered${why.length > 0 ? `\n  ${why.join('\n  ')}` : ''}\nnothing was written`;
    return fail(SAMPLE_EMPTY_EXIT, msg);
  }
  const action = `audit sample: draw by ${by}: ${plan.picks.length} picked of ${plan.population.length} at 1 in ${plan.rate}${plan.forced.length > 0 ? ` (${plan.forced.length} because the record does not verify)` : ''}`;
  const err = write(dir, sampleRecord(SAMPLE_RULES.draw, action, plan.picks.length > 0 ? `picked ${plan.picks.map((u) => `${by}:${u}`).join(', ')}` : 'no pick', drawData(plan), now), now);
  if (err !== null) return fail(SAMPLE_UNREADABLE_EXIT, `openmorals audit sample: could not record the draw, so it does not count and nothing is shown: ${err}`);
  const ok = verified.ok && plan.sampleProblems.length === 0;
  const stdout = p.json ? `${drawJson(file, plan, verified, now.toISOString())}\n` : drawText(file, plan, verified, settings);
  return { exitCode: ok ? 0 : 1, stdout, stderr: plan.sampleProblems.length > 0 && p.json ? `sample record problems:\n${problemLines(plan.sampleProblems)}\n` : '' };
}
