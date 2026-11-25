import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { decideCall } from '../src/adapters/claude-code.js';
import { DEFAULT_BYLAWS, effectiveBylaws, overFloor, resolveBylaws, validateBylaws } from '../src/bylaws.js';
import type { Case, CaseFile } from '../src/eval/cases.js';
import { caseBylaws } from '../src/eval/cases.js';
import { runEval, scoreCases } from '../src/eval/index.js';
import type { EvalReport } from '../src/eval/index.js';
import { packSummary, PACK_NAMES, readPackText } from '../src/packs/load.js';
import { loadCaseFiles } from './case-loader.js';
import { REPO_ROOT, tempDir } from './helpers.js';

/** U11 (0.26.0): the information-security and outward-actions packs, their case tables, per-pack scores and costs. */

const CLI = join(REPO_ROOT, 'dist', 'src', 'cli.js');
const WAVE1 = ['information-security', 'outward-actions'] as const;
type Wave1 = (typeof WAVE1)[number];

/**
 * What each pack costs an ordinary session: the benign (`expect: allow`) rows of every OTHER case file that ask or
 * refuse once the pack is laid over the row's own policy as a project file (what `init --pack` makes). Pinned here
 * so docs/packs/<name>.md, which lists the rows, cannot drift: change the pack or the rows, then update both.
 */
const COST: Record<Wave1, number> = { 'information-security': 4, 'outward-actions': 3 };

interface RawRule {
  id: string;
}
interface RawPrinciple {
  id: string;
  checked_by?: string[];
  advisory?: string;
}
interface RawPack {
  rules: RawRule[];
  principles: RawPrinciple[];
  [k: string]: unknown;
}

function packText(name: string): string {
  const t = readPackText(name);
  assert.ok(t.ok, t.ok ? '' : t.error);
  return t.text;
}

function rawPack(name: string): RawPack {
  return parseYaml(packText(name), { maxAliasCount: 50 }) as RawPack;
}

function packFile(name: string): CaseFile {
  const f = loadCaseFiles().find((x) => x.guard === name);
  assert.ok(f !== undefined, `cases/${name}.cases.yaml`);
  return f;
}

/** The pack with one rule removed, and that rule's id dropped from every principle (a principle left naming nothing goes too). */
function withoutRule(name: string, id: string): RawPack {
  const raw = JSON.parse(JSON.stringify(rawPack(name))) as RawPack;
  raw.rules = raw.rules.filter((r) => r.id !== id);
  raw.principles = raw.principles
    .map((p) => (p.checked_by !== undefined ? { ...p, checked_by: p.checked_by.filter((x) => x !== id) } : p))
    .filter((p) => p.checked_by === undefined || p.checked_by.length > 0);
  return raw;
}

function score(file: CaseFile): EvalReport {
  const r = scoreCases({ source: 'packs-wave1', guardFiles: [file], inbound: [], diffClass: [] }, { repetitions: 0 });
  assert.ok(r.ok, r.ok ? '' : r.error);
  return r.value;
}

/** Benign rows of the other case files that ask or refuse with the pack laid over the row's policy as a project file. */
function packCost(name: string): { file: string; index: number; line: number | null; label: string; decision: string; rule: string }[] {
  const raw = rawPack(name);
  const out: { file: string; index: number; line: number | null; label: string; decision: string; rule: string }[] = [];
  for (const f of loadCaseFiles()) {
    if (f.guard === name) continue;
    f.cases.forEach((c: Case, i: number) => {
      if (c.expect !== 'allow') return;
      const base = caseBylaws(c, `${f.file}[${i}]`);
      assert.ok(base.ok, `${f.file}[${i}]`);
      const floor = effectiveBylaws(base);
      const over = overFloor(validateBylaws(raw, `pack:${name}`, floor, true), floor, base.source);
      assert.ok(over.ok, `${name} over ${f.file}[${i}]: ${over.ok ? '' : over.error}`);
      const v = decideCall(c.tool, c.actions, over, c.state, undefined, c.where);
      if (v.decision !== 'allow') out.push({ file: f.file, index: i, line: c.line, label: c.label, decision: v.decision, rule: v.rule });
    });
  }
  return out;
}

