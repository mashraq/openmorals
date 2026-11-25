// Cell references and the two formula shapes the checker recomputes (SUM and COUNT over references and numbers).
// Pure: strings in, numbers out.

export const MAX_ROW = 1_048_576;
export const MAX_COL = 16_384;

export interface Area {
  /** The sheet the reference names, or null for the formula's own sheet. */
  sheet: string | null;
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export function colNumber(letters: string): number | null {
  if (!/^[A-Za-z]{1,3}$/.test(letters)) return null;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n >= 1 && n <= MAX_COL ? n : null;
}

export function colLetters(n: number): string {
  let s = '';
  let x = n;
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

export function cellName(row: number, col: number): string {
  return `${colLetters(col)}${row}`;
}

/** `A1`, `$B$7`: row and column, or null. */
export function parseCell(ref: string): { row: number; col: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref);
  if (m === null) return null;
  const col = colNumber(m[1] ?? '');
  const row = Number(m[2]);
  if (col === null || !Number.isInteger(row) || row < 1 || row > MAX_ROW) return null;
  return { row, col };
}

/** Splits `Sheet!A1:B2` or `'My ''Sheet'''!A1` into the sheet name (unquoted) and the rest; no `!` means no sheet. */
export function splitSheet(ref: string): { sheet: string | null; rest: string } | null {
  const t = ref.trim();
  if (t.startsWith("'")) {
    let i = 1;
    let name = '';
    for (;;) {
      if (i >= t.length) return null;
      const ch = t[i];
      if (ch === "'") {
        if (t[i + 1] === "'") {
          name += "'";
          i += 2;
          continue;
        }
        break;
      }
      name += ch;
      i++;
    }
    if (t[i + 1] !== '!') return null;
    return { sheet: name, rest: t.slice(i + 2) };
  }
  const bang = t.lastIndexOf('!');
  if (bang === -1) return { sheet: null, rest: t };
  const sheet = t.slice(0, bang);
  if (sheet === '' || /['[\]*?/\\:]/.test(sheet)) return null;
  return { sheet, rest: t.slice(bang + 1) };
}

/** `A1`, `A1:C9`, `A:C` (whole columns), `2:5` (whole rows), each with an optional sheet. Null when it is none of these. */
export function parseArea(ref: string): Area | null {
  const s = splitSheet(ref);
  if (s === null) return null;
  const parts = s.rest.split(':');
  if (parts.length === 1) {
    const c = parseCell(parts[0] ?? '');
    return c === null ? null : { sheet: s.sheet, r1: c.row, c1: c.col, r2: c.row, c2: c.col };
  }
  if (parts.length !== 2) return null;
  const [a, b] = [parts[0] ?? '', parts[1] ?? ''];
  const ca = parseCell(a);
  const cb = parseCell(b);
  if (ca !== null && cb !== null) return { sheet: s.sheet, r1: Math.min(ca.row, cb.row), c1: Math.min(ca.col, cb.col), r2: Math.max(ca.row, cb.row), c2: Math.max(ca.col, cb.col) };
  const colA = /^\$?([A-Za-z]{1,3})$/.exec(a);
  const colB = /^\$?([A-Za-z]{1,3})$/.exec(b);
  if (colA !== null && colB !== null) {
    const x = colNumber(colA[1] ?? '');
    const y = colNumber(colB[1] ?? '');
    if (x === null || y === null) return null;
    return { sheet: s.sheet, r1: 1, c1: Math.min(x, y), r2: MAX_ROW, c2: Math.max(x, y) };
  }
  const rowA = /^\$?(\d{1,7})$/.exec(a);
  const rowB = /^\$?(\d{1,7})$/.exec(b);
  if (rowA !== null && rowB !== null) {
    const x = Number(rowA[1]);
    const y = Number(rowB[1]);
    if (x < 1 || y < 1 || x > MAX_ROW || y > MAX_ROW) return null;
    return { sheet: s.sheet, r1: Math.min(x, y), c1: 1, r2: Math.max(x, y), c2: MAX_COL };
  }
  return null;
}

export function areaName(a: Area): string {
  const sheet = a.sheet === null ? '' : `${/^[A-Za-z_][A-Za-z0-9_.]*$/.test(a.sheet) ? a.sheet : `'${a.sheet.replace(/'/g, "''")}'`}!`;
  const one = cellName(a.r1, a.c1);
  return a.r1 === a.r2 && a.c1 === a.c2 ? `${sheet}${one}` : `${sheet}${one}:${cellName(a.r2, a.c2)}`;
}

/** Splits on commas outside strings, quoted sheet names and brackets. Null when quotes or brackets do not balance. */
export function splitArgs(s: string): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] ?? '';
    if (ch === '"' || ch === "'") {
      const q = ch;
      cur += ch;
      i++;
      for (;;) {
        if (i >= s.length) return null;
        const c = s[i] ?? '';
        cur += c;
        if (c === q) {
          if (s[i + 1] === q) {
            cur += q;
            i += 2;
            continue;
          }
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
      if (depth < 0) return null;
    }
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (depth !== 0) return null;
  out.push(cur);
  return out;
}

export type AggregateArg = { kind: 'area'; area: Area } | { kind: 'number'; value: number } | { kind: 'name'; name: string };

export interface Aggregate {
  fn: 'SUM' | 'COUNT';
  args: AggregateArg[];
}

const NAME = /^[A-Za-z_\\][A-Za-z0-9_.\\]{0,254}$/;

/** `SUM(...)` or `COUNT(...)` as the whole formula, over references, numbers and defined names; null for anything else. */
export function aggregateOf(formula: string): Aggregate | null {
  const m = /^\s*=?\s*(SUM|COUNT)\s*\(([\s\S]*)\)\s*$/i.exec(formula);
  if (m === null) return null;
  const fn = (m[1] ?? '').toUpperCase() as 'SUM' | 'COUNT';
  const inner = m[2] ?? '';
  if (inner.trim() === '') return null;
  const parts = splitArgs(inner);
  if (parts === null) return null;
  const args: AggregateArg[] = [];
  for (const raw of parts) {
    const p = raw.trim();
    if (p === '') return null;
    if (/^[-+]?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(p)) {
      args.push({ kind: 'number', value: Number(p) });
      continue;
    }
    const area = parseArea(p);
    if (area !== null) {
      args.push({ kind: 'area', area });
      continue;
    }
    if (NAME.test(p) && parseCell(p) === null && !/^(TRUE|FALSE)$/i.test(p)) {
      args.push({ kind: 'name', name: p });
      continue;
    }
    return null;
  }
  return { fn, args };
}

/**
 * The formula of a shared-formula cell, from its master's text moved by (dRow, dCol): relative references move, `$`
 * parts stay. Null when the text holds anything this cannot move safely (whole rows or columns, R1C1, structured refs).
 */
export function shiftFormula(f: string, dRow: number, dCol: number): string | null {
  if (/\[/.test(f)) return null;
  let out = '';
  let i = 0;
  while (i < f.length) {
    const ch = f[i] ?? '';
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= f.length) return null;
        if (f[j] === ch) {
          if (f[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      out += f.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const m = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})/.exec(f.slice(i, i + 13));
    const prev = i > 0 ? (f[i - 1] ?? '') : '';
    if (m !== null && !/[A-Za-z0-9_.$]/.test(prev)) {
      const after = f[i + m[0].length] ?? '';
      if (!/[A-Za-z0-9_(!]/.test(after)) {
        const col = colNumber(m[2] ?? '');
        const row = Number(m[4]);
        if (col !== null && row >= 1 && row <= MAX_ROW) {
          const nc = m[1] === '$' ? col : col + dCol;
          const nr = m[3] === '$' ? row : row + dRow;
          if (nc < 1 || nc > MAX_COL || nr < 1 || nr > MAX_ROW) return null;
          out += `${m[1] ?? ''}${colLetters(nc)}${m[3] ?? ''}${nr}`;
          i += m[0].length;
          continue;
        }
      }
    }
    if (ch === ':' && (!/\$?[A-Za-z]{1,3}\$?\d{1,7}$/.test(out) || !/^\$?[A-Za-z]{1,3}\$?\d{1,7}/.test(f.slice(i + 1)))) return null;
    out += ch;
    i++;
  }
  return out;
}
