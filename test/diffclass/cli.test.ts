import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import type { DiffClassCase } from '../../src/diffclass/rows.js';
import { folderSource, loadCasesFrom } from '../../src/eval/cases.js';
import { REPO_ROOT, tempDir } from '../helpers.js';

const CLI = join(REPO_ROOT, 'dist', 'src', 'cli.js');

function row(name: string): DiffClassCase {
  const r = loadCasesFrom(folderSource(join(REPO_ROOT, 'cases')));
  assert.ok(r.ok, r.ok ? '' : r.error);
  const c = r.value.diffClass.flatMap((f) => f.cases).find((x) => x.name === name);
  assert.ok(c !== undefined, `no row named ${name}`);
  return c;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Place {
  cwd: string;
  home: string;
  base: string;
}

function place(baseFiles: Record<string, string>, user: string | null = null): Place {
  const cwd = tempDir('dc-cwd');
  const home = tempDir('dc-home');
  const base = tempDir('dc-base');
  for (const [p, t] of Object.entries(baseFiles)) {
    mkdirSync(dirname(join(base, p)), { recursive: true });
    writeFileSync(join(base, p), t);
  }
  if (user !== null) writeFileSync(join(home, 'openmorals.yaml'), user);
  return { cwd, home, base };
}

function run(args: string[], p: Place, input = '', extraEnv: NodeJS.ProcessEnv = {}): Run {
  const r = spawnSync(process.execPath, [CLI, 'diff-class', ...args], { encoding: 'utf8', cwd: p.cwd, input, env: { ...process.env, OPENMORALS_HOME: p.home, OPENMORALS_UNATTENDED: '', OPENMORALS_RUN: '', ...extraEnv } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function file(p: Place, name: string, text: string): string {
  const f = join(p.cwd, name);
  writeFileSync(f, text);
  return f;
}

const ON = 'version: 1\nmerge:\n  review_free: [tighten-only, reproduced]\n';
const ROWS = row('A1: two added rows expecting ask and deny, class switched on');
const DOC = row('A2: byte-equal to the reproduced diff');

describe('openmorals diff-class on the command line', () => {
  it('usage errors exit 64 and do nothing', () => {
    const p = place({});
    for (const args of [[], ['a', 'b'], ['--nope', 'x'], ['x', '--audit', 'log'], ['x', '--run', 'r', '--summary', 's'], ['x', '--base'], ['x', '--paths', '../up'], ['x', '--paths', '/abs'], ['x', '--paths'], ['x', '--max-lines', '0'], ['x', '--max-lines', '-3'], ['x', '--max-files', 'ten'], ['x', '--max-lines', '5', '--max-lines', '6']]) {
      const r = run(args, p);
      assert.equal(r.code, 64, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, /nothing was done/);
    }
  });

  it('--paths repeats, and a file outside every declared glob gets a reason line', () => {
    const p = place(ROWS.base, ON);
    const d = file(p, 'rows.diff', ROWS.diff);
    assert.equal(run([d, '--base', p.base, '--paths', 'cases/'], p).code, 0);
    const out = run([d, '--base', p.base, '--paths', 'src/', '--paths', 'test/'], p);
    assert.equal(out.code, 1);
    assert.match(out.stdout, /changes a file outside the declared paths: cases\/destructive\.cases\.yaml/);
    const j = JSON.parse(run([d, '--base', p.base, '--json'], p).stdout) as { notChecked: string[] };
    assert.ok(j.notChecked.some((x) => x.startsWith('integrity.outside-paths:')));
  });

  it('input it cannot read exits 2 and says to read it as review, in text and JSON', () => {
    const p = place({});
    const garbage = file(p, 'g.diff', 'this is not a diff\n');
    const t = run([garbage], p);
    assert.equal(t.code, 2);
    assert.match(t.stderr, /REVIEW \(unreadable input\)/);
    assert.match(t.stderr, /needs review/);
    const j = run([garbage, '--json'], p);
    assert.equal(j.code, 2);
    assert.deepEqual({ ...JSON.parse(j.stdout), error: 'x' }, { verdict: 'review', class: 'B', exitCode: 2, error: 'x', line: 1 });
    assert.equal(run([join(p.cwd, 'missing.diff')], p).code, 2);
    assert.equal(run(['-'], p, '').code, 2, 'an empty diff on standard input');
  });

  it('a diff that meets tighten-only still needs review by default (nothing switched on)', () => {
    const p = place(ROWS.base);
    const r = run(['-', '--base', p.base], p, ROWS.diff);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^openmorals diff-class: REVIEW \(class B\)/);
    assert.match(r.stdout, /meets tighten-only, which is not switched on/);
  });

  it('with the class switched on in the user-level file it is review-free, exit 0, and says what it cannot see', () => {
    const p = place(ROWS.base, ON);
    const r = run(['-', '--base', p.base], p, ROWS.diff);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /REVIEW-FREE \(class A, tighten-only\)/);
    assert.match(r.stdout, /2 added rows, each expecting ask or deny/);
    assert.match(r.stdout, /It cannot see:/);
    assert.match(r.stdout, /required status pinned to an app identity/);
  });

  it('a project file in the base tree cannot switch a class on, and the attempt is noted', () => {
    const p = place({ ...ROWS.base, 'openmorals.yaml': ON });
    const r = run(['-', '--base', p.base], p, ROWS.diff);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /note: .*tried to set merge\.review_free to tighten-only; only the user-level file can switch a class on/);
  });

  it('a project file in the base tree can switch the user\'s class off', () => {
    const p = place({ ...ROWS.base, 'openmorals.yaml': 'version: 1\nmerge:\n  review_free: []\n' }, ON);
    assert.equal(run(['-', '--base', p.base], p, ROWS.diff).code, 1);
  });

  it('an invalid user-level file switches nothing on', () => {
    const p = place(ROWS.base, 'version: 1\nmerge:\n  review_free: [everything]\n');
    const r = run(['-', '--base', p.base], p, ROWS.diff);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /merge settings could not be read/);
  });

  it('a wrong base folder cannot make it review-free', () => {
    const p = place({ 'cases/destructive.cases.yaml': 'guard: destructive\ncases: []\n' }, ON);
    const r = run(['-', '--base', p.base], p, ROWS.diff);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /not the base this diff was made from/);
  });

  it('--reproduced: byte-equal is review-free when switched on; one byte off is review', () => {
    const p = place({}, ON);
    const d = file(p, 'pr.diff', DOC.diff);
    assert.equal(run([d, '--reproduced', file(p, 'same.diff', DOC.diff)], p).code, 0);
    const off = run([d, '--reproduced', file(p, 'other.diff', DOC.diff.replace('line 2', 'line 3'))], p);
    assert.equal(off.code, 1);
    assert.match(off.stdout, /differs from the reproduced diff/);
    assert.equal(run([d, '--reproduced', join(p.cwd, 'nope.diff')], p).code, 2);
  });

  it('--summary: a deny in the run record makes it need review; a clean one changes nothing; garbage exits 2', () => {
    const p = place(ROWS.base, ON);
    const d = file(p, 'pr.diff', ROWS.diff);
    const clean = { run: 'r1', status: 'ok', records: 3, sessions: ['s'], denies: [], asks: [], approved_asks: [], taint_marks: [], loosening_notes: [], record: { ok: true, problems: [] } };
    assert.equal(run([d, '--base', p.base, '--summary', file(p, 'clean.json', JSON.stringify(clean))], p).code, 0);
    const denied = run([d, '--base', p.base, '--summary', file(p, 'deny.json', JSON.stringify({ ...clean, denies: [{}] })), '--json'], p);
    assert.equal(denied.code, 1);
    const v = JSON.parse(denied.stdout) as { reasons: { rule: string }[]; qualifies: string | null };
    assert.ok(v.reasons.some((x) => x.rule === 'record.deny'));
    assert.equal(v.qualifies, null);
    assert.equal(run([d, '--base', p.base, '--summary', file(p, 'bad.json', '{"run": 1}')], p).code, 2);
  });

  it('--run reads the run from the real audit log: a clean run changes nothing, an ask makes it need review, no log is review', () => {
    const p = place(ROWS.base, ON);
    const d = file(p, 'pr.diff', ROWS.diff);
    const none = run([d, '--base', p.base, '--run', 'job-1'], p);
    assert.equal(none.code, 1);
    assert.match(none.stdout, /no audit log|no record/);
    const check = (cmd: string): void => {
      const r = spawnSync(process.execPath, [CLI, 'check', cmd], { encoding: 'utf8', cwd: p.cwd, env: { ...process.env, OPENMORALS_HOME: p.home, OPENMORALS_RUN: 'job-1', OPENMORALS_UNATTENDED: '' } });
      assert.ok(r.status === 0 || r.status === 1, r.stderr);
    };
    check('ls');
    const clean = run([d, '--base', p.base, '--run', 'job-1'], p);
    assert.equal(clean.code, 0, clean.stdout);
    check('rm -rf build');
    const asked = run([d, '--base', p.base, '--run', 'job-1'], p);
    assert.equal(asked.code, 1);
    assert.match(asked.stdout, /openmorals asked 1 time/);
  });

  it('--json carries the verdict, the reasons, the files and what it cannot see', () => {
    const p = place(ROWS.base);
    const r = run(['-', '--base', p.base, '--json'], p, ROWS.diff);
    const v = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.deepEqual(Object.keys(v).sort(), ['basis', 'cannotSee', 'class', 'exitCode', 'files', 'notChecked', 'notes', 'qualifies', 'reasons', 'switchedOn', 'verdict']);
    assert.equal(v['verdict'], 'review');
    assert.equal(v['qualifies'], 'tighten-only');
    assert.equal(v['exitCode'], 1);
  });

  it('prints at most three reason lines for a large change', () => {
    const p = place({});
    const many = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'README.md', 'package.json', '.github/x.yml'].map((f) => `diff --git a/${f} b/${f}\nindex 1111111..2222222 100644\n--- a/${f}\n+++ b/${f}\n@@ -1 +1 @@\n-a\n+b\n`).join('');
    const r = run(['-'], p, many);
    assert.equal(r.code, 1);
    const reasons = r.stdout.split('\n').filter((l) => l.startsWith('  - '));
    assert.equal(reasons.length, 3, r.stdout);
    assert.match(r.stdout, /more facts? in --json/);
    assert.match(r.stdout, /executable source: src\/a\.ts, src\/b\.ts, src\/c\.ts and 1 more/);
  });

  it('writes nothing in the current folder or the config folder', () => {
    const p = place(ROWS.base, ON);
    const before = readdirSync(p.home).sort();
    run(['-', '--base', p.base], p, ROWS.diff);
    assert.deepEqual(readdirSync(p.cwd), []);
    assert.deepEqual(readdirSync(p.home).sort(), before);
  });
});
