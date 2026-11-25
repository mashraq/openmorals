// `openmorals order new | approve | check`: the work order (Q6). `approve` is the person's (self-protect asks when an
// agent runs it); `check` exits non-zero on any failure and writes its result to the run record (U4).
import { isAbsolute, relative } from 'node:path';
import type { AuditFields, AuditMeta } from '../audit.js';
import { cleanAuditId, cleanAuditPath } from '../audit.js';
import { ORDER_SESSION } from '../audit-verify.js';
import { configDir } from '../paths.js';
import { appendAuditForSession } from '../state.js';
import type { ConditionResult, InputResult } from './check.js';
import { ALWAYS_NOT_CHECKED, checkInputs, checkOutputs, outputsWithoutCondition, runConditions } from './check.js';
import { extOf, readBytes, sha256Hex } from './files.js';
import type { Edit } from './model.js';
import { CONDITION_KINDS, FILE_TYPES, ORDER_KINDS, TEMPLATE_NAME, describeCondition } from './model.js';
import type { ApprovalState, LoadedOrder, StoredApproval } from './store.js';
import { appendApproval, approvalState, loadOrder, readApprovals, templateLosses } from './store.js';

export const ORDER_EXIT = { pass: 0, fail: 1, unrecorded: 2, usage: 64 } as const;
export const ORDER_RULES = { pass: 'order.check.pass', fail: 'order.check.fail', approve: 'order.approve' } as const;

export const ORDER_USAGE = `  openmorals order new [--kind ${ORDER_KINDS.join('|')}] [--input FILE]... [--output FILE]...
                  [--template NAME]
      Print the start of a work order (YAML) with each input's sha256 filled in.
      Writes nothing. Conditions: ${CONDITION_KINDS.join(', ')}.
  openmorals order approve <order.yaml> [--yes]
      Approve a work order yourself: shows its conditions, what they do not check,
      and, for an order approved before, each edit since as a loosening, a
      tightening or a change. Stores the order's hash (and its text) in
      orders/approvals.jsonl in the config directory. In a terminal it asks (type
      yes); elsewhere nothing is stored without --yes. An agent running it is
      asked or refused by the hook. Exit 0 approved or already approved
      unchanged, 1 not approved (invalid order, an input that does not match its
      sha256, a template that lost a condition, not confirmed).
  openmorals order check [<order.yaml>] [--run ID] [--json]
      Check the work against an approved order (default: $OPENMORALS_ORDER): each
      input's sha256, each output, each condition. Prints what a pass does not
      show beside every pass, and writes the result to the audit log with the run
      id (--run, else $OPENMORALS_RUN). Exit 0 every check passed and the order
      is approved as it reads now, 1 anything failed or the order is missing,
      invalid, not approved or edited after approval, 2 the result could not be
      written to the record (read it as not passed), 64 usage error.`;

export interface OrderCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface OrderCommandOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  now?: () => Date;
  /** True when both standard input and output are a terminal. */
  interactive: boolean;
  readLine: () => string | null;
  prompt: (text: string) => void;
}

function usage(error: string): OrderCommandResult {
  return { exitCode: ORDER_EXIT.usage, stdout: '', stderr: `openmorals order: ${error}; nothing was done\n\nUsage:\n${ORDER_USAGE}\n` };
}

interface Flags {
  pos: string[];
  values: Map<string, string[]>;
  bools: Set<string>;
}

function parseFlags(argv: readonly string[], valueOpts: readonly string[], boolOpts: readonly string[]): { ok: true; f: Flags } | { ok: false; error: string } {
  const f: Flags = { pos: [], values: new Map(), bools: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--') {
      f.pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('-') && a !== '-') {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      if (boolOpts.includes(name) && eq === -1) {
        f.bools.add(name);
        continue;
      }
      if (!valueOpts.includes(name)) return { ok: false, error: `unknown option ${name}` };
      const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (value === undefined || value === '') return { ok: false, error: `${name} needs a value` };
      f.values.set(name, [...(f.values.get(name) ?? []), value]);
      continue;
    }
    f.pos.push(a);
  }
  return { ok: true, f };
}

