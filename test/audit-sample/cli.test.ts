import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_BYLAWS } from '../../src/bylaws.js';
import { decide } from '../../src/engine.js';
import { SAMPLE_EMPTY_EXIT, SAMPLE_SETTINGS_FILE, SAMPLE_UNREADABLE_EXIT, sampleCommand } from '../../src/sample/command.js';
import { SAMPLE_LIMITS, SAMPLE_RULES, drawPicks } from '../../src/sample/draw.js';
import { unattendedVerdict } from '../../src/session.js';
import { EMPTY_STATE } from '../../src/types.js';
import { REPO_ROOT, tempDir } from '../helpers.js';
import type { Rec } from './fixtures.js';
import { NOW, buildLog, fixedRandom, runs, seedHex } from './fixtures.js';

const CLI = join(REPO_ROOT, 'dist', 'src', 'cli.js');

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function cli(args: string[], home: string, cwd = tempDir('as-cwd')): Run {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd, env: { ...process.env, OPENMORALS_HOME: home, OPENMORALS_UNATTENDED: '', OPENMORALS_RUN: '' } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function home(recs: readonly Rec[] | null, settings?: string): string {
  const h = tempDir('as-home');
  if (recs !== null) writeFileSync(join(h, 'audit.jsonl'), buildLog(recs));
  if (settings !== undefined) writeFileSync(join(h, SAMPLE_SETTINGS_FILE), settings);
  return h;
}

function logLines(h: string): string[] {
  return readFileSync(join(h, 'audit.jsonl'), 'utf8').split('\n').filter((l) => l !== '');
}

function listAll(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).sort();
}

