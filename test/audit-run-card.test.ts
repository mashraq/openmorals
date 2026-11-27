import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { runClaudeCodeHook } from '../src/adapters/claude-code.js';
import { runCodexHook } from '../src/adapters/codex/index.js';
import { makeAuditRecord } from '../src/audit.js';
import type { RunSummary } from '../src/audit-verify.js';
import { CHECK_PATTERNS, ORDER_SESSION, formatRunSummary, isCheckCommand, isGitCommit, summarizeRun } from '../src/audit-verify.js';
import { appendAuditForSession } from '../src/state.js';
import { runDir, startRun } from '../src/tokens/run.js';
import { stopRun } from '../src/tokens/stop.js';
import { REPO_ROOT, tempDir } from './helpers.js';

// Every fixture lives in one fresh temp folder, removed at the end. Ids and paths are obviously fake.
const CLI = join(REPO_ROOT, 'dist', 'src', 'cli.js');
const root = tempDir('run-card');
after(() => {
  rmSync(root, { recursive: true, force: true });
});
let n = 0;
function fresh(): { home: string; proj: string; log: string } {
  n++;
  const home = join(root, `c${n}`, 'home');
  const proj = join(root, `c${n}`, 'proj');
  mkdirSync(home, { recursive: true });
  mkdirSync(proj, { recursive: true });
  return { home, proj, log: join(home, 'audit.jsonl') };
}
const RUN = 'run-fake-card';
const env = (home: string): NodeJS.ProcessEnv => ({ OPENMORALS_HOME: home, OPENMORALS_RUN: RUN });
function cc(home: string, proj: string, tool: string, input: Record<string, unknown>, id: string, session = 'sess-card'): void {
  runClaudeCodeHook(JSON.stringify({ session_id: session, cwd: proj, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: id }), { env: env(home), cwd: proj });
}
const cli = (home: string, args: string[]): { status: number | null; stdout: string; stderr: string } => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, OPENMORALS_HOME: home, OPENMORALS_RUN: '' } });
const card = (home: string): RunSummary => {
  const r = cli(home, ['audit', '--run', RUN, '--json']);
  return JSON.parse(r.stdout) as RunSummary;
};