describe('packs wave 1: the two pack files', () => {
  it('are shipped, listed and valid, with principles split into checked and advice only', () => {
    for (const name of WAVE1) {
      assert.ok((PACK_NAMES as readonly string[]).includes(name), name);
      const s = packSummary(packText(name), name);
      assert.ok(s.ok, s.ok ? '' : s.error);
      assert.ok(s.checked.length >= 5 && s.advisory.length >= 4, `${name}: ${s.checked.length} checked, ${s.advisory.length} advice only`);
      const ids = new Set(rawPack(name).rules.map((r) => r.id));
      for (const r of ids) assert.ok(s.checked.some((p) => (p.checked_by ?? []).includes(r)), `${name}: rule ${r} checks no principle`);
    }
  });
  it('say in the first line and the disclaimer that they are not a certification, an audit or legal advice, and claim no standard', () => {
    for (const name of WAVE1) {
      const text = packText(name);
      const first = text.split('\n', 1)[0] ?? '';
      assert.match(first, new RegExp(`^# pack: ${name} - .*not a certification, an audit or legal advice\\.$`));
      const s = packSummary(text, name);
      assert.ok(s.ok && s.disclaimer !== null);
      assert.match(s.disclaimer, /^Not a certification, an audit or legal advice\. /);
      assert.match(s.disclaimer, /not that (the work is secure|no harm was done)\.$/);
      assert.doesNotMatch(text, /\b(compliant|compliance|certified|do no harm|HIPAA|GDPR|62304)\b/i);
    }
  });
  it('only add asks: every rule asks, and every guard they list is at the built-in default', () => {
    for (const name of WAVE1) {
      const load = validateBylaws(parseYaml(packText(name)), name);
      assert.ok(load.ok, load.ok ? '' : load.error);
      for (const r of load.bylaws.rules) assert.equal(r.decision, 'ask', `${name} ${r.id}`);
      const { rules: _r, disclaimers: _d, ...guardsAndRest } = load.bylaws;
      const { rules: _dr, ...defaults } = DEFAULT_BYLAWS;
      assert.deepEqual(guardsAndRest, defaults, `${name}: a listed guard differs from the default`);
    }
  });
});

describe('packs wave 1: case tables', () => {
  for (const name of WAVE1) {
    it(`${name}: every rule has rows only it catches and at least two benign rows in its section, and a pack-off row`, () => {
      const text = readFileSync(join(REPO_ROOT, 'cases', `${name}.cases.yaml`), 'utf8');
      const ids = rawPack(name).rules.map((r) => r.id);
      const sections = new Map<string, { catching: number; benign: number; off: number }>();
      let current: string[] = [];
      for (const line of text.split('\n')) {
        const head = /^ {2}# (.*)$/.exec(line);
        if (head !== null) {
          current = ids.filter((id) => new RegExp(`\\b${id}\\b`).test(head[1] ?? ''));
          continue;
        }
        if (!line.startsWith('  - {')) continue;
        for (const id of current) {
          const s = sections.get(id) ?? { catching: 0, benign: 0, off: 0 };
          if (line.includes(`rule: rules.${id} `)) s.catching++;
          if (line.includes(`pack: ${name},`) && line.includes('expect: allow')) s.benign++;
          sections.set(id, s);
        }
      }
      const f = packFile(name);
      for (const id of ids) {
        const s = sections.get(id);
        assert.ok(s !== undefined, `${name}: no section headed with ${id}`);
        assert.ok(s.catching >= 3, `${name} ${id}: ${s.catching} catching rows`);
        assert.ok(s.benign >= 2, `${name} ${id}: ${s.benign} benign rows`);
        const caught = f.cases.filter((c) => c.rule === `rules.${id}`).map((c) => c.label);
        const off = f.cases.filter((c) => c.pack === null && c.expect === 'allow' && caught.includes(c.label));
        assert.ok(off.length >= 1, `${name} ${id}: no row showing a caught call allowed with the pack off`);
      }
    });
  }
});

