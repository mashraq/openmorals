// Runs a work order's conditions against the files. Reads files only; writes nothing and calls no model. The named
// acceptance tests are judged by `tests compare` over two reports, never by a second implementation.
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { compareTests } from '../tests/compare.js';
import { MAX_REPORT_BYTES } from '../tests/command.js';
import { matchName } from '../tests/failfirst.js';
import { parseTestReport } from '../tests/report.js';
import type { TestReport } from '../tests/report.js';
import type { Csv, Read } from './files.js';
import { asText, extOf, markdownHeadings, parseCsv, parseEml, readBytes, readCsv, sha256Hex } from './files.js';
import { docxParagraphs } from '../office/docx.js';
import { officeKind, zipEntries } from '../office/zip.js';
import { compareOffice } from '../office/index.js';
import type { OfficeFormat } from '../office/index.js';
import type { Condition, ColumnRef, FileType, Order } from './model.js';
import { conditionKey, describeCondition } from './model.js';

export type Outcome = 'pass' | 'fail';

export interface ConditionResult {
  key: string;
  kind: Condition['kind'];
  from: 'order' | 'template';
  /** What the condition asks for, in one line. */
  asks: string;
  outcome: Outcome;
  /** 0.30.0, `before_after` only: set when nothing failed but the workbook was not recalculated. The outcome is then fail: "not computed" is never a pass. */
  status?: 'not computed';
  /** Why it failed, or what it found when it passed; at most MAX_DETAIL lines. */
  detail: string[];
  /** What a pass of this condition does not show. */
  notShown: string;
}

export interface InputResult {
  path: string;
  outcome: Outcome;
  detail: string;
}

export const MAX_DETAIL = 10;

/** What a pass of each condition does not show; printed beside every pass. */
export const NOT_SHOWN: Readonly<Record<Condition['kind'], string>> = {
  exists: 'that the content is right: only that the file is there, not empty, and reads as its type',
  headings: 'what the text under each heading says, and any heading not listed',
  no_placeholders: 'placeholders worded other than the built-in patterns and your own; in a .docx, text outside the body paragraphs (headers, footers, comments, text boxes, tracked deletions)',
  recipients: 'whether the message should be sent at all, what it says, and any change after this check',
  attachments: 'what the attached files say: it compares names and content hashes only',
  rows: 'whether each row was kept or dropped for the right reason: it counts rows and reasons',
  unique: 'whether the values are right: only that the combination does not repeat',
  not_null: 'whether the values are right: only that the cells are not empty',
  accepted_values: 'whether each value is right for its row: only that it is one of the listed values',
  relationships: 'whether each value points at the right row: only that it exists in the other file (empty cells are not checked)',
  freshness: 'whether the dates are true: only that the newest one is recent enough',
  total: 'whether the control total itself is right, or whether the column holds the right rows',
  tests: 'what the named tests check, every other test (tests compare judges losses), and whether the two reports came from your own gate',
  before_after:
    'workbooks: cell values outside the declared input ranges, a formula changed into another formula, formulas other than SUM and COUNT (not recomputed), formatting, charts, pivot tables, macros, comments, conditional formats and hidden state; documents: what the text says, headers, footers, footnotes, comments, text boxes beyond their text, formatting, and, without redline, whether a change was tracked',
};

/** What a pass of `before_after` does not show, by the kind of file it compares (0.30.0). */
export const BEFORE_AFTER_NOT_SHOWN: Readonly<Record<'xlsx' | 'docx', string>> = {
  xlsx: 'cell values outside the declared input ranges, a formula changed into another formula, the results of formulas other than SUM and COUNT (not recomputed), formatting, charts, pivot tables, macros, comments, conditional formats, hidden state, and a column inserted (rows are aligned by their text labels, columns are not)',
  docx: 'what the text says, headers, footers, footnotes, comments, text boxes beyond their text, formatting, numbering, a table replaced by another table, and, without redline, whether a change was tracked',
};

