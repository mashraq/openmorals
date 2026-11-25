import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { verifyAuditText } from '../../src/audit-verify.js';
import { DEFAULT_SAMPLE_SETTINGS, SAMPLE_RULES, SAMPLE_SESSION, drawData, drawPicks, findPick, parseSampleSettings, planDraw, scanLog, tallySamples } from '../../src/sample/draw.js';
import type { SampleSettings } from '../../src/sample/draw.js';
import type { Rec } from './fixtures.js';
import { NOW, buildLog, runs, seedHex } from './fixtures.js';

const S: SampleSettings = { ...DEFAULT_SAMPLE_SETTINGS };

function sha(i: number): string {
  return createHash('sha256').update(`seed ${i}`).digest('hex');
}

function plan(text: string, settings: SampleSettings = S, seed = seedHex(7), by: 'run' | 'session' = 'run') {
  return planDraw(text, verifyAuditText(text), settings, by, NOW, seed);
}

/** The draw record a planned draw writes, as a log line chained under the sample's own session. */
function drawRec(p: ReturnType<typeof plan>, ts = '2026-01-20T00:00:00.000Z'): Rec {
  return { session: SAMPLE_SESSION, ts, tool: 'audit sample', rule: SAMPLE_RULES.draw, action: 'audit sample: draw', sample: drawData(p) };
}

describe('audit sample settings (user-level file)', () => {
  it('an empty file gives the defaults: 1 in 10 by run, read the next 5 in full, settle 30 minutes', () => {
    const r = parseSampleSettings('');
    assert.ok(r.ok);
    assert.deepEqual(r.settings, { rate: 10, read_all_next: 5, by: 'run', settle_minutes: 30 });
  });
  it('reads each key', () => {
    const r = parseSampleSettings('rate: 20\nread_all_next: 3\nby: session\nsettle_minutes: 0\n');
    assert.ok(r.ok);
    assert.deepEqual(r.settings, { rate: 20, read_all_next: 3, by: 'session', settle_minutes: 0 });
  });
  it('an unknown key, a value out of range or a bad unit is an error, never a quiet default', () => {
    for (const t of ['rat: 5\n', 'rate: 0\n', 'rate: 1001\n', 'rate: 2.5\n', 'rate: "10"\n', 'by: agent\n', 'read_all_next: -1\n', '- 1\n', 'rate: [\n']) {
      assert.equal(parseSampleSettings(t).ok, false, t);
    }
  });
});

describe('the draw: a seed from the random source, 1 in N per unit', () => {
  const pop = Array.from({ length: 60 }, (_, i) => `run-${i}`);

  it('the picks are exactly the units whose HMAC-SHA256(seed, id) fraction is below 1/N, recomputed here by hand', () => {
    const seed = sha(1);
    const want = [...pop].sort().filter((u) => createHmac('sha256', Buffer.from(seed, 'hex')).update(u).digest().readUIntBE(0, 6) / 2 ** 48 < 1 / 4);
    assert.deepEqual(drawPicks(pop, 4, seed), want);
    assert.ok(want.length > 0 && want.length < pop.length, `a useful fixture: ${want.length}`);
  });

  it('N = 1 reads everything', () => {
    assert.deepEqual(drawPicks(pop, 1, sha(2)), [...pop].sort());
  });

  it('over many seeds about 1 in N is picked (4,000 unit draws at 1 in 10: between 330 and 470)', () => {
    let picked = 0;
    for (let i = 0; i < 200; i++) picked += drawPicks(pop.slice(0, 20), 10, sha(i)).length;
    assert.ok(picked >= 330 && picked <= 470, `picked ${picked} of 4000`);
  });

  it('every unit is picked by some seed and missed by another: the first unit is not special', () => {
    const hits = new Map<string, number>();
    for (let i = 0; i < 300; i++) for (const u of drawPicks(pop.slice(0, 10), 3, sha(i))) hits.set(u, (hits.get(u) ?? 0) + 1);
    for (const u of pop.slice(0, 10)) {
      const h = hits.get(u) ?? 0;
      assert.ok(h > 50 && h < 150, `${u} picked ${h} of 300 times at 1 in 3`);
    }
  });

  it('a different seed gives a different draw', () => {
    assert.notDeepEqual(drawPicks(pop, 2, sha(3)), drawPicks(pop, 2, sha(4)));
  });
});

