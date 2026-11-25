import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runClaudeCodeHook } from '../../src/adapters/claude-code.js';
import { parseAuditText } from '../../src/audit.js';
import { BOOK_STYLES, DOC_STYLES, budgetBook, cloneBook, contractDoc, getCell, writeBook, writeDoc } from '../../src/office/corpus.js';
import type { BookStyle } from '../../src/office/corpus.js';
import { baselinesFile, copyPath } from '../../src/order/baseline.js';
import type { OrderCommandOptions, OrderCommandResult } from '../../src/order/command.js';
import { orderCommand } from '../../src/order/command.js';
import { NOW, place, sha, write } from '../order/fixtures.js';

const STYLE: BookStyle = BOOK_STYLES[0] ?? { id: 'x', strings: 'shared', prefix: '', refs: true, sharedFormulas: true, extValidations: false };
const DSTYLE = DOC_STYLES[0] ?? { id: 'x', prefix: 'w', styles: true, splitRuns: false, rsid: false, proofErr: false, bookmarks: false };

function order(cmd: string[], dir: string, env: NodeJS.ProcessEnv, extra: Partial<OrderCommandOptions> = {}): OrderCommandResult {
  return orderCommand(cmd, { env, cwd: dir, now: () => NOW, interactive: false, readLine: () => null, prompt: () => undefined, ...extra });
}

const ORDER = 'version: 1\nkind: spreadsheet\ntitle: Budget update\noutputs: [model.xlsx, contract.docx]\nconditions:\n  - before_after: { file: model.xlsx, inputs: [Assumptions] }\n  - before_after: { file: contract.docx, redline: true }\n';

function setup(): { dir: string; env: NodeJS.ProcessEnv; home: string; w: ReturnType<typeof budgetBook> } {
  const w = budgetBook(21);
  const p = place({ 'model.xlsx': writeBook(w.book, STYLE), 'contract.docx': writeDoc(contractDoc(21), DSTYLE, 1), 'order.yaml': ORDER });
  return { ...p, w };
}

function hook(home: string, proj: string, tool: string, input: Record<string, unknown>, env: NodeJS.ProcessEnv = {}): { decision: string; rule: string; reason: string } {
  const r = runClaudeCodeHook(JSON.stringify({ session_id: 's-office', cwd: proj, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 't1' }), { env: { OPENMORALS_HOME: home, ...env }, cwd: proj });
  return { decision: r.verdict.decision, rule: r.verdict.rule, reason: r.verdict.reason };
}

