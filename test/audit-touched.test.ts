import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { runClaudeCodeHook } from '../src/adapters/claude-code.js';
import { runGeminiHook } from '../src/adapters/gemini-cli/index.js';
import { runOpencodeHook } from '../src/adapters/opencode/index.js';
import { searchNote } from '../src/adapters/search-note.js';
import { parseAuditLine } from '../src/audit.js';
import type { AuditRecordV2 } from '../src/audit.js';
import type { TouchedReport } from '../src/audit-touched.js';
import { TOUCHED_NOT_SEEN, shellSearchFolders, touchedCommand, touchedReport } from '../src/audit-touched.js';
import { runCodexHook } from '../src/adapters/codex/index.js';
import { makeAuditRecord } from '../src/audit.js';
import type { AuditRecord } from '../src/audit.js';
import { REPO_ROOT, tempDir } from './helpers.js';

// Every fixture lives in one fresh temp folder, removed at the end. Ids and paths are obviously fake.
const CLI = join(REPO_ROOT, 'dist', 'src', 'cli.js');
const root = tempDir('touched');
after(() => {
  rmSync(root, { recursive: true, force: true });
});
let n = 0;
function fresh(): { home: string; proj: string; log: string } {
  n++;
  const home = join(root, `t${n}`, 'home');
  const proj = join(root, `t${n}`, 'proj');
  mkdirSync(join(proj, 'holdout'), { recursive: true });
  mkdirSync(home, { recursive: true });
  return { home, proj, log: join(home, 'audit.jsonl') };
}
const env = (home: string, run = 'r1'): NodeJS.ProcessEnv => ({ OPENMORALS_HOME: home, OPENMORALS_RUN: run });
function cc(home: string, proj: string, tool: string, input: Record<string, unknown>, id: string, run = 'r1', session = 'sess-t'): void {
  runClaudeCodeHook(JSON.stringify({ session_id: session, cwd: proj, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: id }), { env: env(home, run), cwd: proj });
}
const records = (log: string): AuditRecordV2[] =>
  readFileSync(log, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => parseAuditLine(l) as AuditRecordV2);
const touched = (home: string, ...args: string[]): { exitCode: number; report: TouchedReport & { not_seen: string[] } } => {
  const r = touchedCommand([...args, '--json'], { OPENMORALS_HOME: home });
  return { exitCode: r.exitCode, report: JSON.parse(r.stdout) as TouchedReport & { not_seen: string[] } };
};

