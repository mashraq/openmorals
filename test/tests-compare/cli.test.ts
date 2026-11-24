import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_BYLAWS } from '../../src/bylaws.js';
import { decide } from '../../src/engine.js';
import { APPROVAL_FILE } from '../../src/tests/command.js';
import { EMPTY_STATE } from '../../src/types.js';
import { REPO_ROOT, tempDir } from '../helpers.js';
import { BASE, junit } from './fixtures.js';

const CLI = join(REPO_ROOT, 'dist', 'src', 'cli.js');

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd: string, home: string): Run {
  const r = spawnSync(process.execPath, [CLI, 'tests', ...args], { encoding: 'utf8', cwd, env: { ...process.env, OPENMORALS_HOME: home, OPENMORALS_UNATTENDED: '' } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

interface Setup {
  dir: string;
  home: string;
  before: string;
  after: string;
}

function setup(after: string, before = junit(BASE)): Setup {
  const dir = tempDir('tc-cwd');
  const home = tempDir('tc-home');
  writeFileSync(join(dir, 'before.xml'), before);
  writeFileSync(join(dir, 'after.xml'), after);
  return { dir, home, before: 'before.xml', after: 'after.xml' };
}

function listAll(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).sort();
}

const LOST_ONE = junit([
  { name: 'alpha sorts', status: 'fail' },
  { name: 'beta merges', status: 'pass' },
  { name: 'gamma rounds', status: 'pass' },
  { name: 'delta trims', status: 'skip' },
]);

describe('openmorals tests compare (CLI)', () => {
  it('identical reports exit 0 and say so; nothing is written anywhere', () => {
    const s = setup(junit(BASE));
    const r = run(['compare', s.before, s.after], s.dir, s.home);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Failed or absent before, pass after: 0/);
    assert.match(r.stdout, /Passed before, now failing, gone or skipped: 0/);
    assert.match(r.stdout, /exit 0/);
    assert.match(r.stdout, /cannot tell which of these tests the agent could edit/);
    assert.deepEqual(listAll(s.dir), ['after.xml', 'before.xml']);
    assert.deepEqual(listAll(s.home), []);
  });

  it('a lost test exits 1, names it with the approval line to add, and lists the gain', () => {
    const s = setup(LOST_ONE);
    const r = run(['compare', s.before, s.after], s.dir, s.home);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /- fails {3}demo\.WidgetTest > alpha sorts/);
    assert.match(r.stdout, /\+ demo\.WidgetTest > gamma rounds {3}\(was failing\)/);
    assert.ok(r.stdout.includes(join(s.home, APPROVAL_FILE)), r.stdout);
    assert.match(r.stdout, /^ {2}fails demo\.WidgetTest > alpha sorts$/m);
  });

  it('the approval file in the config directory turns that exit 1 into 0', () => {
    const s = setup(LOST_ONE);
    writeFileSync(join(s.home, APPROVAL_FILE), 'fails demo.WidgetTest > alpha sorts\n');
    const r = run(['compare', s.before, s.after], s.dir, s.home);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\(approved, line 1\)/);
  });

  it('--json carries the lists, the exit code, "editable: unknown" and the limits', () => {
    const s = setup(LOST_ONE);
    const r = run(['compare', '--json', s.before, s.after], s.dir, s.home);
    assert.equal(r.code, 1);
    const j = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.equal(j['exitCode'], 1);
    assert.equal(j['blocking'], 1);
    assert.equal(j['editable'], 'unknown');
    assert.deepEqual((j['passToFail'] as { id: string }[]).map((l) => l.id), ['demo.WidgetTest > alpha sorts']);
    assert.deepEqual((j['failToPass'] as { id: string }[]).map((l) => l.id), ['demo.WidgetTest > gamma rounds']);
    assert.ok(Array.isArray(j['limits']) && (j['limits'] as unknown[]).length === 4);
  });

  it('an unreadable report exits 2 with a plain message, never "no damage", in text and JSON', () => {
    const s = setup('<testsuites><testcase name="cut off"');
    const r = run(['compare', s.before, s.after], s.dir, s.home);
    assert.equal(r.code, 2);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /after\.xml: junit: unreadable XML/);
    assert.match(r.stderr, /not as "no damage"/);
    const j = run(['compare', '--json', s.before, s.after], s.dir, s.home);
    assert.equal(j.code, 2);
    assert.equal((JSON.parse(j.stdout) as { exitCode: number }).exitCode, 2);
    const missing = run(['compare', s.before, 'nope.xml'], s.dir, s.home);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /cannot read nope\.xml/);
  });

  it('an approval file it cannot read exits 2 instead of being ignored', () => {
    const s = setup(LOST_ONE);
    writeFileSync(join(s.home, APPROVAL_FILE), 'approve everything\n');
    const r = run(['compare', s.before, s.after], s.dir, s.home);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /approval file .* line 1/);
    const d = setup(LOST_ONE);
    mkdirSync(join(d.home, APPROVAL_FILE));
    assert.equal(run(['compare', d.before, d.after], d.dir, d.home).code, 2);
  });

  it('--before-repeat finds a flaky test; --before-root and --after-root align reports made in two folders', () => {
    const s = setup(junit(BASE));
    writeFileSync(join(s.dir, 'before2.xml'), junit([{ name: 'alpha sorts', status: 'fail' }, ...BASE.slice(1)]));
    const r = run(['compare', s.before, s.after, '--before-repeat', 'before2.xml'], s.dir, s.home);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /Flaky .*: 1\n {2}~ demo\.WidgetTest > alpha sorts/);
    const one = '<testsuites><testcase name="a" file="/w/one/t/x.js"/></testsuites>';
    const two = '<testsuites><testcase name="a" file="/w/two/t/x.js"/></testsuites>';
    const f = setup(two, one);
    const raw = run(['compare', f.before, f.after], f.dir, f.home);
    assert.equal(raw.code, 1);
    assert.match(raw.stdout, /No test name is in both reports/);
    const aligned = run(['compare', f.before, f.after, '--before-root', '/w/one', '--after-root=/w/two'], f.dir, f.home);
    assert.equal(aligned.code, 0, aligned.stdout);
  });

  it('usage errors exit 64', () => {
    const s = setup(junit(BASE));
    for (const args of [[], ['diff'], ['compare'], ['compare', s.before], ['compare', s.before, s.after, 'extra'], ['compare', '--bogus', s.before, s.after], ['compare', '--format', 'tap', s.before, s.after], ['compare', s.before, s.after, '--before-root']]) {
      const r = run(args, s.dir, s.home);
      assert.equal(r.code, 64, `${args.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, /Usage:/);
    }
  });

  it('help names the command', () => {
    const s = setup(junit(BASE));
    const r = run(['compare', '--help'], s.dir, s.home);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /openmorals tests compare <before> <after>/);
  });
});

describe('tests compare: the approval file is out of an agent\'s reach', () => {
  it('an agent writing the approval file in the config directory is not allowed (self-protect)', () => {
    const home = tempDir('tc-sp');
    for (const path of [join(home, APPROVAL_FILE), `/home/someone/.config/openmorals/${APPROVAL_FILE}`]) {
      const v = decide({ kind: 'write', path, tool: 'Write' }, DEFAULT_BYLAWS, EMPTY_STATE, undefined, { configDir: home, home: '/home/someone' });
      assert.notEqual(v.decision, 'allow', `${path}: ${v.rule}`);
      const sh = decide({ kind: 'exec', command: `echo "gone x > y" >> ${path}`, shell: 'posix', tool: 'Bash' }, DEFAULT_BYLAWS, EMPTY_STATE, undefined, { configDir: home, home: '/home/someone' });
      assert.notEqual(sh.decision, 'allow', `shell append to ${path}: ${sh.rule}`);
    }
  });
});