describe('openmorals audit sample (command, injected random source)', () => {
  it('the draw printed and recorded is the one the injected seed gives; the population is in the record', () => {
    const h = home(runs(8));
    const r = sampleCommand(['--json'], { env: { OPENMORALS_HOME: h }, now: () => NOW, random: fixedRandom(seedHex(0x5a)) });
    assert.equal(r.exitCode, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { seed: string; population: string[]; drawn: string[]; rate: number; limits: string[] };
    assert.equal(out.seed, seedHex(0x5a));
    assert.equal(out.rate, 10);
    assert.deepEqual(out.population, ['run-01', 'run-02', 'run-03', 'run-04', 'run-05', 'run-06', 'run-07', 'run-08']);
    assert.deepEqual(out.drawn, drawPicks(out.population, 10, seedHex(0x5a)));
    assert.deepEqual(out.limits, [...SAMPLE_LIMITS]);
    const last = JSON.parse(logLines(h).at(-1) ?? '{}') as { rule: string; session: string; sample: { seed: string; population: string[]; picks: string[]; rate: number; method: string } };
    assert.equal(last.rule, SAMPLE_RULES.draw);
    assert.equal(last.session, 'audit-sample');
    assert.equal(last.sample.seed, seedHex(0x5a));
    assert.deepEqual(last.sample.population, out.population);
    assert.equal(last.sample.rate, 10);
  });

  it('same run ids, records in another order and with other agent-written fields: the same seed gives the same picks', () => {
    for (const seed of [seedHex(1), seedHex(0x33), seedHex(0xc4)]) {
      const a = home(runs(15));
      const b = home([...runs(15, { tool: 'Edit', action: (i) => `tests/t${i}.ts`, agent: 'sub-agent-9', cwd: '/srv/x' })].reverse());
      const opts = (h: string) => ({ env: { OPENMORALS_HOME: h, OPENMORALS_RUN: '' }, now: () => NOW, random: fixedRandom(seed) });
      const ra = JSON.parse(sampleCommand(['--json', '--by', 'run'], { ...opts(a) }).stdout) as { drawn: string[] };
      const rb = JSON.parse(sampleCommand(['--json', '--by', 'run'], { ...opts(b) }).stdout) as { drawn: string[] };
      assert.deepEqual(rb.drawn, ra.drawn);
    }
  });

  it('a random source that gives fewer than 32 bytes draws nothing and writes nothing', () => {
    const h = home(runs(3));
    const before = logLines(h).length;
    const r = sampleCommand([], { env: { OPENMORALS_HOME: h }, now: () => NOW, random: () => Buffer.alloc(4) });
    assert.equal(r.exitCode, SAMPLE_UNREADABLE_EXIT);
    assert.equal(logLines(h).length, before);
  });
});

describe('openmorals audit sample (built CLI)', () => {
  it('no log: exit 3, says so, writes nothing', () => {
    const h = home(null);
    const r = cli(['audit', 'sample'], h);
    assert.equal(r.code, SAMPLE_EMPTY_EXIT, r.stderr);
    assert.match(r.stderr, /no audit log at .*nothing to draw from/);
    assert.deepEqual(listAll(h), []);
  });

  it('a draw at 1 in 1 picks every finished run, records the draw, keeps the log verifiable; the next draw has nothing new (exit 3)', () => {
    const h = home(runs(3), 'rate: 1\n');
    const r = cli(['audit', 'sample'], h);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /picked 3 of 3 finished runs at 1 in 1/);
    assert.match(r.stdout, /run:run-01 {2}4 records in 2 sessions/);
    assert.match(r.stdout, /more: openmorals audit --run run-01/);
    assert.match(r.stdout, /--record run:<id> clean\|escape/);
    for (const l of SAMPLE_LIMITS) assert.ok(r.stdout.includes(l), l);
    assert.equal(cli(['audit', 'verify'], h).code, 0);
    const again = cli(['audit', 'sample'], h);
    assert.equal(again.code, SAMPLE_EMPTY_EXIT);
    assert.match(again.stderr, /3 runs already considered by an earlier draw/);
  });

  it('an unreadable log: exit 2, nothing drawn, nothing written', () => {
    const h = tempDir('as-home');
    mkdirSync(join(h, 'audit.jsonl'));
    const r = cli(['audit', 'sample'], h);
    assert.equal(r.code, SAMPLE_UNREADABLE_EXIT, r.stdout);
    assert.match(r.stderr, /cannot read/);
    assert.deepEqual(listAll(h), ['audit.jsonl']);
  });

  it('a log that does not verify: exit 1, the unit is picked and named, not left out', () => {
    const h = home(runs(4), 'rate: 1000\n');
    const lines = logLines(h);
    lines[4] = (lines[4] ?? '').replace('npm test', 'npm tset');
    writeFileSync(join(h, 'audit.jsonl'), `${lines.join('\n')}\n`);
    const r = cli(['audit', 'sample', '--json'], h);
    assert.equal(r.code, 1, r.stderr);
    const out = JSON.parse(r.stdout) as { population: string[]; forced: string[]; picks: { id: string; problems: unknown[] }[]; record: { ok: boolean } };
    assert.equal(out.population.length, 4);
    const edited = out.picks.find((u) => u.id === 'run-02');
    assert.ok(edited !== undefined && edited.problems.length > 0, r.stdout);
    assert.ok(out.forced.every((u) => u === 'run-02'), JSON.stringify(out.forced));
    assert.equal(out.record.ok, false);
  });

  it('an invalid settings file: exit 2, nothing written; there is no command-line N', () => {
    const h = home(runs(2), 'rate: 0\n');
    const r = cli(['audit', 'sample'], h);
    assert.equal(r.code, SAMPLE_UNREADABLE_EXIT);
    assert.match(r.stderr, /rate must be a whole number/);
    assert.equal(logLines(h).length, 8);
    const flag = cli(['audit', 'sample', '--rate', '1'], home(runs(2)));
    assert.equal(flag.code, 64);
    assert.match(flag.stderr, /unknown option --rate/);
  });

  it('records no run id: the run population is empty (exit 3) and says how to draw sessions', () => {
    const h = home([{ session: 's1', ts: '2026-01-01T00:00:00.000Z' }]);
    const r = cli(['audit', 'sample'], h);
    assert.equal(r.code, SAMPLE_EMPTY_EXIT);
    assert.match(r.stderr, /carry no run id \(draw sessions with --by session\)/);
    const s = cli(['audit', 'sample', '--by', 'session'], h);
    assert.equal(s.code, 0, s.stderr);
  });

  it('verdicts, the tally, and reading everything after an escape', () => {
    const h = home(runs(2), 'rate: 1\nread_all_next: 2\n');
    assert.equal(cli(['audit', 'sample'], h).code, 0);
    const notPicked = cli(['audit', 'sample', '--record', 'run:run-09', 'clean', 'looked fine'], h);
    assert.equal(notPicked.code, 1);
    assert.match(notPicked.stderr, /was not picked by any draw/);
    const noWhy = cli(['audit', 'sample', '--record', 'run:run-01', 'clean'], h);
    assert.equal(noWhy.code, 64);
    const ok = cli(['audit', 'sample', '--record', 'run:run-01', 'clean', 'read the diff, tests named the change'], h);
    assert.equal(ok.code, 0, ok.stderr);
    const esc = cli(['audit', 'sample', '--record', 'run-02', 'escape', 'a test was skipped and nothing flagged it'], h);
    assert.equal(esc.code, 0, esc.stderr);
    assert.match(esc.stdout, /read everything/);
    const t = cli(['audit', 'sample', '--tally'], h);
    assert.equal(t.code, 0, t.stdout);
    assert.match(t.stdout, /draws: 1 \(1 by run, 0 by session\); units considered: 2; picked: 2/);
    assert.match(t.stdout, /verdicts: 2 of 2 picks \(100%\): 1 clean, 1 escape/);
    assert.match(t.stdout, /escapes: 1 of 2 verdicts \(50%\)/);
    assert.match(t.stdout, /next draw: reads everything \(2 more units after the escape recorded for run:run-02/);
    const tj = JSON.parse(cli(['audit', 'sample', '--tally', '--json'], h).stdout) as { escape_rate: number; verdicts: { escape: number }; next: { read_all: boolean } };
    assert.equal(tj.escape_rate, 0.5);
    assert.equal(tj.next.read_all, true);
    assert.equal(cli(['audit', 'verify'], h).code, 0, 'verdict lines are chained too');
  });

  it('--change records a declared change; the next draw reads everything', () => {
    const h = home(runs(2), 'rate: 1000\nread_all_next: 5\n');
    const c = cli(['audit', 'sample', '--change', 'model changed'], h);
    assert.equal(c.code, 0, c.stderr);
    const d = JSON.parse(cli(['audit', 'sample', '--json'], h).stdout) as { rate: number; read_all: boolean; picks: unknown[] };
    assert.equal(d.read_all, true);
    assert.equal(d.rate, 1);
    assert.equal(d.picks.length, 2);
  });

  it('--tally writes nothing and reads another log with --file', () => {
    const h = home(runs(2));
    const other = join(tempDir('as-other'), 'copy.jsonl');
    writeFileSync(other, buildLog(runs(1)));
    const before = listAll(h);
    const r = cli(['audit', 'sample', '--tally', '--file', other], h);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /draws: 0/);
    assert.deepEqual(listAll(h), before);
  });

  const bad: string[][] = [
    ['--tally', '--record', 'run:x', 'clean', 'y'],
    ['--record', 'run:x', 'fine', 'y'],
    ['--file', 'x.jsonl'],
    ['--by', 'agent'],
    ['--change'],
    ['extra'],
    ['--record', 'run:x', 'clean', 'y', '--json'],
  ];
  for (const args of bad) {
    it(`audit sample ${args.join(' ')} is a usage error (64) that writes nothing`, () => {
      const h = home(null);
      const r = cli(['audit', 'sample', ...args], h);
      assert.equal(r.code, 64, `${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /Usage:/);
      assert.deepEqual(listAll(h), []);
    });
  }
});

describe('an agent cannot draw, judge or declare through the plain command: self-protect asks', () => {
  const where = { configDir: '/home/someone/.config/openmorals', home: '/home/someone' };
  const judge = (command: string) => decide({ kind: 'exec', command, shell: 'posix', tool: 'Bash' }, DEFAULT_BYLAWS, EMPTY_STATE, undefined, where);

  for (const c of [
    'openmorals audit sample --record run:run-01 clean "looked fine"',
    'openmorals audit sample --record=run:run-01 escape why',
    'openmorals audit sample',
    'openmorals audit sample --by session --json',
    'openmorals audit sample --change "new model"',
    'openmorals audit sample --record run:run-01 clean -- --tally',
    'cd /tmp && openmorals audit sample --record run:run-01 clean ok',
    'npx openmorals audit sample --record run:run-01 clean ok',
    'npx --yes openmorals@0.11.0 audit sample --change x',
    'npx -p openmorals openmorals audit sample',
    'pnpm dlx openmorals audit sample --record run:run-01 clean ok',
    'npm exec openmorals -- audit sample --record run:run-01 clean ok',
    'bunx openmorals audit sample',
    'python3 -m openmorals audit sample --record run:run-01 clean ok',
    'npx openmorals init',
    'python -m openmorals purge --older-than 1 --yes',
  ]) {
    it(`asks: ${c}`, () => {
      const v = judge(c);
      assert.equal(v.decision, 'ask', v.reason);
      assert.equal(v.rule, 'self-protect.write');
    });
  }

  for (const c of ['openmorals audit sample --tally', 'openmorals audit sample --tally --json', 'openmorals audit sample --help', 'openmorals audit verify', 'openmorals audit --run nightly', 'npx openmorals audit sample --tally', 'python3 -m openmorals check "ls"', 'npx prettier --write audit sample', 'npm exec eslint -- audit sample']) {
    it(`does not ask: ${c}`, () => {
      assert.notEqual(judge(c).rule, 'self-protect.write');
    });
  }

  it('unattended, an agent-run verdict is denied', () => {
    assert.equal(unattendedVerdict(judge('openmorals audit sample --record run:run-01 clean fine')).decision, 'deny');
  });

  it('the settings file is in the config directory, so an agent writing it is asked about', () => {
    const v = decide({ kind: 'write', path: `${where.configDir}/${SAMPLE_SETTINGS_FILE}`, tool: 'Write' }, DEFAULT_BYLAWS, EMPTY_STATE, undefined, where);
    assert.equal(v.decision, 'ask', v.reason);
    assert.equal(v.rule, 'self-protect.write');
  });
});