function one(f: Flags, name: string): string | null | 'twice' {
  const v = f.values.get(name);
  if (v === undefined) return null;
  return v.length > 1 ? 'twice' : (v[0] ?? null);
}

// ---------------------------------------------------------------------------------------------------------------- new

function yamlString(s: string): string {
  return /^[A-Za-z0-9_./-][A-Za-z0-9_./ -]*$/.test(s) && !/^(true|false|null|yes|no|on|off|~)$/i.test(s) && !/\s$/.test(s) ? s : JSON.stringify(s);
}

function orderNew(argv: readonly string[], opts: OrderCommandOptions): OrderCommandResult {
  const p = parseFlags(argv, ['--kind', '--input', '--output', '--template'], []);
  if (!p.ok) return usage(p.error);
  if (p.f.pos.length > 0) return usage(`unexpected argument ${JSON.stringify(p.f.pos[0])}`);
  const kind = one(p.f, '--kind') ?? 'other';
  if (kind === 'twice' || !(ORDER_KINDS as readonly string[]).includes(kind)) return usage(`--kind must be one of ${ORDER_KINDS.join(', ')}`);
  const template = one(p.f, '--template');
  if (template === 'twice' || (template !== null && !TEMPLATE_NAME.test(template))) return usage('--template must be a template name (lower-case letters, digits, - and _)');
  const L: string[] = [
    '# A work order for `openmorals order check`. Write what "done" means as conditions, then approve it',
    '# yourself: openmorals order approve <this file>. Paths are read from the folder this file is in.',
    `# Conditions: ${CONDITION_KINDS.join(', ')}.`,
    'version: 1',
    `kind: ${kind}`,
  ];
  if (template !== null) L.push(`template: ${template}`);
  const inputs = p.f.values.get('--input') ?? [];
  if (inputs.length > 0) {
    L.push('inputs:');
    for (const i of inputs) {
      const b = readBytes(i.startsWith('/') ? i : `${opts.cwd}/${i}`);
      if (!b.ok) return { exitCode: ORDER_EXIT.fail, stdout: '', stderr: `openmorals order new: the input ${i} ${b.error}; nothing was printed\n` };
      L.push(`  - path: ${yamlString(i)}`, `    sha256: ${sha256Hex(b.value)}`);
    }
  }
  const outputs = p.f.values.get('--output') ?? [];
  if (outputs.length > 0) L.push('outputs:', ...outputs.map((o) => `  - ${yamlString(o)}`));
  L.push('conditions:');
  if (outputs.length === 0) L.push('  - exists: { file: CHANGE-ME.md }');
  for (const o of outputs) {
    const t = extOf(o);
    L.push(`  - exists: { file: ${yamlString(o)}${(FILE_TYPES as readonly string[]).includes(t) ? `, type: ${t}` : ''} }`);
  }
  return { exitCode: 0, stdout: `${L.join('\n')}\n`, stderr: '' };
}

// ---------------------------------------------------------------------------------------------------------------- shared text

function editLines(edits: readonly Edit[]): string[] {
  const order: Edit['kind'][] = ['loosening', 'change', 'tightening'];
  const label: Record<Edit['kind'], string> = { loosening: 'loosening', change: 'change (read as a loosening)', tightening: 'tightening' };
  return order.flatMap((k) => edits.filter((e) => e.kind === k).map((e) => `  ${label[k]}: ${e.what}`));
}

function editCounts(edits: readonly Edit[]): string {
  const n = (k: Edit['kind']): number => edits.filter((e) => e.kind === k).length;
  return `${n('loosening')} loosening(s), ${n('change')} change(s), ${n('tightening')} tightening(s)`;
}

