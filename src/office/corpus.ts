// The seeded corpus of `openmorals eval`'s office rows (Q8, 0.30.0): fake workbooks and Word documents built here from a
// seed, never copied from anywhere, each written in one of several writer styles (shared or inline strings, shared
// formulas or not, cells with or without their reference, a namespace prefix, split runs, revision ids, no styles part),
// then edited: clean edits that lose nothing the check looks at, damaged ones, workbooks that were not recalculated,
// and malformed or hostile files. Nothing is written to disk: rows are built in memory when eval runs.
import { deflateRawSync } from 'node:zlib';
import { crc32, zipEntries, zipRead } from './zip.js';
import { colLetters, colNumber, parseCell, shiftFormula } from './refs.js';

// ---------------------------------------------------------------------------------------------------------------- basics

/** mulberry32: a small seeded generator, so every run builds the same corpus. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: () => number, xs: readonly T[]): T {
  const x = xs[Math.floor(r() * xs.length)];
  if (x === undefined) throw new Error('pick from an empty list');
  return x;
}

function int(r: () => number, lo: number, hi: number): number {
  return lo + Math.floor(r() * (hi - lo + 1));
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface ZipItem {
  name: string;
  data: Buffer | string;
  store?: boolean;
}

/** A zip file (deflated entries unless `store`), with correct CRCs and sizes. `tamper` lets a malformed row lie in it. */
export function zipWrite(items: readonly ZipItem[], tamper: { flags?: number; crcXor?: number; sizeOf?: (n: string, real: number) => number; total?: number } = {}): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const it of items) {
    const data = typeof it.data === 'string' ? Buffer.from(it.data, 'utf8') : it.data;
    const body = it.store === true ? data : deflateRawSync(data);
    const method = it.store === true ? 0 : 8;
    const n = Buffer.from(it.name, 'utf8');
    const crc = (crc32(data) ^ (tamper.crcXor ?? 0)) >>> 0;
    const size = tamper.sizeOf !== undefined ? tamper.sizeOf(it.name, data.length) : data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(tamper.flags ?? 0, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(n.length, 26);
    locals.push(lh, n, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(tamper.flags ?? 0, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, n);
    offset += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(tamper.total ?? items.length, 8);
  end.writeUInt16LE(tamper.total ?? items.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---------------------------------------------------------------------------------------------------------------- workbooks

export type GValue = number | string | boolean | { error: string } | null;

export interface GCell {
  /** Formula text without `=`. */
  f?: string;
  /** The value (a constant, or a formula's cached result). */
  v: GValue;
  style?: number;
}

export interface GValidation {
  sqref: string;
  type: string;
  operator?: string;
  f1: string;
}

export interface GSheet {
  name: string;
  cells: Map<string, GCell>;
  validations: GValidation[];
}

export interface GBook {
  sheets: GSheet[];
  names: { name: string; scope?: number; text: string }[];
  fullCalcOnLoad?: boolean;
}

export interface BookStyle {
  id: string;
  strings: 'shared' | 'inline';
  prefix: '' | 'x:';
  refs: boolean;
  sharedFormulas: boolean;
  extValidations: boolean;
  /** Formulas written without cached values (a writer that does not calculate). */
  noCache?: 'all' | ((sheet: string, key: string) => boolean);
}

export const BOOK_STYLES: readonly BookStyle[] = [
  { id: 'excel-like', strings: 'shared', prefix: '', refs: true, sharedFormulas: true, extValidations: false },
  { id: 'prefixed', strings: 'shared', prefix: 'x:', refs: true, sharedFormulas: false, extValidations: false },
  { id: 'inline-no-refs', strings: 'inline', prefix: '', refs: false, sharedFormulas: false, extValidations: true },
];

const key = (r: number, c: number): string => `${r},${c}`;

function rc(k: string): [number, number] {
  const [a, b] = k.split(',');
  return [Number(a), Number(b)];
}

export function cloneBook(b: GBook): GBook {
  return {
    sheets: b.sheets.map((s) => ({ name: s.name, cells: new Map([...s.cells].map(([k, c]) => [k, { ...c, v: typeof c.v === 'object' && c.v !== null ? { ...c.v } : c.v }])), validations: s.validations.map((v) => ({ ...v })) })),
    names: b.names.map((n) => ({ ...n })),
    ...(b.fullCalcOnLoad !== undefined ? { fullCalcOnLoad: b.fullCalcOnLoad } : {}),
  };
}

function sheetOf(b: GBook, name: string): GSheet {
  const s = b.sheets.find((x) => x.name === name);
  if (s === undefined) throw new Error(`no sheet ${name}`);
  return s;
}

export function setCell(s: GSheet, ref: string, c: GCell): void {
  const p = parseCell(ref);
  if (p === null) throw new Error(`bad ref ${ref}`);
  s.cells.set(key(p.row, p.col), c);
}

export function getCell(s: GSheet, ref: string): GCell | undefined {
  const p = parseCell(ref);
  return p === null ? undefined : s.cells.get(key(p.row, p.col));
}

// A small evaluator for the formulas the generator writes: + - * /, unary minus, numbers, references with an optional
// sheet, ranges inside SUM, COUNT, AVERAGE and ROUND, and #REF!.
type EV = number | string | boolean | { error: string } | null | EV[];

function evalFormula(b: GBook, own: GSheet, f: string): GValue {
  let i = 0;
  const s = f.replace(/\s+/g, '');
  const err = (e: string): { error: string } => ({ error: e });
  const peek = (): string => s[i] ?? '';
  const refAt = (): { sheet: GSheet | null; r1: number; c1: number; r2: number; c2: number } | null => {
    const m = /^(?:('(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?/.exec(s.slice(i));
    if (m === null) return null;
    const after = s[i + m[0].length] ?? '';
    if (after === '(') return null;
    i += m[0].length;
    const sname = m[1] === undefined ? null : m[1].startsWith("'") ? m[1].slice(1, -1).replace(/''/g, "'") : m[1];
    const sheet = sname === null ? own : (b.sheets.find((x) => x.name === sname) ?? null);
    const c1 = colNumber(m[2] ?? '') ?? 0;
    const r1 = Number(m[3]);
    const c2 = m[4] !== undefined ? (colNumber(m[4]) ?? 0) : c1;
    const r2 = m[5] !== undefined ? Number(m[5]) : r1;
    return { sheet, r1, c1, r2, c2 };
  };
  const cellValue = (sh: GSheet, r: number, c: number): GValue => sh.cells.get(key(r, c))?.v ?? null;
  const num = (v: EV): number | { error: string } => {
    if (Array.isArray(v)) return err('#VALUE!');
    if (v === null) return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'object') return v;
    const n = Number(v);
    return Number.isFinite(n) && v.trim() !== '' ? n : err('#VALUE!');
  };
  const flat = (v: EV): GValue[] => (Array.isArray(v) ? v.flatMap(flat) : [v]);
  const expr = (): EV => {
    let left = term();
    while (peek() === '+' || peek() === '-') {
      const op = s[i++];
      const right = term();
      const x = num(left);
      const y = num(right);
      if (typeof x === 'object') return x;
      if (typeof y === 'object') return y;
      left = op === '+' ? x + y : x - y;
    }
    return left;
  };
  const term = (): EV => {
    let left = factor();
    while (peek() === '*' || peek() === '/') {
      const op = s[i++];
      const right = factor();
      const x = num(left);
      const y = num(right);
      if (typeof x === 'object') return x;
      if (typeof y === 'object') return y;
      if (op === '/' && y === 0) return err('#DIV/0!');
      left = op === '*' ? x * y : x / y;
    }
    return left;
  };
  const factor = (): EV => {
    if (peek() === '-') {
      i++;
      const v = num(factor());
      return typeof v === 'object' ? v : -v;
    }
    if (peek() === '(') {
      i++;
      const v = expr();
      i++;
      return v;
    }
    if (s.startsWith('#REF!', i)) {
      i += 5;
      return err('#REF!');
    }
    const n = /^\d+(\.\d+)?/.exec(s.slice(i));
    if (n !== null) {
      i += n[0].length;
      return Number(n[0]);
    }
    const fn = /^([A-Z]+)\(/.exec(s.slice(i));
    if (fn !== null) {
      i += fn[0].length;
      const args: EV[] = [];
      while (peek() !== ')') {
        args.push(expr());
        if (peek() === ',') i++;
      }
      i++;
      const vals = args.flatMap(flat);
      const errs = vals.find((v) => typeof v === 'object' && v !== null) as { error: string } | undefined;
      const nums = vals.filter((v): v is number => typeof v === 'number');
      switch (fn[1]) {
        case 'SUM':
          return errs ?? nums.reduce((a, x) => a + x, 0);
        case 'COUNT':
          return nums.length;
        case 'AVERAGE':
          return errs ?? (nums.length === 0 ? err('#DIV/0!') : nums.reduce((a, x) => a + x, 0) / nums.length);
        case 'ROUND': {
          const x = num(args[0] ?? 0);
          const d = num(args[1] ?? 0);
          if (typeof x === 'object') return x;
          if (typeof d === 'object') return d;
          const k = 10 ** d;
          return Math.round(x * k) / k;
        }
        default:
          return err('#NAME?');
      }
    }
    const ref = refAt();
    if (ref === null) return err('#NAME?');
    if (ref.sheet === null) return err('#REF!');
    if (ref.r1 === ref.r2 && ref.c1 === ref.c2) return cellValue(ref.sheet, ref.r1, ref.c1);
    const out: EV[] = [];
    for (let r = ref.r1; r <= ref.r2; r++) for (let c = ref.c1; c <= ref.c2; c++) out.push(cellValue(ref.sheet, r, c));
    return out;
  };
  const v = expr();
  if (Array.isArray(v)) return err('#VALUE!');
  if (typeof v === 'number') return Number.isFinite(v) ? Number(v.toPrecision(15)) : err('#NUM!');
  return v;
}

/** Recomputes every cached value, as a spreadsheet program does on save. */
export function recalc(b: GBook): GBook {
  for (let pass = 0; pass < 12; pass++) {
    let changed = false;
    for (const s of b.sheets) {
      for (const c of s.cells.values()) {
        if (c.f === undefined) continue;
        const v = evalFormula(b, s, c.f);
        if (JSON.stringify(v) !== JSON.stringify(c.v)) {
          c.v = v;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return b;
}

/** Moves references to rows at or after `at` on `target` by `delta` (rows inserted or deleted), as a spreadsheet does. */
export function moveRows(f: string, target: string, own: string, at: number, delta: number): string {
  return f.replace(/(?:('(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?(\$?)([A-Z]{1,3})(\$?)(\d+)(?::(\$?)([A-Z]{1,3})(\$?)(\d+))?(?![A-Za-z0-9_(])/g, (m: string, sh: string | undefined, d1: string, c1: string, d2: string, r1: string, d3: string | undefined, c2: string | undefined, d4: string | undefined, r2: string | undefined) => {
    const sname = sh === undefined ? own : sh.startsWith("'") ? sh.slice(1, -1).replace(/''/g, "'") : sh;
    if (sname !== target) return m;
    const mv = (r: number): number => (r >= at ? r + delta : r);
    const prefix = sh !== undefined ? `${sh}!` : '';
    const first = `${d1}${c1}${d2}${mv(Number(r1))}`;
    if (c2 === undefined || r2 === undefined) return `${prefix}${first}`;
    const lo = Number(r1);
    const hi = Number(r2);
    const nhi = hi >= at ? hi + delta : hi;
    const nlo = lo >= at ? lo + delta : lo;
    return `${prefix}${d1}${c1}${d2}${nlo}:${d3 ?? ''}${c2}${d4 ?? ''}${nhi}`;
  });
}

/** Inserts `n` empty rows at `at` on a sheet, moving cells, formulas, validations and names that point below. */
export function insertRows(b: GBook, sheetName: string, at: number, n: number): void {
  const s = sheetOf(b, sheetName);
  const moved = new Map<string, GCell>();
  for (const [k, c] of s.cells) {
    const [r, col] = rc(k);
    moved.set(key(r >= at ? r + n : r, col), c);
  }
  s.cells = moved;
  for (const sh of b.sheets) for (const c of sh.cells.values()) if (c.f !== undefined) c.f = moveRows(c.f, sheetName, sh.name, at, n);
  for (const v of s.validations) v.sqref = moveRows(v.sqref, sheetName, sheetName, at, n);
  for (const sh of b.sheets) for (const v of sh.validations) v.f1 = moveRows(v.f1, sheetName, sh.name, at, n);
  for (const nm of b.names) nm.text = moveRows(nm.text, sheetName, '\u0000', at, n);
}

/** Deletes one row, moving everything below up. */
export function deleteRow(b: GBook, sheetName: string, row: number): void {
  const s = sheetOf(b, sheetName);
  const moved = new Map<string, GCell>();
  for (const [k, c] of s.cells) {
    const [r, col] = rc(k);
    if (r === row) continue;
    moved.set(key(r > row ? r - 1 : r, col), c);
  }
  s.cells = moved;
  for (const sh of b.sheets) for (const c of sh.cells.values()) if (c.f !== undefined) c.f = moveRows(c.f, sheetName, sh.name, row + 1, -1);
  for (const v of s.validations) v.sqref = moveRows(v.sqref, sheetName, sheetName, row + 1, -1);
  for (const nm of b.names) nm.text = moveRows(nm.text, sheetName, '\u0000', row + 1, -1);
}

function cellXml(p: string, ref: string, c: GCell, st: BookStyle, shared: Map<string, number>, sheetName: string, k: string, sf: { si: number; ref?: string } | null, writeF: boolean): string {
  const attrs: string[] = [];
  if (st.refs) attrs.push(`r="${ref}"`);
  if (c.style !== undefined) attrs.push(`s="${c.style}"`);
  const v = c.v;
  let t = '';
  let inner = '';
  const noCache = c.f !== undefined && (st.noCache === 'all' || (typeof st.noCache === 'function' && st.noCache(sheetName, k)));
  if (typeof v === 'number') inner = noCache ? '' : `<${p}v>${v}</${p}v>`;
  else if (typeof v === 'boolean') {
    t = 'b';
    inner = noCache ? '' : `<${p}v>${v ? 1 : 0}</${p}v>`;
  } else if (v !== null && typeof v === 'object') {
    t = 'e';
    inner = noCache ? '' : `<${p}v>${esc(v.error)}</${p}v>`;
  } else if (typeof v === 'string') {
    if (c.f !== undefined) {
      t = 'str';
      inner = noCache ? '' : `<${p}v>${esc(v)}</${p}v>`;
    } else if (st.strings === 'shared') {
      t = 's';
      let idx = shared.get(v);
      if (idx === undefined) {
        idx = shared.size;
        shared.set(v, idx);
      }
      inner = `<${p}v>${idx}</${p}v>`;
    } else {
      t = 'inlineStr';
      inner = `<${p}is><${p}t xml:space="preserve">${esc(v)}</${p}t></${p}is>`;
    }
  }
  if (t !== '') attrs.push(`t="${t}"`);
  let fx = '';
  if (c.f !== undefined && writeF) {
    if (sf !== null) fx = sf.ref !== undefined ? `<${p}f t="shared" ref="${sf.ref}" si="${sf.si}">${esc(c.f)}</${p}f>` : `<${p}f t="shared" si="${sf.si}"/>`;
    else fx = `<${p}f>${esc(c.f)}</${p}f>`;
  }
  if (st.id === 'inline-no-refs') attrs.reverse();
  return `<${p}c${attrs.length > 0 ? ` ${attrs.join(' ')}` : ''}>${fx}${inner}</${p}c>`;
}

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** Writes a workbook in a writer style. */
export function writeBook(b: GBook, st: BookStyle): Buffer {
  const p = st.prefix;
  const xmlns = p === '' ? `xmlns="${NS}"` : `xmlns:${p.slice(0, -1)}="${NS}"`;
  const shared = new Map<string, number>();
  const sheetsXml: string[] = [];
  b.sheets.forEach((s, si) => {
    const rows = new Map<number, [number, string, GCell][]>();
    for (const [k, c] of s.cells) {
      const [r, col] = rc(k);
      const list = rows.get(r) ?? [];
      list.push([col, k, c]);
      rows.set(r, list);
    }
    const sharedOf = new Map<string, { si: number; ref?: string }>();
    if (st.sharedFormulas) {
      let next = 0;
      const cols = new Map<number, [number, string, GCell][]>();
      for (const [k, c] of s.cells) {
        if (c.f === undefined) continue;
        const [r, col] = rc(k);
        const list = cols.get(col) ?? [];
        list.push([r, k, c]);
        cols.set(col, list);
      }
      for (const [col, list] of cols) {
        list.sort((x, y) => x[0] - y[0]);
        let i = 0;
        while (i < list.length) {
          const first = list[i];
          if (first === undefined) break;
          let j = i + 1;
          while (j < list.length) {
            const cur = list[j];
            const prevRow = list[j - 1]?.[0] ?? 0;
            if (cur === undefined || cur[0] !== prevRow + 1 || shiftFormula(first[2].f ?? '', cur[0] - first[0], 0) !== cur[2].f) break;
            j++;
          }
          if (j - i >= 3) {
            const si = next++;
            const last = list[j - 1];
            sharedOf.set(first[1], { si, ref: `${colLetters(col)}${first[0]}:${colLetters(col)}${last?.[0] ?? first[0]}` });
            for (let x = i + 1; x < j; x++) {
              const it = list[x];
              if (it !== undefined) sharedOf.set(it[1], { si });
            }
          }
          i = j;
        }
      }
    }
    const rowXml = [...rows.entries()]
      .sort((x, y) => x[0] - y[0])
      .map(([r, cells]) => {
        cells.sort((x, y) => x[0] - y[0]);
        if (!st.refs) {
          let prev = 0;
          for (const [col] of cells) {
            if (col !== prev + 1) return null;
            prev = col;
          }
        }
        const inner = cells.map(([col, k, c]) => cellXml(p, `${colLetters(col)}${r}`, c, st, shared, s.name, k, sharedOf.get(k) ?? null, true)).join('');
        return `<${p}row${st.refs ? ` r="${r}"` : ''}>${inner}</${p}row>`;
      });
    let body: string;
    if (rowXml.some((x) => x === null)) {
      body = [...rows.entries()]
        .sort((x, y) => x[0] - y[0])
        .map(([r, cells]) => `<${p}row r="${r}">${cells.map(([col, k, c]) => cellXml(p, `${colLetters(col)}${r}`, c, { ...st, refs: true }, shared, s.name, k, sharedOf.get(k) ?? null, true)).join('')}</${p}row>`)
        .join('');
    } else if (!st.refs) {
      const sorted = [...rows.keys()].sort((x, y) => x - y);
      body = sorted.map((r, idx) => {
        const xml = rowXml[idx] ?? '';
        return r === (sorted[idx - 1] ?? 0) + 1 ? xml : xml.replace(`<${p}row>`, `<${p}row r="${r}">`);
      }).join('');
    } else body = rowXml.join('');
    let dv = '';
    let ext = '';
    const normal = st.extValidations ? s.validations.filter((v) => !v.f1.includes('!')) : s.validations;
    const crossSheet = st.extValidations ? s.validations.filter((v) => v.f1.includes('!')) : [];
    if (normal.length > 0) dv = `<${p}dataValidations count="${normal.length}">${normal.map((v) => `<${p}dataValidation type="${v.type}"${v.operator !== undefined ? ` operator="${v.operator}"` : ''} allowBlank="1" sqref="${v.sqref}"><${p}formula1>${esc(v.f1)}</${p}formula1></${p}dataValidation>`).join('')}</${p}dataValidations>`;
    if (crossSheet.length > 0) {
      ext = `<${p}extLst><${p}ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:dataValidations count="${crossSheet.length}" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">${crossSheet
        .map((v) => `<x14:dataValidation type="${v.type}" allowBlank="1"><x14:formula1><xm:f>${esc(v.f1)}</xm:f></x14:formula1><xm:sqref>${v.sqref}</xm:sqref></x14:dataValidation>`)
        .join('')}</x14:dataValidations></${p}ext></${p}extLst>`;
    }
    sheetsXml[si] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${p}worksheet ${xmlns} xmlns:r="${RNS}"><${p}sheetData>${body}</${p}sheetData>${dv}${ext}</${p}worksheet>`;
  });
  const names = b.names.length > 0 ? `<${p}definedNames>${b.names.map((n) => `<${p}definedName name="${esc(n.name)}"${n.scope !== undefined ? ` localSheetId="${n.scope}"` : ''}>${esc(n.text)}</${p}definedName>`).join('')}</${p}definedNames>` : '';
  const wb = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${p}workbook ${xmlns} xmlns:r="${RNS}"><${p}sheets>${b.sheets.map((s, i) => `<${p}sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</${p}sheets>${names}<${p}calcPr calcId="191029"${b.fullCalcOnLoad === true ? ' fullCalcOnLoad="1"' : ''}/></${p}workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${PKG}">${b.sheets.map((_s, i) => `<Relationship Id="rId${i + 1}" Type="${RNS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${b.sheets.length + 1}" Type="${RNS}/styles" Target="styles.xml"/>${st.strings === 'shared' ? `<Relationship Id="rId${b.sheets.length + 2}" Type="${RNS}/sharedStrings" Target="sharedStrings.xml"/>` : ''}</Relationships>`;
  const sst = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${p}sst ${xmlns} count="${shared.size}" uniqueCount="${shared.size}">${[...shared.keys()].map((t) => `<${p}si><${p}t xml:space="preserve">${esc(t)}</${p}t></${p}si>`).join('')}</${p}sst>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${p}styleSheet ${xmlns}><${p}cellXfs count="4"><${p}xf/><${p}xf/><${p}xf/><${p}xf/></${p}cellXfs></${p}styleSheet>`;
  const items: ZipItem[] = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${RNS}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: wb },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/styles.xml', data: styles },
    ...sheetsXml.map((x, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: x })),
  ];
  if (st.strings === 'shared') items.push({ name: 'xl/sharedStrings.xml', data: sst });
  return zipWrite(items);
}

const ITEMS = ['Widget', 'Gadget', 'Bracket', 'Sprocket', 'Panel', 'Cable', 'Lamp', 'Valve', 'Hinge', 'Gasket', 'Pulley', 'Clamp', 'Spring', 'Washer', 'Bolt', 'Rivet', 'Filter', 'Sensor'];
const REGIONS = ['North', 'South', 'East', 'West'];

export interface BudgetBook {
  book: GBook;
  /** First and last data row of the Data sheet. */
  first: number;
  last: number;
}

/** Recipe W1: inputs, a data table with a formula column, totals, a count, a summary sheet, names and validations. */
export function budgetBook(seed: number): BudgetBook {
  const r = rng(seed);
  const n = int(r, 6, 14);
  const inputs: GSheet = { name: 'Inputs', cells: new Map(), validations: [] };
  setCell(inputs, 'A1', { v: 'Assumption' });
  setCell(inputs, 'B1', { v: 'Value' });
  setCell(inputs, 'A2', { v: 'Tax rate' });
  setCell(inputs, 'B2', { v: pick(r, [0.15, 0.2, 0.25]) });
  setCell(inputs, 'A3', { v: 'Discount' });
  setCell(inputs, 'B3', { v: pick(r, [0.02, 0.05, 0.1]) });
  setCell(inputs, 'A4', { v: 'Headcount' });
  setCell(inputs, 'B4', { v: int(r, 3, 40) });
  setCell(inputs, 'A5', { v: 'Growth' });
  setCell(inputs, 'B5', { v: pick(r, [0.01, 0.03, 0.04]) });
  const data: GSheet = { name: 'Data', cells: new Map(), validations: [] };
  ['Item', 'Qty', 'Price', 'Amount', 'Region'].forEach((h, i) => setCell(data, `${colLetters(i + 1)}1`, { v: h }));
  const names = [...ITEMS].sort(() => r() - 0.5).slice(0, n);
  for (let i = 0; i < n; i++) {
    const row = i + 2;
    setCell(data, `A${row}`, { v: `${names[i] ?? 'Item'} ${String.fromCharCode(65 + i)}` });
    setCell(data, `B${row}`, { v: int(r, 1, 90) });
    setCell(data, `C${row}`, { v: int(r, 100, 9999) / 100 });
    setCell(data, `D${row}`, { f: `B${row}*C${row}`, v: 0 });
    setCell(data, `E${row}`, { v: pick(r, REGIONS) });
  }
  const last = n + 1;
  setCell(data, `A${last + 1}`, { v: 'Total' });
  setCell(data, `B${last + 1}`, { f: `SUM(B2:B${last})`, v: 0 });
  setCell(data, `D${last + 1}`, { f: `SUM(D2:D${last})`, v: 0 });
  setCell(data, `A${last + 2}`, { v: 'Count' });
  setCell(data, `B${last + 2}`, { f: `COUNT(B2:B${last})`, v: 0 });
  data.validations.push({ sqref: `B2:B${last}`, type: 'whole', operator: 'greaterThanOrEqual', f1: '0' });
  data.validations.push({ sqref: `E2:E${last}`, type: 'list', f1: 'Lists!$A$1:$A$4' });
  const lists: GSheet = { name: 'Lists', cells: new Map(), validations: [] };
  REGIONS.forEach((g, i) => setCell(lists, `A${i + 1}`, { v: g }));
  const summary: GSheet = { name: 'Summary', cells: new Map(), validations: [] };
  setCell(summary, 'A1', { v: 'Net total' });
  setCell(summary, 'B1', { f: `Data!D${last + 1}*(1-Inputs!B3)`, v: 0 });
  setCell(summary, 'A2', { v: 'Tax' });
  setCell(summary, 'B2', { f: 'B1*Inputs!B2', v: 0 });
  setCell(summary, 'A3', { v: 'Average amount' });
  setCell(summary, 'B3', { f: `AVERAGE(Data!D2:D${last})`, v: 0 });
  setCell(summary, 'A4', { v: 'Per head' });
  setCell(summary, 'B4', { f: 'ROUND(B1/Inputs!B4,2)', v: 0 });
  const book: GBook = {
    sheets: [inputs, data, lists, summary],
    names: [
      { name: 'TaxRate', text: 'Inputs!$B$2' },
      { name: 'Assumptions', text: 'Inputs!$B$2:$B$5' },
      { name: 'Regions', text: 'Lists!$A$1:$A$4' },
    ],
  };
  return { book: recalc(book), first: 2, last };
}

/** Recipe W2: a ledger of constants (no formula per row) with totals, a count and an average, a rate sheet and names. */
export function ledgerBook(seed: number): BudgetBook {
  const r = rng(seed);
  const m = int(r, 8, 20);
  const ledger: GSheet = { name: 'Ledger', cells: new Map(), validations: [] };
  ['Date', 'Region', 'Amount', 'Ref'].forEach((h, i) => setCell(ledger, `${colLetters(i + 1)}1`, { v: h }));
  for (let i = 0; i < m; i++) {
    const row = i + 2;
    setCell(ledger, `A${row}`, { v: 46300 + int(r, 0, 60) });
    setCell(ledger, `B${row}`, { v: pick(r, REGIONS) });
    setCell(ledger, `C${row}`, { v: int(r, 500, 250000) / 100 });
    setCell(ledger, `D${row}`, { v: `L-${String(100 + i)}` });
  }
  const last = m + 1;
  setCell(ledger, `A${last + 2}`, { v: 'Total' });
  setCell(ledger, `C${last + 2}`, { f: `SUM(C2:C${last})`, v: 0 });
  setCell(ledger, `A${last + 3}`, { v: 'Entries' });
  setCell(ledger, `C${last + 3}`, { f: `COUNT(C2:C${last})`, v: 0 });
  setCell(ledger, `A${last + 4}`, { v: 'Average' });
  setCell(ledger, `C${last + 4}`, { f: `AVERAGE(C2:C${last})`, v: 0 });
  setCell(ledger, `A${last + 5}`, { v: 'In euro' });
  setCell(ledger, `C${last + 5}`, { f: `C${last + 2}*Rates!B1`, v: 0 });
  ledger.validations.push({ sqref: `B2:B${last}`, type: 'list', f1: 'Lists!$A$1:$A$4' });
  ledger.validations.push({ sqref: `C2:C${last}`, type: 'decimal', operator: 'greaterThan', f1: '0' });
  const lists: GSheet = { name: 'Lists', cells: new Map(), validations: [] };
  REGIONS.forEach((g, i) => setCell(lists, `A${i + 1}`, { v: g }));
  const rates: GSheet = { name: 'Rates', cells: new Map(), validations: [] };
  setCell(rates, 'A1', { v: 'FX rate' });
  setCell(rates, 'B1', { v: pick(r, [0.91, 0.92, 0.95]) });
  setCell(rates, 'A2', { v: 'Fee' });
  setCell(rates, 'B2', { v: pick(r, [1.5, 2, 2.5]) });
  const book: GBook = {
    sheets: [ledger, lists, rates],
    names: [
      { name: 'FX', text: 'Rates!$B$1' },
      { name: 'Regions', text: 'Lists!$A$1:$A$4' },
      { name: 'Amounts', text: `Ledger!$C$2:$C$${last}` },
      { name: '_xlnm._FilterDatabase', scope: 0, text: `Ledger!$A$1:$D$${last}` },
    ],
  };
  return { book: recalc(book), first: 2, last };
}

// ---------------------------------------------------------------------------------------------------------------- documents

export interface GRun {
  text: string;
  ins?: boolean;
  del?: boolean;
}

export type GBlock = { kind: 'p'; style: string | null; outline?: number; runs: GRun[]; markIns?: boolean } | { kind: 'table'; rows: string[][] };

export interface GDoc {
  blocks: GBlock[];
}

export interface DocStyle {
  id: string;
  prefix: string;
  styles: boolean;
  splitRuns: boolean;
  rsid: boolean;
  proofErr: boolean;
  bookmarks: boolean;
}

export const DOC_STYLES: readonly DocStyle[] = [
  { id: 'word-like', prefix: 'w', styles: true, splitRuns: true, rsid: true, proofErr: true, bookmarks: true },
  { id: 'plain', prefix: 'w', styles: false, splitRuns: false, rsid: false, proofErr: false, bookmarks: false },
  { id: 'ns0-prefix', prefix: 'ns0', styles: true, splitRuns: false, rsid: false, proofErr: false, bookmarks: true },
];

export function cloneDoc(d: GDoc): GDoc {
  return { blocks: d.blocks.map((b) => (b.kind === 'p' ? { ...b, runs: b.runs.map((x) => ({ ...x })) } : { kind: 'table', rows: b.rows.map((r) => [...r]) })) };
}

const WNS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function runsXml(p: string, runs: readonly GRun[], st: DocStyle, r: () => number): string {
  let id = 1;
  const runOne = (text: string, del: boolean): string => {
    const pieces: string[] = [];
    if (st.splitRuns && text.length > 12) {
      const cut = 3 + Math.floor(r() * (text.length - 6));
      pieces.push(text.slice(0, cut), text.slice(cut));
    } else pieces.push(text);
    return pieces.map((t) => `<${p}:r${st.rsid ? ` ${p}:rsidR="00${int(r, 100000, 999999)}"` : ''}><${p}:${del ? 'delText' : 't'} xml:space="preserve">${esc(t)}</${p}:${del ? 'delText' : 't'}></${p}:r>${st.proofErr && r() < 0.2 ? `<${p}:proofErr ${p}:type="spellStart"/>` : ''}`).join('');
  };
  return runs
    .map((x) => {
      if (x.ins === true) return `<${p}:ins ${p}:id="${id++}" ${p}:author="Reviewer" ${p}:date="2026-11-20T10:00:00Z">${runOne(x.text, false)}</${p}:ins>`;
      if (x.del === true) return `<${p}:del ${p}:id="${id++}" ${p}:author="Reviewer" ${p}:date="2026-11-20T10:00:00Z">${runOne(x.text, true)}</${p}:del>`;
      return runOne(x.text, false);
    })
    .join('');
}

/** Writes a Word document in a writer style. */
export function writeDoc(d: GDoc, st: DocStyle, seed: number): Buffer {
  const r = rng(seed);
  const p = st.prefix;
  let mark = 0;
  const body = d.blocks
    .map((b) => {
      if (b.kind === 'table') {
        return `<${p}:tbl><${p}:tblPr><${p}:tblW ${p}:w="0" ${p}:type="auto"/></${p}:tblPr>${b.rows.map((row) => `<${p}:tr>${row.map((c) => `<${p}:tc><${p}:p><${p}:r><${p}:t xml:space="preserve">${esc(c)}</${p}:t></${p}:r></${p}:p></${p}:tc>`).join('')}</${p}:tr>`).join('')}</${p}:tbl>`;
      }
      const pPr: string[] = [];
      if (b.style !== null) pPr.push(`<${p}:pStyle ${p}:val="${b.style}"/>`);
      if (b.outline !== undefined) pPr.push(`<${p}:outlineLvl ${p}:val="${b.outline}"/>`);
      if (b.markIns === true) pPr.push(`<${p}:rPr><${p}:ins ${p}:id="900" ${p}:author="Reviewer" ${p}:date="2026-11-20T10:00:00Z"/></${p}:rPr>`);
      const bm = st.bookmarks && b.style !== null ? `<${p}:bookmarkStart ${p}:id="${mark}" ${p}:name="_Toc${100 + mark}"/>` : '';
      const bmEnd = st.bookmarks && b.style !== null ? `<${p}:bookmarkEnd ${p}:id="${mark++}"/>` : '';
      return `<${p}:p${st.rsid ? ` ${p}:rsidR="00${int(r, 100000, 999999)}" ${p}:rsidRDefault="00${int(r, 100000, 999999)}"` : ''}>${pPr.length > 0 ? `<${p}:pPr>${pPr.join('')}</${p}:pPr>` : ''}${bm}${runsXml(p, b.runs, st, r)}${bmEnd}</${p}:p>`;
    })
    .join('');
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${p}:document xmlns:${p}="${WNS}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><${p}:body>${body}<${p}:sectPr/></${p}:body></${p}:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<${p}:styles xmlns:${p}="${WNS}"><${p}:style ${p}:type="paragraph" ${p}:default="1" ${p}:styleId="Normal"><${p}:name ${p}:val="Normal"/></${p}:style><${p}:style ${p}:type="paragraph" ${p}:styleId="Title"><${p}:name ${p}:val="Title"/><${p}:basedOn ${p}:val="Normal"/></${p}:style><${p}:style ${p}:type="paragraph" ${p}:styleId="Heading1"><${p}:name ${p}:val="heading 1"/><${p}:basedOn ${p}:val="Normal"/><${p}:pPr><${p}:outlineLvl ${p}:val="0"/></${p}:pPr></${p}:style><${p}:style ${p}:type="paragraph" ${p}:styleId="Heading2"><${p}:name ${p}:val="heading 2"/><${p}:basedOn ${p}:val="Normal"/><${p}:pPr><${p}:outlineLvl ${p}:val="1"/></${p}:pPr></${p}:style></${p}:styles>`;
  const items: ZipItem[] = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${RNS}/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: 'word/document.xml', data: doc },
  ];
  if (st.styles) {
    items.push({ name: 'word/_rels/document.xml.rels', data: `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${RNS}/styles" Target="styles.xml"/><Relationship Id="rId9" Type="${RNS}/hyperlink" Target="https://example.test/terms" TargetMode="External"/></Relationships>` });
    items.push({ name: 'word/styles.xml', data: styles });
  }
  return zipWrite(items);
}

const para = (text: string, style: string | null = null): GBlock => ({ kind: 'p', style, runs: [{ text }] });

const SUPPLIERS = ['Northwind Ltd', 'Harbour Works Ltd', 'Bluefield Services', 'Copperleaf Co'];
const CUSTOMERS = ['Example Co', 'Sample Holdings', 'Demo Retail Ltd', 'Placeholder Group'];

/** Recipe D1: a short services agreement with defined terms, numbered headings and a fee table. */
export function contractDoc(seed: number): GDoc {
  const r = rng(seed);
  const sup = pick(r, SUPPLIERS);
  const cus = pick(r, CUSTOMERS);
  return {
    blocks: [
      para('Services Agreement', 'Title'),
      para(`This agreement is made between ${sup} (the "Supplier") and ${cus} (the "Customer").`),
      para('1. Definitions', 'Heading1'),
      para('"Agreement" means this services agreement and its schedules.'),
      para(`"Services" means the ${pick(r, ['maintenance', 'support', 'hosting'])} services described in Schedule 1.`),
      para('"Fees" means the amounts set out in clause 3.'),
      para('2. Services', 'Heading1'),
      para(`The Supplier provides the Services from ${pick(r, ['1 January', '1 March', '1 June'])} 2027 with reasonable skill and care.`),
      para(`Service hours are ${pick(r, ['8:00 to 18:00', '9:00 to 17:00'])} on working days.`),
      para('3. Fees', 'Heading1'),
      para('The Customer pays the Fees in the table below within 30 days of each invoice.'),
      { kind: 'table', rows: [['Item', 'Amount'], ['Setup', `${int(r, 5, 30) * 100}`], ['Monthly support', `${int(r, 2, 9) * 50}`]] },
      para('4. Term', 'Heading1'),
      para(`This Agreement starts on signature and lasts ${pick(r, ['12', '24', '36'])} months.`),
      para('4.1 Renewal', 'Heading2'),
      para('It renews for a further year unless either party gives three months notice.'),
      para('5. Signatures', 'Heading1'),
      para('Signed for the Supplier and for the Customer.'),
    ],
  };
}

/** Recipe D2: a quarterly report with a figures table and one defined term. */
export function reportDoc(seed: number): GDoc {
  const r = rng(seed);
  return {
    blocks: [
      para('Quarterly Operations Report', 'Title'),
      para('Summary', 'Heading1'),
      para(`Volumes rose by ${int(r, 2, 19)} percent; this report goes to the operations board (the "Board").`),
      para('Findings', 'Heading1'),
      para('Volumes', 'Heading2'),
      { kind: 'table', rows: [['Month', 'Orders', 'Returns'], ['October', `${int(r, 900, 2000)}`, `${int(r, 10, 90)}`], ['November', `${int(r, 900, 2000)}`, `${int(r, 10, 90)}`], ['December', `${int(r, 900, 2000)}`, `${int(r, 10, 90)}`]] },
      para('Quality', 'Heading2'),
      para(`Returns stayed under ${int(r, 2, 5)} percent of orders in every month.`),
      para('Risks', 'Heading1'),
      para(`Supplier lead times grew to ${int(r, 3, 12)} weeks.`),
      para('Next steps', 'Heading1'),
      para('The Board reviews the stock plan at its next meeting.'),
    ],
  };
}

// ---------------------------------------------------------------------------------------------------------------- rows

export type RowKind = 'clean' | 'damaged' | 'not-computed' | 'malformed';

export interface OfficeRow {
  id: string;
  format: 'xlsx' | 'docx';
  kind: RowKind;
  /** What the check must say: pass, fail (with `check` among the failing lines), or not computed. */
  expect: 'pass' | 'fail' | 'not computed';
  check?: string;
  inputs?: string[];
  redline?: boolean;
  label: string;
  build: () => { before: Buffer; after: Buffer };
}

type BookEdit = { id: string; label: string; kind: RowKind; expect: OfficeRow['expect']; check?: string; recipes: ('budget' | 'ledger')[]; afterStyle?: (s: BookStyle) => BookStyle; edit: (b: GBook, w: BudgetBook) => void };

function bookEdits(): BookEdit[] {
  return [
    { id: 'label-text', label: 'a label text changed', kind: 'clean', expect: 'pass', recipes: ['budget', 'ledger'], edit: (b) => setCell(sheetOf(b, b.sheets[0]?.name === 'Ledger' ? 'Lists' : 'Data'), 'A1', { v: b.sheets[0]?.name === 'Ledger' ? 'North region' : 'Item name' }) },
    {
      id: 'append-rows',
      label: 'two data rows appended, totals widened and recomputed',
      kind: 'clean',
      expect: 'pass',
      recipes: ['budget', 'ledger'],
      edit: (b, w) => {
        const ledger = b.sheets[0]?.name === 'Ledger';
        const s = sheetOf(b, ledger ? 'Ledger' : 'Data');
        insertRows(b, s.name, w.last + 1, 2);
        for (const row of [w.last + 1, w.last + 2]) {
          if (ledger) {
            setCell(s, `A${row}`, { v: 46400 + row });
            setCell(s, `B${row}`, { v: 'East' });
            setCell(s, `C${row}`, { v: 120.5 + row });
            setCell(s, `D${row}`, { v: `L-9${row}` });
          } else {
            setCell(s, `A${row}`, { v: `New item ${row}` });
            setCell(s, `B${row}`, { v: 7 });
            setCell(s, `C${row}`, { v: 12.25 });
            setCell(s, `D${row}`, { f: `B${row}*C${row}`, v: 0 });
            setCell(s, `E${row}`, { v: 'West' });
          }
        }
        const nl = w.last + 2;
        for (const sh of b.sheets) for (const c of sh.cells.values()) if (c.f !== undefined) c.f = c.f.replace(new RegExp(`(${s.name}!)?([A-Z])2:([A-Z])${w.last}\\b`, 'g'), (m: string) => m.replace(new RegExp(`${w.last}$`), String(nl)));
        recalc(b);
      },
    },
    {
      id: 'insert-row',
      label: 'a data row inserted mid-table, references moved and recomputed',
      kind: 'clean',
      expect: 'pass',
      recipes: ['budget', 'ledger'],
      edit: (b, w) => {
        const ledger = b.sheets[0]?.name === 'Ledger';
        const s = sheetOf(b, ledger ? 'Ledger' : 'Data');
        const at = w.first + 3;
        insertRows(b, s.name, at, 1);
        if (ledger) {
          setCell(s, `A${at}`, { v: 46333 });
          setCell(s, `B${at}`, { v: 'South' });
          setCell(s, `C${at}`, { v: 333.33 });
          setCell(s, `D${at}`, { v: 'L-777' });
        } else {
          setCell(s, `A${at}`, { v: 'Inserted item' });
          setCell(s, `B${at}`, { v: 3 });
          setCell(s, `C${at}`, { v: 9.99 });
          setCell(s, `D${at}`, { f: `B${at}*C${at}`, v: 0 });
          setCell(s, `E${at}`, { v: 'North' });
        }
        recalc(b);
      },
    },
    { id: 'add-sheet', label: 'a sheet added', kind: 'clean', expect: 'pass', recipes: ['budget', 'ledger'], edit: (b) => b.sheets.push({ name: 'Notes', cells: new Map([[key(1, 1), { v: 'Checked against the bank statement.' }]]), validations: [] }) },
    {
      id: 'add-formula-column',
      label: 'a formula column added with computed values',
      kind: 'clean',
      expect: 'pass',
      recipes: ['budget', 'ledger'],
      edit: (b, w) => {
        const ledger = b.sheets[0]?.name === 'Ledger';
        const s = sheetOf(b, ledger ? 'Ledger' : 'Data');
        setCell(s, ledger ? 'E1' : 'F1', { v: ledger ? 'Net' : 'With tax' });
        for (let row = w.first; row <= w.last; row++) setCell(s, `${ledger ? 'E' : 'F'}${row}`, { f: ledger ? `C${row}-Rates!$B$2` : `D${row}*(1+Inputs!$B$2)`, v: 0 });
        recalc(b);
      },
    },
    { id: 'resave', label: 're-saved by another writer style', kind: 'clean', expect: 'pass', recipes: ['budget', 'ledger'], afterStyle: (s) => BOOK_STYLES[(BOOK_STYLES.indexOf(s) + 1) % BOOK_STYLES.length] ?? s, edit: () => undefined },
    {
      id: 'constant-recalc',
      label: 'a non-input constant changed and everything recomputed',
      kind: 'clean',
      expect: 'pass',
      recipes: ['budget', 'ledger'],
      edit: (b, w) => {
        const ledger = b.sheets[0]?.name === 'Ledger';
        setCell(sheetOf(b, ledger ? 'Ledger' : 'Data'), `${ledger ? 'C' : 'C'}${w.first + 1}`, { v: 77.7 });
        recalc(b);
      },
    },
    { id: 'add-validation', label: 'a data validation added', kind: 'clean', expect: 'pass', recipes: ['budget', 'ledger'], edit: (b, w) => (b.sheets[0]?.name === 'Ledger' ? sheetOf(b, 'Ledger') : sheetOf(b, 'Data')).validations.push({ sqref: `A2:A${w.last}`, type: 'textLength', operator: 'lessThan', f1: '60' }) },
    { id: 'add-name', label: 'a defined name added', kind: 'clean', expect: 'pass', recipes: ['budget', 'ledger'], edit: (b, w) => b.names.push({ name: 'Totals', text: b.sheets[0]?.name === 'Ledger' ? `Ledger!$C$${w.last + 2}` : `Data!$D$${w.last + 1}` }) },
    {
      id: 'style-only',
      label: 'a style-only change',
      kind: 'clean',
      expect: 'pass',
      recipes: ['budget', 'ledger'],
      edit: (b) => {
        for (const s of b.sheets) for (const c of s.cells.values()) if (typeof c.v === 'number') c.style = 2;
      },
    },
    {
      id: 'delete-constant-row',
      label: 'a constant-only data row deleted and recomputed',
      kind: 'clean',
      expect: 'pass',
      recipes: ['ledger', 'ledger'],
      edit: (b, w) => {
        deleteRow(b, 'Ledger', w.first + 2);
        recalc(b);
      },
    },
    // ------------------------------------------------------------------------------------------------ damaged
    {
      id: 'one-formula-to-value',
      label: 'one formula replaced by its value',
      kind: 'damaged',
      expect: 'fail',
      check: 'formulas-to-constants',
      recipes: ['budget', 'ledger'],
      edit: (b, w) => {
        const ledger = b.sheets[0]?.name === 'Ledger';
        const c = getCell(sheetOf(b, ledger ? 'Ledger' : 'Data'), ledger ? `C${w.last + 4}` : `D${w.first + 1}`);
        if (c !== undefined) delete c.f;
      },
    },
    {
      id: 'values-only',
      label: 'every formula replaced by its value (a values-only save)',
      kind: 'damaged',
      expect: 'fail',
      check: 'formulas-to-constants',
      recipes: ['budget', 'ledger'],
      edit: (b) => {
        for (const s of b.sheets) for (const c of s.cells.values()) delete c.f;
      },
    },
    {
      id: 'formula-emptied',
      label: 'a formula cell emptied',
      kind: 'damaged',
      expect: 'fail',
      check: 'formulas-removed',
      recipes: ['budget', 'ledger'],
      edit: (b, w) => {
        const ledger = b.sheets[0]?.name === 'Ledger';
        const s = sheetOf(b, ledger ? 'Ledger' : 'Summary');
        const p = parseCell(ledger ? `C${w.last + 4}` : 'B3');
        if (p !== null) s.cells.delete(key(p.row, p.col));
      },
    },
    { id: 'sheet-deleted', label: 'a sheet deleted', kind: 'damaged', expect: 'fail', check: 'sheets', recipes: ['budget', 'ledger'], edit: (b) => b.sheets.splice(b.sheets.findIndex((s) => s.name === 'Lists'), 1) },
    { id: 'name-deleted', label: 'a defined name deleted', kind: 'damaged', expect: 'fail', check: 'names', recipes: ['budget', 'ledger'], edit: (b) => b.names.splice(b.names.findIndex((n) => n.name === 'Regions'), 1) },
    {
      id: 'validation-deleted',
      label: 'a data validation deleted',
      kind: 'damaged',
      expect: 'fail',
      check: 'validation',
      recipes: ['budget', 'ledger'],
      edit: (b) => {
        const s = b.sheets[0]?.name === 'Ledger' ? sheetOf(b, 'Ledger') : sheetOf(b, 'Data');
        s.validations.splice(s.validations.findIndex((v) => v.type === 'list'), 1);
      },
    },
    {
      id: 'new-ref-error',
      label: 'a formula now reads #REF! (its source cell was deleted)',
      kind: 'damaged',
      expect: 'fail',
      check: 'errors',
      recipes: ['budget', 'ledger'],
      edit: (b, w) => {
        const ledger = b.sheets[0]?.name === 'Ledger';
        const c = getCell(sheetOf(b, ledger ? 'Ledger' : 'Summary'), ledger ? `C${w.last + 5}` : 'B2');
        if (c !== undefined) c.f = ledger ? `C${w.last + 2}*#REF!` : 'B1*#REF!';
        recalc(b);
      },
    },
    {
      id: 'new-div0',
      label: 'a new ratio formula divides by an empty cell (#DIV/0!)',
      kind: 'damaged',
      expect: 'fail',
      check: 'errors',
      recipes: ['budget'],
      edit: (b) => {
        const s = sheetOf(b, 'Summary');
        setCell(s, 'A6', { v: 'Ratio' });
        setCell(s, 'B6', { f: 'B1/B7', v: 0 });
        recalc(b);
      },
    },
    {
      id: 'input-changed',
      label: 'a value in the declared input range changed (and recomputed)',
      kind: 'damaged',
      expect: 'fail',
      check: 'inputs',
      recipes: ['budget', 'ledger'],
      edit: (b) => {
        const ledger = b.sheets[0]?.name === 'Ledger';
        setCell(sheetOf(b, ledger ? 'Rates' : 'Inputs'), ledger ? 'B1' : 'B3', { v: ledger ? 0.5 : 0.3 });
        recalc(b);
      },
    },
    {
      id: 'stale-sum',
      label: 'a summed value changed without recalculating (the SUM disagrees)',
      kind: 'damaged',
      expect: 'fail',
      check: 'sum-count',
      recipes: ['budget', 'ledger'],
      edit: (b, w) => {
        const ledger = b.sheets[0]?.name === 'Ledger';
        setCell(sheetOf(b, ledger ? 'Ledger' : 'Data'), `${ledger ? 'C' : 'B'}${w.first + 2}`, { v: 999 });
      },
    },
    {
      id: 'stale-count',
      label: 'an amount emptied without recalculating (the COUNT disagrees)',
      kind: 'damaged',
      expect: 'fail',
      check: 'sum-count',
      recipes: ['ledger'],
      edit: (b, w) => {
        const p = parseCell(`C${w.first + 1}`);
        if (p !== null) sheetOf(b, 'Ledger').cells.delete(key(p.row, p.col));
      },
    },
  ];
}

const DOC_EDITS: { id: string; label: string; kind: RowKind; expect: OfficeRow['expect']; check?: string; redline?: boolean; recipes: ('contract' | 'report')[]; afterStyle?: (s: DocStyle) => DocStyle; edit: (d: GDoc) => void }[] = [
  { id: 'reword', label: 'a body paragraph reworded', kind: 'clean', expect: 'pass', recipes: ['contract', 'report'], edit: (d) => setText(d, lastBody(d), 'This paragraph now says the same thing in other words.') },
  { id: 'add-paragraph', label: 'a paragraph added', kind: 'clean', expect: 'pass', recipes: ['contract', 'report'], edit: (d) => d.blocks.splice(d.blocks.length - 1, 0, para('A further paragraph adds a detail the reader asked for.')) },
  { id: 'add-heading', label: 'a new heading with text', kind: 'clean', expect: 'pass', recipes: ['contract', 'report'], edit: (d) => d.blocks.push(para('Appendix', 'Heading1'), para('Supporting notes are kept on file.')) },
  {
    id: 'add-table-row',
    label: 'a table row added',
    kind: 'clean',
    expect: 'pass',
    recipes: ['contract', 'report'],
    edit: (d) => {
      const t = d.blocks.find((b) => b.kind === 'table');
      if (t !== undefined && t.kind === 'table') t.rows.push(t.rows[0]?.map((_c, i) => (i === 0 ? 'Extra' : '10')) ?? ['Extra']);
    },
  },
  { id: 'add-term', label: 'a new defined term', kind: 'clean', expect: 'pass', recipes: ['contract', 'report'], edit: (d) => d.blocks.splice(3, 0, para('"Schedule" means a schedule to this document.')) },
  { id: 'resave', label: 're-saved with runs split, revision ids, proofing marks and bookmarks', kind: 'clean', expect: 'pass', recipes: ['contract', 'report'], afterStyle: (s) => DOC_STYLES[(DOC_STYLES.indexOf(s) + 1) % DOC_STYLES.length] ?? s, edit: () => undefined },
  {
    id: 'redline-tracked',
    label: 'under redline, a paragraph reworded as a tracked change',
    kind: 'clean',
    expect: 'pass',
    redline: true,
    recipes: ['contract', 'report'],
    edit: (d) => {
      const i = lastBody(d);
      const b = d.blocks[i];
      if (b !== undefined && b.kind === 'p') b.runs = [{ text: b.runs.map((r) => r.text).join(''), del: true }, { text: 'The reworded sentence, as a tracked insertion.', ins: true }];
    },
  },
  {
    id: 'redline-added',
    label: 'under redline, a paragraph added as a tracked insertion',
    kind: 'clean',
    expect: 'pass',
    redline: true,
    recipes: ['contract', 'report'],
    edit: (d) => d.blocks.splice(d.blocks.length - 1, 0, { kind: 'p', style: null, markIns: true, runs: [{ text: 'An inserted paragraph, tracked.', ins: true }] }),
  },
  { id: 'heading-typo', label: 'a one-letter change in a heading', kind: 'clean', expect: 'pass', recipes: ['contract', 'report'], edit: (d) => renameHeading(d) },
  { id: 'delete-paragraph', label: 'a body paragraph deleted', kind: 'clean', expect: 'pass', recipes: ['contract', 'report'], edit: (d) => d.blocks.splice(lastBody(d), 1) },
  {
    id: 'move-paragraph',
    label: 'a paragraph moved',
    kind: 'clean',
    expect: 'pass',
    recipes: ['contract', 'report'],
    edit: (d) => {
      const i = lastBody(d);
      const [b] = d.blocks.splice(i, 1);
      if (b !== undefined) d.blocks.splice(2, 0, b);
    },
  },
  {
    id: 'outline-heading',
    label: 'a heading marked by outline level instead of a style',
    kind: 'clean',
    expect: 'pass',
    recipes: ['contract', 'report'],
    edit: (d) => {
      const h = d.blocks.find((b) => b.kind === 'p' && b.style === 'Heading1');
      if (h !== undefined && h.kind === 'p') {
        h.style = null;
        h.outline = 0;
      }
    },
  },
  // ------------------------------------------------------------------------------------------------ damaged
  {
    id: 'heading-deleted',
    label: 'a heading deleted',
    kind: 'damaged',
    expect: 'fail',
    check: 'headings',
    recipes: ['contract', 'report'],
    edit: (d) => {
      const i = d.blocks.findIndex((b) => b.kind === 'p' && b.style === 'Heading2');
      d.blocks.splice(i, 1);
    },
  },
  {
    id: 'table-flattened',
    label: 'a table turned into paragraphs',
    kind: 'damaged',
    expect: 'fail',
    check: 'tables',
    recipes: ['contract', 'report'],
    edit: (d) => {
      const i = d.blocks.findIndex((b) => b.kind === 'table');
      const t = d.blocks[i];
      if (t !== undefined && t.kind === 'table') d.blocks.splice(i, 1, ...t.rows.map((r) => para(r.join('\t'))));
    },
  },
  {
    id: 'term-removed',
    label: "a defined term's definition removed",
    kind: 'damaged',
    expect: 'fail',
    check: 'terms',
    recipes: ['contract', 'report'],
    edit: (d) => {
      const i = d.blocks.findIndex((b) => b.kind === 'p' && /\((?:the )?"|" means/.test(b.runs.map((r) => r.text).join('')) && !/^"Agreement"/.test(b.runs.map((r) => r.text).join('')));
      const b = d.blocks[i];
      if (b !== undefined && b.kind === 'p') b.runs = [{ text: b.runs.map((r) => r.text).join('').replace(/\s*\((?:the )?"[^"]+"\)/, '').replace(/^"([^"]+)" means/, 'The $1 are') }];
    },
  },
  { id: 'untracked', label: 'under redline, a paragraph reworded without tracking', kind: 'damaged', expect: 'fail', check: 'untracked', redline: true, recipes: ['contract', 'report'], edit: (d) => setText(d, lastBody(d), 'Silently reworded text.') },
  {
    id: 'accepted-silently',
    label: "under redline, a reviewer's tracked insertion accepted silently",
    kind: 'damaged',
    expect: 'fail',
    check: 'untracked',
    redline: true,
    recipes: ['contract', 'report'],
    edit: (d) => {
      for (const b of d.blocks) if (b.kind === 'p') for (const r of b.runs) if (r.ins === true) delete r.ins;
    },
  },
];

function bodyText(b: GBlock): string {
  return b.kind === 'p' ? b.runs.map((r) => r.text).join('') : '';
}

function lastBody(d: GDoc): number {
  for (let i = d.blocks.length - 1; i >= 0; i--) {
    const b = d.blocks[i];
    if (b !== undefined && b.kind === 'p' && b.style === null && !/"[^"]+"/.test(bodyText(b))) return i;
  }
  return d.blocks.length - 1;
}

function setText(d: GDoc, i: number, text: string): void {
  const b = d.blocks[i];
  if (b !== undefined && b.kind === 'p') b.runs = [{ text }];
}

function renameHeading(d: GDoc): void {
  const h = [...d.blocks].reverse().find((b) => b.kind === 'p' && (b.style === 'Heading2' || b.style === 'Heading1'));
  if (h !== undefined && h.kind === 'p') h.runs = [{ text: `${bodyText(h)}s` }];
}

/** A reviewer's pending tracked insertion in the baseline, for the accepted-silently row. */
function withPendingInsertion(d: GDoc): GDoc {
  const c = cloneDoc(d);
  const i = lastBody(c);
  const b = c.blocks[i];
  if (b !== undefined && b.kind === 'p') b.runs.push({ text: ' A reviewer added this clause.', ins: true });
  return c;
}

const MALFORMED: { id: string; label: string; format: 'xlsx' | 'docx'; side?: 'before'; make: (good: Buffer, seed: number) => Buffer }[] = [
  { id: 'not-zip', label: 'not a zip file at all', format: 'xlsx', make: () => Buffer.from('Item,Qty\nWidget,3\n') },
  { id: 'truncated', label: 'cut off part way', format: 'xlsx', make: (g) => g.subarray(0, Math.floor(g.length * 0.6)) },
  { id: 'truncated-doc', label: 'cut off part way', format: 'docx', make: (g) => g.subarray(0, Math.floor(g.length * 0.6)) },
  { id: 'bomb-declared', label: 'a part declaring 70 MB inflated', format: 'xlsx', make: () => zipWrite([{ name: '[Content_Types].xml', data: '<Types/>' }, { name: 'xl/workbook.xml', data: '<workbook/>' }], { sizeOf: (n, real) => (n === 'xl/workbook.xml' ? 70 * 1024 * 1024 : real) }) },
  { id: 'bomb-lying', label: 'a part that inflates far past its declared size', format: 'docx', make: () => zipWrite([{ name: '[Content_Types].xml', data: '<Types/>' }, { name: 'word/document.xml', data: Buffer.alloc(8 * 1024 * 1024, 32) }], { sizeOf: (n, real) => (n === 'word/document.xml' ? 1000 : real) }) },
  { id: 'doctype-entity', label: 'a DOCTYPE defining an entity (billion laughs)', format: 'xlsx', make: (g, s) => replacePart(g, 'xl/workbook.xml', (t) => t.replace('<workbook', '<!DOCTYPE lol [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;">]>\n<workbook'), s) },
  { id: 'external-entity', label: 'an external entity naming a local file', format: 'docx', make: (g, s) => replacePart(g, 'word/document.xml', (t) => t.replace(/<(\w+):document/, '<!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/hostname">]>\n<$1:document').replace('<w:body>', '<w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p>'), s) },
  { id: 'unknown-entity', label: 'an entity that is not one of the five', format: 'docx', make: (g, s) => replacePart(g, 'word/document.xml', (t) => t.replace('<w:body>', '<w:body><w:p><w:r><w:t>&nbsp;</w:t></w:r></w:p>'), s) },
  { id: 'mismatched', label: 'a tag closed by the wrong end tag', format: 'xlsx', make: (g, s) => replacePart(g, 'xl/worksheets/sheet1.xml', (t) => t.replace('</sheetData>', '</sheetDta>'), s) },
  { id: 'encrypted', label: 'the encrypted flag set', format: 'xlsx', make: (g) => setCentralFlag(g) },
  { id: 'zip64', label: 'a ZIP64 marker in the directory', format: 'docx', make: (g) => setEntryTotal(g, 0xffff) },
  { id: 'bad-crc', label: 'a part whose CRC-32 does not match', format: 'xlsx', make: (g) => flipCrc(g) },
  { id: 'no-main', label: 'the main part missing', format: 'xlsx', make: (g) => dropPart(g, 'xl/workbook.xml') },
  { id: 'no-main-doc', label: 'the main part missing', format: 'docx', make: (g) => dropPart(g, 'word/document.xml') },
  { id: 'many-entries', label: 'more than 10,000 entries', format: 'xlsx', make: () => zipWrite(Array.from({ length: 10_001 }, (_x, i) => ({ name: i === 0 ? '[Content_Types].xml' : `x/${i}.xml`, data: '<a/>', store: true }))) },
  { id: 'climbing-name', label: 'an entry named ../../outside.xml', format: 'docx', make: (g) => addPart(g, '../../outside.xml', '<a/>') },
  { id: 'wrong-kind', label: 'a .docx that is really a workbook', format: 'docx', make: (_g, s) => writeBook(budgetBook(s).book, BOOK_STYLES[0] ?? { id: 'x', strings: 'shared', prefix: '', refs: true, sharedFormulas: false, extValidations: false }) },
  { id: 'deep-nesting', label: 'elements nested 300 deep', format: 'docx', make: (g, s) => replacePart(g, 'word/document.xml', (t) => t.replace('<w:body>', `<w:body>${'<w:sdt>'.repeat(300)}${'</w:sdt>'.repeat(300)}`), s) },
  { id: 'bad-shared-string', label: 'a cell naming a shared string that does not exist', format: 'xlsx', make: (g, s) => replacePart(g, 'xl/worksheets/sheet1.xml', (t) => t.replace(/<c r="A1" t="s"><v>\d+<\/v>/, '<c r="A1" t="s"><v>999999</v>'), s) },
  { id: 'malformed-baseline', label: 'the baseline copy itself is damaged', format: 'xlsx', side: 'before', make: (g) => g.subarray(0, Math.floor(g.length * 0.5)) },
];

// Rewriting a container: entries are read back with the zip reader's own primitives, then written again.

function partsOf(g: Buffer): ZipItem[] {
  const z = zipEntries(g);
  if (!z.ok) throw new Error(z.error);
  return z.value.map((e) => {
    const r = zipRead(g, e);
    if (!r.ok) throw new Error(r.error);
    return { name: e.name, data: r.value };
  });
}

function replacePart(g: Buffer, name: string, f: (t: string) => string, _seed: number): Buffer {
  return zipWrite(partsOf(g).map((p) => (p.name === name ? { name, data: f(p.data.toString()) } : p)));
}

function dropPart(g: Buffer, name: string): Buffer {
  return zipWrite(partsOf(g).filter((p) => p.name !== name));
}

function addPart(g: Buffer, name: string, data: string): Buffer {
  return zipWrite([...partsOf(g), { name, data }]);
}

function setCentralFlag(g: Buffer): Buffer {
  return zipWrite(partsOf(g), { flags: 1 });
}

function flipCrc(g: Buffer): Buffer {
  return zipWrite(partsOf(g), { crcXor: 0x5a5a5a5a });
}

function setEntryTotal(g: Buffer, total: number): Buffer {
  return zipWrite(partsOf(g), { total });
}

/** Every office row of `openmorals eval`, in a fixed order, built from fixed seeds. */
export function officeRows(): OfficeRow[] {
  const rows: OfficeRow[] = [];
  let n = 0;
  for (const e of bookEdits()) {
    e.recipes.forEach((recipe, ri) => {
      const seed = 1000 + n * 7 + ri;
      const style = BOOK_STYLES[n % BOOK_STYLES.length] ?? BOOK_STYLES[0];
      n++;
      if (style === undefined) return;
      const inputs = recipe === 'budget' ? [n % 2 === 0 ? 'Assumptions' : 'Inputs!B2:B5'] : [n % 2 === 0 ? 'FX' : 'Rates!B1:B2'];
      rows.push({
        id: `xlsx-${e.id}-${recipe}${ri > 0 && e.recipes[0] === recipe ? '-2' : ''}`,
        format: 'xlsx',
        kind: e.kind,
        expect: e.expect,
        ...(e.check !== undefined ? { check: e.check } : {}),
        inputs,
        label: `${recipe} workbook (${style.id}): ${e.label}`,
        build: () => {
          const w = recipe === 'budget' ? budgetBook(seed) : ledgerBook(seed);
          const before = writeBook(w.book, style);
          const after = cloneBook(w.book);
          e.edit(after, w);
          return { before, after: writeBook(after, e.afterStyle !== undefined ? e.afterStyle(style) : style) };
        },
      });
    });
  }
  const notComputed: { id: string; label: string; make: (w: BudgetBook) => { book: GBook; style: Partial<BookStyle> } ; recipe: 'budget' | 'ledger' }[] = [
    { id: 'no-cache', label: 'written by a program that does not calculate (no cached values)', recipe: 'budget', make: (w) => ({ book: w.book, style: { noCache: 'all' } }) },
    {
      id: 'full-calc',
      label: 'saved asking for a full recalculation on open',
      recipe: 'ledger',
      make: (w) => {
        const b = cloneBook(w.book);
        b.fullCalcOnLoad = true;
        return { book: b, style: {} };
      },
    },
    {
      id: 'new-formulas-uncached',
      label: 'formulas added by a script with no cached values',
      recipe: 'ledger',
      make: (w) => {
        const b = cloneBook(w.book);
        const s = sheetOf(b, 'Ledger');
        for (let row = w.first; row <= w.last; row++) setCell(s, `E${row}`, { f: `C${row}*Rates!$B$1`, v: null });
        return { book: b, style: { noCache: (sheet, k) => sheet === 'Ledger' && k.endsWith(',5') } };
      },
    },
  ];
  notComputed.forEach((x, i) => {
    const style = BOOK_STYLES[i % BOOK_STYLES.length] ?? BOOK_STYLES[0];
    if (style === undefined) return;
    rows.push({
      id: `xlsx-not-computed-${x.id}`,
      format: 'xlsx',
      kind: 'not-computed',
      expect: 'not computed',
      check: 'computed',
      label: `${x.recipe} workbook (${style.id}): ${x.label}`,
      build: () => {
        const w = x.recipe === 'budget' ? budgetBook(2000 + i) : ledgerBook(2000 + i);
        const before = writeBook(w.book, style);
        const m = x.make(w);
        return { before, after: writeBook(m.book, { ...style, ...m.style }) };
      },
    });
  });
  let d = 0;
  for (const e of DOC_EDITS) {
    e.recipes.forEach((recipe) => {
      const seed = 3000 + d * 11;
      const style = DOC_STYLES[d % DOC_STYLES.length] ?? DOC_STYLES[0];
      d++;
      if (style === undefined) return;
      rows.push({
        id: `docx-${e.id}-${recipe}`,
        format: 'docx',
        kind: e.kind,
        expect: e.expect,
        ...(e.check !== undefined ? { check: e.check } : {}),
        ...(e.redline === true ? { redline: true } : {}),
        label: `${recipe} document (${style.id}): ${e.label}`,
        build: () => {
          const base0 = recipe === 'contract' ? contractDoc(seed) : reportDoc(seed);
          const base = e.id === 'accepted-silently' ? withPendingInsertion(base0) : base0;
          const after = cloneDoc(base);
          e.edit(after);
          return { before: writeDoc(base, style, seed), after: writeDoc(after, e.afterStyle !== undefined ? e.afterStyle(style) : style, seed + 1) };
        },
      });
    });
  }
  MALFORMED.forEach((m, i) => {
    rows.push({
      id: `${m.format}-malformed-${m.id}`,
      format: m.format,
      kind: 'malformed',
      expect: 'fail',
      check: 'read',
      label: `${m.side === 'before' ? 'baseline' : 'file'}: ${m.label}`,
      build: () => {
        const seed = 5000 + i;
        const good = m.format === 'xlsx' ? writeBook(budgetBook(seed).book, BOOK_STYLES[0] ?? { id: 'x', strings: 'shared', prefix: '', refs: true, sharedFormulas: true, extValidations: false }) : writeDoc(contractDoc(seed), DOC_STYLES[0] ?? { id: 'x', prefix: 'w', styles: true, splitRuns: false, rsid: false, proofErr: false, bookmarks: false }, seed);
        const bad = m.make(good, seed);
        return m.side === 'before' ? { before: bad, after: good } : { before: good, after: bad };
      },
    });
  });
  return rows;
}