function notShownOf(c: Condition): string {
  if (c.kind !== 'before_after') return NOT_SHOWN[c.kind];
  return extOf(c.file) === 'docx' ? BEFORE_AFTER_NOT_SHOWN.docx : BEFORE_AFTER_NOT_SHOWN.xlsx;
}

/**
 * Where `before_after` finds the baseline copy of a file (0.30.0): given the file's real path, its bytes as the person's
 * baseline holds them, or why there is none. Supplied by `order check`; without it the condition fails.
 */
export type BaselineSource = (fileReal: string) => { ok: true; data: Buffer; ts: string } | { ok: false; error: string };

export interface RunContext {
  baseline?: BaselineSource;
  realPath?: (path: string) => string;
}

/** Lines printed with every result, pass or fail. */
export const ALWAYS_NOT_CHECKED: readonly string[] = [
  'Only the conditions above were checked. Whether this is the right work, whether a source is true, tone, and whether to send or submit are yours.',
  'A pass adds nothing to and removes nothing from any other guard\'s decision.',
];

const PLACEHOLDERS: readonly { name: string; re: RegExp }[] = [
  { name: 'TODO, TBD, FIXME or XXX', re: /\b(TODO|TBD|FIXME|XXX)\b/ },
  { name: 'lorem ipsum', re: /lorem ipsum/i },
  { name: 'a bracketed blank such as [name] or [insert date]', re: /\[(insert|name|date|todo|tbd|placeholder|your|client|company|amount|recipient|xx+)\b[^\]\n]{0,40}\]/i },
  { name: 'a template field such as {{name}}', re: /\{\{[^{}\n]{0,60}\}\}/ },
  { name: 'an angle-bracket blank such as <insert>', re: /<(insert|placeholder)\b[^>\n]{0,40}>/i },
  { name: '???', re: /\?\?\?/ },
];

class Fail extends Error {}

function at(dir: string, p: string): string {
  return isAbsolute(p) ? p : resolve(dir, p);
}

function need<T>(r: Read<T>, label: string): T {
  if (!r.ok) throw new Fail(`${label} ${r.error}`);
  return r.value;
}

function cut(lines: string[]): string[] {
  return lines.length > MAX_DETAIL ? [...lines.slice(0, MAX_DETAIL - 1), `... and ${lines.length - MAX_DETAIL + 1} more`] : lines;
}

function q(s: string): string {
  return JSON.stringify(s.length > 80 ? `${s.slice(0, 80)}...` : s);
}

/** A CSV read once per check, by its resolved path. */
class CsvCache {
  private readonly seen = new Map<string, Read<Csv>>();
  constructor(private readonly dir: string) {}
  get(p: string): Csv {
    const full = at(this.dir, p);
    let r = this.seen.get(full);
    if (r === undefined) {
      r = readCsv(full);
      this.seen.set(full, r);
    }
    return need(r, p);
  }
  column(p: string, name: string): { csv: Csv; index: number } {
    const csv = this.get(p);
    const index = csv.header.indexOf(name);
    if (index === -1) throw new Fail(`${p} has no column ${q(name)} (columns: ${csv.header.join(', ')})`);
    return { csv, index };
  }
}

// ---------------------------------------------------------------------------------------------------------------- numbers and dates

const SCALE = 12;
const AMOUNT = /^(\()?([-+])?([$£€¥])?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(\))?$/;

/** A decimal amount as an integer scaled by 10^12: digits, an optional sign or brackets, a currency sign, thousands commas. */
export function parseAmount(raw: string): bigint | null {
  const s = raw.trim().replace(/\s+/g, '');
  const m = AMOUNT.exec(s);
  if (m === null) return null;
  const open = m[1] !== undefined;
  const close = m[6] !== undefined;
  if (open !== close || (open && m[2] !== undefined)) return null;
  const frac = m[5] ?? '';
  if (frac.length > SCALE) return null;
  const v = BigInt((m[4] ?? '0').replace(/,/g, '') + frac.padEnd(SCALE, '0'));
  return open || m[2] === '-' ? -v : v;
}