function invalidText(cmd: string, path: string, errors: readonly string[]): string {
  return `openmorals order ${cmd}: ${path} is not a valid work order:\n${errors.map((e) => `  ${e}`).join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------------------------- approve

function orderApprove(argv: readonly string[], opts: OrderCommandOptions): OrderCommandResult {
  const p = parseFlags(argv, [], ['--yes']);
  if (!p.ok) return usage(p.error);
  if (p.f.pos.length !== 1) return usage(p.f.pos.length === 0 ? 'order approve needs the order file' : `unexpected argument ${JSON.stringify(p.f.pos[1])}`);
  const now = (opts.now ?? (() => new Date()))();
  const fail = (msg: string, out = ''): OrderCommandResult => ({ exitCode: ORDER_EXIT.fail, stdout: out, stderr: msg.endsWith('\n') ? msg : `${msg}\n` });
  const l = loadOrder(p.f.pos[0] ?? '', opts.env, opts.cwd);
  if (!l.ok) return fail(l.kind === 'invalid' ? `${invalidText('approve', l.path, l.errors)}Nothing was approved.` : `openmorals order approve: ${l.errors.join('; ')}; nothing was approved`);
  const o = l.loaded;
  const store = readApprovals(opts.env);
  if (!store.ok) return fail(`openmorals order approve: ${store.error}; nothing was approved. Move the file aside or fix the line.`);
  const lost = templateLosses(o, store.list);
  if (lost.length > 0) return fail(`openmorals order approve: ${lost.join('; ')}. Nothing was approved; put the condition back in the template, or start a template with a new name.`);
  const bad = checkInputs(o.order, o.dir).filter((r) => r.outcome === 'fail');
  if (bad.length > 0) return fail(`openmorals order approve: an input does not match the order:\n${bad.map((b) => `  ${b.detail}`).join('\n')}\nNothing was approved; write the input's current sha256 into the order (openmorals order new --input FILE prints it) if this is the input you mean.`);
  const st = approvalState(o, store.list);
  if (st.state === 'approved') return { exitCode: 0, stdout: `openmorals order approve: ${o.path} is already approved as it reads now (sha256 ${o.sha256.slice(0, 12)}, approved ${st.approval.ts}); nothing was written\n`, stderr: '' };
  const L: string[] = [];
  L.push(`Work order ${o.path}`);
  L.push(`  kind ${o.order.kind}${o.order.title !== null ? `, "${o.order.title}"` : ''}${o.template !== null ? `, template ${o.template.name}` : ''}; sha256 ${o.sha256.slice(0, 12)}`);
  for (const i of o.order.inputs) L.push(`  input  ${i.path} (sha256 ${i.sha256.slice(0, 12)}, matches now)`);
  for (const out of o.order.outputs) L.push(`  output ${out}`);
  L.push(`Conditions (${o.order.conditions.length}):`);
  for (const c of o.order.conditions) L.push(`  ${describeCondition(c.condition)}${c.from === 'template' ? '   (template)' : ''}`);
  if (st.state === 'edited') {
    L.push(`Edited since it was approved on ${st.approval.ts}: ${editCounts(st.edits)}`);
    L.push(...editLines(st.edits));
  } else L.push('Not approved before.');
  const bare = outputsWithoutCondition(o.order);
  if (bare.length > 0) L.push(`Outputs no condition reads (checked only for existing): ${bare.join(', ')}`);
  L.push('A pass of this order will not show what is listed under "Not checked" in order check, and never whether to send.');
  const shown = `${L.join('\n')}\n`;
  if (!p.f.bools.has('--yes')) {
    if (!opts.interactive) return fail('openmorals order approve: add --yes to approve it, or run it in a terminal to be asked. Nothing was approved.', shown);
    opts.prompt(`${shown}Approve this work order? Type yes: `);
    const line = opts.readLine();
    if (line === null || line.trim().toLowerCase() !== 'yes') return fail('openmorals order approve: not confirmed; nothing was approved');
  }
  const rec: StoredApproval = { v: 1, ts: now.toISOString(), path: o.real, sha256: o.sha256, text: o.text, template: o.template };
  let file: string;
  try {
    file = appendApproval(opts.env, rec);
  } catch (e: unknown) {
    return fail(`openmorals order approve: could not write the approval (${e instanceof Error ? e.message : String(e)}); nothing was approved`);
  }
  const audit: AuditFields = {
    ts: now.toISOString(),
    source: 'openmorals',
    session: ORDER_SESSION,
    tool: 'order approve',
    action: `order approve ${o.real}`,
    decision: 'allow',
    rule: ORDER_RULES.approve,
    reason: `approved work order sha256 ${o.sha256}${st.state === 'edited' ? ` after an edit (${editCounts(st.edits)})` : ''}`,
    cwd: opts.cwd,
    budget: null,
    order_check: { path: o.real, sha256: o.sha256, kind: o.order.kind, conditions: o.order.conditions.length, edits: st.state === 'edited' ? st.edits.map((e) => `${e.kind}: ${e.what}`) : [] },
  };
  let note = '';
  try {
    appendAuditForSession(ORDER_SESSION, [audit], { order: o.real }, configDir(opts.env), now);
  } catch (e: unknown) {
    note = `; the audit log line could not be written (${e instanceof Error ? e.message : String(e)})`;
  }
  return { exitCode: 0, stdout: `${p.f.bools.has('--yes') ? shown : ''}approved ${o.path} (sha256 ${o.sha256.slice(0, 12)}) in ${file}${note}. order check now checks against this approval; any edit to the order or its template fails it until you approve again.\n`, stderr: '' };
}

