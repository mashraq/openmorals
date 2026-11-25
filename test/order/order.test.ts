import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseAuditText } from '../../src/audit.js';
import { summarizeRunText, verifyAuditText } from '../../src/audit-verify.js';
import { runConditions } from '../../src/order/check.js';
import type { OrderCommandOptions, OrderCommandResult } from '../../src/order/command.js';
import { ORDER_EXIT, orderCommand } from '../../src/order/command.js';
import { CONDITION_KINDS, parseOrder, parseTemplate } from '../../src/order/model.js';
import type { Order } from '../../src/order/model.js';
import { approvalsFile } from '../../src/order/store.js';
import { REPO_ROOT } from '../helpers.js';
import { DROPPED_CSV, IN_CSV, KEPT_CSV, NOW, REPORT_MD, docx, eml, junit, place, sha, write, xlsx } from './fixtures.js';

function opts(dir: string, env: NodeJS.ProcessEnv, extra: Partial<OrderCommandOptions> = {}): OrderCommandOptions {
  return { env, cwd: dir, now: () => NOW, interactive: false, readLine: () => null, prompt: () => undefined, ...extra };
}

function order(cmd: string[], dir: string, env: NodeJS.ProcessEnv, extra: Partial<OrderCommandOptions> = {}): OrderCommandResult {
  return orderCommand(cmd, opts(dir, env, extra));
}

function parsed(yaml: string): Order {
  const r = parseOrder(yaml, () => ({ ok: false, errors: ['no template here'] }));
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  return r.value;
}

function errorsOf(yaml: string): string[] {
  const r = parseOrder(yaml, (n) => (n === 't1' ? parseTemplate('version: 1\nconditions:\n  - exists: { file: a.md }\n') : { ok: false, errors: ['no such template'] }));
  assert.ok(!r.ok, 'expected the order to be refused');
  return r.errors;
}

/** Runs one condition in a folder holding the files and returns pass or fail with the detail. */
function one(condition: string, files: Readonly<Record<string, string | Buffer>>): { outcome: string; detail: string } {
  const p = place(files);
  const r = runConditions(parsed(`version: 1\nkind: data\nconditions:\n  - ${condition}\n`), p.dir, NOW);
  assert.equal(r.length, 1);
  return { outcome: r[0]?.outcome ?? '', detail: (r[0]?.detail ?? []).join(' | ') };
}

const BASE_FILES = { 'data/in.csv': IN_CSV, 'out/kept.csv': KEPT_CSV, 'out/dropped.csv': DROPPED_CSV, 'out/report.md': REPORT_MD };

function dataOrder(extra = ''): string {
  return `version: 1
kind: data
title: Quarter rows
inputs:
  - path: data/in.csv
    sha256: ${sha(IN_CSV)}
outputs:
  - out/kept.csv
  - out/report.md
conditions:
  - exists: { file: out/kept.csv, type: csv }
  - rows: { input: data/in.csv, kept: out/kept.csv, dropped: out/dropped.csv, filters: [region out of scope], key: id }
  - accepted_values: { file: out/kept.csv, column: region, values: [north, south] }
  - total: { file: out/kept.csv, column: amount, equals: 1010.50, tolerance: 0.001 }
  - headings: { file: out/report.md, include: [Summary, Figures] }
${extra}`;
}

function logRecords(home: string): ReturnType<typeof parseAuditText>['records'] {
  return parseAuditText(readFileSync(join(home, 'audit.jsonl'), 'utf8')).records;
}

