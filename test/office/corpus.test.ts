import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OFFICE_FALSE_ALARM_THRESHOLD } from '../../src/eval/office.js';
import { DOCUMENT_CHECKS, WORKBOOK_CHECKS } from '../../src/office/compare.js';
import { officeRows } from '../../src/office/corpus.js';
import { scoreOffice } from '../../src/office/eval.js';

describe('the seeded office corpus of eval', () => {
  const rows = officeRows();
  it('is the same every run (seeded) and meets the floor set before measuring: 40 clean pairs, 20 per format', () => {
    const again = officeRows();
    for (const [i, r] of rows.entries()) {
      const a = r.build();
      const b = again[i]?.build();
      assert.ok(b !== undefined && a.before.equals(b.before) && a.after.equals(b.after), r.id);
    }
    const clean = rows.filter((r) => r.kind === 'clean');
    assert.ok(clean.length >= 40);
    assert.ok(clean.filter((r) => r.format === 'xlsx').length >= 20);
    assert.ok(clean.filter((r) => r.format === 'docx').length >= 20);
    assert.equal(OFFICE_FALSE_ALARM_THRESHOLD, 0.05, 'the threshold set in the build log before measuring');
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, 'row ids are unique');
  });
  it('every check has a damaged row that names it, and every clean pair really changes the file', () => {
    for (const c of [...WORKBOOK_CHECKS.filter((x) => x !== 'computed'), ...DOCUMENT_CHECKS]) assert.ok(rows.some((r) => r.kind === 'damaged' && r.check === c), c);
    assert.ok(rows.some((r) => r.kind === 'not-computed' && r.check === 'computed'));
    for (const r of rows.filter((x) => x.kind === 'clean')) {
      const { before, after } = r.build();
      assert.ok(!before.equals(after), `${r.id}: a clean pair must change something`);
    }
  });
  it('scores: every row right, damaged all caught, false alarms within the threshold, no crash', () => {
    const s = scoreOffice();
    assert.deepEqual(s.wrong.map((w) => `${w.id}: ${w.got} ${w.first}`), []);
    assert.equal(s.caught, s.damaged);
    assert.equal(s.saidNotComputed, s.notComputed);
    assert.equal(s.unreadable, s.malformed);
    assert.equal(s.crashes, 0);
    assert.ok(s.falseAlarmRate !== null && s.falseAlarmRate <= s.threshold);
  });
});
