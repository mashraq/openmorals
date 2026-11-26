import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runClaudeCodeHook } from '../src/adapters/claude-code.js';
import { parseAuditLine } from '../src/audit.js';
import { summarizeRunText, verifyAudit, verifyAuditText } from '../src/audit-verify.js';
import { DEFAULT_BYLAWS } from '../src/bylaws.js';
import { decide } from '../src/engine.js';
import * as om from '../src/index.js';
import { formatOversight, MIN_ASKS_FOR_RATE, parseOversightTime, summarizeOversight, summarizeOversightText } from '../src/oversight.js';
import { auditLogPath } from '../src/paths.js';
import { scanLog } from '../src/sample/draw.js';
import { stopCommand, stopRecord } from '../src/tokens/command.js';
import { readStop, STOP_CLEAR_RULE, STOP_SESSION, STOP_SET_RULE } from '../src/tokens/stop.js';
import { EMPTY_STATE } from '../src/types.js';
import { REPO_ROOT, tempDir } from './helpers.js';

const CLI = join(REPO_ROOT, 'dist', 'src', 'cli.js');

type Rec = Record<string, unknown>;
const lines = (home: string): Rec[] =>
  readFileSync(auditLogPath(home), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Rec);

/** One v1 record line (unchained), for summaries built from text. */
const line = (o: Partial<Rec> & { decision: string; rule: string }): string =>
  JSON.stringify({ v: 1, ts: '2026-11-20T10:00:00.000Z', source: 'claude-code', session: 'a', tool: 'Bash', action: 'ls', reason: 'r', cwd: null, budget: null, ...o });

/** A hook call through the Claude Code adapter. */
function hook(home: string, proj: string, event: string, command: string, session = 's1'): void {
  runClaudeCodeHook(JSON.stringify({ session_id: session, cwd: proj, hook_event_name: event, tool_name: 'Bash', tool_input: { command } }), { env: { OPENMORALS_HOME: home } });
}

describe('openmorals stop records its acts in the audit log (0.38.0)', () => {
  it('a stop and a clear each add one chained record that verifies', () => {
    const home = tempDir('ov-stop');
    const env = { OPENMORALS_HOME: home };
    const now = new Date('2026-11-26T09:00:00.000Z');
    assert.equal(stopCommand(['s1'], { env, now, terminal: true }).stderr, '');
    assert.equal(lines(home).length, 1);
    assert.equal(stopCommand(['--clear', 's1'], { env, now }).exitCode, 0);
    assert.equal(stopCommand(['--all'], { env, now }).exitCode, 0);
    assert.equal(stopCommand(['--clear'], { env, now }).exitCode, 0);
    const rs = lines(home);
    assert.equal(rs.length, 4);
    assert.deepEqual(
      rs.map((r) => [r['session'], r['source'], r['decision'], r['rule'], r['action']]),
      [
        [STOP_SESSION, 'openmorals', 'allow', STOP_SET_RULE, 'stop s1'],
        [STOP_SESSION, 'openmorals', 'allow', STOP_CLEAR_RULE, 'stop --clear s1'],
        [STOP_SESSION, 'openmorals', 'allow', STOP_SET_RULE, 'stop --all'],
        [STOP_SESSION, 'openmorals', 'allow', STOP_CLEAR_RULE, 'stop --clear'],
      ],
    );
    assert.deepEqual(rs.map((r) => [r['v'], r['seq']]), [[2, 1], [2, 2], [2, 3], [2, 4]]);
    assert.match(String(rs[0]?.['reason']), /stopped session s1, run from a terminal/);
    assert.match(String(rs[1]?.['reason']), /cleared the stop of s1, run without a terminal/);
    assert.equal('run' in (rs[0] ?? {}), false, 'a stop is no part of a run');
    const v = verifyAudit(auditLogPath(home));
    assert.equal(v.ok, true);
    assert.equal(v.v2, 4);
  });

  it('a stop still takes effect when its record cannot be written, and says so on stderr', () => {
    const home = tempDir('ov-stop-nolog');
    mkdirSync(auditLogPath(home), { recursive: true });
    const r = stopCommand(['s9'], { env: { OPENMORALS_HOME: home } });
    assert.equal(r.exitCode, 0);
    assert.match(r.stderr, /could not be written to the audit log/);
    const f = readStop(home);
    assert.ok(f !== null && !('error' in f) && f.sessions['s9'] !== undefined);
  });

  it('a refused stop writes nothing, and an agent clearing a stop is still asked (0.36.2 unchanged)', () => {
    const home = tempDir('ov-stop-bad');
    assert.equal(stopCommand(['a', 'b'], { env: { OPENMORALS_HOME: home } }).exitCode, 64);
    assert.throws(() => readFileSync(auditLogPath(home)));
    assert.equal(decide({ kind: 'exec', command: 'openmorals stop --clear s1', shell: 'posix', tool: 'Bash' }, DEFAULT_BYLAWS, EMPTY_STATE).rule.startsWith('self-protect'), true);
  });

  it('stop records are left out of audit sample units and of audit --run', () => {
    const home = tempDir('ov-stop-units');
    const proj = tempDir('ov-stop-units-proj');
    hook(home, proj, 'PreToolUse', 'ls');
    stopCommand(['s1'], { env: { OPENMORALS_HOME: home } });
    const text = readFileSync(auditLogPath(home), 'utf8');
    assert.deepEqual([...scanLog(text, 'session').units.keys()], ['s1']);
    const run = summarizeRunText(text, 'r1', verifyAuditText(text, { run: 'r1' }));
    assert.equal(run.records, 0);
  });

  it('a run stop and its clear are recorded too, and the summary tracks the run', () => {
    const home = tempDir('ov-stop-run');
    const env = { OPENMORALS_HOME: home };
    assert.equal(stopCommand(['--run', 'r1'], { env }).stderr, '');
    let file = auditLogPath(home);
    assert.deepEqual(lines(home).map((r) => [r['rule'], r['action']]), [[STOP_SET_RULE, 'stop --run r1']]);
    let s = summarizeOversight(file, verifyAudit(file));
    assert.match(s.notes.find((n) => n.kind === 'still-stopped')?.detail ?? '', /run r1/);
    assert.equal(stopCommand(['--clear', '--run', 'r1'], { env }).exitCode, 0);
    assert.equal(lines(home)[1]?.['action'], 'stop --clear --run r1');
    file = auditLogPath(home);
    s = summarizeOversight(file, verifyAudit(file));
    assert.deepEqual([s.stops_set, s.stops_cleared], [1, 1]);
    assert.equal(s.notes.some((n) => n.kind === 'still-stopped'), false);
    assert.equal(verifyAudit(file).ok, true);
  });

  it('the stop record helpers are exported', () => {
    assert.equal(om.STOP_SESSION, 'stop');
    assert.equal(typeof om.stopRecord, 'function');
    assert.equal(typeof om.summarizeOversightText, 'function');
    assert.equal(stopRecord('set', { session: null }, false, new Date(0)).action, 'stop --all');
  });
});

