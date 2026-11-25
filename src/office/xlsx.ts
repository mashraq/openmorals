// A workbook (.xlsx) read for the before-after check: sheets, cells with their formulas and cached values, defined
// names, data validations and whether the writer asked for a recalculation. Read only through the bounded zip reader and
// the scanner; every limit below makes a larger file "could not read", never a partial read that could pass.
import { ZipReader, officeKind } from './zip.js';
import type { Read } from './zip.js';
import { attrOf, local, scanXml } from './xmlscan.js';
import { parseCell } from './refs.js';

/** The most cells read from one workbook (all sheets). */
export const MAX_CELLS = 500_000;
/** The largest part (a sheet, the shared strings) read. */
export const MAX_PART_BYTES = 48 * 1024 * 1024;
/** The most sheets read. */
export const MAX_SHEETS = 1_000;
/** Excel's own limit on the characters in one cell; a longer value is not a workbook Excel wrote. */
export const MAX_CELL_CHARS = 32_767;
const MAX_FORMULA_CHARS = 16_384;

export type CellType = 'n' | 's' | 'str' | 'inlineStr' | 'b' | 'e' | 'd';

export interface Cell {
  row: number;
  col: number;
  /** The formula text as stored (no `=`), '' for a shared-formula cell that takes its master's, or null for a constant. */
  formula: string | null;
  shared: { si: string; master: boolean } | null;
  type: CellType;
  /** The cached value (formula) or the constant, as written; a shared string resolved; null when the cell holds none. */
  value: string | null;
}

export interface Validation {
  sqref: string;
  type: string;
  operator: string;
  formula1: string;
  formula2: string;
}

export interface Sheet {
  name: string;
  state: string;
  kind: 'worksheet' | 'chartsheet' | 'other';
  rows: Map<number, Map<number, Cell>>;
  cells: number;
  formulas: number;
  validations: Validation[];
  /** Shared-formula masters by `si`. */
  masters: Map<string, Cell>;
}

export interface DefinedName {
  name: string;
  /** The sheet index it is local to, or null for the whole workbook. */
  scope: number | null;
  text: string;
}

export interface Workbook {
  sheets: Sheet[];
  names: DefinedName[];
  /** The writer set `fullCalcOnLoad`: the cached values are not to be trusted until a spreadsheet program recalculates. */
  fullCalcOnLoad: boolean;
  cells: number;
}