describe('order baseline and before_after (Q8)', () => {
  it('before a baseline the condition fails; baseline needs the person (a terminal or --yes); then an unchanged order passes', () => {
    const { dir, env } = setup();
    const first = order(['check', 'order.yaml'], dir, env);
    assert.equal(first.exitCode, 1);
    assert.match(first.stdout, /FAIL {2}before_after model\.xlsx[\s\S]*no baseline was taken: run openmorals order baseline/);
    const no = order(['baseline', 'order.yaml'], dir, env);
    assert.equal(no.exitCode, 1);
    assert.match(no.stderr, /add --yes to take it, or run it in a terminal/);
    assert.equal(existsSync(baselinesFile(env)), false, 'nothing stored');
    const asked: string[] = [];
    const refused = order(['baseline', 'order.yaml'], dir, env, { interactive: true, readLine: () => 'no', prompt: (t) => asked.push(t) });
    assert.equal(refused.exitCode, 1);
    assert.match(asked[0] ?? '', /model\.xlsx: \d+ bytes, sha256 [0-9a-f]{12}, reads as \.xlsx[\s\S]*Take this baseline\? Type yes/);
    const ok = order(['baseline', 'order.yaml'], dir, env, { interactive: true, readLine: () => 'yes', prompt: () => undefined });
    assert.equal(ok.exitCode, 0, ok.stderr);
    assert.match(ok.stdout, /took the office baseline of .*order\.yaml \(2 file\(s\) kept\)/);
    const copy = copyPath(env, sha(readFileSync(join(dir, 'model.xlsx'))));
    assert.ok(existsSync(copy), 'the copy is stored under its SHA-256');
    assert.equal(order(['approve', 'order.yaml', '--yes'], dir, env).exitCode, 0);
    const pass = order(['check', 'order.yaml', '--run', 'R-OFF'], dir, env);
    assert.equal(pass.exitCode, 0, pass.stdout);
    assert.match(pass.stdout, /pass {2}before_after model\.xlsx against the baseline of model\.xlsx, inputs Assumptions unchanged/);
    assert.match(pass.stdout, /ok {2}formulas turned into constants: none/);
    assert.match(pass.stdout, /ok {2}untracked changes: none/);
    assert.match(pass.stdout, /before_after model\.xlsx: cell values outside the declared input ranges/);
    assert.match(pass.stdout, /before_after contract\.docx: what the text says, headers, footers/);
    const recs = parseAuditText(readFileSync(join(env['OPENMORALS_HOME'] ?? '', 'audit.jsonl'), 'utf8')).records;
    const base = recs.find((r) => r.rule === 'order.baseline');
    assert.ok(base !== undefined && JSON.stringify(base.order_check).includes(sha(readFileSync(join(dir, 'model.xlsx')))), 'the baseline is a chained audit record with each file\'s SHA-256');
  });

  it('damage fails with the check named; not computed is printed as such and is never a pass; a malformed file cannot pass', () => {
    const { dir, env, w } = setup();
    order(['baseline', 'order.yaml', '--yes'], dir, env);
    order(['approve', 'order.yaml', '--yes'], dir, env);
    const flat = cloneBook(w.book);
    const c = getCell(flat.sheets[1] ?? { name: '', cells: new Map(), validations: [] }, 'D3');
    if (c !== undefined) delete c.f;
    write(dir, 'model.xlsx', writeBook(flat, STYLE));
    const dmg = order(['check', 'order.yaml', '--json'], dir, env);
    assert.equal(dmg.exitCode, 1);
    const j = JSON.parse(dmg.stdout) as { result: string; conditions: { key: string; outcome: string; status?: string; detail: string[] }[]; items: { path: string; sha256: string | null }[] };
    assert.equal(j.result, 'fail');
    assert.match(j.conditions[0]?.detail.join('\n') ?? '', /FAIL {2}formulas turned into constants: 1 \(Data!D3 = /);
    assert.equal(j.conditions[0]?.status, undefined);
    assert.ok(j.items.some((i) => i.path.endsWith('model.xlsx') && i.sha256 !== null), 'the Q9 items carry the workbook');
    write(dir, 'model.xlsx', writeBook(w.book, { ...STYLE, noCache: 'all' }));
    const nc = order(['check', 'order.yaml', '--json'], dir, env);
    assert.equal(nc.exitCode, 1);
    const k = JSON.parse(nc.stdout) as { result: string; conditions: { outcome: string; status?: string }[] };
    assert.equal(k.result, 'fail');
    assert.deepEqual([k.conditions[0]?.outcome, k.conditions[0]?.status], ['fail', 'not computed']);
    assert.match(order(['check', 'order.yaml'], dir, env).stdout, /NOT COMPUTED {2}before_after model\.xlsx[\s\S]*1 of 2 condition\(s\) failed \(1 not computed\)/);
    write(dir, 'model.xlsx', Buffer.from('PK\u0003\u0004 not really a workbook'));
    assert.match(order(['check', 'order.yaml'], dir, env).stdout, /FAIL {2}before_after model\.xlsx[\s\S]*could not read model\.xlsx: it /);
  });

  it('a baseline copy changed after it was taken, or an unreadable index, fails the check; a file that does not read refuses the baseline', () => {
    const { dir, env } = setup();
    order(['baseline', 'order.yaml', '--yes'], dir, env);
    const copy = copyPath(env, sha(readFileSync(join(dir, 'model.xlsx'))));
    writeFileSync(copy, Buffer.concat([readFileSync(copy), Buffer.from('x')]));
    assert.match(order(['check', 'order.yaml'], dir, env).stdout, /baseline of model\.xlsx: the baseline copy was changed after it was taken/);
    writeFileSync(baselinesFile(env), 'not json\n');
    assert.match(order(['check', 'order.yaml'], dir, env).stdout, /the baseline index cannot be read/);
    const fresh = setup();
    write(fresh.dir, 'contract.docx', Buffer.from('not a document'));
    const r = order(['baseline', 'order.yaml', '--yes'], fresh.dir, fresh.env);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /contract\.docx does not read as a \.docx file: it is not a zip container/);
    assert.equal(existsSync(baselinesFile(fresh.env)), false);
  });

  it('the release hold reads a failed office check unchanged: a send of the workbook is held, a passing check lowers nothing', () => {
    const { dir, env, home, w } = setup();
    order(['baseline', 'order.yaml', '--yes'], dir, env);
    order(['approve', 'order.yaml', '--yes'], dir, env);
    const flat = cloneBook(w.book);
    for (const s of flat.sheets) for (const c of s.cells.values()) delete c.f;
    write(dir, 'model.xlsx', writeBook(flat, STYLE));
    assert.equal(order(['check', 'order.yaml'], dir, env).exitCode, 1);
    const send = { command: 'curl -F f=@model.xlsx https://example.test/upload' };
    const held = hook(home, dir, 'Bash', send, { OPENMORALS_ORDER: join(dir, 'order.yaml') });
    assert.equal(held.decision, 'ask');
    assert.match(held.reason, /before_after model\.xlsx/);
    assert.equal(hook(home, dir, 'Bash', send, { OPENMORALS_ORDER: join(dir, 'order.yaml'), OPENMORALS_UNATTENDED: '1' }).decision, 'deny');
    write(dir, 'model.xlsx', writeBook(w.book, STYLE));
    assert.equal(order(['check', 'order.yaml'], dir, env).exitCode, 0);
    for (const c of ['rm -rf build', 'git push --force origin main', 'ls']) {
      assert.deepEqual(hook(home, dir, 'Bash', { command: c }, { OPENMORALS_ORDER: join(dir, 'order.yaml') }).decision, hook(home, dir, 'Bash', { command: c }).decision, c);
    }
  });

  it('the baseline store asks when an agent writes into it, like the approval store', () => {
    const { dir, env, home } = setup();
    order(['baseline', 'order.yaml', '--yes'], dir, env);
    const copies = join(env['OPENMORALS_HOME'] ?? '', 'orders', 'baselines');
    const one = readdirSync(copies)[0] ?? '';
    assert.equal(hook(home, dir, 'Write', { file_path: join(copies, one), content: 'x' }).decision, 'ask');
    assert.equal(hook(home, dir, 'Bash', { command: `cp model.xlsx ${join(copies, one)}` }).decision, 'ask');
    assert.equal(hook(home, dir, 'Edit', { file_path: baselinesFile(env), old_string: 'a', new_string: 'b' }).decision, 'ask');
    assert.equal(hook(home, dir, 'Bash', { command: 'openmorals order baseline order.yaml --yes' }).decision, 'ask');
    assert.equal(hook(home, dir, 'Bash', { command: 'openmorals order baseline order.yaml --yes' }, { OPENMORALS_UNATTENDED: '1' }).decision, 'deny');
  });

  it('an order with no before_after records exactly the 0.29.0 shape (no status key)', () => {
    const p = place({ 'out/report.md': '# Summary\n\nDone.\n', 'order.yaml': 'version: 1\nkind: document\nconditions:\n  - exists: { file: out/report.md }\n' });
    const r = order(['check', 'order.yaml', '--json'], p.dir, p.env);
    const j = JSON.parse(r.stdout) as { conditions: Record<string, unknown>[] };
    assert.deepEqual(Object.keys(j.conditions[0] ?? {}), ['key', 'outcome', 'detail']);
  });
});