describe('order format: a fixed vocabulary, refused with the allowed list', () => {
  it('an unknown condition is refused and every condition name is printed', () => {
    const e = errorsOf('version: 1\nkind: data\nconditions:\n  - spellcheck: { file: a.md }\n');
    assert.equal(e.length, 1);
    assert.match(e[0] ?? '', /unknown condition "spellcheck"; conditions: exists, headings, no_placeholders, recipients, attachments, rows, unique, not_null, accepted_values, relationships, freshness, total, tests, before_after/);
    assert.equal(CONDITION_KINDS.length, 14);
  });
  it('an unknown key in a condition is refused with that condition\'s keys', () => {
    const e = errorsOf('version: 1\nkind: data\nconditions:\n  - total: { file: a.csv, column: x, equals: 1, tolerence: 2 }\n');
    assert.deepEqual(e, ['conditions.0.total: unknown key "tolerence"; allowed: file, column, equals, equals_sum, tolerance']);
  });
  it('an unknown top-level key, a wrong version and kind, and an order with no condition are refused', () => {
    const e = errorsOf('version: 2\nkind: novel\nnotes: x\n');
    assert.ok(e.some((x) => /unknown key "notes"; allowed: version, kind, title, template, inputs, outputs, conditions/.test(x)), e.join('\n'));
    assert.ok(e.some((x) => /^version: must be 1/.test(x)));
    assert.ok(e.some((x) => /^kind: must be one of code, document, spreadsheet, data, email, other/.test(x)));
    assert.match(errorsOf('version: 1\nkind: data\n')[0] ?? '', /an order with no condition checks nothing/);
  });
  it('a file type a reader is not built for is refused by name, never checked as a pass', () => {
    assert.match(errorsOf('version: 1\nkind: document\nconditions:\n  - headings: { file: a.pdf, include: [A] }\n')[0] ?? '', /reading headings from a \.pdf file is not built yet; built for: \.md, \.markdown, \.docx/);
    assert.match(errorsOf('version: 1\nkind: email\nconditions:\n  - recipients: { file: a.msg, to: [a@example.test] }\n')[0] ?? '', /reading recipients from a \.msg file is not built yet/);
    assert.match(errorsOf('version: 1\nkind: data\nconditions:\n  - unique: { file: a.xlsx, columns: [id] }\n')[0] ?? '', /reading columns from a \.xlsx file is not built yet; built for: \.csv, \.tsv/);
  });
  it('inputs need a sha256; a duplicate condition and a template condition repeated by the order are refused', () => {
    assert.match(errorsOf('version: 1\nkind: data\ninputs:\n  - path: a.csv\nconditions:\n  - exists: { file: a.md }\n')[0] ?? '', /inputs\.0\.sha256: must be 64 lower-case hex/);
    assert.match(errorsOf('version: 1\nkind: data\nconditions:\n  - exists: { file: a.md }\n  - exists: { file: a.md, type: md }\n')[0] ?? '', /repeats the condition exists a\.md/);
    assert.match(errorsOf('version: 1\nkind: data\ntemplate: t1\nconditions:\n  - exists: { file: a.md, type: md }\n')[0] ?? '', /the template already holds the condition exists a\.md/);
  });
  it('YAML aliases and duplicate keys are refused', () => {
    assert.match(errorsOf('version: 1\nkind: data\nkind: code\nconditions:\n  - exists: { file: a.md }\n')[0] ?? '', /YAML parse error/);
  });
});