describe('openmorals audit touched (0.40.0)', () => {
  it('(1) a Read of holdout/login.yaml in run r1 is listed under r1, exit 1', () => {
    const { home, proj } = fresh();
    cc(home, proj, 'Read', { file_path: join(proj, 'holdout', 'login.yaml') }, 'a1');
    const { exitCode, report } = touched(home, 'holdout/**');
    assert.equal(exitCode, 1);
    assert.equal(report.listed, 1);
    assert.equal(report.groups[0]?.run, 'r1');
    assert.equal(report.groups[0]?.session, 'sess-t');
    assert.equal(report.groups[0]?.items[0]?.how, 'named');
  });
  it('(2) Bash cat holdout/*.yaml is listed: the command text names the path', () => {
    const { home, proj } = fresh();
    cc(home, proj, 'Bash', { command: 'cat holdout/*.yaml | head' }, 'b1');
    const { exitCode, report } = touched(home, 'holdout/**');
    assert.equal(exitCode, 1);
    assert.equal(report.groups[0]?.items[0]?.matched, 'holdout/*.yaml');
  });
  it('(3) a Grep over holdout/ or the bare holdout, and a Grep with no folder, are listed (the search note)', () => {
    const { home, proj, log } = fresh();
    cc(home, proj, 'Grep', { pattern: 'expected_answer', path: 'holdout/' }, 'c1');
    cc(home, proj, 'Grep', { pattern: 'expected_answer' }, 'c2');
    cc(home, proj, 'Grep', { pattern: 'expected_answer', path: 'holdout' }, 'c3');
    const recs = records(log);
    assert.equal(recs[0]?.action, 'Grep holdout/ [search "expected_answer"]');
    assert.equal(recs[1]?.action, 'Grep [search "expected_answer" in the working folder]');
    const { exitCode, report } = touched(home, 'holdout/**');
    assert.equal(exitCode, 1);
    assert.equal(report.listed, 3);
    assert.deepEqual(report.groups[0]?.items.map((i) => i.how), ['named-folder', 'searched-folder', 'named-folder']);
  });
  it('(4) a script that opens the holdout itself is not listed, and the report says why', () => {
    const { home, proj } = fresh();
    cc(home, proj, 'Bash', { command: 'python scripts/peek.py' }, 'd1');
    const { exitCode, report } = touched(home, 'holdout/**');
    assert.equal(exitCode, 0);
    assert.equal(report.listed, 0);
    assert.ok(report.not_seen.some((l) => l.includes('Reads by a script')));
    const text = touchedCommand(['holdout/**'], { OPENMORALS_HOME: home }).stdout;
    assert.match(text, /Not seen by this report:\n {2}Reads by a script/);
  });
  it('(5) benign: a run that only touched src/ and test/ lists nothing, exit 0, no ask', () => {
    const { home, proj, log } = fresh();
    cc(home, proj, 'Read', { file_path: join(proj, 'src', 'a.ts') }, 'e1');
    cc(home, proj, 'Edit', { file_path: join(proj, 'src', 'a.ts'), old_string: 'a = 1', new_string: 'a = 2' }, 'e2');
    cc(home, proj, 'Write', { file_path: join(proj, 'test', 'a.test.ts'), content: "import 'node:test';\n" }, 'e3');
    cc(home, proj, 'Grep', { pattern: 'TODO', path: 'src' }, 'e4');
    cc(home, proj, 'Bash', { command: 'npm test' }, 'e5');
    assert.ok(records(log).every((r) => r.decision === 'allow'));
    const { exitCode, report } = touched(home, 'holdout/**');
    assert.equal(exitCode, 0);
    assert.equal(report.listed, 0);
    assert.equal(report.recordsRead, 5);
  });
  it('a test file written under the glob is listed as one; --run and --session filter', () => {
    const { home, proj } = fresh();
    cc(home, proj, 'Write', { file_path: join(proj, 'test', 'fixtures', 'case.test.ts'), content: "import 'node:test';\n" }, 'f1', 'r1');
    cc(home, proj, 'Read', { file_path: join(proj, 'test', 'fixtures', 'case.test.ts') }, 'f2', 'r2', 'sess-u');
    const all = touched(home, 'test/fixtures/**');
    assert.equal(all.report.listed, 2);
    assert.deepEqual(all.report.groups.map((g) => [g.run, g.session]), [['r1', 'sess-t'], ['r2', 'sess-u']]);
    assert.equal(all.report.groups[0]?.items[0]?.how, 'test-file');
    assert.equal(touched(home, 'test/fixtures/**', '--run', 'r2').report.listed, 1);
    assert.equal(touched(home, 'test/fixtures/**', '--session', 'sess-none').exitCode, 0);
  });
  it('the Gemini CLI and opencode searches carry their pattern too', () => {
    const { home, proj, log } = fresh();
    runGeminiHook(JSON.stringify({ session_id: 'g1', cwd: proj, hook_event_name: 'BeforeTool', tool_name: 'grep_search', tool_input: { pattern: 'answer' } }), { env: env(home), cwd: proj });
    runOpencodeHook(JSON.stringify({ event: 'tool.execute.before', sessionID: 'o1', callID: 'c', tool: 'grep', args: { pattern: 'answer', path: 'holdout' }, cwd: proj }), { env: env(home), cwd: proj });
    const recs = records(log);
    assert.equal(recs[0]?.action, 'grep_search [search "answer" in the working folder]');
    assert.equal(recs[1]?.action, 'grep holdout [search "answer"]');
    assert.equal(touched(home, 'holdout/**').report.listed, 2);
  });
  it('usage: no glob, a bad glob, an unknown flag are 64; the CLI routes it', () => {
    const { home } = fresh();
    assert.equal(touchedCommand([], { OPENMORALS_HOME: home }).exitCode, 64);
    assert.equal(touchedCommand(['/abs/**'], { OPENMORALS_HOME: home }).exitCode, 64);
    assert.equal(touchedCommand(['holdout/**', '--bogus'], { OPENMORALS_HOME: home }).exitCode, 64);
    const r = spawnSync(process.execPath, [CLI, 'audit', 'touched', 'holdout/**'], { encoding: 'utf8', env: { ...process.env, OPENMORALS_HOME: home, OPENMORALS_RUN: '' } });
    assert.equal(r.status, 2, 'no log: it cannot tell, never a clean 0');
    assert.match(r.stderr, /there is no audit log at .*cannot tell/);
    assert.equal(TOUCHED_NOT_SEEN.length, 7);
  });
  it('the search note quotes the pattern, caps it and marks a search with no folder', () => {
    assert.equal(searchNote('a"b', 'src'), '[search "a\\"b"]');
    assert.equal(searchNote('x', ''), '[search "x" in the working folder]');
    assert.equal(searchNote(undefined, 'src'), null);
    assert.ok((searchNote('y'.repeat(500), 'src') ?? '').length < 220);
  });
});