export function formatAmount(v: bigint): string {
  const neg = v < 0n;
  const a = (neg ? -v : v).toString().padStart(SCALE + 1, '0');
  const int = a.slice(0, a.length - SCALE);
  const frac = a.slice(a.length - SCALE).replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac !== '' ? `.${frac}` : ''}`;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** A date or date-time in ISO 8601 form (a time with no zone is read as UTC), or null. */
export function parseDate(raw: string): number | null {
  const m = DATE.exec(raw.trim());
  if (m === null) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6]].map((x) => (x === undefined ? 0 : Number(x))) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  const t = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(t);
  if (back.getUTCDate() !== d || back.getUTCMonth() !== mo - 1) return null;
  const z = m[7];
  if (z === undefined || z === 'Z') return t;
  const zm = /^([+-])(\d{2}):?(\d{2})$/.exec(z);
  if (zm === null) return null;
  const off = (Number(zm[2]) * 60 + Number(zm[3])) * 60000;
  return zm[1] === '+' ? t - off : t + off;
}

// ---------------------------------------------------------------------------------------------------------------- one condition

function fileType(path: string, label: string, want: FileType | null): string {
  const b = need(readBytes(path), label);
  if (b.length === 0) throw new Fail(`${label} is empty`);
  const type = want ?? null;
  if (type === null) return `${b.length} bytes`;
  switch (type) {
    case 'csv':
    case 'tsv':
      need(parseCsv(need(asText(b), label), type === 'tsv' ? '\t' : ','), label);
      break;
    case 'json':
      try {
        JSON.parse(need(asText(b), label));
      } catch {
        throw new Fail(`${label} is not valid JSON`);
      }
      break;
    case 'md':
    case 'txt':
      need(asText(b), label);
      break;
    case 'html':
      if (!/<html[\s>]|<!doctype html/i.test(need(asText(b), label))) throw new Fail(`${label} has no <html> element or HTML doctype`);
      break;
    case 'docx':
    case 'xlsx':
    case 'pptx': {
      const k = officeKind(need(zipEntries(b), label));
      if (k !== type) throw new Fail(k === null ? `${label} is not an Office file` : `${label} is a ${k} file, not ${type}`);
      break;
    }
    case 'pdf':
      if (b.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Fail(`${label} does not start with %PDF-`);
      break;
    case 'eml':
      need(parseEml(b), label);
      break;
  }
  return `${b.length} bytes, reads as ${type}`;
}

function textLines(path: string, label: string): { where: string; text: string }[] {
  const b = need(readBytes(path), label);
  if (extOf(path) === 'docx') return need(docxParagraphs(b), label).map((p, i) => ({ where: `paragraph ${i + 1}`, text: p.text }));
  return need(asText(b), label).split(/\r?\n/).map((text, i) => ({ where: `line ${i + 1}`, text }));
}

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

function runOne(c: Condition, dir: string, csv: CsvCache, now: Date, ctx: RunContext): { ok: boolean; detail: string[]; status?: 'not computed' } {
  switch (c.kind) {
    case 'before_after': {
      const src = ctx.baseline;
      if (src === undefined) throw new Fail('no baseline store was given to this check, so there is nothing to compare against');
      const full = at(dir, c.file);
      const beforeFull = at(dir, c.before);
      const real = ctx.realPath ?? ((p: string): string => p);
      const base = src(real(beforeFull));
      if (!base.ok) throw new Fail(`baseline of ${c.before}: ${base.error}`);
      const now = need(readBytes(full), c.file);
      const r = compareOffice(extOf(c.file) as OfficeFormat, base.data, now, { inputs: c.inputs, redline: c.redline }, { before: `the baseline of ${c.before}`, after: c.file });
      const shown = r.lines.map((l) => `${l.outcome === 'pass' ? 'ok' : l.outcome === 'fail' ? 'FAIL' : 'NOT COMPUTED'}  ${l.text}`);
      const head = `against the baseline of ${c.before} taken ${base.ts}`;
      if (r.status === 'pass') return { ok: true, detail: [head, ...shown] };
      return { ok: false, detail: cut([head, ...shown]), ...(r.status === 'not computed' ? { status: 'not computed' as const } : {}) };
    }
    case 'exists':
      return { ok: true, detail: [fileType(at(dir, c.file), c.file, c.type)] };
    case 'headings': {
      const full = at(dir, c.file);
      const b = need(readBytes(full), c.file);
      const found = extOf(full) === 'docx' ? need(docxParagraphs(b), c.file).filter((p) => p.level !== null).map((p) => p.text) : markdownHeadings(need(asText(b), c.file));
      const have = found.map(norm);
      const missing = c.include.filter((h) => !have.includes(norm(h)));
      if (missing.length > 0) return { ok: false, detail: [`missing: ${missing.map(q).join(', ')}`, `headings found: ${found.length === 0 ? 'none' : found.slice(0, 12).map(q).join(', ')}`] };
      if (c.in_order) {
        const pos = c.include.map((h) => have.indexOf(norm(h)));
        const bad = pos.findIndex((p, i) => i > 0 && p < (pos[i - 1] ?? -1));
        if (bad !== -1) return { ok: false, detail: [`${q(c.include[bad] ?? '')} comes before ${q(c.include[bad - 1] ?? '')}`] };
      }
      return { ok: true, detail: [`${c.include.length} of ${c.include.length} present (${found.length} headings in the file)`] };
    }
    case 'no_placeholders': {
      const hits: string[] = [];
      for (const l of textLines(at(dir, c.file), c.file)) {
        for (const p of PLACEHOLDERS) {
          const m = p.re.exec(l.text);
          if (m !== null) hits.push(`${l.where}: ${q(m[0])} (${p.name})`);
        }
        for (const a of c.also) if (l.text.includes(a)) hits.push(`${l.where}: ${q(a)}`);
      }
      return hits.length > 0 ? { ok: false, detail: cut(hits) } : { ok: true, detail: ['none of the patterns found'] };
    }
    case 'recipients': {
      const m = need(parseEml(need(readBytes(at(dir, c.file)), c.file)), c.file);
      const out: string[] = [];
      for (const k of ['to', 'cc', 'bcc'] as const) {
        const want = new Set(c[k]);
        const have = new Set(m[k]);
        const extra = [...have].filter((x) => !want.has(x));
        const missing = [...want].filter((x) => !have.has(x));
        if (extra.length > 0) out.push(`${k}: not in the order: ${extra.join(', ')}`);
        if (missing.length > 0) out.push(`${k}: missing: ${missing.join(', ')}`);
      }
      return out.length > 0 ? { ok: false, detail: out } : { ok: true, detail: [`${c.to.length + c.cc.length + c.bcc.length} recipient(s), exactly as named`] };
    }
    case 'attachments': {
      const m = need(parseEml(need(readBytes(at(dir, c.file)), c.file)), c.file);
      const want = c.files.map((f) => `${f.name}\0${f.sha256}`);
      const have = m.attachments.map((a) => `${a.name}\0${a.sha256}`);
      const show = (s: string): string => {
        const [n, h] = s.split('\0');
        return `${q(n ?? '')} (sha256 ${(h ?? '').slice(0, 12)})`;
      };
      const left = [...have];
      const missing: string[] = [];
      for (const w of want) {
        const i = left.indexOf(w);
        if (i === -1) missing.push(w);
        else left.splice(i, 1);
      }
      const out = [...missing.map((w) => `missing or changed: ${show(w)}`), ...left.map((h) => `not in the order: ${show(h)}`)];
      return out.length > 0 ? { ok: false, detail: cut(out) } : { ok: true, detail: [`${want.length} attachment(s), names and content as named`] };
    }
    case 'rows': {
      const input = csv.get(c.input);
      const kept = csv.get(c.kept);
      const dropped = c.dropped !== null ? csv.get(c.dropped) : null;
      const out: string[] = [];
      const nIn = input.rows.length;
      const nKept = kept.rows.length;
      const nDrop = dropped?.rows.length ?? 0;
      const counts = new Map<string, number>();
      if (dropped !== null && c.dropped !== null) {
        const r = dropped.header.indexOf(c.reason_column);
        if (r === -1) throw new Fail(`${c.dropped} has no column ${q(c.reason_column)} for the reason of each dropped row`);
        const bad: string[] = [];
        for (const row of dropped.rows) {
          const why = (row.cells[r] ?? '').trim();
          if (why === '') bad.push(`${c.dropped} line ${row.line}: no reason`);
          else if (!c.filters.includes(why)) bad.push(`${c.dropped} line ${row.line}: reason ${q(why)} is not one of the order's filters`);
          else counts.set(why, (counts.get(why) ?? 0) + 1);
        }
        out.push(...bad);
      }
      if (nIn !== nKept + nDrop) out.unshift(`rows in ${nIn} != kept ${nKept} + dropped ${nDrop} (${nKept + nDrop})`);
      if (c.key !== null) {
        const key = c.key;
        const col = (x: Csv, name: string): number => {
          const i = x.header.indexOf(key);
          if (i === -1) throw new Fail(`${name} has no key column ${q(key)}`);
          return i;
        };
        const tally = new Map<string, number>();
        const ki = col(input, c.input);
        for (const row of input.rows) tally.set(row.cells[ki] ?? '', (tally.get(row.cells[ki] ?? '') ?? 0) + 1);
        const sides: [Csv, string][] = [[kept, c.kept]];
        if (dropped !== null && c.dropped !== null) sides.push([dropped, c.dropped]);
        for (const [x, name] of sides) {
          const i = col(x, name);
          for (const row of x.rows) tally.set(row.cells[i] ?? '', (tally.get(row.cells[i] ?? '') ?? 0) - 1);
        }
        const unaccounted = [...tally].filter(([, n]) => n > 0).map(([k]) => k);
        const extra = [...tally].filter(([, n]) => n < 0).map(([k]) => k);
        if (unaccounted.length > 0) out.push(`keys in the input that are neither kept nor dropped: ${unaccounted.slice(0, 8).map(q).join(', ')}${unaccounted.length > 8 ? ` and ${unaccounted.length - 8} more` : ''}`);
        if (extra.length > 0) out.push(`keys kept or dropped that are not in the input (or more often than there): ${extra.slice(0, 8).map(q).join(', ')}${extra.length > 8 ? ` and ${extra.length - 8} more` : ''}`);
      }
      if (out.length > 0) return { ok: false, detail: cut(out) };
      const per = c.filters.map((f) => `${q(f)} ${counts.get(f) ?? 0}`).join(', ');
      return { ok: true, detail: [`rows in ${nIn} = kept ${nKept} + dropped ${nDrop}${per !== '' ? ` (${per})` : ''}${c.key !== null ? `; every ${c.key} accounted for once` : ''}`] };
    }
    case 'unique': {
      const x = csv.get(c.file);
      const idx = c.columns.map((n) => {
        const i = x.header.indexOf(n);
        if (i === -1) throw new Fail(`${c.file} has no column ${q(n)} (columns: ${x.header.join(', ')})`);
        return i;
      });
      const first = new Map<string, number>();
      const dup: string[] = [];
      for (const row of x.rows) {
        const k = JSON.stringify(idx.map((i) => row.cells[i] ?? ''));
        const was = first.get(k);
        if (was !== undefined) dup.push(`line ${row.line} repeats line ${was}: ${idx.map((i) => q(row.cells[i] ?? '')).join(' + ')}`);
        else first.set(k, row.line);
      }
      return dup.length > 0 ? { ok: false, detail: cut(dup) } : { ok: true, detail: [`${x.rows.length} rows, no repeat`] };
    }
    case 'not_null': {
      const x = csv.get(c.file);
      const bad: string[] = [];
      for (const n of c.columns) {
        const { index } = csv.column(c.file, n);
        for (const row of x.rows) if ((row.cells[index] ?? '').trim() === '') bad.push(`line ${row.line}: ${q(n)} is empty`);
      }
      return bad.length > 0 ? { ok: false, detail: cut(bad) } : { ok: true, detail: [`${x.rows.length} rows, no empty cell in ${c.columns.join(', ')}`] };
    }
    case 'accepted_values': {
      const { csv: x, index } = csv.column(c.file, c.column);
      const bad = x.rows.filter((r) => !c.values.includes(r.cells[index] ?? '')).map((r) => `line ${r.line}: ${q(r.cells[index] ?? '')}`);
      return bad.length > 0 ? { ok: false, detail: cut(bad) } : { ok: true, detail: [`${x.rows.length} rows, every value listed`] };
    }
    case 'relationships': {
      const { csv: x, index } = csv.column(c.file, c.column);
      const { csv: y, index: j } = csv.column(c.to.file, c.to.column);
      const known = new Set(y.rows.map((r) => r.cells[j] ?? ''));
      let empty = 0;
      const bad: string[] = [];
      for (const r of x.rows) {
        const v = r.cells[index] ?? '';
        if (v.trim() === '') empty++;
        else if (!known.has(v)) bad.push(`line ${r.line}: ${q(v)} is not in ${c.to.file} ${c.to.column}`);
      }
      return bad.length > 0 ? { ok: false, detail: cut(bad) } : { ok: true, detail: [`${x.rows.length - empty} values found in ${c.to.file}${empty > 0 ? `; ${empty} empty, not checked` : ''}`] };
    }
    case 'freshness': {
      const { csv: x, index } = csv.column(c.file, c.column);
      let newest: number | null = null;
      const bad: string[] = [];
      for (const r of x.rows) {
        const v = (r.cells[index] ?? '').trim();
        if (v === '') continue;
        const t = parseDate(v);
        if (t === null) bad.push(`line ${r.line}: ${q(v)} is not an ISO date (YYYY-MM-DD)`);
        else if (newest === null || t > newest) newest = t;
      }
      if (bad.length > 0) return { ok: false, detail: cut(bad) };
      if (newest === null) return { ok: false, detail: [`${c.column} holds no date`] };
      const ageDays = (now.getTime() - newest) / 86400000;
      const when = new Date(newest).toISOString().slice(0, 10);
      if (ageDays > c.max_age_days) return { ok: false, detail: [`newest ${when} is ${Math.floor(ageDays)} days old; the order allows ${c.max_age_days}`] };
      return { ok: true, detail: [`newest ${when}, ${Math.max(0, Math.floor(ageDays))} days old (at most ${c.max_age_days})`] };
    }
    case 'total': {
      const sum = (ref: ColumnRef): bigint => {
        const { csv: x, index } = csv.column(ref.file, ref.column);
        let s = 0n;
        const bad: string[] = [];
        for (const r of x.rows) {
          const v = r.cells[index] ?? '';
          const n = parseAmount(v);
          if (n === null) bad.push(`${ref.file} line ${r.line}: ${q(v)} is not an amount`);
          else s += n;
        }
        if (bad.length > 0) throw new Fail(cut(bad).join('; '));
        return s;
      };
      const got = sum({ file: c.file, column: c.column });
      const want = c.equals !== null ? (parseAmount(c.equals) ?? 0n) : sum(c.equals_sum ?? { file: '', column: '' });
      const tol = parseAmount(c.tolerance) ?? 0n;
      const diff = got > want ? got - want : want - got;
      const src = c.equals !== null ? 'the stated control total' : `the sum of ${c.equals_sum?.file ?? ''} ${c.equals_sum?.column ?? ''}`;
      const line = `sum ${formatAmount(got)}; ${src} ${formatAmount(want)}; difference ${formatAmount(diff)}; tolerance ${formatAmount(tol)}`;
      return { ok: diff <= tol, detail: [line] };
    }
    case 'tests': {
      const read = (p: string, root: string | null): TestReport => {
        const full = at(dir, p);
        let text: string;
        try {
          const st = statSync(full);
          if (!st.isFile()) throw new Fail(`${p} is not a file`);
          if (st.size > MAX_REPORT_BYTES) throw new Fail(`${p} is larger than ${MAX_REPORT_BYTES} bytes`);
          text = readFileSync(full, 'utf8');
        } catch (e: unknown) {
          if (e instanceof Fail) throw e;
          throw new Fail(`${p} cannot be read`);
        }
        const r = parseTestReport(text, { ...(c.format !== null ? { format: c.format } : {}), ...(root !== null ? { root: at(dir, root) } : {}) });
        if (!r.ok) throw new Fail(`${p}: ${r.error}`);
        return r.report;
      };
      const before = read(c.before, c.before_root);
      const after = read(c.after, c.after_root);
      const beforeIds = new Set(before.tests.map((t) => t.id));
      if (!after.tests.some((t) => beforeIds.has(t.id))) return { ok: false, detail: ['no test name is in both reports; if they were made in two folders, set before_root and after_root'] };
      const cmp = compareTests([before], [after]);
      const gained = new Set(cmp.failToPass.map((g) => g.id));
      const afterIds = after.tests.map((t) => t.id);
      const status = (r: TestReport, id: string): string => r.tests.find((t) => t.id === id)?.status ?? 'absent';
      const bad: string[] = [];
      for (const name of c.ids) {
        const m = matchName(name, afterIds);
        if ('none' in m) bad.push(`${q(name)} is not in the after report`);
        else if ('many' in m) bad.push(`${q(name)} matches ${m.many.length} tests; give the full name`);
        else if (!gained.has(m.id)) bad.push(`${q(name)}: before ${status(before, m.id)}, after ${status(after, m.id)}; it must fail (or be absent) before and pass after`);
      }
      return bad.length > 0 ? { ok: false, detail: cut(bad) } : { ok: true, detail: [`${c.ids.length} named test(s) failed or were absent before and pass after`] };
    }
  }
}