describe('each condition: a catching row and a passing row', () => {
  it('exists: missing, empty, wrong type fail; the right type passes', () => {
    assert.equal(one('exists: { file: a.md }', {}).outcome, 'fail');
    assert.match(one('exists: { file: a.md }', { 'a.md': '' }).detail, /is empty/);
    assert.match(one('exists: { file: a.docx, type: docx }', { 'a.docx': xlsx() }).detail, /is a xlsx file, not docx/);
    assert.match(one('exists: { file: a.pdf, type: pdf }', { 'a.pdf': 'not a pdf' }).detail, /does not start with %PDF-/);
    assert.equal(one('exists: { file: a.docx, type: docx }', { 'a.docx': docx([['Heading1', 'A']]) }).outcome, 'pass');
    assert.equal(one('exists: { file: a.json, type: json }', { 'a.json': '{"a":1}' }).outcome, 'pass');
    assert.equal(one('exists: { file: a.json, type: json }', { 'a.json': '{"a":' }).outcome, 'fail');
  });
  it('headings: Markdown and Word, missing and out of order fail', () => {
    assert.equal(one('headings: { file: r.md, include: [Summary, Figures], in_order: true }', { 'r.md': REPORT_MD }).outcome, 'pass');
    assert.match(one('headings: { file: r.md, include: [Summary, Risks] }', { 'r.md': REPORT_MD }).detail, /missing: "Risks"/);
    assert.match(one('headings: { file: r.md, include: [Figures, Summary], in_order: true }', { 'r.md': REPORT_MD }).detail, /comes before/);
    assert.equal(one('headings: { file: r.md, include: [Fenced] }', { 'r.md': '```\n# Fenced\n```\n' }).outcome, 'fail', 'a heading inside a code fence is not a heading');
    assert.equal(one('headings: { file: r.md, include: [Setext] }', { 'r.md': 'Setext\n======\n' }).outcome, 'pass');
    const word = docx([['Heading1', 'Summary'], [null, 'Body Figures'], ['MyHeading', 'Figures']], '<w:style w:type="paragraph" w:styleId="MyHeading"><w:name w:val="Mine"/><w:basedOn w:val="Heading2"/></w:style>');
    assert.equal(one('headings: { file: r.docx, include: [summary, Figures], in_order: true }', { 'r.docx': word }).outcome, 'pass');
    assert.match(one('headings: { file: r.docx, include: [Body Figures] }', { 'r.docx': word }).detail, /missing: "Body Figures"/);
  });
  it('no_placeholders: the built-in patterns and your own, in text and Word', () => {
    assert.match(one('no_placeholders: { file: r.md }', { 'r.md': 'Dear [client name],\nTODO\n' }).detail, /line 1: "\[client name\]".*line 2: "TODO"/);
    assert.match(one('no_placeholders: { file: r.docx }', { 'r.docx': docx([[null, 'Hello {{name}}']]) }).detail, /paragraph 1: "\{\{name\}\}"/);
    assert.match(one('no_placeholders: { file: r.md, also: [DRAFT] }', { 'r.md': 'DRAFT copy\n' }).detail, /"DRAFT"/);
    assert.equal(one('no_placeholders: { file: r.md }', { 'r.md': REPORT_MD }).outcome, 'pass');
    assert.match(one('no_placeholders: { file: src/a.mjs }', { 'src/a.mjs': 'export const x = 1; // FIXME\n' }).detail, /line 1: "FIXME"/);
    assert.match(one('no_placeholders: { file: a.bin }', { 'a.bin': Buffer.from([0, 1, 2]) }).detail, /holds a NUL byte/);
    assert.match(errorsOf('version: 1\nkind: document\nconditions:\n  - no_placeholders: { file: a.pdf }\n')[0] ?? '', /reading text from a \.pdf file is not built yet/);
  });
  it('recipients: an extra or a missing address fails; names and case do not matter', () => {
    const m = eml({ to: '"Doe, Jo" <JO@example.test>, sam@example.test', cc: 'Boss <boss@example.test>' }, []);
    assert.equal(one('recipients: { file: m.eml, to: [jo@example.test, sam@example.test], cc: [boss@example.test] }', { 'm.eml': m }).outcome, 'pass');
    assert.match(one('recipients: { file: m.eml, to: [jo@example.test, sam@example.test] }', { 'm.eml': m }).detail, /cc: not in the order: boss@example\.test/);
    assert.match(one('recipients: { file: m.eml, to: [jo@example.test, sam@example.test, kim@example.test], cc: [boss@example.test] }', { 'm.eml': m }).detail, /to: missing: kim@example\.test/);
  });
  it('attachments: by name and decoded content hash', () => {
    const rep = Buffer.from('the report, version 3\n'.repeat(20));
    const m = eml({ to: 'a@example.test' }, [['report.pdf', rep]]);
    assert.equal(one(`attachments: { file: m.eml, files: [{ name: report.pdf, sha256: ${sha(rep)} }] }`, { 'm.eml': m }).outcome, 'pass');
    assert.match(one(`attachments: { file: m.eml, files: [{ name: report.pdf, sha256: ${sha('other')} }] }`, { 'm.eml': m }).detail, /missing or changed: "report\.pdf".*not in the order: "report\.pdf"/);
    assert.match(one('attachments: { file: m.eml, files: [] }', { 'm.eml': m }).detail, /not in the order/);
    assert.equal(one('attachments: { file: m.eml, files: [] }', { 'm.eml': eml({ to: 'a@example.test' }, []) }).outcome, 'pass');
  });
  it('rows: in = kept + dropped, each dropped row with a named reason, each key once', () => {
    const c = 'rows: { input: in.csv, kept: kept.csv, dropped: dropped.csv, filters: [region out of scope], key: id }';
    assert.equal(one(c, { 'in.csv': IN_CSV, 'kept.csv': KEPT_CSV, 'dropped.csv': DROPPED_CSV }).outcome, 'pass');
    assert.match(one(c, { 'in.csv': IN_CSV, 'kept.csv': KEPT_CSV, 'dropped.csv': 'id,reason\n' }).detail, /rows in 3 != kept 2 \+ dropped 0/);
    assert.match(one(c, { 'in.csv': IN_CSV, 'kept.csv': KEPT_CSV, 'dropped.csv': 'id,reason\n3,looked odd\n' }).detail, /reason "looked odd" is not one of the order's filters/);
    assert.match(one(c, { 'in.csv': IN_CSV, 'kept.csv': KEPT_CSV.replace('\n2,', '\n9,'), 'dropped.csv': DROPPED_CSV }).detail, /keys in the input that are neither kept nor dropped: "2".*not in the input.*"9"/);
  });
  it('unique, not_null, accepted_values, relationships', () => {
    const csv = 'id,email,region,customer\n1,a@x.test,north,c1\n2,,south,c9\n2,b@x.test,west,\n';
    const files = { 'f.csv': csv, 'c.csv': 'id\nc1\nc2\n' };
    assert.match(one('unique: { file: f.csv, columns: [id] }', files).detail, /line 4 repeats line 3/);
    assert.equal(one('unique: { file: f.csv, columns: [id, region] }', files).outcome, 'pass');
    assert.match(one('not_null: { file: f.csv, columns: [id, email] }', files).detail, /line 3: "email" is empty/);
    assert.equal(one('not_null: { file: f.csv, columns: [id, region] }', files).outcome, 'pass');
    assert.match(one('accepted_values: { file: f.csv, column: region, values: [north, south] }', files).detail, /line 4: "west"/);
    assert.equal(one('accepted_values: { file: f.csv, column: region, values: [north, south, west] }', files).outcome, 'pass');
    assert.match(one('relationships: { file: f.csv, column: customer, to: { file: c.csv, column: id } }', files).detail, /line 3: "c9" is not in c\.csv id/);
    assert.equal(one('relationships: { file: f.csv, column: customer, to: { file: c.csv, column: id } }', { ...files, 'c.csv': 'id\nc1\nc9\n' }).outcome, 'pass');
    assert.match(one('not_null: { file: f.csv, columns: [nope] }', files).detail, /has no column "nope"/);
  });
  it('freshness: the newest date within the days allowed; a value that is not a date fails', () => {
    assert.equal(one('freshness: { file: f.csv, column: d, max_age_days: 7 }', { 'f.csv': 'd\n2026-11-01\n2026-11-20\n' }).outcome, 'pass');
    assert.match(one('freshness: { file: f.csv, column: d, max_age_days: 3 }', { 'f.csv': 'd\n2026-11-01\n2026-11-20\n' }).detail, /newest 2026-11-20 is 5 days old; the order allows 3/);
    assert.match(one('freshness: { file: f.csv, column: d, max_age_days: 30 }', { 'f.csv': 'd\n2026-02-30\n' }).detail, /not an ISO date/);
  });
  it('total: equal to a stated control total or a source column, within the tolerance', () => {
    assert.equal(one('total: { file: k.csv, column: amount, equals: 1010.50 }', { 'k.csv': KEPT_CSV }).outcome, 'pass');
    assert.match(one('total: { file: k.csv, column: amount, equals: 1010.49 }', { 'k.csv': KEPT_CSV }).detail, /sum 1010\.5; the stated control total 1010\.49; difference 0\.01; tolerance 0/);
    assert.equal(one('total: { file: k.csv, column: amount, equals: 1010.49, tolerance: 0.01 }', { 'k.csv': KEPT_CSV }).outcome, 'pass');
    assert.equal(one('total: { file: k.csv, column: amount, equals_sum: { file: bank.csv, column: amt } }', { 'k.csv': KEPT_CSV, 'bank.csv': 'amt\n(10.00)\n"$1,020.50"\n' }).outcome, 'pass');
    assert.match(one('total: { file: k.csv, column: amount, equals: 0 }', { 'k.csv': 'amount\n12abc\n' }).detail, /"12abc" is not an amount/);
  });
  it('tests: named ids must fail before and pass after, read by tests compare', () => {
    const before = junit([['adds', 'pass'], ['clamps high', 'fail']]);
    const files = { 'b.xml': before, 'a.xml': junit([['adds', 'pass'], ['clamps high', 'pass']]) };
    assert.equal(one('tests: { before: b.xml, after: a.xml, ids: [clamps high] }', files).outcome, 'pass');
    assert.match(one('tests: { before: b.xml, after: a.xml, ids: [adds] }', files).detail, /"adds": before pass, after pass/);
    assert.match(one('tests: { before: b.xml, after: a.xml, ids: [clamps high] }', { 'b.xml': before, 'a.xml': junit([['adds', 'pass'], ['clamps high', 'fail']]) }).detail, /after fail/);
    assert.match(one('tests: { before: b.xml, after: a.xml, ids: [nothing] }', files).detail, /"nothing" is not in the after report/);
    assert.match(one('tests: { before: b.xml, after: a.xml, ids: [adds] }', { 'b.xml': junit([['x', 'pass']]), 'a.xml': junit([['adds', 'pass']]) }).detail, /no test name is in both reports/);
  });
});

describe('order approve and order check', () => {
  it('an unapproved order fails even when every condition passes, and the result is recorded with the run', () => {
    const p = place(BASE_FILES);
    write(p.dir, 'order.yaml', dataOrder());
    const r = order(['check', 'order.yaml', '--run', 'R1'], p.dir, p.env);
    assert.equal(r.exitCode, ORDER_EXIT.fail);
    assert.match(r.stdout, /ORDER not approved: you approve it yourself/);
    assert.ok(!/FAIL {2}(exists|rows|total)/.test(r.stdout), r.stdout);
    const recs = logRecords(p.home);
    assert.equal(recs.length, 1);
    const rec = recs[0];
    assert.ok(rec !== undefined && rec.v === 2);
    assert.equal(rec.rule, 'order.check.fail');
    assert.equal(rec.decision, 'ask');
    assert.equal(rec.run, 'R1');
    assert.equal((rec.order_check as { result?: string }).result, 'fail');
  });
  it('approve needs a terminal or --yes; nothing is stored without either', () => {
    const p = place(BASE_FILES);
    write(p.dir, 'order.yaml', dataOrder());
    const r = order(['approve', 'order.yaml'], p.dir, p.env);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /add --yes to approve it, or run it in a terminal/);
    assert.ok(!existsSync(approvalsFile(p.env)));
    const asked: string[] = [];
    const no = order(['approve', 'order.yaml'], p.dir, p.env, { interactive: true, readLine: () => 'no', prompt: (t) => asked.push(t) });
    assert.equal(no.exitCode, 1);
    assert.match(asked[0] ?? '', /Approve this work order\? Type yes/);
    assert.ok(!existsSync(approvalsFile(p.env)));
    const yes = order(['approve', 'order.yaml'], p.dir, p.env, { interactive: true, readLine: () => 'yes' });
    assert.equal(yes.exitCode, 0, yes.stderr);
    assert.ok(existsSync(approvalsFile(p.env)));
  });
  it('an approved order whose conditions pass checks clean, with the not-checked list beside the pass', () => {
    const p = place(BASE_FILES);
    write(p.dir, 'order.yaml', dataOrder());
    assert.equal(order(['approve', 'order.yaml', '--yes'], p.dir, p.env).exitCode, 0);
    const r = order(['check', 'order.yaml'], p.dir, { ...p.env, OPENMORALS_RUN: 'R7' });
    assert.equal(r.exitCode, ORDER_EXIT.pass, r.stdout);
    assert.match(r.stdout, /: PASS\n/);
    assert.match(r.stdout, /Not checked:\n {2}- exists out\/kept\.csv: that the content is right/);
    assert.match(r.stdout, /total out\/kept\.csv amount: whether the control total itself is right/);
    assert.match(r.stdout, /outputs no condition reads \(only that they exist\): out\/report\.md|headings out\/report\.md/);
    assert.match(r.stdout, /whether to send or submit are yours/);
    const recs = logRecords(p.home);
    const last = recs[recs.length - 1];
    assert.ok(last !== undefined && last.v === 2 && last.run === 'R7' && last.rule === 'order.check.pass');
    const text = readFileSync(join(p.home, 'audit.jsonl'), 'utf8');
    const s = summarizeRunText(text, 'R7', verifyAuditText(text));
    assert.equal(s.order_checks.length, 1);
    assert.equal(s.denies.length + s.asks.length, 0, 'an order check is not a deny or an ask in the run summary');
    assert.equal(s.orders.length, 1);
  });
  it('an edit after approval fails the check, condition by condition as loosenings and tightenings (removal test: the hash comparison)', () => {
    const p = place(BASE_FILES);
    write(p.dir, 'order.yaml', dataOrder());
    assert.equal(order(['approve', 'order.yaml', '--yes'], p.dir, p.env).exitCode, 0);
    write(p.dir, 'order.yaml', dataOrder().replace('tolerance: 0.001', 'tolerance: 50').replace('values: [north, south]', 'values: [north, south, east]').replace('  - headings: { file: out/report.md, include: [Summary, Figures] }\n', '') + '  - not_null: { file: out/kept.csv, columns: [id] }\n');
    const r = order(['check', 'order.yaml'], p.dir, p.env);
    assert.equal(r.exitCode, ORDER_EXIT.fail, r.stdout);
    assert.match(r.stdout, /edited after approval \(approved 2026-11-25T12:00:00\.000Z; 3 loosening\(s\), 0 change\(s\), 1 tightening\(s\)\)/);
    assert.match(r.stdout, /loosening: total out\/kept\.csv amount: tolerance made looser \("0\.001" -> "50"\)/);
    assert.match(r.stdout, /loosening: accepted_values out\/kept\.csv region: values made looser/);
    assert.match(r.stdout, /loosening: condition removed: headings out\/report\.md/);
    assert.match(r.stdout, /tightening: condition added: not_null out\/kept\.csv: id/);
    const again = order(['approve', 'order.yaml', '--yes'], p.dir, p.env);
    assert.match(again.stdout, /Edited since it was approved on .*3 loosening\(s\), 0 change\(s\), 1 tightening\(s\)/);
    assert.equal(order(['check', 'order.yaml'], p.dir, p.env).exitCode, ORDER_EXIT.pass);
  });
  it('a comment-only edit is still an edit after approval', () => {
    const p = place(BASE_FILES);
    write(p.dir, 'order.yaml', dataOrder());
    order(['approve', 'order.yaml', '--yes'], p.dir, p.env);
    write(p.dir, 'order.yaml', `# reworded\n${dataOrder()}`);
    const r = order(['check', 'order.yaml'], p.dir, p.env);
    assert.equal(r.exitCode, 1);
    assert.match(r.stdout, /the text changed \(layout, comments or order of lines\) with no change to any condition/);
  });
  it('an input whose content changed is reported and fails; approve refuses an input that does not match', () => {
    const p = place(BASE_FILES);
    write(p.dir, 'order.yaml', dataOrder());
    order(['approve', 'order.yaml', '--yes'], p.dir, p.env);
    write(p.dir, 'data/in.csv', `${IN_CSV}4,1,north,2026-11-22\n`);
    const r = order(['check', 'order.yaml'], p.dir, p.env);
    assert.equal(r.exitCode, 1);
    assert.match(r.stdout, /FAIL {2}input data\/in\.csv changed since the order was written/);
    const q = place(BASE_FILES);
    write(q.dir, 'order.yaml', dataOrder());
    write(q.dir, 'data/in.csv', 'id\n1\n');
    const a = order(['approve', 'order.yaml', '--yes'], q.dir, q.env);
    assert.equal(a.exitCode, 1);
    assert.match(a.stderr, /an input does not match the order/);
  });
  it('a missing order and an invalid order fail and are recorded; neither is a pass', () => {
    const p = place(BASE_FILES);
    const m = order(['check', 'nope.yaml'], p.dir, p.env);
    assert.equal(m.exitCode, 1);
    assert.match(m.stdout, /no order at .*nope\.yaml: a missing order is a failure, never a pass/);
    write(p.dir, 'bad.yaml', 'version: 1\nkind: data\nconditions:\n  - vibes: { file: a }\n');
    const b = order(['check', 'bad.yaml'], p.dir, p.env);
    assert.equal(b.exitCode, 1);
    assert.match(b.stdout, /the order is not valid: conditions\.0: unknown condition "vibes"; conditions: exists, headings/);
    assert.equal(logRecords(p.home).filter((r) => r.rule === 'order.check.fail').length, 2);
    const ap = order(['approve', 'bad.yaml', '--yes'], p.dir, p.env);
    assert.equal(ap.exitCode, 1);
    assert.match(ap.stderr, /is not a valid work order:\n {2}conditions\.0: unknown condition "vibes"/);
  });
  it('the order path comes from OPENMORALS_ORDER when none is given', () => {
    const p = place(BASE_FILES);
    write(p.dir, 'order.yaml', dataOrder());
    order(['approve', 'order.yaml', '--yes'], p.dir, p.env);
    assert.equal(order(['check'], p.dir, { ...p.env, OPENMORALS_ORDER: join(p.dir, 'order.yaml') }).exitCode, 0);
    assert.equal(order(['check'], p.dir, p.env).exitCode, ORDER_EXIT.usage);
  });
  it('an unreadable approval store counts as not approved', () => {
    const p = place(BASE_FILES);
    write(p.dir, 'order.yaml', dataOrder());
    order(['approve', 'order.yaml', '--yes'], p.dir, p.env);
    writeFileSync(approvalsFile(p.env), `${readFileSync(approvalsFile(p.env), 'utf8')}not json\n`);
    const r = order(['check', 'order.yaml'], p.dir, p.env);
    assert.equal(r.exitCode, 1);
    assert.match(r.stdout, /the approval store cannot be read/);
  });
  it('a result that cannot be written to the record exits 2, never 0', () => {
    const p = place(BASE_FILES);
    write(p.dir, 'order.yaml', dataOrder());
    mkdirSync(join(p.home, 'audit.jsonl', 'blocked'), { recursive: true });
    assert.match(order(['approve', 'order.yaml', '--yes'], p.dir, p.env).stdout, /the audit log line could not be written/);
    const r = order(['check', 'order.yaml'], p.dir, p.env);
    assert.equal(r.exitCode, ORDER_EXIT.unrecorded, r.stdout);
    assert.match(r.stdout, /NOT recorded: .*read this as not passed/);
  });
  it('a template\'s conditions are carried by the order, and a template only grows', () => {
    const p = place(BASE_FILES);
    mkdirSync(join(p.home, 'order-templates'), { recursive: true });
    const tpl = join(p.home, 'order-templates', 'quarter.yaml');
    writeFileSync(tpl, 'version: 1\nconditions:\n  - no_placeholders: { file: out/report.md }\n  - unique: { file: out/kept.csv, columns: [id] }\n');
    write(p.dir, 'order.yaml', 'version: 1\nkind: data\ntemplate: quarter\nconditions:\n  - exists: { file: out/kept.csv }\n');
    assert.equal(order(['approve', 'order.yaml', '--yes'], p.dir, p.env).exitCode, 0);
    const ok = order(['check', 'order.yaml'], p.dir, p.env);
    assert.equal(ok.exitCode, 0, ok.stdout);
    assert.match(ok.stdout, /pass {2}no_placeholders out\/report\.md/);
    writeFileSync(tpl, 'version: 1\nconditions:\n  - unique: { file: out/kept.csv, columns: [id] }\n');
    const shrunk = order(['check', 'order.yaml'], p.dir, p.env);
    assert.equal(shrunk.exitCode, 1);
    assert.match(shrunk.stdout, /the template quarter no longer holds "no_placeholders out\/report\.md".*a template's conditions only grow/);
    assert.equal(order(['approve', 'order.yaml', '--yes'], p.dir, p.env).exitCode, 1, 'a shrunk template cannot be approved either');
    writeFileSync(tpl, 'version: 1\nconditions:\n  - no_placeholders: { file: out/report.md }\n  - unique: { file: out/kept.csv, columns: [id] }\n  - not_null: { file: out/kept.csv, columns: [id] }\n');
    const grown = order(['check', 'order.yaml'], p.dir, p.env);
    assert.equal(grown.exitCode, 1, 'a grown template is still an edit after approval');
    assert.match(grown.stdout, /tightening: condition added: not_null out\/kept\.csv: id \(from the template\)/);
    assert.equal(order(['approve', 'order.yaml', '--yes'], p.dir, p.env).exitCode, 0);
    assert.equal(order(['check', 'order.yaml'], p.dir, p.env).exitCode, 0);
  });
  it('order new prints a starting order with the input hashes; order baseline (0.30.0) needs an order that names an office file', () => {
    const p = place(BASE_FILES);
    const r = order(['new', '--kind', 'data', '--input', 'data/in.csv', '--output', 'out/kept.csv'], p.dir, p.env);
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, new RegExp(`sha256: ${sha(IN_CSV)}`));
    assert.match(r.stdout, /- exists: \{ file: out\/kept\.csv, type: csv \}/);
    const parsedNew = parseOrder(r.stdout, () => ({ ok: false, errors: [] }));
    assert.ok(parsedNew.ok);
    assert.match(order(['baseline', 'order.yaml'], p.dir, p.env).stderr, /order baseline: .*order\.yaml does not exist; no baseline was taken/);
    write(p.dir, 'order.yaml', dataOrder());
    const nb = order(['baseline', 'order.yaml', '--yes'], p.dir, p.env);
    assert.equal(nb.exitCode, 1);
    assert.match(nb.stderr, /names no \.xlsx or \.docx file; no baseline was taken/);
  });
  it('--json carries the same result', () => {
    const p = place(BASE_FILES);
    write(p.dir, 'order.yaml', dataOrder());
    const r = order(['check', 'order.yaml', '--json'], p.dir, p.env);
    const j = JSON.parse(r.stdout) as { exitCode: number; result: string; approval: string; conditions: { outcome: string }[]; not_checked: string[] };
    assert.equal(j.exitCode, 1);
    assert.equal(j.result, 'fail');
    assert.equal(j.approval, 'unapproved');
    assert.equal(j.conditions.length, 5);
    assert.ok(j.not_checked.length >= 5);
  });
});

describe('docs/order.md', () => {
  it('its worked code order, worked office order and template read as valid, and it lists every condition', () => {
    const doc = readFileSync(join(REPO_ROOT, 'docs', 'order.md'), 'utf8');
    const blocks = [...doc.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1] ?? '');
    const worked = blocks.filter((b) => b.startsWith('version: 1\nkind:') && b.includes('title:') && !b.includes('...'));
    assert.equal(worked.length, 3, 'the code order, the office order and the before_after order (0.30.0)');
    for (const b of worked) parsed(b);
    const tpl = blocks.find((b) => b.startsWith('version: 1\nconditions:'));
    assert.ok(tpl !== undefined && parseTemplate(tpl).ok);
    for (const k of CONDITION_KINDS) assert.ok(doc.includes(`| \`${k}\` |`), k);
  });
});
