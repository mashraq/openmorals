// The plain-file readers of `openmorals order check`: bytes and hashes, CSV, Markdown headings and a mail draft (.eml).
// The zip container and the Word reader moved to src/office/ in 0.30.0, which no hook module imports (ruling R3: no
// office-format parser runs in the per-call path); this file is imported by the hold's modules, so it holds none.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';

export type Read<T> = { ok: true; value: T } | { ok: false; error: string };

/** The largest file a condition reads. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

export function sha256Hex(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The bytes of a regular file, or why they cannot be read. */
export function readBytes(path: string): Read<Buffer> {
  try {
    const st = statSync(path);
    if (!st.isFile()) return { ok: false, error: 'is not a file' };
    if (st.size > MAX_FILE_BYTES) return { ok: false, error: `is larger than ${MAX_FILE_BYTES} bytes` };
    return { ok: true, value: readFileSync(path) };
  } catch (e: unknown) {
    const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, error: 'does not exist' };
    return { ok: false, error: `cannot be read (${errMessage(e)})` };
  }
}

export function extOf(path: string): string {
  return extname(path).toLowerCase().replace(/^\./, '');
}

/** UTF-8 text, or an error when the bytes hold a NUL or do not decode (a binary file is not text). */
export function asText(buf: Buffer): Read<string> {
  if (buf.includes(0)) return { ok: false, error: 'holds a NUL byte, so it is not a text file' };
  try {
    const t = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return { ok: true, value: t.charCodeAt(0) === 0xfeff ? t.slice(1) : t };
  } catch {
    return { ok: false, error: 'is not valid UTF-8 text' };
  }
}

// ---------------------------------------------------------------------------------------------------------------- CSV

export interface CsvRow {
  /** The line of the file the row starts on (the header is line 1 when the file starts with it). */
  line: number;
  cells: string[];
}

export interface Csv {
  header: string[];
  rows: CsvRow[];
  /** Lines with nothing on them, which are not counted as rows. */
  blankLines: number;
}

/** RFC 4180 with a header row: quoted fields, doubled quotes, CRLF or LF. A row whose field count differs is an error. */
export function parseCsv(text: string, delimiter = ','): Read<Csv> {
  const records: CsvRow[] = [];
  let blankLines = 0;
  let field = '';
  let cells: string[] = [];
  let quoted = false;
  let started = false;
  let line = 1;
  let rowLine = 1;
  let i = 0;
  const endRow = (): void => {
    if (!started && cells.length === 0 && field === '') blankLines++;
    else {
      cells.push(field);
      records.push({ line: rowLine, cells });
    }
    cells = [];
    field = '';
    started = false;
  };
  while (i < text.length) {
    const ch = text[i] ?? '';
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        const next = text[i];
        if (next !== undefined && next !== delimiter && next !== '\n' && next !== '\r') return { ok: false, error: `line ${line}: a closing quote is followed by ${JSON.stringify(next)}` };
        continue;
      }
      if (ch === '\n') line++;
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      if (field !== '') return { ok: false, error: `line ${line}: a quote inside an unquoted field` };
      quoted = true;
      started = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      cells.push(field);
      field = '';
      started = true;
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      endRow();
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      line++;
      rowLine = line;
      continue;
    }
    if (!started) {
      started = true;
      rowLine = line;
    }
    field += ch;
    i++;
  }
  if (quoted) return { ok: false, error: `line ${rowLine}: a quoted field is not closed` };
  if (started || cells.length > 0 || field !== '') endRow();
  const head = records.shift();
  if (head === undefined) return { ok: false, error: 'has no header row' };
  const header = head.cells.map((c) => c.trim());
  const seen = new Set<string>();
  for (const h of header) {
    if (h === '') return { ok: false, error: 'the header has an empty column name' };
    if (seen.has(h)) return { ok: false, error: `the header names column ${JSON.stringify(h)} twice` };
    seen.add(h);
  }
  for (const r of records) {
    if (r.cells.length !== header.length) return { ok: false, error: `line ${r.line} has ${r.cells.length} fields; the header has ${header.length}` };
  }
  return { ok: true, value: { header, rows: records, blankLines } };
}

export function readCsv(path: string): Read<Csv> {
  const b = readBytes(path);
  if (!b.ok) return b;
  const t = asText(b.value);
  if (!t.ok) return t;
  return parseCsv(t.value, extOf(path) === 'tsv' ? '\t' : ',');
}

