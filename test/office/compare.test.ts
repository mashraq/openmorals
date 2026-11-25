import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { BookStyle, GBook, GDoc } from '../../src/office/corpus.js';
import { BOOK_STYLES, DOC_STYLES, budgetBook, cloneBook, cloneDoc, contractDoc, getCell, insertRows, recalc, setCell, writeBook, writeDoc } from '../../src/office/corpus.js';
import { aggregateOf, compareOffice, definedTerms, parseArea, shiftFormula, similarity } from '../../src/office/index.js';
import type { OfficeComparison } from '../../src/office/index.js';

const STYLE: BookStyle = BOOK_STYLES[0] ?? { id: 'x', strings: 'shared', prefix: '', refs: true, sharedFormulas: true, extValidations: false };
const DSTYLE = DOC_STYLES[0] ?? { id: 'x', prefix: 'w', styles: true, splitRuns: false, rsid: false, proofErr: false, bookmarks: false };

function wb(edit: (b: GBook, last: number) => void, opts: { inputs?: string[]; style?: Partial<BookStyle> } = {}): OfficeComparison {
  const w = budgetBook(11);
  const after = cloneBook(w.book);
  edit(after, w.last);
  return compareOffice('xlsx', writeBook(w.book, STYLE), writeBook(after, { ...STYLE, ...opts.style }), { inputs: opts.inputs ?? ['Assumptions'] });
}

function dc(edit: (d: GDoc) => void, redline = false, base: GDoc = contractDoc(11)): OfficeComparison {
  const after = cloneDoc(base);
  edit(after);
  return compareOffice('docx', writeDoc(base, DSTYLE, 1), writeDoc(after, DSTYLE, 2), { redline });
}

const line = (r: OfficeComparison, check: string): string => {
  const l = r.lines.find((x) => x.check === check);
  return `${l?.outcome ?? 'absent'}: ${l?.text ?? ''}`;
};
const sheet = (b: GBook, n: string): GBook['sheets'][number] => {
  const s = b.sheets.find((x) => x.name === n);
  assert.ok(s !== undefined);
  return s;
};