// ---------------------------------------------------------------------------------------------------------------- check

export interface CheckReport {
  result: 'pass' | 'fail';
  path: string;
  sha256: string | null;
  kind: string | null;
  title: string | null;
  template: string | null;
  /** Why the order itself fails (missing, invalid, not approved, edited, store unreadable), or empty. */
  orderProblems: string[];
  approval: { state: ApprovalState['state'] | 'unknown'; ts: string | null; edits: string[] };
  inputs: InputResult[];
  outputs: InputResult[];
  conditions: ConditionResult[];
  notChecked: string[];
}

function summaryLine(r: CheckReport): string {
  const failed = r.conditions.filter((c) => c.outcome === 'fail').length;
  const parts: string[] = [];
  if (r.orderProblems.length > 0) parts.push(r.orderProblems[0] ?? '');
  const badIn = r.inputs.filter((i) => i.outcome === 'fail').length;
  const badOut = r.outputs.filter((i) => i.outcome === 'fail').length;
  if (badIn > 0) parts.push(`${badIn} input(s) changed or missing`);
  if (badOut > 0) parts.push(`${badOut} output(s) missing`);
  if (failed > 0) parts.push(`${failed} of ${r.conditions.length} condition(s) failed`);
  return r.result === 'pass' ? `${r.conditions.length} of ${r.conditions.length} condition(s) passed, order approved as it reads now` : parts.join('; ');
}

function formatCheck(r: CheckReport, recorded: string, exitCode: number): string {
  const L: string[] = [];
  L.push(`openmorals order check ${r.path}: ${r.result === 'pass' ? 'PASS' : 'FAIL'}`);
  if (r.sha256 !== null) L.push(`  kind ${r.kind ?? '?'}${r.title !== null ? `, "${r.title}"` : ''}${r.template !== null ? `, template ${r.template}` : ''}; sha256 ${r.sha256.slice(0, 12)}`);
  if (r.approval.state === 'approved') L.push(`  approved ${r.approval.ts ?? ''}, unchanged since`);
  for (const p of r.orderProblems) L.push(`  ORDER ${p}`);
  if (r.approval.edits.length > 0) L.push(...r.approval.edits.map((e) => `  ${e}`));
  for (const i of r.inputs) L.push(`  ${i.outcome === 'pass' ? 'pass' : 'FAIL'}  input ${i.detail}`);
  for (const o of r.outputs) L.push(`  ${o.outcome === 'pass' ? 'pass' : 'FAIL'}  output ${o.detail}`);
  for (const c of r.conditions) {
    L.push(`  ${c.outcome === 'pass' ? 'pass' : 'FAIL'}  ${c.asks}`);
    for (const d of c.detail) L.push(`        ${d}`);
  }
  if (r.notChecked.length > 0) {
    L.push('Not checked:');
    for (const n of r.notChecked) L.push(`  - ${n}`);
  }
  L.push(`Result: ${r.result === 'pass' ? 'PASS' : 'FAIL'} (exit ${exitCode}): ${summaryLine(r)}.`);
  L.push(recorded);
  return `${L.join('\n')}\n`;
}

