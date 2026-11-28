import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { caseBylaws } from '../src/eval/cases.js';
import { decideCall } from '../src/adapters/claude-code.js';
import { loadCaseFiles, MIN_CASES_PER_GUARD } from './case-loader.js';

const files = loadCaseFiles();

describe('case files', () => {
  it('cover every built-in guard with at least 15 cases each', () => {
    const byGuard = new Map(files.map((f) => [f.guard, f.cases.length]));
    for (const g of ['destructive', 'online-delete', 'secrets', 'self-protect', 'budget']) {
      assert.ok((byGuard.get(g) ?? 0) >= MIN_CASES_PER_GUARD, `${g} has ${byGuard.get(g) ?? 0} cases`);
    }
  });
  it('each have allow cases and non-allow cases, so a guard that always says one thing fails', () => {
    for (const f of files) {
      assert.ok(f.cases.some((c) => c.expect === 'allow'), `${f.file} has no allow case`);
      assert.ok(f.cases.some((c) => c.expect !== 'allow'), `${f.file} has no ask/deny case`);
    }
  });
});

for (const f of files) {
  describe(`${f.file}`, () => {
    f.cases.forEach((c, i) => {
      it(`#${i + 1} ${c.expect}: ${c.label.replace(/\n/g, '\\n').slice(0, 90)}`, () => {
        const load = caseBylaws(c, `${f.file}#${i + 1}`);
        assert.ok(load.ok, `case bylaws invalid: ${load.ok ? '' : load.error}`);
        const v = decideCall(c.tool, c.actions, load, c.state, undefined, c.where, c.unknown);
        assert.equal(v.decision, c.expect, `got ${v.decision} [${v.rule}] ${v.reason}`);
        if (c.rule !== null) assert.equal(v.rule, c.rule, `rule was ${v.rule}: ${v.reason}`);
        else if (c.expect !== 'allow' && !c.ruleAny) assert.ok(v.rule.startsWith(`${f.guard}.`), `decided by ${v.rule}, not by ${f.guard}: ${v.reason}`);
      });
    });
  });
}