describe('workbook checks against the baseline', () => {
  it('an unchanged workbook passes every check, and every check prints a line', () => {
    const r = wb(() => undefined);
    assert.equal(r.status, 'pass');
    assert.deepEqual(r.lines.map((l) => l.check), ['sheets', 'names', 'validation', 'formulas-to-constants', 'formulas-removed', 'errors', 'inputs', 'sum-count', 'computed']);
  });
  it('a formula replaced by its value is named with its cell and value (the ruling row\'s removal test)', () => {
    const r = wb((b) => {
      const c = getCell(sheet(b, 'Data'), 'D3');
      if (c !== undefined) delete c.f;
    });
    assert.equal(r.status, 'fail');
    assert.match(line(r, 'formulas-to-constants'), /^fail: formulas turned into constants: 1 \(Data!D3 = /);
  });
  it('a formula cell emptied, a sheet, a defined name and a validation lost', () => {
    assert.match(line(wb((b) => sheet(b, 'Summary').cells.delete('3,2')), 'formulas-removed'), /^fail: .*Summary!B3/);
    assert.match(line(wb((b) => b.sheets.splice(3, 1)), 'sheets'), /^fail: sheets lost: "Summary"/);
    assert.match(line(wb((b) => b.names.splice(0, 1)), 'names'), /^fail: defined names lost: TaxRate/);
    assert.match(line(wb((b) => sheet(b, 'Data').validations.splice(0, 1)), 'validation'), /^fail: data validation lost: Data!B2:B\d+ \(whole\)/);
  });
  it('a new error value fails; one already in the baseline does not', () => {
    const r = wb((b) => {
      const c = getCell(sheet(b, 'Summary'), 'B2');
      if (c !== undefined) c.f = 'B1*#REF!';
      recalc(b);
    });
    assert.match(line(r, 'errors'), /^fail: new error values: 1 \(Summary!B2 #REF!\)/);
    const w = budgetBook(12);
    setCell(sheet(w.book, 'Summary'), 'B9', { f: '1/0', v: { error: '#DIV/0!' } });
    const same = compareOffice('xlsx', writeBook(w.book, STYLE), writeBook(w.book, STYLE), { inputs: [] });
    assert.match(line(same, 'errors'), /^pass: error values: no new one \(1 already in the baseline\)/);
  });
  it('input ranges: by address and by defined name; a changed value, a lost name and a range with no sheet fail', () => {
    const change = (b: GBook): void => setCell(sheet(b, 'Inputs'), 'B3', { v: 0.5 });
    assert.match(line(wb(change, { inputs: ['Inputs!B2:B5'] }), 'inputs'), /^fail: input ranges changed: Inputs!B3 /);
    assert.match(line(wb(change, { inputs: ['Assumptions'] }), 'inputs'), /^fail: input ranges changed: Inputs!B3 /);
    assert.match(line(wb((b) => b.names.splice(1, 1), { inputs: ['Assumptions'] }), 'inputs'), /^fail: .*Assumptions: now no defined name Assumptions/);
    assert.match(line(wb(() => undefined, { inputs: ['B2:B5'] }), 'inputs'), /^fail: .*names no sheet/);
    assert.match(line(wb(() => undefined, { inputs: [] }), 'inputs'), /^pass: input ranges: none declared/);
    assert.match(line(wb((b) => setCell(sheet(b, 'Inputs'), 'B9', { v: 1 }), { inputs: ['Inputs!B2:B5'] }), 'inputs'), /^pass: input ranges: 4 cell\(s\)/);
  });
  it('SUM and COUNT are recomputed from the cached values; a stale total fails, text and booleans in a range are skipped', () => {
    const stale = wb((b) => setCell(sheet(b, 'Data'), 'B3', { v: 999 }));
    assert.match(line(stale, 'sum-count'), /^fail: SUM or COUNT disagreeing with its range: 1 \(Data!B\d+ SUM: cached \d+, recomputed \d+\)/);
    const w = budgetBook(13);
    const d = sheet(w.book, 'Data');
    setCell(d, 'H1', { v: 'note' });
    setCell(d, 'H2', { v: 5 });
    setCell(d, 'H3', { v: true });
    setCell(d, 'H4', { f: 'SUM(H1:H3,10)', v: 0 });
    setCell(d, 'H5', { f: 'COUNT(H1:H3)', v: 0 });
    recalc(w.book);
    assert.equal(getCell(d, 'H4')?.v, 15);
    const r = compareOffice('xlsx', writeBook(w.book, STYLE), writeBook(w.book, STYLE), { inputs: [] });
    assert.match(line(r, 'sum-count'), /^pass: SUM and COUNT: 5 recomputed, all agree/);
  });
  it('not computed: no cached values, or fullCalcOnLoad; never pass', () => {
    const none = wb(() => undefined, { style: { noCache: 'all' } });
    assert.equal(none.status, 'not computed');
    assert.match(line(none, 'computed'), /^not computed: not computed: \d+ of \d+ formula cell\(s\) hold no computed value/);
    const full = wb((b) => {
      b.fullCalcOnLoad = true;
    });
    assert.equal(full.status, 'not computed');
    assert.match(line(full, 'computed'), /fullCalcOnLoad/);
    const both = wb((b) => b.sheets.splice(2, 1), { style: { noCache: 'all' } });
    assert.equal(both.status, 'fail', 'a failure outranks not computed');
  });
  it('a row inserted mid-table (references moved, recomputed) is aligned by its labels and passes', () => {
    const r = wb((b) => {
      insertRows(b, 'Data', 4, 1);
      setCell(sheet(b, 'Data'), 'A4', { v: 'Inserted' });
      setCell(sheet(b, 'Data'), 'B4', { v: 1 });
      setCell(sheet(b, 'Data'), 'C4', { v: 2 });
      setCell(sheet(b, 'Data'), 'D4', { f: 'B4*C4', v: 0 });
      recalc(b);
    });
    assert.equal(r.status, 'pass', r.lines.map((l) => l.text).join('\n'));
  });
  it('every writer style reads the same workbook the same way', () => {
    const w = budgetBook(14);
    for (const a of BOOK_STYLES) for (const b of BOOK_STYLES) assert.equal(compareOffice('xlsx', writeBook(w.book, a), writeBook(w.book, b), { inputs: ['Assumptions'] }).status, 'pass', `${a.id} -> ${b.id}`);
  });
});

describe('document checks against the baseline', () => {
  it('an unchanged document passes; a lost heading, table and defined term fail', () => {
    assert.equal(dc(() => undefined).status, 'pass');
    assert.match(line(dc((d) => d.blocks.splice(2, 1)), 'headings'), /^fail: headings lost: "1\. Definitions"/);
    assert.match(line(dc((d) => d.blocks.splice(11, 1)), 'tables'), /^fail: tables lost: 1 in the baseline, 0 now/);
    assert.match(line(dc((d) => d.blocks.splice(3, 1)), 'terms'), /^fail: defined terms lost: "Agreement"/);
  });
  it('a reworded heading (one letter) is shown, not failed', () => {
    const r = dc((d) => {
      const b = d.blocks[14];
      if (b?.kind === 'p') b.runs = [{ text: '4.1 Renewals' }];
    });
    assert.equal(r.status, 'pass');
    assert.match(line(r, 'headings'), /reworded: "4\.1 Renewal" -> "4\.1 Renewals"/);
  });
  it('redline: tracked changes pass; an untracked change or a silently accepted insertion fails; without redline it is not checked', () => {
    const tracked = dc((d) => {
      const b = d.blocks[8];
      if (b?.kind === 'p') b.runs = [{ text: b.runs[0]?.text ?? '', del: true }, { text: 'New hours apply.', ins: true }];
    }, true);
    assert.equal(tracked.status, 'pass', tracked.lines.map((l) => l.text).join('\n'));
    const silent = dc((d) => {
      const b = d.blocks[8];
      if (b?.kind === 'p') b.runs = [{ text: 'New hours apply.' }];
    }, true);
    assert.match(line(silent, 'untracked'), /^fail: untracked changes: .* differs from the baseline at word/);
    assert.equal(dc((d) => {
      const b = d.blocks[8];
      if (b?.kind === 'p') b.runs = [{ text: 'New hours apply.' }];
    }, false).lines.some((l) => l.check === 'untracked'), false);
    const pending = contractDoc(11);
    const p = pending.blocks[8];
    if (p?.kind === 'p') p.runs.push({ text: ' A reviewer clause.', ins: true });
    const accepted = dc((d) => {
      for (const b of d.blocks) if (b.kind === 'p') for (const x of b.runs) delete x.ins;
    }, true, pending);
    assert.equal(accepted.status, 'fail');
  });
  it('defined terms: "X" means and (the "X"), curly quotes too; lower-case quoted words are not terms', () => {
    assert.deepEqual([...definedTerms('“Effective Date” means the date of signature; between A (the "Buyer") and B ("Seller"); the word "maybe" is quoted.')].sort(), ['Buyer', 'Effective Date', 'Seller']);
  });
});

describe('references and the formula shapes recomputed', () => {
  it('reads areas, SUM and COUNT, and moves shared formulas', () => {
    assert.deepEqual(parseArea("'My ''Sheet'''!$A$1:B3"), { sheet: "My 'Sheet'", r1: 1, c1: 1, r2: 3, c2: 2 });
    assert.equal(parseArea('A:A')?.r2, 1_048_576);
    assert.equal(aggregateOf('SUM(A1:A3)*2'), null);
    assert.equal(aggregateOf('SUM(IF(A1>0,A1,0))'), null);
    assert.deepEqual(aggregateOf('count(Data!B2:B9, 4)')?.args.map((a) => a.kind), ['area', 'number']);
    assert.equal(shiftFormula('B2*C2+$D$1', 3, 0), 'B5*C5+$D$1');
    assert.equal(shiftFormula('SUM(A:A)', 1, 0), null);
    assert.equal(shiftFormula('"B2"&B2', 1, 0), '"B2"&B3');
    assert.ok(similarity('next steps', 'next stepss') > 0.75);
  });
});