const recOf = (action: string, cwd: string | null, tool = 'Bash'): AuditRecord => makeAuditRecord({ source: 'claude-code', session: 's', tool, action, decision: 'allow', rule: 'none', reason: 'r', cwd, budget: null });
const listedFor = (glob: string, ...recs: AuditRecord[]): string[] => touchedReport(recs, glob).groups.flatMap((g) => g.items.map((i) => `${i.how}:${i.matched}`));

describe('audit touched: folders, filters, paths and shell searches', () => {
  it('a command naming the bare folder (cp -r, rg, tar, Codex shell) is listed', () => {
    const { home, proj } = fresh();
    cc(home, proj, 'Bash', { command: 'cp -r holdout /tmp/h' }, 'g1');
    cc(home, proj, 'Bash', { command: 'tar czf h.tgz holdout/' }, 'g2');
    runCodexHook(JSON.stringify({ session_id: 'cx-t', cwd: proj, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'x1', tool_input: { command: 'rg expected_answer holdout' } }), { env: env(home), cwd: proj });
    const { exitCode, report } = touched(home, 'holdout/**');
    assert.equal(exitCode, 1);
    assert.equal(report.listed, 3);
    assert.ok(report.groups.flatMap((g) => g.items).every((i) => i.how === 'named-folder'));
    assert.deepEqual(listedFor('holdout/**', recOf('ls src', '/w/p')), []);
  });
  it('a search folder equal to the working folder, given absolute, is the working folder', () => {
    assert.deepEqual(listedFor('holdout/**', recOf('Grep /w/p [search "k"]', '/w/p', 'Grep')), ['searched-folder:/w/p']);
    assert.deepEqual(listedFor('holdout/**', recOf('Grep /w/p/*.json [search "k"]', '/w/p', 'Grep')), ['searched-folder:/w/p/*.json']);
  });
  it('a given folder plus a file filter is matched', () => {
    const { home, proj } = fresh();
    cc(home, proj, 'Grep', { pattern: 'k', path: '.', glob: '*.json' }, 'h1');
    runGeminiHook(JSON.stringify({ session_id: 'g2', cwd: proj, hook_event_name: 'BeforeTool', tool_name: 'grep_search', tool_input: { pattern: 'k', dir_path: '.', include: '*.json' } }), { env: env(home), cwd: proj });
    assert.equal(touched(home, 'holdout/**').report.listed, 2);
    assert.deepEqual(listedFor('holdout/**', recOf('Grep src/*.ts [search "k"]', '/w/p', 'Grep')), []);
  });
  it('unanchored and **/ globs, and folders deeper than the fixed prefix, are "may hold"', () => {
    const grepConfig = recOf('Grep config [search "k"]', '/w/p', 'Grep');
    assert.deepEqual(listedFor('**/*.yaml', grepConfig), ['searched-folder-maybe:config']);
    assert.deepEqual(listedFor('*.yaml', grepConfig), ['searched-folder-maybe:config']);
    assert.deepEqual(listedFor('holdout/*/answers/**', recOf('Grep holdout/a [search "k"]', '/w/p', 'Grep')), ['searched-folder-maybe:holdout/a']);
    assert.deepEqual(listedFor('holdout/**', recOf('Grep holdout/a [search "k"]', '/w/p', 'Grep')), ['named:holdout/a']);
    assert.deepEqual(listedFor('holdout/**', grepConfig), []);
  });
  it('.. is resolved; a path that leaves the working folder is not matched; a search of an ancestor holds everything', () => {
    assert.deepEqual(listedFor('holdout/**', recOf('cat src/../holdout/a.yaml', '/w/p')), ['named:src/../holdout/a.yaml']);
    assert.deepEqual(listedFor('holdout/**', recOf('cat ../other/holdout/a.yaml', '/w/p')), []);
    assert.deepEqual(listedFor('holdout/**', recOf('Grep .. [search "k"]', '/w/p', 'Grep')), ['searched-folder:..']);
    assert.deepEqual(listedFor('holdout/**', recOf('Grep /w [search "k"]', '/w/p', 'Grep')), ['searched-folder:/w']);
  });
  it('a log with no readable record, and a log that does not verify with nothing listed, exit 2', () => {
    const { home, proj, log } = fresh();
    writeFileSync(log, 'not a record\n{"also": "not"}\n');
    const bad = touchedCommand(['holdout/**'], { OPENMORALS_HOME: home });
    assert.equal(bad.exitCode, 2);
    assert.match(bad.stderr, /holds no readable record \(2 lines could not be read\)/);
    assert.equal(touchedCommand(['holdout/**', '--file', join(home, 'audit.jsnol')], { OPENMORALS_HOME: home }).exitCode, 2);
    const f2 = fresh();
    for (const [i, c] of ['ls', 'git status', 'echo done'].entries()) cc(f2.home, f2.proj, 'Bash', { command: c }, `v${i}`);
    assert.equal(touchedCommand(['holdout/**'], { OPENMORALS_HOME: f2.home }).exitCode, 0);
    const kept = readFileSync(f2.log, 'utf8').split('\n').filter((l, i) => i !== 1).join('\n');
    writeFileSync(f2.log, kept);
    const cut = touchedCommand(['holdout/**'], { OPENMORALS_HOME: f2.home });
    assert.equal(cut.exitCode, 2);
    assert.match(cut.stdout, /does NOT verify/);
    void proj;
  });
  it('a shell search with no folder reads the working folder; one reading a pipe does not', () => {
    for (const c of ['rg expected_answer', 'grep -rn expected_answer .', 'git grep expected_answer', 'cd x && grep -R -e k', 'ag k']) assert.deepEqual(listedFor('holdout/**', recOf(c, '/w/p')), ['searched-folder:' + (c.endsWith(' .') ? '.' : 'the working folder')], c);
    for (const c of ['cat a | rg k', 'grep k notes.txt', 'rg k src', 'echo "rg k"']) assert.deepEqual(listedFor('holdout/**', recOf(c, '/w/p')), [], c);
    assert.deepEqual(shellSearchFolders('rg -g "*.ts" -e k src lib'), [['src', 'lib']]);
  });
  it('an absolute path outside the working folder, or with no working folder, is not matched', () => {
    assert.deepEqual(listedFor('holdout/**', recOf('cat /holdout/x', '/w/p')), []);
    assert.deepEqual(listedFor('holdout/**', recOf('cat /w/p/holdout/x', null)), []);
    assert.deepEqual(listedFor('holdout/**', recOf('cat /holdout/x', null)), []);
    assert.deepEqual(listedFor('holdout/**', recOf('cat holdout/x', null)), ['named:holdout/x']);
  });
  it('a pattern the redaction rewrote still marks a search of the working folder', () => {
    const { home, proj, log } = fresh();
    cc(home, proj, 'Grep', { pattern: 'token="abc123"' }, 'k1');
    assert.match(records(log)[0]?.action ?? '', /REDACTED/);
    assert.equal(touched(home, 'holdout/**').report.listed, 1);
  });
  it('each item carries its log line', () => {
    const { home, proj, log } = fresh();
    cc(home, proj, 'Bash', { command: 'ls' }, 'l1');
    cc(home, proj, 'Read', { file_path: join(proj, 'holdout', 'x.yaml') }, 'l2');
    writeFileSync(log, `garbage\n${readFileSync(log, 'utf8')}`);
    const item = touched(home, 'holdout/**').report.groups[0]?.items[0];
    assert.equal(item?.line, 3);
    assert.equal(item?.record, 2);
  });
});
