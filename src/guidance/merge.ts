import { BEGIN_MARKER, END_MARKER } from './render.js';

export type MergeResult =
  | { ok: true; text: string; changed: boolean }
  | { ok: false; code: 'malformed-markers'; message: string };

interface MarkerScan {
  begins: number[];
  ends: number[];
  lines: string[];
  eol: string;
}

function scan(text: string): MarkerScan {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const begins: number[] = [];
  const ends: number[] = [];
  lines.forEach((l, i) => {
    const t = l.trim();
    if (t === BEGIN_MARKER) begins.push(i);
    else if (t === END_MARKER) ends.push(i);
  });
  return { begins, ends, lines, eol };
}

function malformed(s: MarkerScan): string | null {
  if (s.begins.length === 0 && s.ends.length === 0) return null;
  if (s.begins.length !== 1 || s.ends.length !== 1) {
    return `expected one openmorals block, found ${s.begins.length} begin and ${s.ends.length} end markers; fix the file by hand, nothing was changed`;
  }
  const [b] = s.begins;
  const [e] = s.ends;
  if (b === undefined || e === undefined || b > e) return 'the openmorals end marker comes before the begin marker; nothing was changed';
  return null;
}

function blockLines(block: string): string[] {
  return block.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
}

export function mergeGuidance(existing: string | null, block: string): MergeResult {
  const inner = scan(block);
  const bad = malformed(inner);
  if (bad !== null || inner.begins.length !== 1) {
    return { ok: false, code: 'malformed-markers', message: 'the generated block must hold exactly one begin and one end marker' };
  }
  const newBlock = blockLines(block);
  if (existing === null || existing === '') {
    return { ok: true, text: newBlock.join('\n') + '\n', changed: true };
  }
  const s = scan(existing);
  const err = malformed(s);
  if (err !== null) return { ok: false, code: 'malformed-markers', message: err };
  let lines: string[];
  if (s.begins.length === 0) {
    lines = [...s.lines];
    const trailingEmpty = lines.length > 0 && lines[lines.length - 1] === '';
    if (trailingEmpty) lines.pop();
    if (lines.length > 0 && lines[lines.length - 1]?.trim() !== '') lines.push('');
    lines.push(...newBlock, '');
  } else {
    const b = s.begins[0] ?? 0;
    const e = s.ends[0] ?? 0;
    lines = [...s.lines.slice(0, b), ...newBlock, ...s.lines.slice(e + 1)];
  }
  const text = lines.join(s.eol);
  return { ok: true, text, changed: text !== existing };
}

export function removeGuidance(existing: string): MergeResult {
  const s = scan(existing);
  const err = malformed(s);
  if (err !== null) return { ok: false, code: 'malformed-markers', message: err };
  if (s.begins.length === 0) return { ok: true, text: existing, changed: false };
  const b = s.begins[0] ?? 0;
  const e = s.ends[0] ?? 0;
  const before = s.lines.slice(0, b);
  const after = s.lines.slice(e + 1);
  if (after.length > 0 && after[0] === '' && before.length > 0 && before[before.length - 1]?.trim() === '') before.pop();
  const text = [...before, ...after].join(s.eol);
  return { ok: true, text, changed: text !== existing };
}

export function extractGuidance(existing: string): string | null {
  const s = scan(existing);
  if (malformed(s) !== null || s.begins.length === 0) return null;
  const b = s.begins[0] ?? 0;
  const e = s.ends[0] ?? 0;
  return s.lines.slice(b, e + 1).join('\n');
}
