// The before-after comparison (Q8): a workbook or a Word document against its baseline copy. Pure: two parsed files in,
// one line per check out. Each check is one function, so dropping one is one edit and its eval rows go red.
import type { Area, AggregateArg } from './refs.js';
import { MAX_COL, aggregateOf, areaName, cellName, parseArea, shiftFormula, splitArgs } from './refs.js';
import type { Cell, Sheet, Workbook } from './xlsx.js';
import { cellAt, sheetByName } from './xlsx.js';
import type { WordDocument } from './docx.js';

export type CheckOutcome = 'pass' | 'fail' | 'not computed';

export interface CheckLine {
  /** The check's id: sheets, names, validation, formulas-to-constants, formulas-removed, errors, inputs, sum-count, computed; headings, tables, terms, untracked. */
  check: string;
  outcome: CheckOutcome;
  text: string;
}

export interface OfficeComparison {
  status: CheckOutcome;
  lines: CheckLine[];
}

export const WORKBOOK_CHECKS = ['sheets', 'names', 'validation', 'formulas-to-constants', 'formulas-removed', 'errors', 'inputs', 'sum-count', 'computed'] as const;
export const DOCUMENT_CHECKS = ['headings', 'tables', 'terms', 'untracked'] as const;

const LIST = 6;

function listed(xs: readonly string[]): string {
  return xs.length <= LIST ? xs.join(', ') : `${xs.slice(0, LIST).join(', ')} and ${xs.length - LIST} more`;
}

function short(s: string, n = 40): string {
  const t = s.replace(/\s+/g, ' ');
  return t.length > n ? `${t.slice(0, n - 3)}...` : t;
}

function statusOf(lines: readonly CheckLine[]): CheckOutcome {
  if (lines.some((l) => l.outcome === 'fail')) return 'fail';
  if (lines.some((l) => l.outcome === 'not computed')) return 'not computed';
  return 'pass';
}