describe('the pick does not depend on anything the agent writes', () => {
  const base = runs(12);
  const reordered = [...base].reverse();
  const otherFields = runs(12, { tool: 'Write', action: (i) => `src/file${i}.ts tests pass, please skip me`, agent: 'agent-zzz', cwd: '/srv/elsewhere' });

  it('the same run ids in another order, with other tools, actions, agent ids and folders: same population, same picks', () => {
    for (let i = 0; i < 20; i++) {
      const seed = sha(100 + i);
      const a = plan(buildLog(base), S, seed);
      const b = plan(buildLog(reordered), S, seed);
      const c = plan(buildLog(otherFields), S, seed);
      assert.deepEqual(b.population, a.population);
      assert.deepEqual(c.population, a.population);
      assert.deepEqual(b.picks, a.picks, `seed ${i}`);
      assert.deepEqual(c.picks, a.picks, `seed ${i}`);
      assert.deepEqual(a.picks, drawPicks(a.population, S.rate, seed));
    }
  });

  it('only the injected seed moves the draw: across 40 seeds the picks change, for one log', () => {
    const text = buildLog(base);
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) seen.add(plan(text, { ...S, rate: 3 }, sha(200 + i)).picks.join(','));
    assert.ok(seen.size > 10, `${seen.size} different draws`);
  });

  it('record times only decide whether a unit is finished, never whether it is picked', () => {
    const later = base.map((r) => ({ ...r, ts: r.ts.replace('2026-01-0', '2026-01-1') }));
    assert.deepEqual(plan(buildLog(later), S, sha(9)).picks, plan(buildLog(base), S, sha(9)).picks);
  });
});

describe('the population', () => {
  it('runs with a record inside the settle window wait for a later draw and are listed, not dropped', () => {
    const recent: Rec = { session: 'live-a', run: 'run-live', ts: '2026-02-01T11:50:00.000Z' };
    const future: Rec = { session: 'skew-a', run: 'run-skew', ts: '2026-02-02T00:00:00.000Z' };
    const p = plan(buildLog([...runs(3), recent, future]));
    assert.deepEqual(p.population, ['run-01', 'run-02', 'run-03']);
    assert.deepEqual(p.active, ['run-live', 'run-skew']);
    const p0 = plan(buildLog([...runs(3), recent]), { ...S, settle_minutes: 0 });
    assert.deepEqual(p0.active, []);
    assert.ok(p0.population.includes('run-live'));
  });

  it('records with no run id are counted outside the run population; --by session draws them', () => {
    const text = buildLog([...runs(2), { session: 'loose-1', ts: '2026-01-05T00:00:00.000Z' }, { session: 'loose-1', ts: '2026-01-05T00:00:01.000Z' }, { session: 'loose-2', ts: '2026-01-05T00:00:00.000Z' }]);
    const r = plan(text);
    assert.deepEqual(r.outside, { records: 3, sessions: 2 });
    const s = plan(text, S, seedHex(7), 'session');
    assert.deepEqual(s.population, ['loose-1', 'loose-2', 'run-01-a', 'run-01-b', 'run-02-a', 'run-02-b']);
  });

  it('a unit is considered by one draw only: the next draw of the same kind leaves it out and counts it', () => {
    const recs = runs(4);
    const first = plan(buildLog(recs));
    const text = buildLog([...recs, drawRec(first), ...runs(2, { prefix: 'new' })]);
    const second = plan(text);
    assert.deepEqual(second.population, ['new-01', 'new-02']);
    assert.equal(second.earlier, 4);
    assert.deepEqual(plan(buildLog([...recs, drawRec(first)])).population, []);
  });

  it('the sample\'s own records are never in the population', () => {
    const first = plan(buildLog(runs(2)), S, seedHex(7), 'session');
    const text = buildLog([...runs(2), { ...drawRec(first), sample: { ...drawData(first), by: 'run', population: [] } }]);
    assert.ok(!plan(text, S, seedHex(7), 'session').population.includes(SAMPLE_SESSION));
  });

  it('the summary of a pick names what the record holds: times, counts, denies, asks, folders, commands', () => {
    const recs: Rec[] = [
      { session: 'x-a', run: 'run-x', ts: '2026-01-02T09:00:00.000Z', action: 'git push --force origin main', decision: 'deny', rule: 'git.force-push' },
      { session: 'x-a', run: 'run-x', ts: '2026-01-02T09:01:00.000Z', action: 'rm -rf build', decision: 'ask', rule: 'destructive.rm' },
      { session: 'x-b', run: 'run-x', ts: '2026-01-02T09:02:00.000Z', action: 'rm -rf build', decision: 'allow', rule: 'ask.approved' },
      { session: 'x-b', run: 'run-x', ts: '2026-01-02T09:03:00.000Z', tool: 'Write', action: 'src/a.ts', cwd: '/srv/other' },
    ];
    const p = plan(buildLog(recs), { ...S, rate: 1 });
    const u = p.summaries[0];
    assert.ok(u !== undefined);
    assert.equal(u.records, 4);
    assert.equal(u.first, '2026-01-02T09:00:00.000Z');
    assert.equal(u.last, '2026-01-02T09:03:00.000Z');
    assert.deepEqual(u.sessions, ['x-a', 'x-b']);
    assert.deepEqual(u.cwds, ['/srv/example', '/srv/other']);
    assert.deepEqual([u.denied, u.asked, u.approved_asks], [1, 1, 1]);
    assert.equal(u.denies[0]?.rule, 'git.force-push');
    assert.equal(u.asks[0]?.action, 'rm -rf build');
    assert.deepEqual(u.actions, ['git push --force origin main', 'rm -rf build', 'src/a.ts']);
  });
});