// ---------------------------------------------------------------------------------------------------------------- markdown

/** ATX (`## Title`) and setext (a line underlined with === or ---) headings, outside fenced code. */
export function markdownHeadings(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let fence: string | null = null;
  let prev: string | null = null;
  for (const raw of lines) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
    if (fence !== null) {
      if (f !== null && f[1] !== undefined && f[1][0] === fence[0] && f[1].length >= fence.length && raw.trim() === f[1]) fence = null;
      prev = null;
      continue;
    }
    if (f !== null && f[1] !== undefined) {
      fence = f[1];
      prev = null;
      continue;
    }
    const atx = /^ {0,3}#{1,6}(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(raw);
    if (atx !== null) {
      out.push((atx[1] ?? '').trim());
      prev = null;
      continue;
    }
    if (prev !== null && /^ {0,3}(=+|-+)[ \t]*$/.test(raw)) {
      out.push(prev.trim());
      prev = null;
      continue;
    }
    prev = raw.trim() === '' || /^ {4}/.test(raw) ? null : raw;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- mail

export interface MailAttachment {
  name: string;
  sha256: string;
  bytes: number;
}

export interface Mail {
  to: string[];
  cc: string[];
  bcc: string[];
  attachments: MailAttachment[];
}

const MAX_PARTS = 500;
const MAX_DEPTH = 10;

interface Part {
  headers: Map<string, string>;
  body: string;
}

/** Splits a message (latin1, so bytes survive) into unfolded headers and the body. */
function splitPart(s: string): Part {
  const m = /\r?\n\r?\n/.exec(s);
  const head = m === null ? s : s.slice(0, m.index);
  const body = m === null ? '' : s.slice(m.index + m[0].length);
  const headers = new Map<string, string>();
  let last: string | null = null;
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && last !== null) {
      headers.set(last, `${headers.get(last) ?? ''} ${line.trim()}`);
      continue;
    }
    const c = line.indexOf(':');
    if (c <= 0) continue;
    const name = line.slice(0, c).trim().toLowerCase();
    const value = line.slice(c + 1).trim();
    headers.set(name, headers.has(name) ? `${headers.get(name) ?? ''}, ${value}` : value);
    last = name;
  }
  return { headers, body };
}

/** A header value's main token and its parameters (RFC 2045, with RFC 2231 `name*=charset''value` and `name*0=` parts). */
function headerParams(v: string): { value: string; params: Map<string, string> } {
  const parts: string[] = [];
  let cur = '';
  let q = false;
  for (const ch of v) {
    if (ch === '"') q = !q;
    if (ch === ';' && !q) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  const params = new Map<string, string>();
  const pieces = new Map<string, { idx: number; val: string; enc: boolean }[]>();
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq <= 0) continue;
    let key = p.slice(0, eq).trim().toLowerCase();
    let val = p.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"') && val.length >= 2) val = val.slice(1, -1).replace(/\\(.)/g, '$1');
    const m = /^(.+?)\*(\d+)?(\*)?$/.exec(key);
    if (m !== null && m[1] !== undefined) {
      key = m[1];
      const list = pieces.get(key) ?? [];
      list.push({ idx: m[2] !== undefined ? Number(m[2]) : 0, val, enc: m[3] !== undefined || m[2] === undefined });
      pieces.set(key, list);
    } else params.set(key, val);
  }
  for (const [key, list] of pieces) {
    list.sort((a, b) => a.idx - b.idx);
    let charset = 'utf-8';
    let bytes = '';
    list.forEach((x, i) => {
      let val = x.val;
      if (x.enc && i === 0) {
        const m = /^([^']*)'[^']*'(.*)$/.exec(val);
        if (m !== null) {
          charset = m[1] !== undefined && m[1] !== '' ? m[1] : charset;
          val = m[2] ?? '';
        }
      }
      bytes += x.enc ? val.replace(/%([0-9A-Fa-f]{2})/g, (_m: string, h: string) => String.fromCharCode(parseInt(h, 16))) : val;
    });
    params.set(key, decodeBytes(bytes, charset));
  }
  return { value: (parts[0] ?? '').trim().toLowerCase(), params };
}

function decodeBytes(latin1: string, charset: string): string {
  const b = Buffer.from(latin1, 'latin1');
  try {
    return new TextDecoder(charset.toLowerCase(), { fatal: false }).decode(b);
  } catch {
    return b.toString('utf8');
  }
}

/** RFC 2047 encoded words in a header (`=?utf-8?B?...?=`, `=?utf-8?Q?...?=`). */
function decodeWords(s: string): string {
  return s.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m: string, cs: string, enc: string, text: string) => {
    const bytes = enc.toLowerCase() === 'b' ? Buffer.from(text, 'base64').toString('latin1') : text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_x: string, h: string) => String.fromCharCode(parseInt(h, 16)));
    return decodeBytes(bytes, cs);
  });
}

