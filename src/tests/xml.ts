/**
 * A small XML reader for test reports: elements, attributes and (0.17.0) each element's own text, cut at MAX_TEXT
 * characters (comments and the prolog are skipped; CDATA counts as text).
 * It refuses a DOCTYPE (no entity definitions are ever expanded), an unknown entity, a mismatched or unclosed tag, more
 * than one root element and nesting deeper than MAX_DEPTH, so a report it cannot read is reported as unreadable rather
 * than read as fewer tests.
 */

export interface XmlElement {
  name: string;
  attrs: ReadonlyMap<string, string>;
  children: XmlElement[];
  /** The element's own text and CDATA, entities decoded where they can be (else kept as written), at most MAX_TEXT characters. */
  text?: string;
}

export type XmlResult = { ok: true; root: XmlElement } | { ok: false; error: string };

export const MAX_DEPTH = 256;
export const MAX_TEXT = 16384;

function addText(el: XmlElement | undefined, raw: string, decode: boolean): void {
  if (el === undefined || raw === '') return;
  const have = el.text ?? '';
  if (have.length >= MAX_TEXT) return;
  const t = decode ? decodeEntities(raw) ?? raw : raw;
  el.text = (have + t).slice(0, MAX_TEXT);
}

const NAMED: Readonly<Record<string, string>> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Decodes the five named entities and numeric references; null when the text holds any other `&`. */
export function decodeEntities(s: string): string | null {
  if (!s.includes('&')) return s;
  let bad = false;
  const out = s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z]+);?/g, (m: string, body: string) => {
    if (!m.endsWith(';')) {
      bad = true;
      return m;
    }
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code > 0x10ffff) {
        bad = true;
        return m;
      }
      return String.fromCodePoint(code);
    }
    const named = Object.prototype.hasOwnProperty.call(NAMED, body) ? NAMED[body] : undefined;
    if (named === undefined) {
      bad = true;
      return m;
    }
    return named;
  });
  if (bad || /&(?!#[xX][0-9a-fA-F]{1,6};|#[0-9]{1,7};|(lt|gt|amp|quot|apos);)/.test(s)) return null;
  return out;
}

const NAME_END = /[\s/>]/;

function lineAt(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

export function parseXml(input: string): XmlResult {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const fail = (at: number, what: string): XmlResult => ({ ok: false, error: `${what} (line ${lineAt(text, at)})` });
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      if (stack.length === 0 && text.slice(i).trim() === '') break;
      if (stack.length > 0) return fail(text.length, `unclosed <${stack[stack.length - 1]?.name ?? ''}>`);
      break;
    }
    if (stack.length === 0 && text.slice(i, lt).trim() !== '') return fail(i, 'text outside the root element');
    addText(stack[stack.length - 1], text.slice(i, lt), true);
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
      addText(stack[stack.length - 1], text.slice(i + 9, end), false);
      i = end + 3;
      continue;
    }
    if (text.startsWith('<!', i)) return fail(i, 'a DOCTYPE or other declaration is not read');
    if (text.startsWith('</', i)) {
      const end = text.indexOf('>', i + 2);
      if (end === -1) return fail(i, 'unclosed end tag');
      const name = text.slice(i + 2, end).trim();
      const open = stack.pop();
      if (open === undefined || open.name !== name) return fail(i, `</${name}> does not close ${open === undefined ? 'anything' : `<${open.name}>`}`);
      i = end + 1;
      continue;
    }
    let j = i + 1;
    while (j < text.length && !NAME_END.test(text.charAt(j))) j++;
    const name = text.slice(i + 1, j);
    if (name === '') return fail(i, 'a tag with no name');
    const attrs = new Map<string, string>();
    let selfClosing = false;
    for (;;) {
      while (j < text.length && /\s/.test(text.charAt(j))) j++;
      if (j >= text.length) return fail(i, `unclosed <${name}`);
      if (text.startsWith('/>', j)) {
        selfClosing = true;
        j += 2;
        break;
      }
      if (text.charAt(j) === '>') {
        j += 1;
        break;
      }
      const a = j;
      while (j < text.length && !/[\s=/>]/.test(text.charAt(j))) j++;
      const attr = text.slice(a, j);
      if (attr === '') return fail(j, `a bad attribute in <${name}>`);
      while (j < text.length && /\s/.test(text.charAt(j))) j++;
      if (text.charAt(j) !== '=') return fail(j, `attribute ${attr} in <${name}> has no value`);
      j++;
      while (j < text.length && /\s/.test(text.charAt(j))) j++;
      const q = text.charAt(j);
      if (q !== '"' && q !== "'") return fail(j, `attribute ${attr} in <${name}> is not quoted`);
      const close = text.indexOf(q, j + 1);
      if (close === -1) return fail(j, `attribute ${attr} in <${name}> is not closed`);
      const value = decodeEntities(text.slice(j + 1, close));
      if (value === null) return fail(j, `attribute ${attr} in <${name}> holds an entity that is not read`);
      attrs.set(attr, value);
      j = close + 1;
    }
    const el: XmlElement = { name, attrs, children: [] };
    const parent = stack[stack.length - 1];
    if (parent !== undefined) parent.children.push(el);
    else if (root !== null) return fail(i, 'more than one root element');
    else root = el;
    if (!selfClosing) {
      if (stack.length >= MAX_DEPTH) return fail(i, `elements nested deeper than ${MAX_DEPTH}`);
      stack.push(el);
    }
    i = j;
  }
  if (stack.length > 0) return fail(text.length, `unclosed <${stack[stack.length - 1]?.name ?? ''}>`);
  if (root === null) return { ok: false, error: 'no XML element found' };
  return { ok: true, root };
}