describe('a record that does not verify', () => {
  it('a unit whose session has an edited line is picked whatever the draw says, and named with the problem', () => {
    const lines = buildLog(runs(6)).split('\n');
    lines[4] = (lines[4] ?? '').replace('npm test', 'npm tset');
    const text = lines.join('\n');
    const v = verifyAuditText(text);
    assert.equal(v.ok, false);
    const p = planDraw(text, v, { ...S, rate: 1000 }, 'run', NOW, sha(5));
    assert.deepEqual(p.drawn, [], 'at 1 in 1000 this seed picks nothing');
    assert.ok(p.forced.length >= 1, JSON.stringify(p.forced));
    for (const u of p.forced) assert.ok((p.unitProblems.get(u) ?? []).length > 0);
    assert.deepEqual(p.picks, p.forced);
    assert.equal(p.population.length, 6, 'nothing left out of the population');
  });
});

describe('after an escape or a declared change, read everything for the next K units', () => {
  const recs = runs(3);
  const first = plan(buildLog(recs), { ...S, rate: 1 });
  const verdict = (unit: string, v: 'clean' | 'escape'): Rec => ({ session: SAMPLE_SESSION, ts: '2026-01-21T00:00:00.000Z', tool: 'audit sample', rule: SAMPLE_RULES.verdict, reason: 'one line why', sample: { by: 'run', unit, verdict: v } });

  it('an escape: the next draw is at 1 in 1 until 5 units were considered, then back to N', () => {
    const k: Rec[] = [...recs, drawRec(first), verdict('run-01', 'escape'), ...runs(3, { prefix: 'b' })];
    const second = plan(buildLog(k), { ...S, rate: 1000 }, sha(8));
    assert.equal(second.read_all, true);
    assert.equal(second.rate, 1);
    assert.equal(second.remaining_before, 5);
    assert.deepEqual(second.picks, ['b-01', 'b-02', 'b-03']);
    const k2 = [...k, drawRec(second, '2026-01-22T00:00:00.000Z'), ...runs(3, { prefix: 'c' })];
    const third = plan(buildLog(k2), { ...S, rate: 1000 }, sha(8));
    assert.equal(third.read_all, true, 'only 3 of 5 considered so far');
    assert.equal(third.remaining_before, 2);
    const k3 = [...k2, drawRec(third, '2026-01-23T00:00:00.000Z'), ...runs(3, { prefix: 'd' })];
    const fourth = plan(buildLog(k3), { ...S, rate: 1000 }, sha(8));
    assert.equal(fourth.read_all, false);
    assert.equal(fourth.rate, 1000);
  });

  it('a clean verdict changes nothing; a declared change reads everything; read_all_next 0 turns it off', () => {
    const clean = plan(buildLog([...recs, drawRec(first), verdict('run-01', 'clean'), ...runs(2, { prefix: 'b' })]), { ...S, rate: 1000 }, sha(8));
    assert.equal(clean.read_all, false);
    const change: Rec = { session: SAMPLE_SESSION, ts: '2026-01-21T00:00:00.000Z', tool: 'audit sample', rule: SAMPLE_RULES.change, reason: 'model changed', sample: {} };
    const text = buildLog([...recs, change, ...runs(2, { prefix: 'b' })]);
    const after = plan(text, { ...S, rate: 1000 }, sha(8));
    assert.equal(after.read_all, true);
    assert.equal(after.since?.kind, 'change');
    assert.equal(plan(text, { ...S, rate: 1000, read_all_next: 0 }, sha(8)).read_all, false);
  });
});

