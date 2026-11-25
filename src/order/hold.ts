// The release hold (0.28.0). When the hook's own environment names a work order (`OPENMORALS_ORDER`), an
// outward action (a send, a form submit, an upload, a publish, or overwriting an original) on a file the order names is
// held (ask; the adapters turn it into a deny unattended and queue it under the deferred ask) while the order's last
// check failed, is missing, or the file changed since that check. It only ever adds an ask: a passing check adds nothing
// and removes nothing from any other guard's decision (ADR 0013, ADR 0014). With no order named it returns at once.
//
// Recognition is the other guards' own: the outbound guard's send and form-entry tools, its browser tools and the
// network commands it judges (`reachesNetwork`); the replace guard's whole replacements and the move guard's copies and
// moves over a file (built on the document guard's path reading). Files are read through `Where`, so a case row fakes
// the disk; no office file is parsed here (no office reader runs in a hook), and nothing is written.
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseAuditLine } from '../audit.js';
import type { Finding, Guard, GuardContext, TailProbe, Where } from '../guard.js';
import { documentPath, pathFrom } from '../guards/document.js';
import { commandPlaces } from '../guards/folders.js';
import { moveShape } from '../guards/moves.js';
import { replacementsOf } from '../guards/replace.js';
import { reachesNetwork } from '../network.js';
import { entryTool, isBrowserTool, isSendTool } from '../outbound/guard.js';
import { auditLogPath } from '../paths.js';
import type { ParsedCommand, SimpleCommand } from '../shell.js';
import type { Action, Bylaws } from '../types.js';
import type { Condition, ItemRole, Order, Parsed } from './model.js';
import { orderItems, parseOrder, parseTemplate } from './model.js';
import type { TemplateText } from './store.js';
import { APPROVALS_FILE, ORDERS_DIR, TEMPLATES_DIR, latestApproval, orderHash, parseApprovals, parseWithTemplate } from './store.js';

export type HoldRule = 'hold.order' | 'hold.failed' | 'hold.missing' | 'hold.changed';

/** The most of an order file (and of its template) the hold reads. */
export const HOLD_ORDER_MAX_BYTES = 1024 * 1024;
/** The most of the approval store the hold reads (as `order approve` and `order check` do). */
export const HOLD_APPROVALS_MAX_BYTES = 64 * 1024 * 1024;
/** The most of the audit log's end the hold searches for the order's last check. */
export const HOLD_AUDIT_TAIL_BYTES = 16 * 1024 * 1024;
/** The largest file the hold hashes (as `order check` does). */
export const HOLD_HASH_MAX_BYTES = 64 * 1024 * 1024;
/** The most tool-call values and command words looked at for files. */
const MAX_WORDS = 256;

/** How an outward action reaches out: a message or form or upload (send), a folder going out whole (publish), a file replaced (overwrite). */
export type TouchHow = 'send' | 'publish' | 'overwrite';

/** One outward step of a call and the files and folders it carries (absolute, as named). */
export interface Touch {
  how: TouchHow;
  /** How the reason names the step, e.g. `send_email sends` or `cp overwrites`. */
  verb: string;
  files: string[];
  folders: string[];
  /** True for a send or submit: it is an outward step even when it names no file (the message itself goes out). */
  always: boolean;
}

function shown(abs: string, where: Where): string {
  for (const base of [resolve(where.cwd), where.realpath(resolve(where.cwd))]) {
    const rel = relative(base, abs);
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return rel;
  }
  return abs;
}

function kindAt(abs: string, where: Where): 'file' | 'folder' | null {
  const p = where.readFile(abs, 0);
  return p.kind === 'file' ? 'file' : p.kind === 'other' ? 'folder' : null;
}

