import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BOOK_STYLES, DOC_STYLES, budgetBook, contractDoc, rng, writeBook, writeDoc, zipWrite } from '../../src/office/corpus.js';
import { readDocument } from '../../src/office/docx.js';
import { compareOffice } from '../../src/office/index.js';
import { scanXml } from '../../src/office/xmlscan.js';
import { readWorkbook } from '../../src/office/xlsx.js';
import { MAX_ENTRIES, ZipReader, zipEntries, zipRead } from '../../src/office/zip.js';

const STYLE = BOOK_STYLES[0] ?? { id: 'x', strings: 'shared', prefix: '', refs: true, sharedFormulas: true, extValidations: false };
const DSTYLE = DOC_STYLES[0] ?? { id: 'x', prefix: 'w', styles: true, splitRuns: false, rsid: false, proofErr: false, bookmarks: false };
const book = (): Buffer => writeBook(budgetBook(7).book, STYLE);
const doc = (): Buffer => writeDoc(contractDoc(7), DSTYLE, 7);

function err<T>(r: { ok: true; value: T } | { ok: false; error: string }): string {
  assert.equal(r.ok, false, 'expected the reader to refuse');
  return r.ok ? '' : r.error;
}

const noop = { open: (): void => undefined, close: (): void => undefined, text: (): void => undefined };

describe('the zip reader treats every file as hostile', () => {
  it('reads a good workbook and document', () => {
    assert.ok(readWorkbook(book()).ok);
    assert.ok(readDocument(doc()).ok);
  });
  it('refuses what is not a zip, a cut-off file, an encrypted entry, ZIP64 and a multi-part archive', () => {
    assert.match(err(zipEntries(Buffer.from('id,amount\n1,2\n'))), /not a zip container/);
    assert.match(err(zipEntries(Buffer.alloc(3))), /too short/);
    assert.match(err(readWorkbook(book().subarray(0, 900))), /not a zip container|central directory|damaged/);
    assert.match(err(zipEntries(zipWrite([{ name: 'a.xml', data: '<a/>' }], { flags: 1 }))), /encrypted/);
    assert.match(err(zipEntries(zipWrite([{ name: 'a.xml', data: '<a/>' }], { total: 0xffff }))), /ZIP64/);
  });
  it('refuses more than the entry cap, names that climb out or are absolute, a backslash, and a name given twice', () => {
    assert.match(err(zipEntries(zipWrite(Array.from({ length: MAX_ENTRIES + 1 }, (_x, i) => ({ name: `p/${i}`, data: '', store: true }))))), /at most 10000/);
    for (const name of ['../../outside.xml', 'a/../../b.xml', '/etc/x.xml', 'C:/x.xml', 'a\\b.xml', 'a\u0000b']) assert.match(err(zipEntries(zipWrite([{ name, data: '<a/>' }]))), /entry name/, name);
    assert.match(err(zipEntries(zipWrite([{ name: 'a.xml', data: '<a/>' }, { name: 'a.xml', data: '<b/>' }]))), /twice/);
  });
  it('an entry must inflate to exactly its declared size, with its CRC; a declared size over the cap is not inflated', () => {
    const lying = zipWrite([{ name: 'big.xml', data: Buffer.alloc(4 * 1024 * 1024, 32) }], { sizeOf: () => 100 });
    const e = zipEntries(lying);
    assert.ok(e.ok);
    assert.match(err(zipRead(lying, e.value[0] ?? { name: '', method: 0, compressedSize: 0, size: 0, offset: 0, crc: 0 })), /does not inflate to its declared 100 bytes/);
    const short = zipWrite([{ name: 'a.xml', data: '<abc/>' }], { sizeOf: (_n, real) => real + 5 });
    const s = zipEntries(short);
    assert.ok(s.ok);
    assert.match(err(zipRead(short, s.value[0] ?? { name: '', method: 0, compressedSize: 0, size: 0, offset: 0, crc: 0 })), /inflates to 6 bytes, not its declared 11/);
    const crc = zipWrite([{ name: 'a.xml', data: '<abc/>' }], { crcXor: 1 });
    const c = zipEntries(crc);
    assert.ok(c.ok);
    assert.match(err(zipRead(crc, c.value[0] ?? { name: '', method: 0, compressedSize: 0, size: 0, offset: 0, crc: 0 })), /CRC-32/);
    const big = zipWrite([{ name: 'a.xml', data: '<a/>' }], { sizeOf: () => 70 * 1024 * 1024 });
    const b = zipEntries(big);
    assert.ok(b.ok);
    assert.match(err(zipRead(big, b.value[0] ?? { name: '', method: 0, compressedSize: 0, size: 0, offset: 0, crc: 0 })), /larger than 67108864 bytes/);
  });
  it('keeps a budget of bytes inflated across the parts of one file', () => {
    const buf = zipWrite([{ name: 'a', data: Buffer.alloc(1000) }, { name: 'b', data: Buffer.alloc(1000) }]);
    const e = zipEntries(buf);
    assert.ok(e.ok);
    const z = new ZipReader(buf, e.value, 1500);
    assert.ok(z.read('a')?.ok);
    assert.match(err(z.read('b') ?? { ok: true, value: Buffer.alloc(0) }), /inflate past 1500 bytes/);
  });
});

