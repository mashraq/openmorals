// An XML scanner for the parts of docx and xlsx files: it reports each element's start and end and its text to the
// caller and builds no tree, so a large sheet costs what the caller keeps. The same refusals as the test-report reader:
// a DOCTYPE or any other declaration is refused (so no entity is ever defined, and no external entity is ever resolved),
// an entity other than the five named ones and numeric references is refused, as are a mismatched or unclosed tag, text
// or a second element outside the root, nesting deeper than a cap and more elements than a cap.
import { decodeEntities } from '../tests/xml.js';
import type { Read } from './zip.js';

export const SCAN_MAX_DEPTH = 256;
export const SCAN_MAX_ELEMENTS = 8_000_000;

export interface ScanHandler {
  /** An element starts. `attrs` keeps the names as written (with any prefix). */
  open(name: string, attrs: ReadonlyMap<string, string>, selfClosing: boolean): void;
  close(name: string): void;
  /** Character data inside the root element, entities decoded; CDATA as written. */
  text(t: string): void;
}

/** The name without its namespace prefix: `w:p` -> `p`. */
export function local(name: string): string {
  const i = name.indexOf(':');
  return i === -1 ? name : name.slice(i + 1);
}

/** An attribute by its local name (`val` finds `w:val`), skipping namespace declarations. */
export function attrOf(attrs: ReadonlyMap<string, string>, name: string): string | undefined {
  const direct = attrs.get(name);
  if (direct !== undefined) return direct;
  for (const [k, v] of attrs) if (k !== 'xmlns' && !k.startsWith('xmlns:') && local(k) === name) return v;
  return undefined;
}

function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

function lineAt(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

export function scanXml(input: string, h: ScanHandler, limits: { maxDepth?: number; maxElements?: number } = {}): Read<null> {
  const maxDepth = limits.maxDepth ?? SCAN_MAX_DEPTH;
  const maxElements = limits.maxElements ?? SCAN_MAX_ELEMENTS;
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const fail = (at: number, what: string): Read<null> => ({ ok: false, error: `${what} (line ${lineAt(text, at)})` });
  const stack: string[] = [];
  let rootSeen = false;
  let elements = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    const chunkEnd = lt === -1 ? n : lt;
    if (chunkEnd > i) {
      const raw = text.slice(i, chunkEnd);
      if (stack.length === 0) {
        if (raw.trim() !== '') return fail(i, 'text outside the root element');
      } else {
        const t = decodeEntities(raw);
        if (t === null) return fail(i, 'an entity that is not read (only &lt; &gt; &amp; &quot; &apos; and numeric references are)');
        h.text(t);
      }
    }
    if (lt === -1) break;
    i = lt;
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2);
      if (end === -1) return fail(i, 'unclosed <?');
      i = end + 2;
      continue;
    }
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end === -1) return fail(i, 'unclosed comment');
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      if (stack.length === 0) return fail(i, 'CDATA outside the root element');
      const end = text.indexOf(']]>', i + 9);
      if (end === -1) return fail(i, 'unclosed CDATA');
      h.text(text.slice(i + 9, end));
      i = end + 3;
      continue;
    }
    if (text.startsWith('<!', i)) return fail(i, 'a DOCTYPE or other declaration is not read');
    if (text.startsWith('</', i)) {
      const end = text.indexOf('>', i + 2);
      if (end === -1) return fail(i, 'unclosed end tag');
      const name = text.slice(i + 2, end).trim();
      const open = stack.pop();
      if (open === undefined || open !== name) return fail(i, `</${name.slice(0, 60)}> does not close ${open === undefined ? 'anything' : `<${open}>`}`);
      h.close(name);
      i = end + 1;
      continue;
    }
    let j = i + 1;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (isSpace(c) || c === 0x2f || c === 0x3e) break;
      j++;
    }
    const name = text.slice(i + 1, j);
    if (name === '') return fail(i, 'a tag with no name');
    const attrs = new Map<string, string>();
    let selfClosing = false;
    for (;;) {
      while (j < n && isSpace(text.charCodeAt(j))) j++;
      if (j >= n) return fail(i, `unclosed <${name.slice(0, 60)}`);
      if (text.charCodeAt(j) === 0x2f && text.charCodeAt(j + 1) === 0x3e) {
        selfClosing = true;
        j += 2;
        break;
      }
      if (text.charCodeAt(j) === 0x3e) {
        j += 1;
        break;
      }
      const a = j;
      while (j < n) {
        const c = text.charCodeAt(j);
        if (isSpace(c) || c === 0x3d || c === 0x2f || c === 0x3e) break;
        j++;
      }
      const attr = text.slice(a, j);
      if (attr === '') return fail(j, `a bad attribute in <${name.slice(0, 60)}>`);
      while (j < n && isSpace(text.charCodeAt(j))) j++;
      if (text.charCodeAt(j) !== 0x3d) return fail(j, `attribute ${attr.slice(0, 60)} in <${name.slice(0, 60)}> has no value`);
      j++;
      while (j < n && isSpace(text.charCodeAt(j))) j++;
      const q = text.charAt(j);
      if (q !== '"' && q !== "'") return fail(j, `attribute ${attr.slice(0, 60)} in <${name.slice(0, 60)}> is not quoted`);
      const close = text.indexOf(q, j + 1);
      if (close === -1) return fail(j, `attribute ${attr.slice(0, 60)} in <${name.slice(0, 60)}> is not closed`);
      const value = decodeEntities(text.slice(j + 1, close));
      if (value === null) return fail(j, `attribute ${attr.slice(0, 60)} in <${name.slice(0, 60)}> holds an entity that is not read`);
      if (attrs.has(attr)) return fail(j, `attribute ${attr.slice(0, 60)} appears twice in <${name.slice(0, 60)}>`);
      attrs.set(attr, value);
      j = close + 1;
    }
    if (stack.length === 0) {
      if (rootSeen) return fail(i, 'more than one root element');
      rootSeen = true;
    }
    if (++elements > maxElements) return fail(i, `more than ${maxElements} elements`);
    if (!selfClosing && stack.length >= maxDepth) return fail(i, `elements nested deeper than ${maxDepth}`);
    h.open(name, attrs, selfClosing);
    if (selfClosing) h.close(name);
    else stack.push(name);
    i = j;
  }
  if (stack.length > 0) return fail(n, `unclosed <${stack[stack.length - 1] ?? ''}>`);
  if (!rootSeen) return { ok: false, error: 'no XML element found' };
  return { ok: true, value: null };
}