describe('packs wave 1: per-pack scores', () => {
  const r = runEval({ repetitions: 2 });
  const report = r.report as EvalReport;
  it('the scorer publishes each pack\'s catch and false-alarm counts: every row caught, no false alarm', () => {
    assert.equal(r.exitCode, 0, r.stdout);
    for (const name of WAVE1) {
      const p = report.packs.find((x) => x.pack === name);
      assert.ok(p !== undefined, name);
      const rows = packFile(name).cases.filter((c) => c.pack === name);
      assert.equal(p.rows, rows.length);
      assert.equal(p.blocking, rows.filter((c) => c.expect !== 'allow').length);
      assert.equal(p.caught, p.blocking);
      assert.equal(p.falseAlarms, 0);
      assert.equal(p.ruleMismatches, 0);
      assert.ok(p.blocking >= 30 && p.allowing >= 25, `${name}: ${p.blocking} blocking, ${p.allowing} benign`);
      assert.deepEqual(p.files, [`${name}.cases.yaml`]);
      assert.ok(p.p50Ms !== null && p.p95Ms !== null && p.p50Ms <= p.p95Ms);
      assert.match(r.stdout, new RegExp(`^pack ${name} .*: ${p.rows} rows; caught ${p.caught}/${p.blocking} \\(100\\.0%\\); false alarms 0/${p.allowing} \\(0\\.0%\\)`, 'm'));
    }
    const lock = report.packs.find((x) => x.pack === 'test-lock');
    assert.ok(lock !== undefined && lock.caught === lock.blocking && lock.falseAlarms === 0);
  });
  it('a wrong row judged under a pack shows in that pack\'s counts: a miss and a false alarm are not hidden', () => {
    const dir = tempDir('w1-wrong');
    writeFileSync(
      join(dir, 'mine.cases.yaml'),
      [
        'guard: mine',
        'cases:',
        '  - { pack: outward-actions, cmd: "npm publish", expect: ask, rule: rules.out-publish }',
        '  - { pack: outward-actions, cmd: "gh pr list", expect: ask, note: "deliberately wrong: a miss" }',
        '  - { pack: outward-actions, cmd: "npm publish", expect: allow, note: "deliberately wrong: a false alarm" }',
        '  - { pack: outward-actions, cmd: "gh pr view 1", expect: allow }',
        '  - { cmd: "npm publish", expect: allow, note: "pack off" }',
        '',
      ].join('\n'),
    );
    const rep = runEval({ cases: dir, repetitions: 0 }).report as EvalReport;
    const p = rep.packs.find((x) => x.pack === 'outward-actions');
    assert.ok(p !== undefined);
    assert.deepEqual([p.rows, p.caught, p.blocking, p.falseAlarms, p.allowing, p.wrong], [4, 1, 2, 1, 2, 2]);
    assert.equal(p.catchRate, 0.5);
    assert.equal(p.falseAlarmRate, 0.5);
    assert.deepEqual(rep.packs.map((x) => x.pack), ['outward-actions']);
  });
  it('the pack view only regroups rows: the guard lines and the total are what they were', () => {
    for (const name of WAVE1) {
      const g = report.guards.find((x) => x.guard === name);
      const p = report.packs.find((x) => x.pack === name);
      assert.ok(g !== undefined && p !== undefined);
      assert.equal(g.rows - p.rows, packFile(name).cases.filter((c) => c.pack === null).length);
    }
    assert.equal(report.total.rows, report.guards.reduce((n, g) => n + g.rows, 0));
  });
});

