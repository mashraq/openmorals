import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateBylaws } from '../src/bylaws.js';
import { decide } from '../src/engine.js';
import type { Bylaws, Rule } from '../src/types.js';
import { decisionRank } from '../src/types.js';
import { loadCaseFiles } from './case-loader.js';

/** ENG-07: a user rule can only add ask or deny; no rule can ever produce allow over a guard's ask or deny. */

const MATCH_ALL: Rule['match'][] = [{ tool: '.' }, { command: '.' }, { path: '.' }, { tool: '.', path: '.' }];

function withRules(b: Bylaws, rules: Rule[]): Bylaws {
  return { ...b, rules: [...b.rules, ...rules] };
}

describe('ENG-07: no rule can turn a guard ask or deny into allow', () => {
  it('the validator refuses a rule whose decision is allow, or anything but ask and deny', () => {
    for (const decision of ['allow', 'Allow', 'ALLOW', 'permit', 'skip', '', null, 0, true]) {
      const r = validateBylaws({ version: 1, rules: [{ id: 'loosen', match: { command: '.' }, decision }] });
      assert.equal(r.ok, false, `decision ${JSON.stringify(decision)} was accepted`);
      if (!r.ok) assert.match(r.error, /rules\[0\]\.decision: must be ask or deny/);
    }
    for (const decision of ['ask', 'deny']) assert.ok(validateBylaws({ version: 1, rules: [{ id: 'ok', match: { command: '.' }, decision }] }).ok);
  });
  it('a rule has no field that could exempt an action (unknown keys such as allow or except are refused)', () => {
    for (const key of ['allow', 'except', 'unless', 'override', 'priority']) {
      const r = validateBylaws({ version: 1, rules: [{ id: 'x', match: { command: '.' }, decision: 'ask', [key]: true }] });
      assert.equal(r.ok, false, `rule key ${key} was accepted`);
    }
  });
  const files = loadCaseFiles();
  let checked = 0;
  for (const f of files) {
    it(`${f.file}: rules that match everything never lower a case's decision, even an allow rule forced past the validator`, () => {
      for (const c of f.cases) {
        const load = validateBylaws(c.bylaws, f.file);
        assert.ok(load.ok, load.ok ? '' : load.error);
        const base = decide(c.action, load.bylaws, c.state, undefined, c.where);
        const forced: Rule[] = MATCH_ALL.map((match, i) => ({ id: `forced-allow-${i}`, match, decision: 'allow' as unknown as Rule['decision'], reason: 'forced', hard: false }));
        const valid: Rule[] = MATCH_ALL.map((match, i) => ({ id: `extra-ask-${i}`, match, decision: 'ask', reason: 'extra', hard: false }));
        for (const extra of [forced, valid, [...forced, ...valid], [...valid, ...forced]]) {
          const v = decide(c.action, withRules(load.bylaws, extra), c.state, undefined, c.where);
          assert.ok(decisionRank(v.decision) >= decisionRank(base.decision), `${f.file} "${c.label}": ${base.decision} became ${v.decision} with ${extra.map((r) => r.id).join(',')}`);
          if (base.decision !== 'allow') assert.notEqual(v.decision, 'allow');
        }
        checked++;
      }
    });
  }
  it('covered every case file', () => {
    assert.ok(files.length >= 5);
    assert.ok(checked >= 5 * 15, `only ${checked} cases checked`);
  });
});
