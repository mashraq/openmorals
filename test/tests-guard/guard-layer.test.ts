import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { chainAudit, makeAuditRecord, parseAuditText } from '../../src/audit.js';
import { checkClaim, parseClaimList } from '../../src/tests/claim.js';
import { compareTests } from '../../src/tests/compare.js';
import { compareCoverage, parseCoverage } from '../../src/tests/coverage.js';
import { judgeFailFirst } from '../../src/tests/failfirst.js';
import { testProvenance, testWritesOf } from '../../src/tests/provenance.js';
import { QUARANTINE_FILE, parseQuarantine } from '../../src/tests/quarantine.js';
import { parseTestReport } from '../../src/tests/report.js';
import type { TestReport } from '../../src/tests/report.js';
import type { Action } from '../../src/types.js';
import { REPO_ROOT, tempDir } from '../helpers.js';
import { junit } from '../tests-compare/fixtures.js';
import type { Case } from '../tests-compare/fixtures.js';

const CLI = join(REPO_ROOT, 'dist', 'src', 'cli.js');

function report(cases: readonly Case[]): TestReport {
  const r = parseTestReport(junit(cases));
  assert.ok(r.ok);
  return r.report;
}

function run(args: string[], home: string): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, OPENMORALS_HOME: home } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const ID = (n: string): string => `demo.WidgetTest > ${n}`;

