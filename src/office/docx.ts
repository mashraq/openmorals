// Word documents (.docx). `docxParagraphs` is the 0.27.0 reader of `order check`'s headings and placeholder conditions,
// moved here unchanged apart from the hardened zip reader under it. `readDocument` is the before-after reader (0.30.0):
// each paragraph's text as it reads with every tracked change accepted and as it read with every one rejected, its
// heading level, and the tables, read through the bounded scanner (no tree is built).
import { asText } from '../order/files.js';
import { parseXml } from '../tests/xml.js';
import type { XmlElement } from '../tests/xml.js';
import { ZipReader, officeKind, zipEntries, zipRead } from './zip.js';
import type { Read } from './zip.js';
import { attrOf, local, scanXml } from './xmlscan.js';
import { resolvePart } from './xlsx.js';

export interface Paragraph {
  text: string;
  /** The heading level (0 for the Title style), or null for body text. */
  level: number | null;
}

function attr(el: XmlElement, name: string): string | undefined {
  return el.attrs.get(name);
}

function child(el: XmlElement, name: string): XmlElement | undefined {
  return el.children.find((c) => c.name === name);
}

function headingLevelOfName(name: string): number | null {
  const n = name.trim().toLowerCase();
  if (n === 'title') return 0;
  const m = /^heading\s*([1-9])$/.exec(n);
  return m !== null ? Number(m[1]) : null;
}

function outlineLevel(pPr: XmlElement | undefined): number | null {
  const o = pPr !== undefined ? child(pPr, 'w:outlineLvl') : undefined;
  const v = o !== undefined ? attr(o, 'w:val') : undefined;
  if (v === undefined || !/^[0-8]$/.test(v)) return null;
  return Number(v) + 1;
}

/** Heading levels by style id, from styles.xml: a style named "heading N" or "Title", one with an outline level, or one based on such a style. */
function styleLevels(styles: XmlElement | null): Map<string, number> {
  const direct = new Map<string, number | null>();
  const based = new Map<string, string>();
  if (styles !== null) {
    for (const s of styles.children) {
      if (s.name !== 'w:style' || (attr(s, 'w:type') ?? 'paragraph') !== 'paragraph') continue;
      const id = attr(s, 'w:styleId');
      if (id === undefined) continue;
      const nameEl = child(s, 'w:name');
      const byName = nameEl !== undefined ? headingLevelOfName(attr(nameEl, 'w:val') ?? '') : null;
      direct.set(id, byName ?? outlineLevel(child(s, 'w:pPr')));
      const b = child(s, 'w:basedOn');
      const bv = b !== undefined ? attr(b, 'w:val') : undefined;
      if (bv !== undefined) based.set(id, bv);
    }
  }
  return resolveLevels(direct, based);
}

function resolveLevels(direct: ReadonlyMap<string, number | null>, based: ReadonlyMap<string, string>): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of direct.keys()) {
    let cur: string | undefined = id;
    for (let depth = 0; cur !== undefined && depth < 10; depth++) {
      const lv = direct.get(cur);
      if (lv !== null && lv !== undefined) {
        out.set(id, lv);
        break;
      }
      cur = based.get(cur);
    }
  }
  return out;
}

function paragraphText(p: XmlElement): string {
  let s = '';
  const walk = (el: XmlElement): void => {
    for (const c of el.children) {
      if (c.name === 'w:p') continue;
      if (c.name === 'w:t') s += c.text ?? '';
      else if (c.name === 'w:tab') s += '\t';
      else if (c.name === 'w:br' || c.name === 'w:cr') s += '\n';
      else walk(c);
    }
  };
  walk(p);
  return s;
}