function decodeBody(body: string, encoding: string): Buffer {
  const e = encoding.trim().toLowerCase();
  if (e === 'base64') return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (e === 'quoted-printable') {
    const s = body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_m: string, h: string) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(s, 'latin1');
  }
  return Buffer.from(body, 'latin1');
}

/** Addresses in an address-list header, lower-cased: `Name <a@b>`, bare `a@b`, quoted names with commas, groups. */
export function parseAddresses(v: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  let angle = 0;
  let paren = 0;
  const flush = (): void => {
    let s = cur.trim();
    cur = '';
    if (s === '') return;
    const g = /^[^<>"@]*:(.*)$/.exec(s);
    if (g !== null) s = (g[1] ?? '').trim();
    s = s.replace(/;$/, '').trim();
    if (s === '') return;
    const m = /<([^<>]*)>/.exec(s);
    out.push((m !== null ? (m[1] ?? '') : s.replace(/\([^)]*\)/g, '')).trim().toLowerCase());
  };
  for (const ch of v) {
    if (ch === '"' && angle === 0 && paren === 0) q = !q;
    else if (!q) {
      if (ch === '<') angle++;
      else if (ch === '>') angle = Math.max(0, angle - 1);
      else if (ch === '(') paren++;
      else if (ch === ')') paren = Math.max(0, paren - 1);
      else if ((ch === ',' || ch === ';') && angle === 0 && paren === 0) {
        if (ch === ';') cur += ch;
        flush();
        continue;
      }
    }
    cur += ch;
  }
  flush();
  return out.filter((a) => a !== '');
}

/** Recipients and attachments of a mail draft in RFC 5322 / MIME form (.eml). */
export function parseEml(buf: Buffer): Read<Mail> {
  const top = splitPart(buf.toString('latin1'));
  if (top.headers.size === 0) return { ok: false, error: 'has no mail headers' };
  const addr = (h: string): string[] => parseAddresses(decodeWords(top.headers.get(h) ?? ''));
  const attachments: MailAttachment[] = [];
  let parts = 0;
  const walk = (p: Part, depth: number): string | null => {
    if (++parts > MAX_PARTS) return `has more than ${MAX_PARTS} parts`;
    if (depth > MAX_DEPTH) return `nests parts deeper than ${MAX_DEPTH}`;
    const ct = headerParams(p.headers.get('content-type') ?? 'text/plain');
    if (ct.value.startsWith('multipart/')) {
      const boundary = ct.params.get('boundary');
      if (boundary === undefined || boundary === '') return 'has a multipart part with no boundary';
      const lines = p.body.split(/\r?\n/);
      let cur: string[] | null = null;
      let closed = false;
      for (const line of lines) {
        const t = line.replace(/[ \t]+$/, '');
        if (t === `--${boundary}` || t === `--${boundary}--`) {
          if (cur !== null) {
            const e = walk(splitPart(cur.join('\r\n')), depth + 1);
            if (e !== null) return e;
          }
          if (t.endsWith('--') && t === `--${boundary}--`) {
            closed = true;
            cur = null;
            break;
          }
          cur = [];
          continue;
        }
        if (cur !== null) cur.push(line);
      }
      if (!closed) return 'has a multipart part that is not closed';
      return null;
    }
    const cd = headerParams(p.headers.get('content-disposition') ?? '');
    const name = cd.params.get('filename') ?? ct.params.get('name');
    if (cd.value === 'attachment' || name !== undefined) {
      const data = decodeBody(p.body, p.headers.get('content-transfer-encoding') ?? '7bit');
      attachments.push({ name: decodeWords(name ?? ''), sha256: sha256Hex(data), bytes: data.length });
    }
    return null;
  };
  const e = walk(top, 0);
  if (e !== null) return { ok: false, error: e };
  return { ok: true, value: { to: addr('to'), cc: addr('cc'), bcc: addr('bcc'), attachments } };
}