function notCheckedList(o: LoadedOrder | null, conditions: readonly ConditionResult[]): string[] {
  const out: string[] = [];
  for (const c of conditions) if (c.outcome === 'pass') out.push(`${c.key}: ${c.notShown}`);
  if (o !== null) {
    const bare = outputsWithoutCondition(o.order);
    if (bare.length > 0) out.push(`outputs no condition reads (only that they exist): ${bare.join(', ')}`);
  }
  out.push(...ALWAYS_NOT_CHECKED);
  return out;
}

/** Runs the whole check without writing anything. */
export function checkOrder(file: string, env: NodeJS.ProcessEnv, cwd: string, now: Date): { report: CheckReport; loaded: LoadedOrder | null } {
  const r = checkOrderAt(file, env, cwd, now);
  const rel = relative(cwd, r.report.path);
  if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) r.report.path = rel;
  return r;
}

function checkOrderAt(file: string, env: NodeJS.ProcessEnv, cwd: string, now: Date): { report: CheckReport; loaded: LoadedOrder | null } {
  const l = loadOrder(file, env, cwd);
  const empty = { inputs: [], outputs: [], conditions: [] };
  if (!l.ok) {
    const why = l.kind === 'missing' ? `no order at ${l.path}: a missing order is a failure, never a pass` : l.kind === 'invalid' ? `the order is not valid: ${l.errors.join('; ')}` : `the order cannot be read: ${l.errors.join('; ')}`;
    return { report: { result: 'fail', path: l.path, sha256: null, kind: null, title: null, template: null, orderProblems: [why], approval: { state: 'unknown', ts: null, edits: [] }, ...empty, notChecked: [...ALWAYS_NOT_CHECKED] }, loaded: null };
  }
  const o = l.loaded;
  const problems: string[] = [];
  let approval: CheckReport['approval'] = { state: 'unknown', ts: null, edits: [] };
  const store = readApprovals(env);
  if (!store.ok) problems.push(`the approval store cannot be read (${store.error}), so the order counts as not approved`);
  else {
    const lost = templateLosses(o, store.list);
    problems.push(...lost);
    const st = approvalState(o, store.list);
    if (st.state === 'unapproved') problems.push(`not approved: you approve it yourself with openmorals order approve ${o.path}`);
    else if (st.state === 'edited') problems.push(`edited after approval (approved ${st.approval.ts}; ${editCounts(st.edits)}); approve it again yourself if the edit is meant`);
    approval = st.state === 'unapproved' ? { state: 'unapproved', ts: null, edits: [] } : { state: st.state, ts: st.approval.ts, edits: st.state === 'edited' ? editLines(st.edits).map((x) => x.trim()) : [] };
  }
  const inputs = checkInputs(o.order, o.dir);
  const outputs = checkOutputs(o.order, o.dir);
  const conditions = runConditions(o.order, o.dir, now);
  const pass = problems.length === 0 && [...inputs, ...outputs, ...conditions].every((x) => x.outcome === 'pass');
  return {
    report: { result: pass ? 'pass' : 'fail', path: o.path, sha256: o.sha256, kind: o.order.kind, title: o.order.title, template: o.template?.name ?? null, orderProblems: problems, approval, inputs, outputs, conditions, notChecked: notCheckedList(o, conditions) },
    loaded: o,
  };
}