/** A part name resolved against the folder of the part that names it; null when it climbs out of the archive. */
export function resolvePart(fromPart: string, target: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  const base = target.startsWith('/') ? [] : fromPart.split('/').slice(0, -1);
  const out = [...base];
  for (const seg of target.replace(/^\/+/, '').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.length === 0 ? null : out.join('/');
}

function relsPartOf(part: string): string {
  const i = part.lastIndexOf('/');
  return i === -1 ? `_rels/${part}.rels` : `${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`;
}

interface Rel {
  id: string;
  type: string;
  target: string | null;
}

function scanPart(z: ZipReader, name: string, open: (n: string, a: ReadonlyMap<string, string>, path: readonly string[]) => void, text?: (t: string, path: readonly string[]) => string | null, close?: (n: string, path: readonly string[]) => void): Read<boolean> {
  const t = z.text(name, MAX_PART_BYTES);
  if (t === null) return { ok: true, value: false };
  if (!t.ok) return t;
  const path: string[] = [];
  let err: string | null = null;
  const r = scanXml(t.value, {
    open(n, a) {
      if (err !== null) return;
      path.push(local(n));
      open(local(n), a, path);
    },
    close(n) {
      if (err === null && close !== undefined) close(local(n), path);
      path.pop();
    },
    text(s) {
      if (err === null && text !== undefined) err = text(s, path);
    },
  });
  if (!r.ok) return { ok: false, error: `${name}: ${r.error}` };
  if (err !== null) return { ok: false, error: `${name}: ${err}` };
  return { ok: true, value: true };
}

function readRels(z: ZipReader, part: string): Read<Rel[]> {
  const rels: Rel[] = [];
  const relsName = relsPartOf(part);
  const r = scanPart(z, relsName, (n, a) => {
    if (n !== 'Relationship') return;
    const external = (attrOf(a, 'TargetMode') ?? '').toLowerCase() === 'external';
    const target = attrOf(a, 'Target');
    rels.push({ id: attrOf(a, 'Id') ?? '', type: attrOf(a, 'Type') ?? '', target: external || target === undefined ? null : resolvePart(part, target) });
  });
  return r.ok ? { ok: true, value: rels } : r;
}

const CELL_TYPES: readonly string[] = ['n', 's', 'str', 'inlineStr', 'b', 'e', 'd'];

/** Reads a workbook. Any part that does not read, any limit passed, or a missing main part is an error, never a partial read. */
export function readWorkbook(buf: Buffer, limits: { maxCells?: number } = {}): Read<Workbook> {
  const maxCells = limits.maxCells ?? MAX_CELLS;
  const o = ZipReader.open(buf);
  if (!o.ok) return o;
  const z = o.value;
  if (officeKind(z.entries) !== 'xlsx' && !z.has('_rels/.rels')) return { ok: false, error: 'is not a workbook (no xl/workbook.xml)' };
  if (!z.has('[Content_Types].xml')) return { ok: false, error: 'is not an Office file (no [Content_Types].xml)' };
  const root = readRels(z, '');
  if (!root.ok) return root;
  const main = root.value.find((r) => r.type.endsWith('/officeDocument'))?.target ?? 'xl/workbook.xml';
  if (!z.has(main)) return { ok: false, error: `is not a workbook (no ${main})` };
  const wbRels = readRels(z, main);
  if (!wbRels.ok) return wbRels;
  const relById = new Map(wbRels.value.map((r) => [r.id, r]));

  const sheetsMeta: { name: string; state: string; rid: string }[] = [];
  const names: DefinedName[] = [];
  let fullCalcOnLoad = false;
  let nameOpen: DefinedName | null = null;
  let nameChars = 0;
  let rootName = '';
  const wb = scanPart(
    z,
    main,
    (n, a, path) => {
      if (path.length === 1) rootName = n;
      if (n === 'sheet' && path[path.length - 2] === 'sheets') sheetsMeta.push({ name: attrOf(a, 'name') ?? '', state: attrOf(a, 'state') ?? 'visible', rid: attrOf(a, 'id') ?? '' });
      else if (n === 'definedName') {
        const ls = attrOf(a, 'localSheetId');
        nameOpen = { name: attrOf(a, 'name') ?? '', scope: ls !== undefined && /^\d{1,4}$/.test(ls) ? Number(ls) : null, text: '' };
        nameChars = 0;
        names.push(nameOpen);
      } else if (n === 'calcPr') {
        const f = (attrOf(a, 'fullCalcOnLoad') ?? '').toLowerCase();
        fullCalcOnLoad = f === '1' || f === 'true';
      }
    },
    (t, path) => {
      if (path[path.length - 1] === 'definedName' && nameOpen !== null) {
        nameChars += t.length;
        if (nameChars > MAX_FORMULA_CHARS) return 'a defined name is longer than 16,384 characters';
        nameOpen.text += t;
      }
      return null;
    },
    (n) => {
      if (n === 'definedName') nameOpen = null;
    },
  );
  if (!wb.ok) return wb;
  if (rootName !== 'workbook') return { ok: false, error: `is not a workbook (${main} holds <${rootName.slice(0, 40)}>)` };
  if (sheetsMeta.length === 0) return { ok: false, error: `${main} lists no sheet` };
  if (sheetsMeta.length > MAX_SHEETS) return { ok: false, error: `lists ${sheetsMeta.length} sheets; at most ${MAX_SHEETS} are read` };

  const shared: string[] = [];
  const ssRel = wbRels.value.find((r) => r.type.endsWith('/sharedStrings'));
  const ssPart = ssRel?.target ?? (z.has('xl/sharedStrings.xml') ? 'xl/sharedStrings.xml' : null);
  if (ssPart !== null) {
    let cur: string | null = null;
    let tooLong = false;
    const ss = scanPart(
      z,
      ssPart,
      (n, _a, path) => {
        if (n === 'si' && path.length === 2) cur = '';
      },
      (t, path) => {
        if (cur === null || path[path.length - 1] !== 't' || path.includes('rPh')) return null;
        cur += t;
        if (cur.length > MAX_CELL_CHARS) tooLong = true;
        return tooLong ? `a shared string is longer than ${MAX_CELL_CHARS} characters` : null;
      },
      (n, path) => {
        if (n === 'si' && path.length === 2 && cur !== null) {
          shared.push(cur);
          cur = null;
        }
      },
    );
    if (!ss.ok) return ss;
  }

  const sheets: Sheet[] = [];
  let total = 0;
  for (const meta of sheetsMeta) {
    if (meta.name === '') return { ok: false, error: `${main} has a sheet with no name` };
    const rel = relById.get(meta.rid);
    const kind: Sheet['kind'] = rel === undefined ? 'other' : rel.type.endsWith('/worksheet') ? 'worksheet' : rel.type.endsWith('/chartsheet') ? 'chartsheet' : 'other';
    const sheet: Sheet = { name: meta.name, state: meta.state, kind, rows: new Map(), cells: 0, formulas: 0, validations: [], masters: new Map() };
    sheets.push(sheet);
    if (kind !== 'worksheet') continue;
    if (rel === undefined || rel.target === null) return { ok: false, error: `sheet ${JSON.stringify(meta.name)} has no part` };
    if (!z.has(rel.target)) return { ok: false, error: `sheet ${JSON.stringify(meta.name)}: its part ${rel.target} is missing` };
    const r = readSheet(z, rel.target, sheet, shared, maxCells - total, maxCells);
    if (!r.ok) return { ok: false, error: `sheet ${JSON.stringify(meta.name)}: ${r.error}` };
    total += sheet.cells;
  }
  const seen = new Set<string>();
  for (const s of sheets) {
    const k = s.name.toLowerCase();
    if (seen.has(k)) return { ok: false, error: `names the sheet ${JSON.stringify(s.name)} twice` };
    seen.add(k);
  }
  return { ok: true, value: { sheets, names, fullCalcOnLoad, cells: total } };
}

function readSheet(z: ZipReader, part: string, sheet: Sheet, shared: readonly string[], budget: number, maxCells: number): Read<null> {
  let rowNo = 0;
  let colNo = 0;
  let cell: Cell | null = null;
  let sawV = false;
  let vText = '';
  let fText: string | null = null;
  let isText: string | null = null;
  let error: string | null = null;
  let dv: Validation | null = null;
  let dvField: 'formula1' | 'formula2' | 'sqref' | null = null;
  const finishCell = (): string | null => {
    const c = cell;
    if (c === null) return null;
    if (c.type === 'inlineStr') c.value = isText;
    else if (sawV) {
      if (c.type === 's') {
        if (!/^\d{1,9}$/.test(vText.trim())) return `cell ${c.row}:${c.col} names shared string ${JSON.stringify(vText.slice(0, 20))}`;
        const s = shared[Number(vText.trim())];
        if (s === undefined) return `cell ${c.row}:${c.col} names shared string ${vText.trim()}, which does not exist`;
        c.value = s;
      } else c.value = vText;
    }
    if (fText !== null) c.formula = fText;
    if (c.formula !== null) sheet.formulas++;
    let row = sheet.rows.get(c.row);
    if (row === undefined) {
      row = new Map();
      sheet.rows.set(c.row, row);
    }
    if (row.has(c.col)) return `cell ${c.row}:${c.col} is written twice`;
    row.set(c.col, c);
    if (c.shared !== null && c.shared.master) sheet.masters.set(c.shared.si, c);
    if (++sheet.cells > budget) return `the workbook holds more than ${maxCells} cells, which is more than is read`;
    cell = null;
    return null;
  };
  const r = scanPart(
    z,
    part,
    (n, a, path) => {
      if (error !== null) return;
      const parent = path[path.length - 2];
      if (n === 'row' && parent === 'sheetData') {
        const rv = attrOf(a, 'r');
        if (rv !== undefined) {
          if (!/^\d{1,7}$/.test(rv) || Number(rv) < 1 || Number(rv) > 1_048_576) {
            error = `row number ${JSON.stringify(rv.slice(0, 20))} is not a row`;
            return;
          }
          rowNo = Number(rv);
        } else rowNo++;
        colNo = 0;
      } else if (n === 'c' && parent === 'row') {
        const ref = attrOf(a, 'r');
        if (ref !== undefined) {
          const p = parseCell(ref);
          if (p === null || p.row !== rowNo) {
            error = `cell reference ${JSON.stringify(ref.slice(0, 20))} is not in row ${rowNo}`;
            return;
          }
          colNo = p.col;
        } else colNo++;
        const t = attrOf(a, 't') ?? 'n';
        if (!CELL_TYPES.includes(t)) {
          error = `cell type ${JSON.stringify(t.slice(0, 20))} is not a cell type`;
          return;
        }
        cell = { row: rowNo, col: colNo, formula: null, shared: null, type: t as CellType, value: null };
        sawV = false;
        vText = '';
        fText = null;
        isText = null;
      } else if (cell !== null && parent === 'c') {
        if (n === 'f') {
          fText = '';
          const ft = attrOf(a, 't');
          const si = attrOf(a, 'si');
          if (ft === 'shared' && si !== undefined) cell.shared = { si, master: attrOf(a, 'ref') !== undefined };
        } else if (n === 'v') sawV = true;
        else if (n === 'is') isText = '';
      } else if (n === 'dataValidation') {
        dv = { sqref: attrOf(a, 'sqref') ?? '', type: attrOf(a, 'type') ?? 'none', operator: attrOf(a, 'operator') ?? '', formula1: '', formula2: '' };
        sheet.validations.push(dv);
        if (sheet.validations.length > 100_000) error = 'more than 100,000 data validations';
      } else if (dv !== null && (n === 'formula1' || n === 'formula2' || n === 'sqref')) dvField = n;
    },
    (t, path) => {
      if (error !== null) return error;
      const top = path[path.length - 1];
      if (cell !== null) {
        if (top === 'v' && path[path.length - 2] === 'c') {
          vText += t;
          if (vText.length > MAX_CELL_CHARS) return `a cell value is longer than ${MAX_CELL_CHARS} characters`;
        } else if (top === 'f' && path[path.length - 2] === 'c' && fText !== null) {
          fText += t;
          if (fText.length > MAX_FORMULA_CHARS) return 'a formula is longer than 16,384 characters';
        } else if (top === 't' && isText !== null && path.includes('is') && !path.includes('rPh')) {
          isText += t;
          if (isText.length > MAX_CELL_CHARS) return `a cell value is longer than ${MAX_CELL_CHARS} characters`;
        }
      } else if (dv !== null && dvField !== null) {
        const v = dv[dvField] + t;
        if (v.length > MAX_FORMULA_CHARS) return 'a data validation formula is longer than 16,384 characters';
        dv[dvField] = v;
      }
      return null;
    },
    (n, path) => {
      if (error !== null) return;
      if (n === 'c' && path[path.length - 2] === 'row') error = finishCell();
      else if (n === 'dataValidation') {
        dv = null;
        dvField = null;
      } else if (n === 'formula1' || n === 'formula2' || n === 'sqref') dvField = null;
    },
  );
  if (!r.ok) return r;
  if (error !== null) return { ok: false, error };
  return { ok: true, value: null };
}

/** The cell at a place, if any. */
export function cellAt(sheet: Sheet, row: number, col: number): Cell | undefined {
  return sheet.rows.get(row)?.get(col);
}

export function sheetByName(wb: Workbook, name: string): Sheet | undefined {
  const k = name.toLowerCase();
  return wb.sheets.find((s) => s.name.toLowerCase() === k);
}