describe('the run card: what the run used (audit --run, 0.40.0)', () => {
  it('(1) a run with a budget file: tool calls and tokens beside the record counts', () => {
    const { home, proj } = fresh();
    assert.equal(startRun(home, RUN, { tool_calls: { soft: 0, hard: 500, step: 500 } }).ok, true);
    cc(home, proj, 'Bash', { command: 'ls' }, 'a1');
    cc(home, proj, 'Bash', { command: 'git status' }, 'a2');
    writeFileSync(join(runDir(home, RUN), 'nodes', 'sess-fake-other.json'), `${JSON.stringify({ session: 'sess-fake-other', tool_calls: 118, tokens: 1_800_000, spawns: 3, updated: '2026-11-26T00:00:00.000Z' })}\n`);
    const r = cli(home, ['audit', '--run', RUN]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^run run-fake-card: 2 records in 1 session;/);
    assert.match(r.stdout, /counts: 120 tool calls, 1,800,000 tokens, 3 sub-agent runs in 2 sessions; limits set; not stopped/);
    const s = card(home);
    assert.deepEqual(s.counts, { status: 'counted', tool_calls: 120, tokens: 1_800_000, spawns: 3, sessions: 2, limits: true, limits_error: null, unreadable_sessions: [], stopped: false });
  });
  it('a stopped run says STOPPED; counts with no limits file say counted only', () => {
    const { home, proj } = fresh();
    cc(home, proj, 'Bash', { command: 'ls' }, 'b1');
    stopRun(home, RUN);
    const s = card(home);
    assert.equal(s.counts?.status, 'counted');
    assert.equal(s.counts?.stopped, true);
    assert.match(cli(home, ['audit', '--run', RUN]).stdout, /no limits set \(counted only\); STOPPED/);
  });
  it('(2) a run that wrote src/a.ts with no check of any kind: "no check recorded", exit unchanged', () => {
    const { home, proj } = fresh();
    cc(home, proj, 'Write', { file_path: join(proj, 'src', 'a.ts'), content: 'export const a = 1;\n' }, 'c1');
    cc(home, proj, 'Bash', { command: 'git add src/a.ts && git commit -m "add a"' }, 'c2');
    const r = cli(home, ['audit', '--run', RUN]);
    assert.equal(r.status, 0, 'the line never changes the exit code');
    assert.match(r.stdout, /^no check recorded: the run wrote files/m);
    assert.match(r.stdout, /git commits: 1;/);
    const s = card(home);
    assert.equal(s.no_check, true);
    assert.equal(s.writes, 1);
    assert.equal(s.commits.length, 1);
    assert.deepEqual(s.check_patterns, CHECK_PATTERNS.map((p) => p.name));
  });
  it('(3) a run with OPENMORALS_RUN and no run folder (a host that only tags): "no counts for this run", never zero', () => {
    const { home, proj } = fresh();
    runCodexHook(JSON.stringify({ session_id: 'cx-card', cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'x1', tool_input: { command: 'ls' } }), { env: env(home), cwd: proj });
    const r = cli(home, ['audit', '--run', RUN]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /counts: no counts for this run/);
    assert.doesNotMatch(r.stdout, /0 tool calls|0 tokens/);
    assert.deepEqual(card(home).counts, { status: 'none', stopped: false });
  });
  it('(4) an unreadable run folder is said as unreadable, not as 0 tokens', () => {
    const { home, proj } = fresh();
    runCodexHook(JSON.stringify({ session_id: 'cx-card', cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'x1', tool_input: { command: 'ls' } }), { env: env(home), cwd: proj });
    mkdirSync(join(home, 'runs'), { recursive: true });
    writeFileSync(runDir(home, RUN), 'not a folder\n');
    const r = cli(home, ['audit', '--run', RUN]);
    assert.match(r.stdout, /counts: unreadable: the run folder could not be read/);
    assert.doesNotMatch(r.stdout, /0 tokens/);
    assert.equal(card(home).counts?.status, 'unreadable');
  });
  it('(5) benign: writes and an order check pass: card printed, no flag, exit as before', () => {
    const { home, proj } = fresh();
    cc(home, proj, 'Edit', { file_path: join(proj, 'src', 'a.ts'), old_string: 'a = 1', new_string: 'a = 2' }, 'd1');
    appendAuditForSession(ORDER_SESSION, [makeAuditRecord({ source: 'openmorals', session: ORDER_SESSION, tool: 'order', action: 'order check fake-order', decision: 'allow', rule: 'order.check.pass', reason: 'every condition holds', cwd: proj, budget: null })], { run: RUN, order: 'fake-order' }, home);
    const r = cli(home, ['audit', '--run', RUN]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /no check recorded/);
    assert.match(r.stdout, /checks: 1$/m);
    const s = card(home);
    assert.equal(s.no_check, false);
    assert.equal(s.checks.length, 1);
  });
  it('a test run command and the test files written count', () => {
    const { home, proj } = fresh();
    cc(home, proj, 'Write', { file_path: join(proj, 'test', 'a.test.ts'), content: "import 'node:test';\n" }, 'e1');
    cc(home, proj, 'Bash', { command: 'npm test' }, 'e2');
    const s = card(home);
    assert.deepEqual(s.tests_written, ['test/a.test.ts']);
    assert.equal(s.checks.length, 1);
    assert.equal(s.no_check, false);
  });
  it('a summary with no config folder has no counts (what diff-class --run reads is unchanged)', () => {
    const { home, proj, log } = fresh();
    cc(home, proj, 'Bash', { command: 'ls' }, 'f1');
    const s = summarizeRun(log, RUN);
    assert.equal(s.counts, undefined);
    assert.doesNotMatch(formatRunSummary(s), /^counts:/m);
  });
});

describe('the check and commit patterns', () => {
  it('recognises common test runners and the openmorals checks', () => {
    for (const c of ['npm test', 'cd a && npm run test:unit', 'npx vitest run', 'pytest -q', 'python3 -m unittest discover -s tests', 'go test ./...', 'FOO=1 cargo test', 'make test', 'node --test "dist/test/**/*.test.js"', 'openmorals diff-class --run r1', './gradlew test', 'bundle exec rspec', 'openmorals order check fake']) assert.equal(isCheckCommand(c), true, c);
  });
  it('does not take a mention for a run', () => {
    for (const c of ['cat jest.config.js', 'npm install', 'echo pytest', 'ls test/', 'git status', 'vim test.py', 'make ci']) assert.equal(isCheckCommand(c), false, c);
  });
  it('git commit, with options before it; not a mention', () => {
    for (const c of ['git commit -m x', 'git -c user.name=a commit -m x', 'git add a && git commit -m y']) assert.equal(isGitCommit(c), true, c);
    for (const c of ['git log --grep commit', 'echo git commit', 'git status']) assert.equal(isGitCommit(c), false, c);
  });
});