/** The absolute path a value names when it is an existing file or folder (`file://` and `~` read), else null. */
function existing(word: string, where: Where, from: string): { abs: string; kind: 'file' | 'folder' } | null {
  const w = word.trim().replace(/^file:\/\//i, '');
  if (w === '' || w.length > 4096) return null;
  const abs = documentPath(w, { ...where, cwd: from });
  if (abs === null) return null;
  const k = kindAt(abs, where);
  return k === null ? null : { abs, kind: k };
}

function collect(words: readonly string[], where: Where, dirs: readonly string[], t: { files: string[]; folders: string[] }): void {
  for (const w of words.slice(0, MAX_WORDS)) {
    for (const d of dirs) {
      const e = existing(w, where, d);
      if (e === null) continue;
      const list = e.kind === 'file' ? t.files : t.folders;
      if (!list.includes(e.abs)) list.push(e.abs);
    }
  }
}

/** The words of a network command that may name what it carries: each argument, the part after `@` (`-F f=@x`, `-d @x`), and `<` inputs. */
function carriedWords(c: SimpleCommand): string[] {
  const out: string[] = [];
  for (const a of c.args) {
    out.push(a);
    const at = a.lastIndexOf('@');
    if (at !== -1) out.push((a.slice(at + 1).split(';')[0] ?? '').trim());
  }
  for (const r of c.redirects) if (r.op === '<') out.push(r.target);
  return out;
}

/** A command that sends the folder it runs in: `git push`, and `npm`/`pnpm`/`yarn publish`. */
function publishesFolder(c: SimpleCommand): boolean {
  if (c.name === 'git') return c.args.includes('push');
  return (c.name === 'npm' || c.name === 'pnpm' || c.name === 'yarn') && c.args.includes('publish');
}

/** Every outward step of one action, with the files and folders each carries. Empty for anything else. */
export function touchesOf(action: Action, parsed: ParsedCommand | null, where: Where, bylaws: Bylaws): Touch[] {
  const out: Touch[] = [];
  const here = [resolve(where.cwd)];
  if (action.kind === 'other') {
    const values = (action.leaves ?? []).map((l) => l.value);
    const leaves = action.leaves ?? [];
    const sends = isSendTool(action.tool) || entryTool(action.tool, leaves);
    if (sends || isBrowserTool(action.tool)) {
      const t: Touch = { how: 'send', verb: `${action.tool} ${sends ? 'sends' : 'uploads'}`, files: [], folders: [], always: sends };
      collect(values, where, here, t);
      if (t.always || t.files.length > 0 || t.folders.length > 0) out.push(t);
    }
  }
  if (action.kind === 'exec' && parsed !== null) {
    const commands = parsed.commands.slice(0, MAX_WORDS);
    const places = commandPlaces(commands, where, pathFrom(where));
    commands.forEach((c, i) => {
      if (!reachesNetwork(c)) return;
      const dirs = places[i]?.dirs ?? here;
      const folder = publishesFolder(c);
      const t: Touch = { how: folder ? 'publish' : 'send', verb: `${c.name} ${folder ? 'publishes' : 'sends'}`, files: [], folders: folder ? dirs.map((d) => resolve(d)) : [], always: false };
      const words = carriedWords(c);
      for (let j = i; j > 0 && commands[j]?.pipeIn === true; j--) {
        const f = commands[j - 1];
        if (f !== undefined) words.push(...f.args, ...f.redirects.filter((r) => r.op === '<').map((r) => r.target));
      }
      collect(words, where, dirs, t);
      if (t.files.length > 0 || t.folders.length > 0) out.push(t);
    });
  }
  for (const r of replacementsOf(action, parsed, where, bylaws)) {
    const t: Touch = { how: 'overwrite', verb: `${r.verb} overwrites`, files: [], folders: [], always: false };
    for (const d of r.dirs) {
      const abs = documentPath(r.word, { ...where, cwd: d });
      if (abs !== null && kindAt(abs, where) === 'file' && !t.files.includes(abs)) t.files.push(abs);
    }
    if (t.files.length > 0) out.push(t);
  }
  if (action.kind === 'exec' && parsed !== null) {
    const commands = parsed.commands.slice(0, MAX_WORDS);
    const places = commandPlaces(commands, where, pathFrom(where));
    commands.forEach((c, i) => {
      const m = moveShape(c);
      if (m === null) return;
      const t: Touch = { how: 'overwrite', verb: `${m.verb} overwrites`, files: [], folders: [], always: false };
      for (const d of places[i]?.dirs ?? here) {
        const dest = documentPath(m.dest, { ...where, cwd: d });
        if (dest === null) continue;
        const targets = kindAt(dest, where) === 'folder' ? m.sources.map((s) => join(dest, basename(s))) : [dest];
        for (const x of targets) if (kindAt(x, where) === 'file' && !t.files.includes(x)) t.files.push(x);
      }
      if (t.files.length > 0) out.push(t);
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------ the order

/** The named order as the hold reads it: not usable (every outward step is held), edited after approval, or approved as it reads. */
export type OrderView =
  | { kind: 'unusable'; shown: string; why: string }
  | { kind: 'edited'; shown: string; items: Map<string, ItemRole> }
  | { kind: 'approved'; shown: string; real: string; sha256: string; items: Map<string, ItemRole> };

function textOf(abs: string, max: number, where: Where): { ok: true; text: string } | { ok: false; why: string } {
  const p = where.readFile(abs, max);
  if (p.kind === 'missing') return { ok: false, why: 'does not exist' };
  if (p.kind === 'other') return { ok: false, why: 'is not a file' };
  if (p.kind === 'error') return { ok: false, why: `cannot be read (${p.error})` };
  if (p.text === undefined) return { ok: false, why: `is larger than ${max} bytes` };
  if (p.text.includes('\u0000')) return { ok: false, why: 'holds a NUL byte, so it is not a text file' };
  return { ok: true, text: p.text.charCodeAt(0) === 0xfeff ? p.text.slice(1) : p.text };
}

function itemsOf(order: Order, dir: string, where: Where, into: Map<string, ItemRole> = new Map()): Map<string, ItemRole> {
  for (const it of orderItems(order)) {
    const real = where.realpath(isAbsolute(it.path) ? resolve(it.path) : resolve(dir, it.path));
    if (!into.has(real)) into.set(real, it.role);
  }
  return into;
}

/** Reads the order `where.order` names, its user-level template and the approval store, all through `where`. */
export function readOrderView(where: Where): OrderView {
  const named = where.order ?? '';
  const abs = documentPath(named, where);
  if (abs === null) return { kind: 'unusable', shown: named, why: 'is not a path openmorals can read (an unexpanded variable)' };
  const show = shown(abs, where);
  const t = textOf(abs, HOLD_ORDER_MAX_BYTES, where);
  if (!t.ok) return { kind: 'unusable', shown: show, why: t.why };
  let template: TemplateText | null = null;
  const parsed: Parsed<Order> = parseOrder(t.text, (name): Parsed<Condition[]> => {
    const tt = textOf(join(where.configDir, TEMPLATES_DIR, `${name}.yaml`), HOLD_ORDER_MAX_BYTES, where);
    if (!tt.ok) return { ok: false, errors: [`its template ${name} ${tt.why}`] };
    template = { name, text: tt.text };
    return parseTemplate(tt.text);
  });
  if (!parsed.ok) {
    const first = (parsed.errors[0] ?? 'invalid').split('; ')[0] ?? 'invalid';
    const more = parsed.errors.length > 1 ? `; +${parsed.errors.length - 1} more, listed by openmorals order check` : '';
    return { kind: 'unusable', shown: show, why: `is not a valid order (${first.length > 100 ? `${first.slice(0, 99)}…` : first}${more})` };
  }
  const dir = dirname(abs);
  const real = where.realpath(abs);
  const sha256 = orderHash(t.text, template);
  const store = join(where.configDir, ORDERS_DIR, APPROVALS_FILE);
  const st = textOf(store, HOLD_APPROVALS_MAX_BYTES, where);
  let list: ReturnType<typeof parseApprovals> = { ok: true, list: [], file: store };
  if (!st.ok && st.why !== 'does not exist') return { kind: 'unusable', shown: show, why: `cannot be confirmed as approved: the approval store ${st.why}` };
  if (st.ok) list = parseApprovals(st.text, store);
  if (!list.ok) return { kind: 'unusable', shown: show, why: `cannot be confirmed as approved: ${list.error}` };
  const a = latestApproval(list.list, real);
  if (a === null) return { kind: 'unusable', shown: show, why: 'is not approved' };
  if (a.sha256 !== sha256) {
    const items = itemsOf(parsed.value, dir, where);
    const before = parseWithTemplate(a.text, a.template);
    if (!before.ok) return { kind: 'unusable', shown: show, why: 'was edited after approval, and the approved text no longer reads as an order' };
    return { kind: 'edited', shown: show, items: itemsOf(before.value, dir, where, items) };
  }
  return { kind: 'approved', shown: show, real, sha256, items: itemsOf(parsed.value, dir, where) };
}

// ------------------------------------------------------------------------------------------------------- the last check

/** The session and rules `order check` writes its records under (the same strings as `ORDER_SESSION` and `ORDER_RULES`; a test keeps them equal). */
export const CHECK_SESSION = 'order';
export const CHECK_RULES = { pass: 'order.check.pass', fail: 'order.check.fail' } as const;

/** The order's last check as the audit log holds it. */
export type LastCheck =
  | { kind: 'none'; why: string }
  | { kind: 'fail'; ts: string; failed: string[] }
  | { kind: 'pass'; ts: string; items: Map<string, { sha256: string | null; error: string | null }> | null };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function failedParts(oc: Record<string, unknown>): string[] {
  const out: string[] = [];
  const each = (k: string, name: (x: Record<string, unknown>) => unknown): void => {
    const v = oc[k];
    if (!Array.isArray(v)) return;
    for (const x of v) if (isObj(x) && x['outcome'] === 'fail' && typeof name(x) === 'string') out.push(name(x) as string);
  };
  if (Array.isArray(oc['problems'])) for (const p of oc['problems']) if (typeof p === 'string') out.push(p.length > 80 ? `${p.slice(0, 79)}…` : p);
  each('inputs', (x) => `input ${String(x['path'])}`);
  each('outputs', (x) => `output ${String(x['path'])}`);
  each('conditions', (x) => x['key']);
  return out;
}

/** The last `order check` record for the order at `real` with the order's hash `sha256`, searched from the end of the audit log. */
export function lastCheck(real: string, sha256: string, where: Where): LastCheck {
  const file = auditLogPath(where.configDir);
  let probe: TailProbe;
  if (where.tail !== undefined) probe = where.tail(file, HOLD_AUDIT_TAIL_BYTES);
  else {
    const p = where.readFile(file, HOLD_AUDIT_TAIL_BYTES);
    probe = p.kind !== 'file' ? p : p.text === undefined ? { kind: 'error', error: `larger than ${HOLD_AUDIT_TAIL_BYTES} bytes` } : { kind: 'text', text: p.text, cut: false };
  }
  if (probe.kind === 'missing') return { kind: 'none', why: 'no check of it is on record (there is no audit log)' };
  if (probe.kind !== 'text') return { kind: 'none', why: `the audit log cannot be read (${probe.kind === 'error' ? probe.error : 'not a file'}), so its last check cannot be found` };
  const lines = probe.text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (!line.includes('"order_check"')) continue;
    const r = parseAuditLine(line.trim());
    if ('error' in r) return { kind: 'none', why: 'a line of the audit log that names a check does not read, so its last check cannot be told' };
    if (r.v !== 2 || !isObj(r.order_check) || r.session !== CHECK_SESSION || (r.rule !== CHECK_RULES.pass && r.rule !== CHECK_RULES.fail)) continue;
    const oc = r.order_check as Record<string, unknown>;
    if (oc['path'] !== real) continue;
    if (oc['sha256'] !== sha256) return { kind: 'none', why: `no check of it as approved now is on record (the last, ${r.ts}, was of another version)` };
    if (oc['result'] !== 'pass') return { kind: 'fail', ts: r.ts, failed: failedParts(oc) };
    const raw = oc['items'];
    if (!Array.isArray(raw)) return { kind: 'pass', ts: r.ts, items: null };
    const items = new Map<string, { sha256: string | null; error: string | null }>();
    for (const x of raw) {
      if (!isObj(x) || typeof x['path'] !== 'string') continue;
      const h = x['sha256'];
      items.set(x['path'], { sha256: typeof h === 'string' ? h : null, error: typeof x['error'] === 'string' ? x['error'] : null });
    }
    return { kind: 'pass', ts: r.ts, items };
  }
  return { kind: 'none', why: probe.cut ? `no check of it is on record in the last ${HOLD_AUDIT_TAIL_BYTES / (1024 * 1024)} MiB of the audit log` : 'no check of it is on record' };
}

/** Why a file differs from the last passing check, or null when it is the same. */
function changedSince(real: string, items: Map<string, { sha256: string | null; error: string | null }> | null, where: Where): string | null {
  if (items === null) return 'the last check did not record the files\' SHA-256 (it was made before 0.28.0)';
  const rec = items.get(real);
  if (rec === undefined) return 'the last check did not record this file';
  if (rec.error !== null) return `the last check could not hash it (${rec.error})`;
  const now = (where.hash ?? (() => ({ kind: 'error' as const, error: 'no hash reader' })))(real, HOLD_HASH_MAX_BYTES);
  if (now.kind === 'hash') return now.sha256 === rec.sha256 ? null : rec.sha256 === null ? 'it was not there at the last check' : 'it changed after the last passing check';
  if (now.kind === 'missing') return rec.sha256 === null ? null : 'it was removed after the last passing check';
  return `it cannot be hashed now (${now.kind === 'large' ? `larger than ${HOLD_HASH_MAX_BYTES} bytes` : now.kind === 'error' ? now.error : 'not a file'})`;
}

// ---------------------------------------------------------------------------------------------------------- the judging

function under(abs: string, folder: string): boolean {
  const rel = relative(folder, abs);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.startsWith(sep));
}

/** The order's files one outward step carries: a named file, or any named file inside a folder it sends. Overwrites count only for inputs (the originals). */
function itemsTouched(t: Touch, items: Map<string, ItemRole>, where: Where): string[] {
  const out: string[] = [];
  const files = t.files.map((f) => where.realpath(f));
  const folders = t.folders.map((f) => where.realpath(f));
  for (const [real, role] of items) {
    if (t.how === 'overwrite' && role !== 'input') continue;
    if (files.includes(real) || folders.some((d) => under(real, d))) out.push(real);
  }
  return out;
}

function what(t: Touch, where: Where): string {
  const all = [...t.files, ...t.folders];
  const first = all[0];
  if (first === undefined) return t.how === 'send' ? 'a message or form' : 'files';
  return `${shown(first, where)}${all.length > 1 ? ` (+${all.length - 1} more)` : ''}`;
}

function named(files: readonly string[], where: Where): string {
  const first = files[0] ?? '';
  return `${shown(first, where)}${files.length > 1 ? ` (+${files.length - 1} more)` : ''}`;
}

const YOURSELF = 'or approve this call yourself';

/** The hold's findings on one call (empty when no order is named, nothing goes out, or nothing is held). */
export function holdFindings(ctx: GuardContext, where: Where): Finding[] {
  if (where.order === undefined || where.order.trim() === '') return [];
  const touches = touchesOf(ctx.action, ctx.parsed, where, ctx.bylaws);
  if (touches.length === 0) return [];
  const view = readOrderView(where);
  const order = view.shown;
  if (view.kind === 'unusable') {
    const t = touches[0] as Touch;
    const fix = view.why === 'is not approved' ? `Approve it yourself (openmorals order approve ${order})` : 'Fix the order';
    return [{ decision: 'ask', rule: 'hold.order', reason: `${t.verb} ${what(t, where)} while the work order ${order} named for this session ${view.why}, so openmorals cannot tell which files it covers. ${fix}, ${YOURSELF}.` }];
  }
  const held: { t: Touch; files: string[] }[] = [];
  for (const t of touches) {
    const files = itemsTouched(t, view.items, where);
    if (files.length > 0) held.push({ t, files });
  }
  const h0 = held[0];
  if (h0 === undefined) return [];
  if (view.kind === 'edited') {
    return [{ decision: 'ask', rule: 'hold.order', reason: `${h0.t.verb} ${named(h0.files, where)}, named in the work order ${order}, which was edited after you approved it. Approve the edit yourself (openmorals order approve ${order}), ${YOURSELF}.` }];
  }
  const last = lastCheck(view.real, view.sha256, where);
  if (last.kind === 'none') {
    return [{ decision: 'ask', rule: 'hold.missing', reason: `${h0.t.verb} ${named(h0.files, where)}, named in the work order ${order}, but ${last.why}. Run openmorals order check ${order}, ${YOURSELF}.` }];
  }
  if (last.kind === 'fail') {
    const f = last.failed;
    const list = f.length === 0 ? '' : ` (${f.slice(0, 2).join('; ')}${f.length > 2 ? `; +${f.length - 2} more` : ''})`;
    return [{ decision: 'ask', rule: 'hold.failed', reason: `${h0.t.verb} ${named(h0.files, where)}, named in the work order ${order}, whose last check failed${list}. Fix it and run openmorals order check ${order} again, ${YOURSELF}.` }];
  }
  for (const h of held) {
    for (const real of h.files) {
      const why = changedSince(real, last.items, where);
      if (why === null) continue;
      return [{ decision: 'ask', rule: 'hold.changed', reason: `${h.t.verb} ${shown(real, where)}, named in the work order ${order}: ${why} (${last.ts}). Run openmorals order check ${order} again, ${YOURSELF} if the change is meant.` }];
    }
  }
  return [];
}

/** The files and folders a call's outward steps carry, when an order is named (for binding a deferred approval to their state). */
export function holdPaths(ctx: GuardContext, where: Where): string[] {
  if (where.order === undefined || where.order.trim() === '') return [];
  const out = new Set<string>();
  for (const t of touchesOf(ctx.action, ctx.parsed, where, ctx.bylaws)) for (const p of [...t.files, ...t.folders]) out.add(p);
  return [...out].sort();
}

export const holdGuard: Guard = {
  id: 'hold',
  isHard: () => false,
  evaluate(ctx: GuardContext): Finding[] {
    const where = ctx.where;
    if (where?.order === undefined) return [];
    return holdFindings(ctx, where);
  },
};

/** The order `OPENMORALS_ORDER` names in a hook's own environment, or undefined when it is unset or blank (then nothing is held). */
export function namedOrder(env: NodeJS.ProcessEnv): string | undefined {
  const v = env['OPENMORALS_ORDER'];
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}
