// The zip container of docx, xlsx and pptx files, read from its central directory with Node's own zlib. Every file is
// hostile input: the entry count, each entry's inflated size and the inflation of all entries read from one file are
// bounded; an entry must inflate to exactly its declared size with a matching CRC-32; an entry name that is not a plain
// part name (absolute, `..`, a backslash, a control character) or a name given twice refuses the whole file. Nothing
// read here is ever written anywhere, and no name from inside an archive ever becomes a path on disk.
// Never imported by a hook (ruling R3): the hook's module graph is tested to hold nothing under src/office/.
import { inflateRawSync } from 'node:zlib';

export type Read<T> = { ok: true; value: T } | { ok: false; error: string };

/** The largest entry read out of a zip container (a guard against a small file that inflates to a huge one). */
export const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
/** The most entries a container may list. */
export const MAX_ENTRIES = 10_000;
/** The most bytes inflated from one container across every entry read (a reader keeps the count). */
export const MAX_TOTAL_INFLATE = 256 * 1024 * 1024;

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
  crc: number;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = (CRC_TABLE[(c ^ (b[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Why an entry name is not a plain part name, or null. */
function badName(name: string): string | null {
  if (name === '') return 'an empty entry name';
  if (/[\u0000-\u001f\u007f\\]/.test(name)) return `the entry name ${JSON.stringify(name.slice(0, 80))} holds a control character or a backslash`;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return `the entry name ${JSON.stringify(name.slice(0, 80))} is absolute`;
  if (name.split('/').some((s) => s === '..')) return `the entry name ${JSON.stringify(name.slice(0, 80))} climbs out with ..`;
  return null;
}

/** The entries of a zip file from its central directory. ZIP64, encryption, multi-disk archives and bad names are refused. */
export function zipEntries(buf: Buffer): Read<ZipEntry[]> {
  if (buf.length < 22) return { ok: false, error: 'is not a zip container (too short)' };
  const min = Math.max(0, buf.length - 22 - 65535);
  let eocd = -1;
  for (let p = buf.length - 22; p >= min; p--) {
    if (buf.readUInt32LE(p) === 0x06054b50) {
      eocd = p;
      break;
    }
  }
  if (eocd === -1) return { ok: false, error: 'is not a zip container (no end of central directory)' };
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return { ok: false, error: 'is a ZIP64 container, which is not read' };
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0) return { ok: false, error: 'is a multi-part zip container, which is not read' };
  if (total > MAX_ENTRIES) return { ok: false, error: `lists ${total} entries; at most ${MAX_ENTRIES} are read` };
  if (cdOffset + cdSize > buf.length) return { ok: false, error: 'has a central directory past its end' };
  const out: ZipEntry[] = [];
  const seen = new Set<string>();
  let p = cdOffset;
  for (let n = 0; n < total; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return { ok: false, error: 'has a damaged central directory' };
    const flags = buf.readUInt16LE(p + 8);
    if ((flags & 1) !== 0) return { ok: false, error: 'is encrypted' };
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    if (p + 46 + nameLen > buf.length) return { ok: false, error: 'has a damaged central directory' };
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const bad = badName(name);
    if (bad !== null) return { ok: false, error: `has ${bad}` };
    if (seen.has(name)) return { ok: false, error: `names the entry ${JSON.stringify(name.slice(0, 80))} twice` };
    seen.add(name);
    out.push({ name, method: buf.readUInt16LE(p + 10), crc: buf.readUInt32LE(p + 16), compressedSize: buf.readUInt32LE(p + 20), size: buf.readUInt32LE(p + 24), offset: buf.readUInt32LE(p + 42) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { ok: true, value: out };
}

/** One entry's bytes: its local header must name it, it must inflate to exactly its declared size, and its CRC-32 must match. */
export function zipRead(buf: Buffer, e: ZipEntry): Read<Buffer> {
  const p = e.offset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) return { ok: false, error: `entry ${e.name} has a damaged header` };
  const nameLen = buf.readUInt16LE(p + 26);
  if (p + 30 + nameLen > buf.length || buf.toString('utf8', p + 30, p + 30 + nameLen) !== e.name) return { ok: false, error: `entry ${e.name} has a local header naming another entry` };
  const start = p + 30 + nameLen + buf.readUInt16LE(p + 28);
  const end = start + e.compressedSize;
  if (end > buf.length) return { ok: false, error: `entry ${e.name} runs past the end of the file` };
  if (e.size > MAX_ENTRY_BYTES) return { ok: false, error: `entry ${e.name} is larger than ${MAX_ENTRY_BYTES} bytes` };
  const data = buf.subarray(start, end);
  let out: Buffer;
  if (e.method === 0) {
    if (e.compressedSize !== e.size) return { ok: false, error: `entry ${e.name} is stored with two different sizes` };
    out = Buffer.from(data);
  } else if (e.method === 8) {
    try {
      out = inflateRawSync(data, { maxOutputLength: Math.max(1, e.size) });
    } catch (err: unknown) {
      return { ok: false, error: `entry ${e.name} does not inflate to its declared ${e.size} bytes (${errMessage(err)})` };
    }
  } else return { ok: false, error: `entry ${e.name} uses compression method ${e.method}, which is not read` };
  if (out.length !== e.size) return { ok: false, error: `entry ${e.name} inflates to ${out.length} bytes, not its declared ${e.size}` };
  if (crc32(out) !== e.crc) return { ok: false, error: `entry ${e.name} fails its CRC-32 check` };
  return { ok: true, value: out };
}

/** The Office file type a zip container holds, from the parts it names: docx, xlsx, pptx, or null. */
export function officeKind(entries: readonly ZipEntry[]): 'docx' | 'xlsx' | 'pptx' | null {
  const names = new Set(entries.map((e) => e.name));
  if (!names.has('[Content_Types].xml')) return null;
  if (names.has('word/document.xml')) return 'docx';
  if (names.has('xl/workbook.xml')) return 'xlsx';
  if (names.has('ppt/presentation.xml')) return 'pptx';
  return null;
}

/** Reads entries of one container by name, keeping a budget of bytes inflated across all of them. */
export class ZipReader {
  private readonly byName: Map<string, ZipEntry>;
  private inflated = 0;
  constructor(
    private readonly buf: Buffer,
    readonly entries: readonly ZipEntry[],
    private readonly budget = MAX_TOTAL_INFLATE,
  ) {
    this.byName = new Map(entries.map((e) => [e.name, e]));
  }

  static open(buf: Buffer): Read<ZipReader> {
    const z = zipEntries(buf);
    return z.ok ? { ok: true, value: new ZipReader(buf, z.value) } : z;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** The entry's bytes, null when there is no such entry. */
  read(name: string, maxBytes = MAX_ENTRY_BYTES): Read<Buffer> | null {
    const e = this.byName.get(name);
    if (e === undefined) return null;
    if (e.size > maxBytes) return { ok: false, error: `part ${name} is ${e.size} bytes; at most ${maxBytes} are read` };
    if (this.inflated + e.size > this.budget) return { ok: false, error: `the parts read would inflate past ${this.budget} bytes` };
    const r = zipRead(this.buf, e);
    if (r.ok) this.inflated += r.value.length;
    return r;
  }

  /** The entry's text as UTF-8 (a byte order mark is dropped), null when there is no such entry. */
  text(name: string, maxBytes = MAX_ENTRY_BYTES): Read<string> | null {
    const b = this.read(name, maxBytes);
    if (b === null || !b.ok) return b;
    try {
      const t = new TextDecoder('utf-8', { fatal: true }).decode(b.value);
      return { ok: true, value: t.charCodeAt(0) === 0xfeff ? t.slice(1) : t };
    } catch {
      return { ok: false, error: `part ${name} is not valid UTF-8` };
    }
  }
}