describe('the XML scanner resolves no entity and builds nothing it was not asked for', () => {
  it('refuses a DOCTYPE (an internal entity, an external one naming a file or a URL), an unknown entity, and mismatched tags', () => {
    assert.match(err(scanXml('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>', noop)), /DOCTYPE/);
    assert.match(err(scanXml('<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/hostname">]><a>&x;</a>', noop)), /DOCTYPE/);
    assert.match(err(scanXml('<!DOCTYPE a SYSTEM "https://example.test/a.dtd"><a/>', noop)), /DOCTYPE/);
    assert.match(err(scanXml('<a>&nbsp;</a>', noop)), /entity that is not read/);
    assert.match(err(scanXml('<a b="&x;"/>', noop)), /entity that is not read/);
    assert.match(err(scanXml('<a><b></a></b>', noop)), /does not close/);
    assert.match(err(scanXml('<a x="1" x="2"/>', noop)), /twice/);
    assert.match(err(scanXml('<a/><b/>', noop)), /more than one root/);
    assert.match(err(scanXml('text<a/>', noop)), /outside the root/);
  });
  it('caps depth and the element count', () => {
    assert.match(err(scanXml(`${'<a>'.repeat(300)}${'</a>'.repeat(300)}`, noop)), /nested deeper than 256/);
    assert.match(err(scanXml(`<r>${'<a/>'.repeat(50)}</r>`, noop, { maxElements: 20 })), /more than 20 elements/);
    assert.ok(scanXml('<a>&lt;&#65;&#x42;<![CDATA[<raw>]]></a>', noop).ok);
  });
});

describe('the workbook and document readers fail closed', () => {
  it('a workbook with a DOCTYPE, a missing main part, a sheet part missing, a bad shared string, or too many cells does not read', () => {
    const parts = (b: Buffer): { name: string; data: Buffer | string }[] => {
      const z = zipEntries(b);
      assert.ok(z.ok);
      return z.value.map((e) => {
        const r = zipRead(b, e);
        assert.ok(r.ok);
        return { name: e.name, data: r.value };
      });
    };
    const swap = (name: string, f: (t: string) => string | null): Buffer =>
      zipWrite(
        parts(book()).flatMap((p): { name: string; data: Buffer | string }[] => {
          if (p.name !== name) return [p];
          const t = f(p.data.toString());
          return t === null ? [] : [{ name, data: t }];
        }),
      );
    assert.match(err(readWorkbook(swap('xl/workbook.xml', (t) => t.replace('<workbook', '<!DOCTYPE w [<!ENTITY a "b">]><workbook')))), /DOCTYPE/);
    assert.match(err(readWorkbook(swap('xl/workbook.xml', () => null))), /not a workbook/);
    assert.match(err(readWorkbook(swap('xl/worksheets/sheet2.xml', () => null))), /sheet "Data": its part xl\/worksheets\/sheet2\.xml is missing/);
    assert.match(err(readWorkbook(swap('xl/worksheets/sheet1.xml', (t) => t.replace(/<c r="A1" t="s"><v>\d+<\/v>/, '<c r="A1" t="s"><v>99999</v>')))), /shared string 99999, which does not exist/);
    assert.match(err(readWorkbook(book(), { maxCells: 10 })), /more than 10 cells/);
    assert.match(err(readWorkbook(doc())), /not a workbook/);
    assert.match(err(readDocument(book())), /not a Word document/);
  });
  it('never throws and never passes on damaged bytes: 300 seeded corruptions of a workbook and of a document', () => {
    const r = rng(42);
    for (const [format, good] of [['xlsx', book()], ['docx', doc()]] as const) {
      let unreadable = 0;
      for (let i = 0; i < 300; i++) {
        const bad = Buffer.from(good);
        const flips = 1 + Math.floor(r() * 4);
        for (let k = 0; k < flips; k++) bad[Math.floor(r() * bad.length)] = Math.floor(r() * 256);
        const cut = r() < 0.2 ? bad.subarray(0, Math.floor(r() * bad.length)) : bad;
        const out = compareOffice(format, good, cut);
        const read = format === 'xlsx' ? readWorkbook(cut) : readDocument(cut);
        if (!read.ok) {
          unreadable++;
          assert.equal(out.status, 'fail', `${format} #${i}: an unreadable file must fail`);
          assert.equal(out.lines[0]?.check, 'read');
          assert.match(out.lines[0]?.text ?? '', /^could not read the file: it /);
        }
      }
      assert.ok(unreadable > 150, `${format}: ${unreadable} of 300 corruptions were unreadable`);
    }
  });
});
