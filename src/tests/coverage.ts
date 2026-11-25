import { parseXml } from './xml.js';
import type { XmlElement } from './xml.js';

export interface FileCoverage {
  file: string;
  /** Instrumented lines. */
  lines: number;
  /** Lines run at least once. */
  covered: number;
}

export type CoverageFormat = 'lcov' | 'cobertura';
export type CoverageResult = { ok: true; format: CoverageFormat; files: FileCoverage[] } | { ok: false; error: string };

function norm(p: string, root: string | undefined): string {
  let s = p.replace(/\\/g, '/');
  if (root !== undefined) {
    const r = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (s.startsWith(`${r}/`)) s = s.slice(r.length + 1);
  }
  return s.replace(/^\.\//, '');
}

/** lcov tracefiles: SF starts a file, DA:<line>,<hits> counts lines, end_of_record closes it. LF/LH are used only when no DA line is given. */
function readLcov(text: string, root: string | undefined): FileCoverage[] {
  const out = new Map<string, FileCoverage>();
  let cur: { file: string; da: Map<number, number>; lf: number | null; lh: number | null } | null = null;
  const close = (): void => {
    if (cur === null) return;
    const lines = cur.da.size > 0 ? cur.da.size : cur.lf ?? 0;
    const covered = cur.da.size > 0 ? [...cur.da.values()].filter((h) => h > 0).length : cur.lh ?? 0;
    const prev = out.get(cur.file);
    out.set(cur.file, prev === undefined ? { file: cur.file, lines, covered } : { file: cur.file, lines: Math.max(prev.lines, lines), covered: Math.max(prev.covered, covered) });
    cur = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      close();
      cur = { file: norm(line.slice(3), root), da: new Map(), lf: null, lh: null };
    } else if (cur !== null && line.startsWith('DA:')) {
      const [n, h] = line.slice(3).split(',');
      const ln = Number(n);
      const hits = Number(h);
      if (Number.isInteger(ln) && Number.isFinite(hits)) cur.da.set(ln, Math.max(cur.da.get(ln) ?? 0, hits));
    } else if (cur !== null && line.startsWith('LF:')) cur.lf = Number(line.slice(3)) || 0;
    else if (cur !== null && line.startsWith('LH:')) cur.lh = Number(line.slice(3)) || 0;
    else if (line === 'end_of_record') close();
  }
  close();
  return [...out.values()];
}

function walk(el: XmlElement, f: (e: XmlElement) => void): void {
  f(el);
  for (const c of el.children) walk(c, f);
}

/** Cobertura XML: each <class filename=...> with its <lines><line number hits/>; line-rate is used when no line is listed. */
function readCobertura(root: XmlElement, base: string | undefined): FileCoverage[] {
  const out = new Map<string, Map<number, number>>();
  const rates = new Map<string, FileCoverage>();
  walk(root, (e) => {
    if (e.name !== 'class') return;
    const fn = e.attrs.get('filename');
    if (fn === undefined) return;
    const file = norm(fn, base);
    const m = out.get(file) ?? new Map<number, number>();
    let seen = 0;
    for (const lines of e.children) {
      if (lines.name !== 'lines') continue;
      for (const l of lines.children) {
        if (l.name !== 'line') continue;
        const n = Number(l.attrs.get('number'));
        const h = Number(l.attrs.get('hits'));
        if (Number.isInteger(n) && Number.isFinite(h)) {
          m.set(n, Math.max(m.get(n) ?? 0, h));
          seen++;
        }
      }
    }
    out.set(file, m);
    if (seen === 0) {
      const rate = Number(e.attrs.get('line-rate'));
      if (Number.isFinite(rate)) rates.set(file, { file, lines: 1000, covered: Math.round(rate * 1000) });
    }
  });
  const files: FileCoverage[] = [];
  for (const [file, m] of out) {
    if (m.size > 0) files.push({ file, lines: m.size, covered: [...m.values()].filter((h) => h > 0).length });
    else {
      const r = rates.get(file);
      if (r !== undefined) files.push(r);
    }
  }
  return files;
}

/** Reads an lcov tracefile or a Cobertura XML report into per-file line counts. Pure. */
export function parseCoverage(text: string, root?: string): CoverageResult {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (/^\s*</.test(t)) {
    const x = parseXml(t);
    if (!x.ok) return { ok: false, error: `not readable XML: ${x.error}` };
    if (x.root.name !== 'coverage') return { ok: false, error: `an XML report whose root is <${x.root.name}>, not Cobertura's <coverage>` };
    const files = readCobertura(x.root, root);
    return files.length === 0 ? { ok: false, error: 'cobertura: the report lists no file' } : { ok: true, format: 'cobertura', files };
  }
  if (/^\s*(TN:|SF:)/m.test(t)) {
    const files = readLcov(t, root);
    return files.length === 0 ? { ok: false, error: 'lcov: the tracefile lists no file' } : { ok: true, format: 'lcov', files };
  }
  return { ok: false, error: 'not a coverage report this command reads (lcov tracefile or Cobertura XML)' };
}

export interface CoverageDrop {
  file: string;
  /** Percent of lines covered before and after, one decimal. */
  before: number;
  after: number | null;
  /** Covered lines before and after. */
  coveredBefore: number;
  coveredAfter: number;
  why: 'dropped' | 'gone-from-report';
}

export interface CoverageComparison {
  drops: CoverageDrop[];
  totals: { before: { lines: number; covered: number }; after: { lines: number; covered: number } };
  /** Files in the after report only: new code. Listed when it has lines and none of them ran. */
  newUncovered: string[];
}

const pct = (c: number, l: number): number => (l === 0 ? 100 : Math.round((c / l) * 1000) / 10);

/**
 * Compares two coverage reports by file (0.32.0). Pure. A file is a drop when its covered share fell by at least
 * `minDrop` percentage points, or when it had covered lines before and is missing after (its tests may no longer run).
 * The totals are printed and never decide anything: one number hides where the coverage went.
 */
export function compareCoverage(before: readonly FileCoverage[], after: readonly FileCoverage[], minDrop = 1): CoverageComparison {
  const a = new Map(after.map((f) => [f.file, f]));
  const b = new Set(before.map((f) => f.file));
  const drops: CoverageDrop[] = [];
  for (const f of before) {
    const g = a.get(f.file);
    const pb = pct(f.covered, f.lines);
    if (g === undefined) {
      if (f.covered > 0) drops.push({ file: f.file, before: pb, after: null, coveredBefore: f.covered, coveredAfter: 0, why: 'gone-from-report' });
      continue;
    }
    const pa = pct(g.covered, g.lines);
    if (pb - pa >= minDrop) drops.push({ file: f.file, before: pb, after: pa, coveredBefore: f.covered, coveredAfter: g.covered, why: 'dropped' });
  }
  drops.sort((x, y) => (y.before - (y.after ?? 0)) - (x.before - (x.after ?? 0)) || x.file.localeCompare(y.file));
  const sum = (fs: readonly FileCoverage[]): { lines: number; covered: number } => fs.reduce((s, f) => ({ lines: s.lines + f.lines, covered: s.covered + f.covered }), { lines: 0, covered: 0 });
  const newUncovered = after.filter((f) => !b.has(f.file) && f.lines > 0 && f.covered === 0).map((f) => f.file).sort();
  return { drops, totals: { before: sum(before), after: sum(after) }, newUncovered };
}