describe('packs wave 1: removal test, one rule at a time', () => {
  for (const name of WAVE1) {
    for (const id of rawPack(name).rules.map((r) => r.id)) {
      it(`${name}: deleting ${id} makes every one of its catching rows fail, and only those`, () => {
        const f = packFile(name);
        const cut = withoutRule(name, id);
        assert.ok(validateBylaws(cut, `${name} without ${id}`).ok);
        const changed: CaseFile = { ...f, cases: f.cases.map((c) => (c.pack === name ? { ...c, bylaws: cut } : c)) };
        const wrong = score(changed).wrong;
        const mine = f.cases.map((c, i) => [c, i] as const).filter(([c]) => c.rule === `rules.${id}`).map(([, i]) => i);
        assert.ok(mine.length >= 3, `${id}: ${mine.length} catching rows`);
        assert.deepEqual(wrong.map((w) => w.index).sort((a, b) => a - b), mine, `${id}: rows that failed`);
        assert.ok(wrong.every((w) => w.kind === 'missed'), `${id}: a catching row was still caught by something else: ${JSON.stringify(wrong.filter((w) => w.kind !== 'missed'))}`);
        assert.ok(score(f).ok, 'the shipped pack still passes');
      });
    }
  }
});

describe('packs wave 1: off by default, and what each pack costs', () => {
  it('no pack is in force unless chosen: the defaults and an empty config folder carry none of their rules', () => {
    const ids = WAVE1.flatMap((n) => rawPack(n).rules.map((r) => r.id));
    assert.deepEqual(DEFAULT_BYLAWS.rules, []);
    const load = resolveBylaws(tempDir('w1-cwd'), { OPENMORALS_HOME: tempDir('w1-home') });
    assert.ok(load.ok);
    assert.ok(!load.bylaws.rules.some((r) => ids.includes(r.id)));
    assert.equal(load.bylaws.disclaimers, undefined);
  });
  for (const name of WAVE1) {
    it(`${name}: the benign rows of the other case files that ask once it is laid over them number exactly as documented`, () => {
      const cost = packCost(name);
      assert.equal(cost.length, COST[name], `${name} now asks on ${cost.length} benign rows of other tables (update COST and docs/packs/<name>.md):\n${cost.map((c) => `${c.file}[${c.index}] ${c.decision} ${c.rule}: ${c.label}`).join('\n')}`);
      const benign = loadCaseFiles().filter((f) => f.guard !== name).reduce((n, f) => n + f.cases.filter((c) => c.expect === 'allow').length, 0);
      const doc = readFileSync(join(REPO_ROOT, 'docs', 'packs', `${name}.md`), 'utf8');
      assert.ok(doc.includes(`asks or refuses on ${COST[name]} of the ${benign} benign rows`), `docs/packs/${name}.md states the count (${COST[name]} of ${benign})`);
    });
  }
});

describe('packs wave 1: the CLI', () => {
  function cli(args: string[], cwd: string, home: string): { code: number | null; stdout: string; stderr: string } {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd, env: { ...process.env, OPENMORALS_HOME: home, OPENMORALS_UNATTENDED: '' } });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  }
  for (const name of WAVE1) {
    it(`${name}: packs show prints both lists and the disclaimer; init --pack writes it and validate accepts it`, () => {
      const home = tempDir('w1-cli-home');
      const dir = tempDir('w1-cli');
      const show = cli(['packs', 'show', name], dir, home);
      assert.equal(show.code, 0, show.stderr);
      assert.match(show.stdout, /^checked \(\d+\): /m);
      assert.match(show.stdout, /^advice only, not checked \(\d+\): /m);
      assert.match(show.stdout, /^disclaimer:\n {2}Not a certification, an audit or legal advice\./m);
      const init = cli(['init', dir, '--pack', name], dir, home);
      assert.equal(init.code, 0, init.stderr);
      assert.equal(readFileSync(join(dir, 'openmorals.yaml'), 'utf8'), packText(name));
      const v = cli(['validate', join(dir, 'openmorals.yaml')], dir, home);
      assert.equal(v.code, 0, v.stdout + v.stderr);
    });
  }
});