describe('test provenance (0.32.0)', () => {
  const w = (path: string): Action => ({ kind: 'write', path, tool: 'Write' });
  const x = (command: string): Action => ({ kind: 'exec', command, shell: 'posix', tool: 'Bash' });
  it('names the test files a write or a command writes, relative to the project', () => {
    assert.deepEqual(testWritesOf([w('/work/app/test/a.test.ts'), w('/work/app/src/a.ts')], '/work/app'), ['test/a.test.ts']);
    assert.deepEqual(testWritesOf([x('echo x > tests/test_a.py')], '/work/app'), ['tests/test_a.py']);
    assert.deepEqual(testWritesOf([x("printf 'y' | tee -a spec/b_spec.rb")], '/work/app'), ['spec/b_spec.rb']);
    assert.deepEqual(testWritesOf([x('cp /tmp/x.go pkg/x_test.go')], '/work/app'), ['pkg/x_test.go']);
    assert.deepEqual(testWritesOf([x("sed -i 's/a/b/' test/c.test.js")], '/work/app'), ['test/c.test.js']);
    assert.deepEqual(testWritesOf([x('cat test/a.test.ts'), x('npm test 2>&1 > /dev/null')], '/work/app'), []);
  });
  it('rides on the audit record and reads back as who wrote which test', () => {
    const recs = [
      makeAuditRecord({ source: 'claude-code', session: 's1', tool: 'Write', action: 'Write test/a.test.ts', decision: 'allow', rule: 'none', reason: '', cwd: '/w', budget: null, tests: ['test/a.test.ts'] }, new Date('2026-11-25T10:00:00Z')),
      makeAuditRecord({ source: 'claude-code', session: 's1', tool: 'Bash', action: 'rm x', decision: 'deny', rule: 'x', reason: '', cwd: '/w', budget: null, tests: ['test/b.test.ts'] }, new Date('2026-11-25T10:01:00Z')),
      makeAuditRecord({ source: 'claude-code', session: 's2', tool: 'Read', action: 'Read a', decision: 'allow', rule: 'none', reason: '', cwd: '/w', budget: null }, new Date('2026-11-25T10:02:00Z')),
    ];
    const text = chainAudit(recs, {}, undefined).text;
    const read = parseAuditText(text);
    assert.equal(read.errors.length, 0);
    assert.equal(text.split('\n').filter((l) => l.includes('"tests"')).length, 2, 'only records that write a test carry the field');
    const p = testProvenance(read.records, { paths: ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'] });
    assert.deepEqual(p.entries.map((e) => [e.path, e.writes.length, e.stopped]), [['test/a.test.ts', 1, 0], ['test/b.test.ts', 0, 1]]);
    assert.deepEqual(p.noRecord, ['test/c.test.ts']);
    assert.equal(testProvenance(read.records, { session: 's2' }).entries.length, 0);
    assert.equal(testProvenance(read.records, { since: '2026-11-25T10:00:30.000Z' }).entries[0]?.path, 'test/b.test.ts');
  });
  it('tests provenance exits 1 when the agent wrote a listed test, 0 when not, 2 when the log is unreadable', () => {
    const home = tempDir('prov');
    const log = join(home, 'a.jsonl');
    const rec = makeAuditRecord({ source: 'claude-code', session: 's', tool: 'Write', action: 'Write t', decision: 'allow', rule: 'none', reason: '', cwd: '/w', budget: null, tests: ['test/t.test.ts'] });
    writeFileSync(log, chainAudit([rec], {}, undefined).text);
    const yes = run(['tests', 'provenance', '--log', log, 'test/t.test.ts'], home);
    assert.equal(yes.code, 1, yes.stderr);
    assert.match(yes.stdout, /test\/t\.test\.ts: 1 write/);
    const no = run(['tests', 'provenance', '--log', log, 'test/other.test.ts'], home);
    assert.equal(no.code, 0);
    assert.match(no.stdout, /No record for: test\/other\.test\.ts/);
    mkdirSync(join(home, 'dir.jsonl'));
    assert.equal(run(['tests', 'provenance', '--log', join(home, 'dir.jsonl')], home).code, 2);
    assert.equal(run(['tests', 'provenance', '--since', 'not-a-time'], home).code, 64);
  });
});

describe('tests claim (0.32.0)', () => {
  const clean = report([{ name: 'adds', status: 'pass' }, { name: 'subtracts', status: 'fail' }, { name: 'divides', status: 'skip' }]);
  it('"every test passes" fails on each failing or skipped test', () => {
    const r = checkClaim(clean, null);
    assert.equal(r.blocking, 2);
    assert.deepEqual(r.problems.map((p) => [p.id, p.miss]), [[ID('subtracts'), 'fails'], [ID('divides'), 'skipped']]);
  });
  it('a list claim checks only what it names, by full id or unique name', () => {
    assert.equal(checkClaim(clean, ['adds']).blocking, 0);
    const r = checkClaim(clean, ['adds', 'subtracts', 'multiplies']);
    assert.deepEqual(r.problems.map((p) => [p.claimed, p.miss]).sort(), [['multiplies', 'did-not-run'], ['subtracts', 'fails']]);
  });
  it('a test on hold is listed and does not decide the result', () => {
    const r = checkClaim(clean, ['adds', 'subtracts'], new Set([ID('subtracts')]));
    assert.equal(r.blocking, 0);
    assert.equal(r.problems[0]?.held, true);
  });
  it('reads a plain list, skipping blanks and comments', () => {
    assert.deepEqual(parseClaimList('# claimed\nadds\n\n  subtracts  \n'), ['adds', 'subtracts']);
  });
  it('the command takes the agent\'s own report as the claim and exits 1 when the clean run disagrees', () => {
    const home = tempDir('claim');
    writeFileSync(join(home, 'clean.xml'), junit([{ name: 'adds', status: 'pass' }, { name: 'subtracts', status: 'fail' }]));
    writeFileSync(join(home, 'agent.xml'), junit([{ name: 'adds', status: 'pass' }, { name: 'subtracts', status: 'pass' }]));
    writeFileSync(join(home, 'list.txt'), 'adds\n');
    const r = run(['tests', 'claim', join(home, 'clean.xml'), '--claimed', join(home, 'agent.xml')], home);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stdout, /subtracts.*fails in the clean run/);
    assert.equal(run(['tests', 'claim', join(home, 'clean.xml'), '--claimed', join(home, 'list.txt')], home).code, 0);
    assert.equal(run(['tests', 'claim', join(home, 'missing.xml')], home).code, 2);
    writeFileSync(join(home, QUARANTINE_FILE), `${ID('subtracts')} # flaky on CI\n`);
    assert.equal(run(['tests', 'claim', join(home, 'clean.xml'), '--claimed', join(home, 'agent.xml')], home).code, 0);
  });
});

describe('held tests (0.32.0)', () => {
  it('parses one id per line with an optional reason', () => {
    assert.deepEqual(parseQuarantine('# held\na > b # flaky\n\nc\n'), [{ id: 'a > b', why: 'flaky', line: 2 }, { id: 'c', why: '', line: 4 }]);
  });
  it('a held loss does not block a comparison and a held gain is marked', () => {
    const before = report([{ name: 'a', status: 'pass' }, { name: 'b', status: 'fail' }]);
    const after = report([{ name: 'a', status: 'fail' }, { name: 'b', status: 'pass' }]);
    assert.equal(compareTests([before], [after]).blocking, 1);
    const c = compareTests([before], [after], [], new Set([ID('a'), ID('b')]));
    assert.equal(c.blocking, 0);
    assert.equal(c.passToFail[0]?.held, true);
    assert.equal(c.failToPass[0]?.held, true);
  });
  it('a held acceptance test fails the fail-first gate', () => {
    const base = report([{ name: 'new one', status: 'fail' }]);
    const head = report([{ name: 'new one', status: 'pass' }]);
    assert.equal(judgeFailFirst({ before: null, base, head, acceptance: ['new one'] }).problems.length, 0);
    const j = judgeFailFirst({ before: null, base, head, acceptance: ['new one'], held: new Set([ID('new one')]) });
    assert.deepEqual(j.problems.map((p) => p.why), ['held']);
  });
});

describe('tests coverage (0.32.0)', () => {
  const lcov = (files: Record<string, number[]>): string => Object.entries(files).map(([f, hits]) => `SF:${f}\n${hits.map((h, i) => `DA:${i + 1},${h}`).join('\n')}\nend_of_record\n`).join('');
  it('reads lcov and Cobertura', () => {
    const l = parseCoverage(lcov({ 'src/a.ts': [1, 0, 3, 0] }));
    assert.ok(l.ok);
    assert.deepEqual(l.files, [{ file: 'src/a.ts', lines: 4, covered: 2 }]);
    const c = parseCoverage('<?xml version="1.0"?><coverage><packages><package><classes><class filename="app/b.py" line-rate="0.5"><lines><line number="1" hits="1"/><line number="2" hits="0"/></lines></class></classes></package></packages></coverage>');
    assert.ok(c.ok);
    assert.deepEqual(c.files, [{ file: 'app/b.py', lines: 2, covered: 1 }]);
    assert.equal(parseCoverage('hello').ok, false);
  });
  it('lists each file that lost coverage or left the report, worst first', () => {
    const b = parseCoverage(lcov({ 'src/a.ts': [1, 1, 1, 1], 'src/b.ts': [1, 1, 1, 1], 'src/c.ts': [1, 0] }));
    const a = parseCoverage(lcov({ 'src/a.ts': [1, 0, 0, 0], 'src/b.ts': [1, 1, 1, 1], 'src/d.ts': [0, 0] }));
    assert.ok(b.ok && a.ok);
    const r = compareCoverage(b.files, a.files);
    assert.deepEqual(r.drops.map((d) => [d.file, d.why]), [['src/a.ts', 'dropped'], ['src/c.ts', 'gone-from-report']]);
    assert.deepEqual(r.newUncovered, ['src/d.ts']);
  });
  it('the command exits 1 on a drop and 0 when none passes --min-drop', () => {
    const home = tempDir('cov');
    writeFileSync(join(home, 'b.info'), lcov({ 'src/a.ts': [1, 1, 1, 1, 1, 1, 1, 1, 1, 1] }));
    writeFileSync(join(home, 'a.info'), lcov({ 'src/a.ts': [1, 1, 1, 1, 1, 1, 1, 1, 1, 0] }));
    const r = run(['tests', 'coverage', join(home, 'b.info'), join(home, 'a.info')], home);
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stdout, /src\/a\.ts: 100% to 90%/);
    assert.equal(run(['tests', 'coverage', join(home, 'b.info'), join(home, 'a.info'), '--min-drop', '20'], home).code, 0);
    assert.equal(run(['tests', 'coverage', join(home, 'b.info')], home).code, 64);
  });
});