/** Runs every condition of an order. A file that cannot be read fails its condition, never passes it. */
export function runConditions(order: Order, dir: string, now: Date, ctx: RunContext = {}): ConditionResult[] {
  const csv = new CsvCache(dir);
  return order.conditions.map((p) => {
    const c = p.condition;
    const base = { key: conditionKey(c), kind: c.kind, from: p.from, asks: describeCondition(c), notShown: notShownOf(c) };
    try {
      const r = runOne(c, dir, csv, now, ctx);
      return { ...base, outcome: r.ok ? 'pass' : 'fail', ...(r.status !== undefined ? { status: r.status } : {}), detail: r.detail };
    } catch (e: unknown) {
      if (!(e instanceof Fail)) throw e;
      return { ...base, outcome: 'fail', detail: [e.message] };
    }
  });
}

/** Each input's sha256 against the order; a changed or missing input is reported and fails the check. */
export function checkInputs(order: Order, dir: string): InputResult[] {
  return order.inputs.map((i) => {
    const b = readBytes(at(dir, i.path));
    if (!b.ok) return { path: i.path, outcome: 'fail', detail: `${i.path} ${b.error}` };
    const h = sha256Hex(b.value);
    return h === i.sha256 ? { path: i.path, outcome: 'pass', detail: `${i.path} unchanged` } : { path: i.path, outcome: 'fail', detail: `${i.path} changed since the order was written (sha256 ${h.slice(0, 12)}, the order says ${i.sha256.slice(0, 12)})` };
  });
}

/** Each output named by the order must exist and not be empty. */
export function checkOutputs(order: Order, dir: string): InputResult[] {
  return order.outputs.map((p) => {
    const b = readBytes(at(dir, p));
    if (!b.ok) return { path: p, outcome: 'fail', detail: `${p} ${b.error}` };
    return b.value.length === 0 ? { path: p, outcome: 'fail', detail: `${p} is empty` } : { path: p, outcome: 'pass', detail: `${p} exists` };
  });
}

/** Outputs no condition reads: a pass says nothing about them beyond their existence. */
export function outputsWithoutCondition(order: Order): string[] {
  const named = new Set<string>();
  for (const p of order.conditions) {
    const c = p.condition;
    for (const v of Object.values(c)) if (typeof v === 'string') named.add(v);
  }
  return order.outputs.filter((o) => !named.has(o));
}