/** The paragraphs of a Word document in order, with their heading level (the 0.27.0 reader of `order check`). */
export function docxParagraphs(buf: Buffer): Read<Paragraph[]> {
  const z = zipEntries(buf);
  if (!z.ok) return z;
  if (officeKind(z.value) !== 'docx') return { ok: false, error: 'is not a Word document (no word/document.xml)' };
  const xml = (name: string): Read<XmlElement> | null => {
    const e = z.value.find((x) => x.name === name);
    if (e === undefined) return null;
    const b = zipRead(buf, e);
    if (!b.ok) return b;
    const t = asText(b.value);
    if (!t.ok) return { ok: false, error: `${name} ${t.error}` };
    const x = parseXml(t.value);
    return x.ok ? { ok: true, value: x.root } : { ok: false, error: `${name}: ${x.error}` };
  };
  const doc = xml('word/document.xml');
  if (doc === null || !doc.ok) return doc ?? { ok: false, error: 'has no word/document.xml' };
  const st = xml('word/styles.xml');
  if (st !== null && !st.ok) return st;
  const levels = styleLevels(st?.value ?? null);
  const out: Paragraph[] = [];
  const walk = (el: XmlElement): void => {
    for (const c of el.children) {
      if (c.name === 'w:p') {
        const pPr = child(c, 'w:pPr');
        const ps = pPr !== undefined ? child(pPr, 'w:pStyle') : undefined;
        const sid = ps !== undefined ? attr(ps, 'w:val') : undefined;
        let level = outlineLevel(pPr);
        if (level === null && sid !== undefined) level = levels.get(sid) ?? headingLevelOfName(sid.replace(/^heading/i, 'heading '));
        out.push({ text: paragraphText(c), level });
      }
      walk(c);
    }
  };
  walk(doc.value);
  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------------------------------------------- before-after

/** The largest document part read. */
export const MAX_DOC_PART_BYTES = 48 * 1024 * 1024;
/** The most paragraphs read. */
export const MAX_PARAGRAPHS = 1_000_000;

export interface DocParagraph {
  /** The text with every tracked change accepted (insertions kept, deletions gone). */
  accepted: string;
  /** The text with every tracked change rejected (insertions gone, deletions back). */
  rejected: string;
  level: number | null;
}

export interface WordDocument {
  paragraphs: DocParagraph[];
  /** Tables, nested ones included. */
  tables: number;
  /** Tracked insertions, deletions and moves found in the body. */
  revisions: number;
}

/** Reads the body of a Word document for the before-after check. Anything that does not read is an error, never a partial read. */
export function readDocument(buf: Buffer): Read<WordDocument> {
  const o = ZipReader.open(buf);
  if (!o.ok) return o;
  const z = o.value;
  if (!z.has('[Content_Types].xml')) return { ok: false, error: 'is not an Office file (no [Content_Types].xml)' };
  let main = 'word/document.xml';
  const rels = readRelTargets(z, '');
  if (!rels.ok) return rels;
  const od = rels.value.find((r) => r.type.endsWith('/officeDocument'));
  if (od !== undefined && od.target !== null) main = od.target;
  if (!z.has(main)) return { ok: false, error: 'is not a Word document (no word/document.xml)' };
  const mainRels = readRelTargets(z, main);
  if (!mainRels.ok) return mainRels;
  const stylesPart = mainRels.value.find((r) => r.type.endsWith('/styles'))?.target ?? 'word/styles.xml';

  const direct = new Map<string, number | null>();
  const based = new Map<string, string>();
  if (z.has(stylesPart)) {
    const t = z.text(stylesPart, MAX_DOC_PART_BYTES);
    if (t === null || !t.ok) return t ?? { ok: false, error: `${stylesPart} is missing` };
    let sid: string | null = null;
    let inPPr = false;
    const s = scanXml(t.value, {
      open(n, a) {
        const l = local(n);
        if (l === 'style') {
          sid = (attrOf(a, 'type') ?? 'paragraph') === 'paragraph' ? (attrOf(a, 'styleId') ?? null) : null;
          if (sid !== null && !direct.has(sid)) direct.set(sid, null);
        } else if (sid !== null) {
          if (l === 'name') {
            const lv = headingLevelOfName(attrOf(a, 'val') ?? '');
            if (lv !== null) direct.set(sid, lv);
          } else if (l === 'basedOn') {
            const v = attrOf(a, 'val');
            if (v !== undefined) based.set(sid, v);
          } else if (l === 'pPr') inPPr = true;
          else if (l === 'outlineLvl' && inPPr && direct.get(sid) === null) {
            const v = attrOf(a, 'val');
            if (v !== undefined && /^[0-8]$/.test(v)) direct.set(sid, Number(v) + 1);
          }
        }
      },
      close(n) {
        const l = local(n);
        if (l === 'style') sid = null;
        else if (l === 'pPr') inPPr = false;
      },
      text() {},
    });
    if (!s.ok) return { ok: false, error: `${stylesPart}: ${s.error}` };
  }
  const levels = resolveLevels(direct, based);

  const t = z.text(main, MAX_DOC_PART_BYTES);
  if (t === null || !t.ok) return t ?? { ok: false, error: `${main} is missing` };
  const paragraphs: DocParagraph[] = [];
  const open: { p: DocParagraph; sid: string | undefined; outline: number | null; at: number }[] = [];
  let tables = 0;
  let revisions = 0;
  let inserted = 0;
  let deleted = 0;
  let fallback = 0;
  let pPrDepth = 0;
  let textTag: 't' | 'delText' | null = null;
  let rootName = '';
  let depth = 0;
  let err: string | null = null;
  const add = (s: string, kind: 'both' | 'accepted' | 'rejected'): void => {
    const cur = open[open.length - 1];
    if (cur === undefined) return;
    if (kind !== 'rejected') cur.p.accepted += s;
    if (kind !== 'accepted') cur.p.rejected += s;
    if (cur.p.accepted.length > 1_000_000 || cur.p.rejected.length > 1_000_000) err = 'a paragraph holds more than 1,000,000 characters';
  };
  const where = (): 'both' | 'accepted' | 'rejected' => (deleted > 0 ? 'rejected' : inserted > 0 ? 'accepted' : 'both');
  const s = scanXml(t.value, {
    open(n, a, selfClosing) {
      depth++;
      const l = local(n);
      if (depth === 1) rootName = l;
      if (err !== null) return;
      if (l === 'Fallback') {
        fallback++;
        return;
      }
      if (fallback > 0) return;
      if (l === 'p') {
        const p: DocParagraph = { accepted: '', rejected: '', level: null };
        open.push({ p, sid: undefined, outline: null, at: paragraphs.length });
        paragraphs.push(p);
        if (paragraphs.length > MAX_PARAGRAPHS) err = `more than ${MAX_PARAGRAPHS} paragraphs`;
      } else if (l === 'pPr') pPrDepth++;
      else if (pPrDepth > 0 && open.length > 0) {
        const cur = open[open.length - 1];
        if (cur !== undefined && l === 'pStyle') cur.sid = attrOf(a, 'val');
        else if (cur !== undefined && l === 'outlineLvl') {
          const v = attrOf(a, 'val');
          if (v !== undefined && /^[0-8]$/.test(v)) cur.outline = Number(v) + 1;
        }
      } else if (l === 'tbl') tables++;
      else if (l === 'ins' || l === 'moveTo') {
        if (!selfClosing) {
          inserted++;
          revisions++;
        }
      } else if (l === 'del' || l === 'moveFrom') {
        if (!selfClosing) {
          deleted++;
          revisions++;
        }
      } else if (l === 't') textTag = 't';
      else if (l === 'delText') textTag = 'delText';
      else if (l === 'tab' && open.length > 0) add('\t', where());
      else if ((l === 'br' || l === 'cr') && open.length > 0) add('\n', where());
    },
    close(n) {
      depth--;
      const l = local(n);
      if (l === 'Fallback') {
        fallback--;
        return;
      }
      if (fallback > 0) return;
      if (l === 'p') {
        const cur = open.pop();
        if (cur !== undefined) {
          let level = cur.outline;
          if (level === null && cur.sid !== undefined) level = levels.get(cur.sid) ?? headingLevelOfName(cur.sid.replace(/^heading/i, 'heading '));
          cur.p.level = level;
        }
      } else if (l === 'pPr') pPrDepth = Math.max(0, pPrDepth - 1);
      else if (l === 'ins' || l === 'moveTo') inserted = Math.max(0, inserted - 1);
      else if (l === 'del' || l === 'moveFrom') deleted = Math.max(0, deleted - 1);
      else if (l === 't' || l === 'delText') textTag = null;
    },
    text(s) {
      if (err !== null || fallback > 0 || textTag === null || pPrDepth > 0) return;
      if (textTag === 'delText') add(s, 'rejected');
      else add(s, where());
    },
  });
  if (!s.ok) return { ok: false, error: `${main}: ${s.error}` };
  if (err !== null) return { ok: false, error: `${main}: ${err}` };
  if (rootName !== 'document') return { ok: false, error: `is not a Word document (${main} holds <${rootName.slice(0, 40)}>)` };
  return { ok: true, value: { paragraphs, tables, revisions } };
}

interface RelTarget {
  type: string;
  target: string | null;
}

function readRelTargets(z: ZipReader, part: string): Read<RelTarget[]> {
  const i = part.lastIndexOf('/');
  const name = part === '' ? '_rels/.rels' : i === -1 ? `_rels/${part}.rels` : `${part.slice(0, i)}/_rels/${part.slice(i + 1)}.rels`;
  const t = z.text(name, MAX_DOC_PART_BYTES);
  if (t === null) return { ok: true, value: [] };
  if (!t.ok) return t;
  const out: RelTarget[] = [];
  const s = scanXml(t.value, {
    open(n, a) {
      if (local(n) !== 'Relationship') return;
      const external = (attrOf(a, 'TargetMode') ?? '').toLowerCase() === 'external';
      const target = attrOf(a, 'Target');
      out.push({ type: attrOf(a, 'Type') ?? '', target: external || target === undefined ? null : resolvePart(part, target) });
    },
    close() {},
    text() {},
  });
  return s.ok ? { ok: true, value: out } : { ok: false, error: `${name}: ${s.error}` };
}