function orderCheck(argv: readonly string[], opts: OrderCommandOptions): OrderCommandResult {
  const p = parseFlags(argv, ['--run'], ['--json']);
  if (!p.ok) return usage(p.error);
  if (p.f.pos.length > 1) return usage(`unexpected argument ${JSON.stringify(p.f.pos[1])}`);
  const file = p.f.pos[0] ?? opts.env['OPENMORALS_ORDER'] ?? '';
  if (file.trim() === '') return usage('order check needs the order file (or OPENMORALS_ORDER)');
  const runFlag = one(p.f, '--run');
  if (runFlag === 'twice') return usage('--run given twice');
  const run = cleanAuditId(runFlag ?? opts.env['OPENMORALS_RUN']);
  const now = (opts.now ?? (() => new Date()))();
  const { report: r, loaded } = checkOrder(file, opts.env, opts.cwd, now);
  const data = {
    result: r.result,
    path: loaded?.real ?? r.path,
    sha256: r.sha256,
    approval: r.approval.state,
    approved: r.approval.ts,
    problems: r.orderProblems,
    inputs: r.inputs.map((i) => ({ path: i.path, outcome: i.outcome, detail: i.detail })),
    outputs: r.outputs.map((i) => ({ path: i.path, outcome: i.outcome })),
    conditions: r.conditions.map((c) => ({ key: c.key, outcome: c.outcome, detail: c.detail })),
    not_checked: r.notChecked,
  };
  const rec: AuditFields = {
    ts: now.toISOString(),
    source: 'openmorals',
    session: ORDER_SESSION,
    tool: 'order check',
    action: `order check ${loaded?.real ?? r.path}`,
    decision: r.result === 'pass' ? 'allow' : 'ask',
    rule: r.result === 'pass' ? ORDER_RULES.pass : ORDER_RULES.fail,
    reason: summaryLine(r),
    cwd: opts.cwd,
    budget: null,
    order_check: data,
  };
  const meta: AuditMeta = {};
  if (run !== undefined) meta.run = run;
  const orderPath = cleanAuditPath(loaded?.real ?? r.path);
  if (orderPath !== undefined) meta.order = orderPath;
  let exitCode: number = r.result === 'pass' ? ORDER_EXIT.pass : ORDER_EXIT.fail;
  let recorded: string;
  try {
    appendAuditForSession(ORDER_SESSION, [rec], meta, configDir(opts.env), now);
    recorded = run !== undefined ? `Recorded in the audit log with run ${run}.` : 'Recorded in the audit log without a run id (set OPENMORALS_RUN or pass --run ID to tie it to a run).';
  } catch (e: unknown) {
    exitCode = ORDER_EXIT.unrecorded;
    recorded = `NOT recorded: the audit log could not be written (${e instanceof Error ? e.message : String(e)}); read this as not passed.`;
  }
  if (p.f.bools.has('--json')) return { exitCode, stdout: `${JSON.stringify({ exitCode, ...data, recorded: exitCode !== ORDER_EXIT.unrecorded, run: run ?? null })}\n`, stderr: '' };
  return { exitCode, stdout: formatCheck(r, recorded, exitCode), stderr: '' };
}

/** `openmorals order <subcommand> ...`. */
export function orderCommand(argv: readonly string[], opts: OrderCommandOptions): OrderCommandResult {
  const sub = argv[0];
  const rest = argv.slice(1);
  if (sub === 'new') return orderNew(rest, opts);
  if (sub === 'approve') return orderApprove(rest, opts);
  if (sub === 'check') return orderCheck(rest, opts);
  if (sub === 'baseline') return usage('order baseline (the office before-after snapshot) is not built yet');
  return usage(sub === undefined ? 'needs a subcommand: new, approve or check' : `unknown subcommand ${sub}`);
}
