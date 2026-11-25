import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { tempDir } from '../helpers.js';

export const NOW = new Date('2026-11-25T12:00:00.000Z');

export function sha(b: Buffer | string): string {
  return createHash('sha256').update(b).digest('hex');
}

const CRC_TABLE = ((): number[] => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t.push(c >>> 0);
  }
  return t;
})();

function crc32(b: Buffer): number {
  let c = 0xffffffff;
  for (const x of b) c = (CRC_TABLE[(c ^ x) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip file with the given entries; even-numbered entries are deflated, odd ones stored. */
export function zip(entries: readonly [string, string][]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  entries.forEach(([name, text], i) => {
    const data = Buffer.from(text, 'utf8');
    const deflate = i % 2 === 0;
    const body = deflate ? deflateRawSync(data) : data;
    const n = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(n.length, 26);
    locals.push(lh, n, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(n.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, n);
    offset += 30 + n.length + body.length;
  });
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A Word document: each paragraph is [style id or null, text]. Heading styles come from styles.xml by name. */
export function docx(paras: readonly [string | null, string][], extraStyles = ''): Buffer {
  const body = paras
    .map(([st, t]) => `<w:p>${st !== null ? `<w:pPr><w:pStyle w:val="${st}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`)
    .join('');
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style>${extraStyles}</w:styles>`;
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ['word/document.xml', doc],
    ['word/styles.xml', styles],
  ]);
}

export function xlsx(): Buffer {
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0"?><Types/>'],
    ['xl/workbook.xml', '<?xml version="1.0"?><workbook/>'],
  ]);
}

/** A mail draft with recipients and base64 attachments. */
export function eml(h: { to: string; cc?: string; bcc?: string }, attachments: readonly [string, Buffer][]): string {
  const head = [`From: Writer <writer@example.test>`, `To: ${h.to}`, ...(h.cc !== undefined ? [`Cc: ${h.cc}`] : []), ...(h.bcc !== undefined ? [`Bcc: ${h.bcc}`] : []), 'Subject: Quarterly figures', 'MIME-Version: 1.0'];
  if (attachments.length === 0) return `${head.join('\r\n')}\r\nContent-Type: text/plain\r\n\r\nHello.\r\n`;
  const b = 'BOUNDARY-42';
  const parts = [`--${b}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPlease find the report attached.\r\n`];
  for (const [name, data] of attachments) {
    const b64 = data.toString('base64').replace(/(.{76})/g, '$1\r\n');
    parts.push(`--${b}\r\nContent-Type: application/octet-stream; name="${name}"\r\nContent-Disposition: attachment;\r\n filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64}\r\n`);
  }
  return `${head.join('\r\n')}\r\nContent-Type: multipart/mixed; boundary="${b}"\r\n\r\n${parts.join('')}--${b}--\r\n`;
}

/** A JUnit report: [test name, 'pass' | 'fail' | 'skip']. */
export function junit(tests: readonly [string, 'pass' | 'fail' | 'skip'][]): string {
  const cases = tests
    .map(([n, s]) => `<testcase classname="calc" name="${n}">${s === 'fail' ? '<failure message="AssertionError">cause: AssertionError [ERR_ASSERTION]</failure>' : s === 'skip' ? '<skipped/>' : ''}</testcase>`)
    .join('');
  return `<?xml version="1.0"?><testsuites><testsuite name="calc" tests="${tests.length}">${cases}</testsuite></testsuites>`;
}

/** A work folder with files written relative to it, and a config directory holding a valid user file. */
export function place(files: Readonly<Record<string, string | Buffer>>): { dir: string; home: string; env: NodeJS.ProcessEnv } {
  const dir = tempDir('order-work');
  const home = tempDir('order-home');
  writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\n');
  for (const [p, c] of Object.entries(files)) {
    const full = join(dir, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, c);
  }
  return { dir, home, env: { OPENMORALS_HOME: home } };
}

export function write(dir: string, p: string, c: string | Buffer): void {
  const full = join(dir, p);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, c);
}

export const IN_CSV = 'id,amount,region,date\n1,10.50,north,2026-11-20\n2,"1,000.00",south,2026-11-21\n3,5,east,2026-11-01\n';
export const KEPT_CSV = 'id,amount,region,date\n1,10.50,north,2026-11-20\n2,"1,000.00",south,2026-11-21\n';
export const DROPPED_CSV = 'id,reason\n3,region out of scope\n';
export const REPORT_MD = '# Summary\n\nThe quarter in one page.\n\n## Figures\n\nKept 2 rows of 3.\n';