function qs(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

function place(sheet: Sheet, row: number, col: number): string {
  return `${qs(sheet.name)}!${cellName(row, col)}`;
}

// ---------------------------------------------------------------------------------------------------------------- rows

function isText(c: Cell): boolean {
  return c.formula === null && (c.type === 's' || c.type === 'inlineStr' || c.type === 'str') && c.value !== null && c.value.trim() !== '';
}

/** A row's text labels (constants only), or null when it has none. */
function rowKey(row: ReadonlyMap<number, Cell>): string | null {
  const parts: string[] = [];
  for (const [col, c] of [...row].sort((x, y) => x[0] - y[0])) if (isText(c)) parts.push(`${col}\u0002${(c.value ?? '').trim()}`);
  return parts.length === 0 ? null : parts.join('\u0001');
}

function uniqueKeys(s: Sheet): Map<string, number> {
  const all = new Map<string, number[]>();
  for (const [r, row] of s.rows) {
    const k = rowKey(row);
    if (k === null) continue;
    const list = all.get(k) ?? [];
    list.push(r);
    all.set(k, list);
  }
  const out = new Map<string, number>();
  for (const [k, rs] of all) if (rs.length === 1 && rs[0] !== undefined) out.set(k, rs[0]);
  return out;
}

/**
 * Maps a row of `from` to the row of `to` it most likely became: rows whose text labels are unique in both sheets are
 * anchors (the longest run that keeps its order), and a row between anchors moves with the nearest anchor above it.
 */
export function alignRows(from: Sheet, to: Sheet): (row: number) => number {
  const a = uniqueKeys(from);
  const b = uniqueKeys(to);
  const pairs: [number, number][] = [];
  for (const [k, r] of a) {
    const t = b.get(k);
    if (t !== undefined) pairs.push([r, t]);
  }
  pairs.sort((x, y) => x[0] - y[0]);
  const tails: number[] = [];
  const tailIdx: number[] = [];
  const prev: number[] = new Array<number>(pairs.length).fill(-1);
  for (let i = 0; i < pairs.length; i++) {
    const v = pairs[i]?.[1] ?? 0;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((tails[mid] ?? 0) < v) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = v;
    tailIdx[lo] = i;
    prev[i] = lo > 0 ? (tailIdx[lo - 1] ?? -1) : -1;
  }
  const anchors: [number, number][] = [];
  for (let i = tails.length > 0 ? (tailIdx[tails.length - 1] ?? -1) : -1; i >= 0; i = prev[i] ?? -1) {
    const p = pairs[i];
    if (p !== undefined) anchors.unshift(p);
  }
  if (anchors.length === 0) return (r) => r;
  return (r: number): number => {
    let lo = 0;
    let hi = anchors.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((anchors[mid]?.[0] ?? 0) <= r) {
        best = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const anc = anchors[best === -1 ? 0 : best] ?? [0, 0];
    return r + (anc[1] - anc[0]);
  };
}

function formulaCells(s: Sheet): Cell[] {
  const out: Cell[] = [];
  for (const row of s.rows.values()) for (const c of row.values()) if (c.formula !== null) out.push(c);
  return out.sort((x, y) => x.row - y.row || x.col - y.col);
}

/** A cell holds a value: a constant or a cached result that is not empty. */
function hasValue(c: Cell | undefined): boolean {
  return c !== undefined && c.value !== null && (c.value !== '' || c.type === 'str' || c.type === 's' || c.type === 'inlineStr');
}

// ---------------------------------------------------------------------------------------------------------------- workbook checks

export function checkSheets(b: Workbook, a: Workbook): CheckLine {
  const lost = b.sheets.filter((s) => sheetByName(a, s.name) === undefined).map((s) => JSON.stringify(s.name));
  return lost.length > 0 ? { check: 'sheets', outcome: 'fail', text: `sheets lost: ${listed(lost)}` } : { check: 'sheets', outcome: 'pass', text: `sheets: none lost (${b.sheets.length} in the baseline, ${a.sheets.length} now)` };
}

function nameKey(w: Workbook, n: { name: string; scope: number | null }): string {
  return `${n.name.toLowerCase()}@${n.scope === null ? '' : (w.sheets[n.scope]?.name.toLowerCase() ?? `#${n.scope}`)}`;
}

export function checkNames(b: Workbook, a: Workbook): CheckLine {
  const have = new Set(a.names.map((n) => nameKey(a, n)));
  const kept = b.names.filter((n) => n.name !== '_xlnm._FilterDatabase');
  const lost = kept.filter((n) => !have.has(nameKey(b, n))).map((n) => (n.scope === null ? n.name : `${n.name} (on ${b.sheets[n.scope]?.name ?? '?'})`));
  return lost.length > 0 ? { check: 'names', outcome: 'fail', text: `defined names lost: ${listed(lost)}` } : { check: 'names', outcome: 'pass', text: `defined names: none lost (${kept.length} in the baseline)` };
}

function norm(f: string): string {
  return f.trim().replace(/^=/, '').replace(/\s+/g, ' ');
}

function sqrefAreas(sqref: string): Area[] {
  return sqref
    .trim()
    .split(/\s+/)
    .map((s) => parseArea(s))
    .filter((x): x is Area => x !== null);
}

function overlaps(x: string, y: string): boolean {
  const xa = sqrefAreas(x);
  const ya = sqrefAreas(y);
  return xa.some((p) => ya.some((q) => p.r1 <= q.r2 && q.r1 <= p.r2 && p.c1 <= q.c2 && q.c1 <= p.c2));
}

export function checkValidation(b: Workbook, a: Workbook): CheckLine {
  const lost: string[] = [];
  let total = 0;
  for (const bs of b.sheets) {
    const as = sheetByName(a, bs.name);
    if (as === undefined) continue;
    total += bs.validations.length;
    const key = (v: (typeof bs.validations)[number]): string => `${v.type}|${v.operator}|${norm(v.formula1)}|${norm(v.formula2)}`;
    const left = [...as.validations];
    const unmatched: typeof bs.validations = [];
    for (const v of bs.validations) {
      const i = left.findIndex((w) => key(w) === key(v));
      if (i === -1) unmatched.push(v);
      else left.splice(i, 1);
    }
    for (const v of unmatched) {
      const i = left.findIndex((w) => w.type === v.type && overlaps(w.sqref, v.sqref));
      if (i === -1) lost.push(`${qs(bs.name)}!${v.sqref.trim() || '?'} (${v.type})`);
      else left.splice(i, 1);
    }
  }
  return lost.length > 0 ? { check: 'validation', outcome: 'fail', text: `data validation lost: ${listed(lost)}` } : { check: 'validation', outcome: 'pass', text: `data validation: none lost (${total} on sheets still there)` };
}

export function checkFormulas(b: Workbook, a: Workbook): [CheckLine, CheckLine] {
  const toConst: string[] = [];
  const removed: string[] = [];
  let total = 0;
  for (const bs of b.sheets) {
    const as = sheetByName(a, bs.name);
    if (as === undefined) continue;
    const map = alignRows(bs, as);
    for (const c of formulaCells(bs)) {
      total++;
      const r = map(c.row);
      const now = cellAt(as, r, c.col);
      if (now !== undefined && now.formula !== null) continue;
      if (now !== undefined && hasValue(now) && now.formula === null) toConst.push(`${place(bs, c.row, c.col)}${r !== c.row ? ` (now row ${r})` : ''} = ${short(now.value ?? '', 20)}`);
      else removed.push(`${place(bs, c.row, c.col)}${r !== c.row ? ` (now row ${r})` : ''}`);
    }
  }
  const a1: CheckLine = toConst.length > 0 ? { check: 'formulas-to-constants', outcome: 'fail', text: `formulas turned into constants: ${toConst.length} (${listed(toConst)})` } : { check: 'formulas-to-constants', outcome: 'pass', text: `formulas turned into constants: none (${total} formula cells in the baseline)` };
  const a2: CheckLine = removed.length > 0 ? { check: 'formulas-removed', outcome: 'fail', text: `formulas lost (cell emptied or gone): ${removed.length} (${listed(removed)})` } : { check: 'formulas-removed', outcome: 'pass', text: 'formulas lost: none' };
  return [a1, a2];
}

export function checkErrors(b: Workbook, a: Workbook): CheckLine {
  const fresh: string[] = [];
  let old = 0;
  for (const as of a.sheets) {
    const bs = sheetByName(b, as.name);
    const map = bs !== undefined ? alignRows(as, bs) : null;
    for (const row of as.rows.values()) {
      for (const c of row.values()) {
        if (c.type !== 'e') continue;
        const was = bs !== undefined && map !== null ? cellAt(bs, map(c.row), c.col) : undefined;
        if (was !== undefined && was.type === 'e') old++;
        else fresh.push(`${place(as, c.row, c.col)} ${short(c.value ?? '#?', 12)}`);
      }
    }
  }
  if (fresh.length > 0) return { check: 'errors', outcome: 'fail', text: `new error values: ${fresh.length} (${listed(fresh)})${old > 0 ? `; ${old} were already in the baseline` : ''}` };
  return { check: 'errors', outcome: 'pass', text: `error values: no new one${old > 0 ? ` (${old} already in the baseline)` : ''}` };
}

const MAX_COMPARED = 1_000_000;

function maxRow(s: Sheet): number {
  let m = 0;
  for (const r of s.rows.keys()) if (r > m) m = r;
  return m;
}

function maxColOf(s: Sheet): number {
  let m = 0;
  for (const row of s.rows.values()) for (const c of row.keys()) if (c > m) m = c;
  return m;
}

/** The areas an input spec names in a workbook: an address with its sheet, or a defined name (workbook-wide). */
function inputAreas(w: Workbook, spec: string): { ok: true; areas: Area[]; byName: boolean } | { ok: false; error: string } {
  const direct = parseArea(spec);
  if (direct !== null) {
    if (direct.sheet === null) return { ok: false, error: `${spec} names no sheet` };
    return { ok: true, areas: [direct], byName: false };
  }
  const n = w.names.find((x) => x.name.toLowerCase() === spec.toLowerCase() && x.scope === null) ?? w.names.find((x) => x.name.toLowerCase() === spec.toLowerCase());
  if (n === undefined) return { ok: false, error: `no defined name ${spec}` };
  const parts = splitArgs(n.text.trim().replace(/^=/, ''));
  if (parts === null) return { ok: false, error: `the defined name ${spec} is not a range` };
  const areas: Area[] = [];
  for (const p of parts) {
    const ar = parseArea(p.trim().replace(/^\(|\)$/g, ''));
    if (ar === null || ar.sheet === null) return { ok: false, error: `the defined name ${spec} (${short(n.text, 40)}) is not a range with a sheet` };
    areas.push(ar);
  }
  return areas.length > 0 ? { ok: true, areas, byName: true } : { ok: false, error: `the defined name ${spec} is empty` };
}

function cellsOf(w: Workbook, areas: readonly Area[]): { ok: true; cells: { sheet: Sheet; row: number; col: number }[] } | { ok: false; error: string } {
  const out: { sheet: Sheet; row: number; col: number }[] = [];
  for (const ar of areas) {
    const s = sheetByName(w, ar.sheet ?? '');
    if (s === undefined) return { ok: false, error: `the sheet ${JSON.stringify(ar.sheet)} is not there` };
    const r2 = Math.min(ar.r2, Math.max(maxRow(s), ar.r1));
    const c2 = Math.min(ar.c2, Math.max(maxColOf(s), ar.c1), MAX_COL);
    if ((r2 - ar.r1 + 1) * (c2 - ar.c1 + 1) + out.length > MAX_COMPARED) return { ok: false, error: `${areaName(ar)} holds more than ${MAX_COMPARED} cells` };
    for (let r = ar.r1; r <= r2; r++) for (let c = ar.c1; c <= c2; c++) out.push({ sheet: s, row: r, col: c });
  }
  return { ok: true, cells: out };
}

function shown(c: Cell | undefined): string {
  if (c === undefined || (!hasValue(c) && c.formula === null)) return '(empty)';
  if (c.formula !== null) return `=${short(c.formula, 24)}`;
  return short(c.value ?? '', 24);
}

function sameCell(x: Cell | undefined, y: Cell | undefined): boolean {
  const ex = x === undefined || (!hasValue(x) && x.formula === null);
  const ey = y === undefined || (!hasValue(y) && y.formula === null);
  if (ex || ey) return ex && ey;
  if (x === undefined || y === undefined) return false;
  if ((x.formula === null) !== (y.formula === null)) return false;
  if (x.formula !== null && y.formula !== null) return x.formula.replace(/\s+/g, '') === y.formula.replace(/\s+/g, '') && (x.formula !== '' || x.shared?.si === y.shared?.si);
  const nx = x.type === 'n' ? Number(x.value) : NaN;
  const ny = y.type === 'n' ? Number(y.value) : NaN;
  if (x.type === 'n' && y.type === 'n') return nx === ny || (x.value ?? '') === (y.value ?? '');
  const textual = (t: string): boolean => t === 's' || t === 'str' || t === 'inlineStr';
  if (textual(x.type) && textual(y.type)) return (x.value ?? '') === (y.value ?? '');
  return x.type === y.type && (x.value ?? '') === (y.value ?? '');
}

export function checkInputs(b: Workbook, a: Workbook, specs: readonly string[]): CheckLine {
  if (specs.length === 0) return { check: 'inputs', outcome: 'pass', text: 'input ranges: none declared, so cell values are not compared' };
  const bad: string[] = [];
  let compared = 0;
  for (const spec of specs) {
    const rb = inputAreas(b, spec);
    if (!rb.ok) {
      bad.push(`${spec}: in the baseline, ${rb.error}`);
      continue;
    }
    const ra = rb.byName ? inputAreas(a, spec) : rb;
    if (!ra.ok) {
      bad.push(`${spec}: now ${ra.error}`);
      continue;
    }
    const cb = cellsOf(b, rb.areas);
    const ca = cellsOf(a, ra.areas);
    if (!cb.ok || !ca.ok) {
      bad.push(`${spec}: ${!cb.ok ? `in the baseline ${cb.error}` : !ca.ok ? `now ${ca.error}` : ''}`);
      continue;
    }
    if (rb.byName && cb.cells.length !== ca.cells.length) {
      bad.push(`${spec}: covers ${cb.cells.length} cells in the baseline and ${ca.cells.length} now`);
      continue;
    }
    for (let i = 0; i < cb.cells.length; i++) {
      const p = cb.cells[i];
      const q = ca.cells[i];
      if (p === undefined || q === undefined) continue;
      compared++;
      const x = cellAt(p.sheet, p.row, p.col);
      const y = cellAt(q.sheet, q.row, q.col);
      if (!sameCell(x, y)) bad.push(`${place(q.sheet, q.row, q.col)} ${shown(x)} -> ${shown(y)}`);
    }
  }
  return bad.length > 0 ? { check: 'inputs', outcome: 'fail', text: `input ranges changed: ${listed(bad)}` } : { check: 'inputs', outcome: 'pass', text: `input ranges: ${compared} cell(s) in ${specs.length} range(s) unchanged` };
}

const WORK_BUDGET = 5_000_000;

function formulaText(s: Sheet, c: Cell): string | null {
  if (c.formula === null) return null;
  if (c.formula !== '' || c.shared === null || c.shared.master) return c.formula;
  const m = s.masters.get(c.shared.si);
  if (m === undefined || m.formula === null || m.formula === '') return null;
  return shiftFormula(m.formula, c.row - m.row, c.col - m.col);
}

function nameAreas(w: Workbook, s: Sheet, name: string): Area[] | null {
  const idx = w.sheets.indexOf(s);
  const n = w.names.find((x) => x.name.toLowerCase() === name.toLowerCase() && x.scope === idx) ?? w.names.find((x) => x.name.toLowerCase() === name.toLowerCase() && x.scope === null);
  if (n === undefined) return null;
  const parts = splitArgs(n.text.trim().replace(/^=/, ''));
  if (parts === null) return null;
  const out: Area[] = [];
  for (const p of parts) {
    const ar = parseArea(p.trim());
    if (ar === null || ar.sheet === null) return null;
    out.push(ar);
  }
  return out;
}

/** SUM or COUNT over the cached and constant values, the way a spreadsheet does: references skip text and booleans; an error in a SUM range makes the SUM an error. */
function evaluate(w: Workbook, s: Sheet, fn: 'SUM' | 'COUNT', args: readonly AggregateArg[], work: { left: number }): { ok: true; value: number; error: boolean } | { ok: false } {
  let sum = 0;
  let count = 0;
  let error = false;
  const areas: Area[] = [];
  for (const a of args) {
    if (a.kind === 'number') {
      sum += a.value;
      count++;
    } else if (a.kind === 'area') areas.push(a.area);
    else {
      const ns = nameAreas(w, s, a.name);
      if (ns === null) return { ok: false };
      areas.push(...ns);
    }
  }
  for (const ar of areas) {
    const sheet = ar.sheet === null ? s : sheetByName(w, ar.sheet);
    if (sheet === undefined) return { ok: false };
    const rows = ar.r2 - ar.r1 + 1 <= sheet.rows.size ? Array.from({ length: ar.r2 - ar.r1 + 1 }, (_x, i) => ar.r1 + i) : [...sheet.rows.keys()].filter((r) => r >= ar.r1 && r <= ar.r2);
    for (const r of rows) {
      const row = sheet.rows.get(r);
      if (row === undefined) continue;
      for (const [col, c] of row) {
        if (--work.left < 0) return { ok: false };
        if (col < ar.c1 || col > ar.c2) continue;
        if (c.type === 'e') {
          error = true;
          continue;
        }
        if (c.type !== 'n' || c.value === null || c.value.trim() === '') continue;
        const v = Number(c.value);
        if (!Number.isFinite(v)) continue;
        sum += v;
        count++;
      }
    }
  }
  return { ok: true, value: fn === 'SUM' ? sum : count, error: fn === 'SUM' && error };
}

function close(x: number, y: number): boolean {
  return Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
}

export function checkSums(a: Workbook): CheckLine {
  const wrong: string[] = [];
  let checked = 0;
  let skipped = 0;
  const work = { left: WORK_BUDGET };
  for (const s of a.sheets) {
    for (const c of formulaCells(s)) {
      const f = formulaText(s, c);
      const agg = f !== null ? aggregateOf(f) : null;
      if (agg === null) {
        skipped++;
        continue;
      }
      if (!hasValue(c)) continue;
      const r = evaluate(a, s, agg.fn, agg.args, work);
      if (!r.ok) {
        skipped++;
        continue;
      }
      checked++;
      const cached = c.value ?? '';
      if (r.error) {
        if (c.type !== 'e') wrong.push(`${place(s, c.row, c.col)} ${agg.fn}: cached ${short(cached, 16)}, but its range holds an error`);
        continue;
      }
      const v = Number(cached);
      if (c.type !== 'n' || !Number.isFinite(v) || !close(v, r.value)) wrong.push(`${place(s, c.row, c.col)} ${agg.fn}: cached ${short(cached, 16)}, recomputed ${Number(r.value.toPrecision(15))}`);
    }
  }
  if (wrong.length > 0) return { check: 'sum-count', outcome: 'fail', text: `SUM or COUNT disagreeing with its range: ${wrong.length} (${listed(wrong)})` };
  if (checked === 0) return { check: 'sum-count', outcome: 'pass', text: `SUM and COUNT: none to recompute${skipped > 0 ? ` (${skipped} other formula(s) not recomputed)` : ''}` };
  return { check: 'sum-count', outcome: 'pass', text: `SUM and COUNT: ${checked} recomputed, all agree${skipped > 0 ? ` (${skipped} other formula(s) not recomputed)` : ''}` };
}

export function checkComputed(a: Workbook): CheckLine {
  if (a.fullCalcOnLoad) return { check: 'computed', outcome: 'not computed', text: 'not computed: the file asks to be recalculated when it is opened (fullCalcOnLoad), so its cached values are not results' };
  const missing: string[] = [];
  let total = 0;
  for (const s of a.sheets) {
    for (const c of formulaCells(s)) {
      total++;
      if (c.value === null || (c.value === '' && c.type !== 'str')) missing.push(place(s, c.row, c.col));
    }
  }
  if (missing.length > 0) return { check: 'computed', outcome: 'not computed', text: `not computed: ${missing.length} of ${total} formula cell(s) hold no computed value (${listed(missing)}); open and save it in a spreadsheet program, then check again` };
  return { check: 'computed', outcome: 'pass', text: `computed: every formula cell (${total}) holds a value` };
}

export function compareWorkbooks(b: Workbook, a: Workbook, opts: { inputs: readonly string[] }): OfficeComparison {
  const lines: CheckLine[] = [checkSheets(b, a), checkNames(b, a), checkValidation(b, a), ...checkFormulas(b, a), checkErrors(b, a), checkInputs(b, a, opts.inputs), checkSums(a), checkComputed(a)];
  return { status: statusOf(lines), lines };
}

// ---------------------------------------------------------------------------------------------------------------- document checks

function normText(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[   ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function headingKey(s: string): string {
  return normText(s).toLowerCase().replace(/[\s.:]+$/, '');
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

/** Dice similarity over character pairs, 0 to 1. */
export function similarity(x: string, y: string): number {
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const a = bigrams(x);
  const b = bigrams(y);
  let both = 0;
  for (const [g, n] of a) both += Math.min(n, b.get(g) ?? 0);
  return (2 * both) / (x.length - 1 + (y.length - 1));
}

const RENAME_SIMILARITY = 0.75;

export function checkHeadings(b: WordDocument, a: WordDocument): CheckLine {
  const hb = b.paragraphs.filter((p) => p.level !== null && headingKey(p.accepted) !== '').map((p) => ({ key: headingKey(p.accepted), text: normText(p.accepted), level: p.level }));
  const ha = a.paragraphs.filter((p) => p.level !== null && headingKey(p.accepted) !== '').map((p) => ({ key: headingKey(p.accepted), text: normText(p.accepted), level: p.level, used: false }));
  const left: typeof hb = [];
  for (const h of hb) {
    const m = ha.find((x) => !x.used && x.key === h.key);
    if (m !== undefined) m.used = true;
    else left.push(h);
  }
  const lost: string[] = [];
  const renamed: string[] = [];
  for (const h of left) {
    const m = ha.find((x) => !x.used && x.level === h.level && similarity(x.key, h.key) >= RENAME_SIMILARITY);
    if (m !== undefined) {
      m.used = true;
      renamed.push(`${JSON.stringify(short(h.text))} -> ${JSON.stringify(short(m.text))}`);
    } else lost.push(JSON.stringify(short(h.text)));
  }
  if (lost.length > 0) return { check: 'headings', outcome: 'fail', text: `headings lost: ${listed(lost)}` };
  return { check: 'headings', outcome: 'pass', text: `headings: none lost (${hb.length} in the baseline${renamed.length > 0 ? `; reworded: ${listed(renamed)}` : ''})` };
}

export function checkTables(b: WordDocument, a: WordDocument): CheckLine {
  return a.tables < b.tables ? { check: 'tables', outcome: 'fail', text: `tables lost: ${b.tables} in the baseline, ${a.tables} now` } : { check: 'tables', outcome: 'pass', text: `tables: none lost (${b.tables} in the baseline, ${a.tables} now)` };
}

const MEANS = /"([^"\n]{1,80})"\s*,?\s*(?:means|mean|shall mean|shall have the meaning|has the meaning|have the meaning|refers to|is defined as|shall include|includes)\b/g;
const PAREN = /\(\s*(?:[^()"\n]{0,40}?[\s,])?"([^"\n]{1,80})"\s*\)/g;

/** Terms a text defines: `"Term" means ...` and `(the "Term")`, with curly quotes read as straight ones; a term starts with a capital or a digit. */
export function definedTerms(text: string): Set<string> {
  const t = text.replace(/[“”„‟″]/g, '"');
  const out = new Set<string>();
  for (const re of [MEANS, PAREN]) {
    re.lastIndex = 0;
    for (let m = re.exec(t); m !== null; m = re.exec(t)) {
      const term = normText(m[1] ?? '');
      if (/^[A-Z0-9]/.test(term)) out.add(term);
    }
  }
  return out;
}

function termsOf(d: WordDocument): Set<string> {
  const out = new Set<string>();
  for (const p of d.paragraphs) for (const t of definedTerms(p.accepted)) out.add(t);
  return out;
}

export function checkTerms(b: WordDocument, a: WordDocument): CheckLine {
  const tb = termsOf(b);
  const ta = termsOf(a);
  const lost = [...tb].filter((t) => !ta.has(t)).map((t) => JSON.stringify(t));
  return lost.length > 0 ? { check: 'terms', outcome: 'fail', text: `defined terms lost: ${listed(lost)}` } : { check: 'terms', outcome: 'pass', text: `defined terms: none lost (${tb.size} in the baseline)` };
}

function words(d: WordDocument): string[] {
  const out: string[] = [];
  for (const p of d.paragraphs) {
    const t = normText(p.rejected);
    if (t !== '') out.push(...t.split(' '));
  }
  return out;
}

/** With every tracked change rejected, the document must read exactly as the baseline did (rejected the same way). */
export function checkUntracked(b: WordDocument, a: WordDocument, redline: boolean): CheckLine | null {
  if (!redline) return null;
  const wb = words(b);
  const wa = words(a);
  let i = 0;
  while (i < wb.length && i < wa.length && wb[i] === wa[i]) i++;
  if (i === wb.length && i === wa.length) return { check: 'untracked', outcome: 'pass', text: `untracked changes: none (${a.revisions} tracked change(s) now)` };
  const ctx = (ws: string[]): string => JSON.stringify(short(ws.slice(Math.max(0, i - 3), i + 5).join(' '), 60));
  return { check: 'untracked', outcome: 'fail', text: `untracked changes: with every tracked change rejected the text differs from the baseline at word ${i + 1}: baseline ${ctx(wb)}, now ${ctx(wa)}` };
}

export function compareDocuments(b: WordDocument, a: WordDocument, opts: { redline: boolean }): OfficeComparison {
  const lines: CheckLine[] = [checkHeadings(b, a), checkTables(b, a), checkTerms(b, a)];
  const u = checkUntracked(b, a, opts.redline);
  if (u !== null) lines.push(u);
  return { status: statusOf(lines), lines };
}