describe('the tally', () => {
  const recs = runs(4);
  let n = 11;
  while (n < 1000 && plan(buildLog(recs), { ...S, rate: 2 }, sha(n)).picks.length !== 3) n++;
  const first = plan(buildLog(recs), { ...S, rate: 2 }, sha(n));
  const verdict = (unit: string, v: 'clean' | 'escape'): Rec => ({ session: SAMPLE_SESSION, ts: '2026-01-21T00:00:00.000Z', tool: 'audit sample', rule: SAMPLE_RULES.verdict, reason: `read ${unit}`, sample: { by: 'run', unit, verdict: v } });

  it('counts draws, picks, verdicts, escapes and open picks; no score per agent, no threshold', () => {
    assert.equal(first.picks.length, 3, 'fixture: a seed that picks 3 of 4 runs at 1 in 2');
    const [p1, p2] = first.picks as [string, string];
    const t = tallySamples(buildLog([...recs, drawRec(first), verdict(p1, 'escape'), verdict(p2, 'clean'), verdict(p2, 'escape')]), S);
    assert.equal(t.draws, 1);
    assert.equal(t.considered, 4);
    assert.equal(t.picked, first.picks.length);
    assert.deepEqual(t.verdicts, { total: 2, clean: 0, escape: 2 }, 'the later verdict on a pick replaces the earlier one');
    assert.equal(t.escape_rate, 1);
    assert.equal(t.verdict_share, 2 / first.picks.length);
    assert.equal(t.open.length, first.picks.length - 2);
    assert.deepEqual(t.problems, []);
    assert.deepEqual(Object.keys(t).sort(), ['by', 'changes', 'considered', 'draws', 'escape_rate', 'forced', 'next', 'open', 'picked', 'picks', 'problems', 'verdict_share', 'verdicts']);
  });

  it('a verdict for a unit no draw picked is not counted and is reported', () => {
    const t = tallySamples(buildLog([...recs, drawRec(first), verdict('run-99', 'clean')]), S);
    assert.equal(t.verdicts.total, 0);
    assert.match(t.problems[0]?.detail ?? '', /no earlier draw picked/);
  });

  it('a draw whose recorded picks do not follow from its seed is reported (an edited line)', () => {
    const forged = { ...drawRec(first), sample: { ...drawData(first), picks: [] } };
    const t = tallySamples(buildLog([...recs, forged]), S);
    assert.match(t.problems[0]?.detail ?? '', /not the ones its seed/);
    const bad = { ...drawRec(first), sample: { by: 'run' } };
    assert.match(tallySamples(buildLog([...recs, bad]), S).problems[0]?.detail ?? '', /missing or mistyped/);
  });

  it('an empty log tallies to zeros', () => {
    const t = tallySamples('', S);
    assert.deepEqual([t.draws, t.picked, t.verdicts.total, t.verdict_share, t.escape_rate], [0, 0, 0, null, null]);
  });
});

describe('naming a pick for a verdict', () => {
  const recs = runs(2);
  const p = plan(buildLog(recs), { ...S, rate: 1 });
  const ps = plan(buildLog(recs), { ...S, rate: 1 }, seedHex(7), 'session');
  const twin = { ...ps, population: ['run-01'], picks: ['run-01'] };
  const events = scanLog(buildLog([...recs, drawRec(p), { ...drawRec(twin), sample: { ...drawData(twin), by: 'session' } }]), 'run').events;

  it('by kind and id, or a bare id only one pick carries', () => {
    assert.deepEqual(findPick(events, 'run:run-02'), { ok: true, by: 'run', unit: 'run-02' });
    assert.deepEqual(findPick(events, 'run-02'), { ok: true, by: 'run', unit: 'run-02' });
    assert.deepEqual(findPick(events, 'session:run-01'), { ok: true, by: 'session', unit: 'run-01' });
  });
  it('an ambiguous bare id is a usage error; an id never picked is refused', () => {
    const amb = findPick(events, 'run-01');
    assert.ok(!amb.ok && amb.usage);
    const none = findPick(events, 'run:run-77');
    assert.ok(!none.ok && !none.usage);
  });
});