describe('openmorals audit oversight (0.38.0)', () => {
  it('counts calls, asks, approved asks, stopped refusals and stops from a real log, and leaves stops out of the calls', () => {
    const home = tempDir('ov-sum');
    const proj = tempDir('ov-sum-proj');
    for (let i = 0; i < 3; i++) hook(home, proj, 'PreToolUse', 'ls');
    hook(home, proj, 'PreToolUse', 'git reset --hard');
    hook(home, proj, 'PostToolUse', 'git reset --hard');
    hook(home, proj, 'PreToolUse', 'git reset --hard');
    stopCommand(['s1'], { env: { OPENMORALS_HOME: home } });
    hook(home, proj, 'PreToolUse', 'ls');
    const file = auditLogPath(home);
    const s = summarizeOversight(file, verifyAudit(file));
    assert.equal(s.calls, 6);
    assert.equal(s.allowed, 3);
    assert.equal(s.asks, 2);
    assert.equal(s.approved, 1);
    assert.equal(s.no_outcome, 1);
    assert.equal(s.approval_rate, 0.5);
    assert.equal(s.denies, 1);
    assert.equal(s.stopped_refusals, 1);
    assert.equal(s.stops_set, 1);
    assert.equal(s.stops_cleared, 0);
    assert.equal(s.person_records, 1);
    assert.equal(s.record.ok, true);
    assert.deepEqual(s.rules, [{ rule: 'destructive.git-reset-hard', asks: 2, approved: 1, approval_rate: 0.5 }]);
    const kinds = s.notes.map((n) => n.kind);
    assert.ok(kinds.includes('asks-without-outcome'));
    assert.ok(kinds.includes('still-stopped'));
    assert.equal(kinds.includes('stops-not-recorded'), false);
    const text = formatOversight(file, s);
    assert.match(text, /6 agent calls: 3 allowed, 2 asked, 1 denied \(1 as stopped\)/);
    assert.match(text, /Evidence, not compliance/);
    assert.doesNotMatch(text, /compliant|certified|tamper-proof|kill switch/i);
  });

  it('names a rule that is almost always approved, and asks above 1 per 100 calls', () => {
    const recs: string[] = [];
    for (let i = 0; i < 200; i++) recs.push(line({ decision: 'allow', rule: 'none' }));
    for (let i = 0; i < MIN_ASKS_FOR_RATE; i++) {
      recs.push(line({ decision: 'ask', rule: 'net.fetch' }));
      recs.push(line({ decision: 'allow', rule: 'ask.approved', reason: 'the call ran after openmorals asked [net.fetch], so the ask was approved' }));
    }
    const text = `${recs.join('\n')}\n`;
    const s = summarizeOversightText(text, verifyAuditText(text));
    assert.equal(s.calls, 220);
    assert.equal(s.approved, 20);
    assert.equal(s.no_outcome, 0);
    const kinds = s.notes.map((n) => n.kind);
    assert.ok(kinds.includes('mostly-approved-rule'));
    assert.ok(kinds.includes('over-friction-mark'));
    const note = s.notes.find((n) => n.kind === 'mostly-approved-rule')?.detail ?? '';
    assert.match(note, /candidate for an allow/);
    assert.match(note, /nothing changes on its own/);
    assert.doesNotMatch(note, /make it a deny|worth making .* deny/, 'a high approval rate never suggests a refusal (ADR 0019)');
    assert.ok(kinds.includes('unchained-records'));
  });

  it('does not judge a rule on fewer asks, nor the ask rate on fewer calls', () => {
    const text = [line({ decision: 'ask', rule: 'net.fetch' }), line({ decision: 'allow', rule: 'ask.approved', reason: 'openmorals asked [net.fetch]' })].join('\n') + '\n';
    const kinds = summarizeOversightText(text, verifyAuditText(text)).notes.map((n) => n.kind);
    assert.equal(kinds.includes('mostly-approved-rule'), false);
    assert.equal(kinds.includes('over-friction-mark'), false);
  });

  it('notes refusals as stopped with no stop recorded, and a record that does not verify', () => {
    const home = tempDir('ov-unrec');
    const proj = tempDir('ov-unrec-proj');
    hook(home, proj, 'PreToolUse', 'ls');
    hook(home, proj, 'PreToolUse', 'ls');
    const file = auditLogPath(home);
    const text = readFileSync(file, 'utf8')
      .split('\n')
      .map((l, i) => (i === 1 ? l.replace('"decision":"allow"', '"decision":"deny"').replace('"rule":"none"', '"rule":"budget.stopped"') : l))
      .join('\n');
    writeFileSync(file, text);
    const s = summarizeOversight(file, verifyAudit(file));
    assert.equal(s.record.ok, false);
    const kinds = s.notes.map((n) => n.kind);
    assert.ok(kinds.includes('record-not-verified'));
    assert.ok(kinds.includes('stops-not-recorded'));
  });

  it('keeps to the period asked for', () => {
    const text = [line({ decision: 'ask', rule: 'x', ts: '2026-10-01T00:00:00.000Z' }), line({ decision: 'deny', rule: 'y', ts: '2026-11-02T00:00:00.000Z' }), line({ decision: 'allow', rule: 'none', ts: '2026-12-01T00:00:00.000Z' })].join('\n') + '\n';
    const s = summarizeOversightText(text, verifyAuditText(text), { since: '2026-11-01T00:00:00.000Z', until: '2026-12-01T00:00:00.000Z' });
    assert.deepEqual([s.calls, s.asks, s.denies], [1, 0, 1]);
    const none = summarizeOversightText(text, verifyAuditText(text), { since: '2030-01-01T00:00:00.000Z' });
    assert.deepEqual(none.notes.map((n) => n.kind), ['unchained-records', 'no-records']);
  });

  it('reads a date or an ISO time, and nothing else', () => {
    assert.equal(parseOversightTime('2026-11-01'), '2026-11-01T00:00:00.000Z');
    assert.equal(parseOversightTime('2026-11-01T12:30:00Z'), '2026-11-01T12:30:00.000Z');
    assert.equal(parseOversightTime('yesterday'), null);
    assert.equal(parseOversightTime('2026-13-45'), null);
  });

  it('runs from the command line, and refuses options that do not apply', () => {
    const home = tempDir('ov-cli');
    const env = { ...process.env, OPENMORALS_HOME: home, OPENMORALS_RUN: '' };
    const cli = (args: string[]): ReturnType<typeof spawnSync> => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
    assert.equal(cli(['stop', 's1']).status, 0);
    const r = cli(['audit', 'oversight', '--json']);
    assert.equal(r.status, 0);
    const j = JSON.parse(String(r.stdout)) as Rec;
    assert.equal(j['stops_set'], 1);
    assert.equal(j['calls'], 0);
    assert.equal(cli(['audit', 'oversight', '--since', '2026-11-01', '--until', '2030-01-01']).status, 0);
    assert.equal(cli(['audit', 'oversight', '--since', 'soon']).status, 64);
    assert.equal(cli(['audit', 'oversight', '--since', '2026-11-02', '--until', '2026-11-01']).status, 64);
    assert.equal(cli(['audit', 'oversight', '--run', 'x']).status, 64);
    assert.equal(cli(['audit', '--since', '2026-11-01']).status, 64);
    assert.equal(cli(['audit', 'verify', '--until', '2026-11-01']).status, 64);
    assert.match(String(cli(['help', 'audit']).stdout) + String(cli(['help', 'audit']).stderr), /audit oversight/);
    const first = parseAuditLine(readFileSync(auditLogPath(home), 'utf8').split('\n')[0] ?? '');
    assert.ok(!('error' in first) && first.rule === STOP_SET_RULE);
    assert.match(first.reason, /without a terminal/);
  });
});
