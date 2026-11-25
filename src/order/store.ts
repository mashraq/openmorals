// Reading an order file with its user-level template, its hash, and the approval store under the config directory
// (`orders/approvals.jsonl`, append-only, protected by the self-protect guard like the rest of the config directory).
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { configDir } from '../paths.js';
import { MAX_FILE_BYTES, readBytes, sha256Hex, asText } from './files.js';
import type { Condition, Edit, Order, Parsed } from './model.js';
import { TEMPLATE_NAME, compareOrders, conditionKey, describeCondition, parseOrder, parseTemplate } from './model.js';

export const ORDERS_DIR = 'orders';
export const APPROVALS_FILE = 'approvals.jsonl';
/** User-level templates (ADR 0010: never read from a project): `<config dir>/order-templates/<name>.yaml`. */
export const TEMPLATES_DIR = 'order-templates';
const HASH_DOMAIN = 'openmorals-order-v1';

export interface TemplateText {
  name: string;
  text: string;
}

export interface LoadedOrder {
  /** The path as the person named it, resolved. */
  path: string;
  /** The real path (links resolved): the key the approval is stored under. */
  real: string;
  /** The folder the order's own paths are read from. */
  dir: string;
  text: string;
  template: TemplateText | null;
  sha256: string;
  order: Order;
}

export type LoadResult = { ok: true; loaded: LoadedOrder } | { ok: false; kind: 'missing' | 'unreadable' | 'invalid'; path: string; errors: string[] };

export interface StoredApproval {
  v: 1;
  ts: string;
  path: string;
  sha256: string;
  text: string;
  template: TemplateText | null;
}

export type ApprovalsRead = { ok: true; list: StoredApproval[]; file: string } | { ok: false; file: string; error: string };

/** SHA-256 of the order's text and its template's text, so an edit to either is an edit after approval. */
export function orderHash(text: string, template: TemplateText | null): string {
  return sha256Hex(`${HASH_DOMAIN}\u0000${text}${template !== null ? `\u0000template\u0000${template.name}\u0000${template.text}` : ''}`);
}

export function templatePath(name: string, env: NodeJS.ProcessEnv): string {
  return join(configDir(env), TEMPLATES_DIR, `${name}.yaml`);
}

function readTemplateText(name: string, env: NodeJS.ProcessEnv): { ok: true; text: string } | { ok: false; error: string } {
  if (!TEMPLATE_NAME.test(name)) return { ok: false, error: 'is not a template name' };
  const file = templatePath(name, env);
  const b = readBytes(file);
  if (!b.ok) return { ok: false, error: `${file} ${b.error}` };
  const t = asText(b.value);
  return t.ok ? { ok: true, text: t.value } : { ok: false, error: `${file} ${t.error}` };
}

/** Parses an order text with a template text already read (or none). */
export function parseWithTemplate(text: string, template: TemplateText | null): Parsed<Order> {
  return parseOrder(text, (name) => {
    if (template === null || template.name !== name) return { ok: false, errors: [`the template ${name} was not read`] };
    return parseTemplate(template.text);
  });
}

/** Reads, validates and hashes an order file and the user-level template it names. */
export function loadOrder(file: string, env: NodeJS.ProcessEnv, cwd: string): LoadResult {
  const path = resolve(cwd, file);
  const b = readBytes(path);
  if (!b.ok) return { ok: false, kind: b.error === 'does not exist' ? 'missing' : 'unreadable', path, errors: [`${path} ${b.error}`] };
  const t = asText(b.value);
  if (!t.ok) return { ok: false, kind: 'unreadable', path, errors: [`${path} ${t.error}`] };
  let template: TemplateText | null = null;
  const first = parseOrder(t.value, (name) => {
    const tt = readTemplateText(name, env);
    if (!tt.ok) return { ok: false, errors: [tt.error] };
    template = { name, text: tt.text };
    return parseTemplate(tt.text);
  });
  if (!first.ok) return { ok: false, kind: 'invalid', path, errors: first.errors };
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // keep the resolved path
  }
  return { ok: true, loaded: { path, real, dir: dirname(path), text: t.value, template, sha256: orderHash(t.value, template), order: first.value } };
}

export function approvalsFile(env: NodeJS.ProcessEnv): string {
  return join(configDir(env), ORDERS_DIR, APPROVALS_FILE);
}

function isTemplateText(v: unknown): v is TemplateText {
  return typeof v === 'object' && v !== null && typeof (v as TemplateText).name === 'string' && typeof (v as TemplateText).text === 'string';
}

/** Every approval, oldest first. A line that does not read makes the whole store unreadable: nothing is assumed approved. */
export function readApprovals(env: NodeJS.ProcessEnv): ApprovalsRead {
  const file = approvalsFile(env);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e: unknown) {
    if (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOENT') return { ok: true, list: [], file };
    return { ok: false, file, error: `cannot read ${file}: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (text.length > MAX_FILE_BYTES) return { ok: false, file, error: `${file} is larger than ${MAX_FILE_BYTES} bytes` };
  return parseApprovals(text, file);
}

/** The approval store's text read as approvals (0.28.0: also read by the release hold through the hook's own file probe). */
export function parseApprovals(text: string, file: string): ApprovalsRead {
  const list: StoredApproval[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      return { ok: false, file, error: `${file} line ${i + 1} is not JSON` };
    }
    const a = o as Partial<StoredApproval>;
    if (typeof o !== 'object' || o === null || a.v !== 1 || typeof a.ts !== 'string' || typeof a.path !== 'string' || typeof a.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(a.sha256) || typeof a.text !== 'string' || !(a.template === null || isTemplateText(a.template))) {
      return { ok: false, file, error: `${file} line ${i + 1} is not an approval record` };
    }
    list.push({ v: 1, ts: a.ts, path: a.path, sha256: a.sha256, text: a.text, template: a.template });
  }
  return { ok: true, list, file };
}

export function appendApproval(env: NodeJS.ProcessEnv, a: StoredApproval): string {
  const file = approvalsFile(env);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify(a)}\n`, { mode: 0o600 });
  return file;
}

export function latestApproval(list: readonly StoredApproval[], real: string): StoredApproval | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i];
    if (a !== undefined && a.path === real) return a;
  }
  return null;
}

export type ApprovalState =
  | { state: 'approved'; approval: StoredApproval }
  | { state: 'unapproved' }
  | { state: 'edited'; approval: StoredApproval; edits: Edit[] };

/** Whether this order, as it reads now, is the one approved: by its hash, then the edits shown condition by condition. */
export function approvalState(loaded: LoadedOrder, list: readonly StoredApproval[]): ApprovalState {
  const a = latestApproval(list, loaded.real);
  if (a === null) return { state: 'unapproved' };
  if (a.sha256 === loaded.sha256) return { state: 'approved', approval: a };
  const before = parseWithTemplate(a.text, a.template);
  const edits: Edit[] = before.ok ? compareOrders(before.value, loaded.order) : [{ kind: 'change', what: 'the approved text no longer reads as an order, so the edit cannot be shown condition by condition' }];
  if (edits.length === 0) edits.push({ kind: 'change', what: 'the text changed (layout, comments or order of lines) with no change to any condition' });
  return { state: 'edited', approval: a, edits };
}

/**
 * A template's conditions only grow: a condition that the template held when any order using it was approved must still
 * be there. Returns one line per condition the template has lost.
 */
export function templateLosses(loaded: LoadedOrder, list: readonly StoredApproval[]): string[] {
  const t = loaded.template;
  if (t === null) return [];
  const now = parseTemplate(t.text);
  if (!now.ok) return [];
  const have = new Set(now.value.map(conditionKey));
  const lost = new Map<string, { c: Condition; ts: string }>();
  for (const a of list) {
    if (a.template === null || a.template.name !== t.name) continue;
    const was = parseTemplate(a.template.text);
    if (!was.ok) continue;
    for (const c of was.value) {
      const k = conditionKey(c);
      if (!have.has(k) && !lost.has(k)) lost.set(k, { c, ts: a.ts });
    }
  }
  return [...lost.values()].map((x) => `the template ${t.name} no longer holds "${describeCondition(x.c)}", which it held when an order was approved on ${x.ts}; a template's conditions only grow`);
}

/**
 * The named acceptance tests of an order for `tests fail-first --order` (ruling R2): the ids of its `tests` conditions,
 * only when the order is approved as it reads now. Anything else is an error, so the agent's own list never counts.
 */
export function approvedOrderTestIds(file: string, env: NodeJS.ProcessEnv, cwd: string): { ok: true; ids: string[] } | { ok: false; error: string } {
  const l = loadOrder(file, env, cwd);
  if (!l.ok) return { ok: false, error: `the order ${l.path} ${l.kind === 'invalid' ? `is not valid (${l.errors.join('; ')})` : l.kind === 'missing' ? 'does not exist' : 'cannot be read'}` };
  const store = readApprovals(env);
  if (!store.ok) return { ok: false, error: store.error };
  const lost = templateLosses(l.loaded, store.list);
  if (lost.length > 0) return { ok: false, error: lost.join('; ') };
  const st = approvalState(l.loaded, store.list);
  if (st.state !== 'approved') return { ok: false, error: `the order ${l.loaded.path} is ${st.state === 'edited' ? 'edited after approval' : 'not approved'}; only an order you approved names acceptance tests` };
  const ids: string[] = [];
  for (const p of l.loaded.order.conditions) if (p.condition.kind === 'tests') for (const id of p.condition.ids) if (!ids.includes(id)) ids.push(id);
  if (ids.length === 0) return { ok: false, error: `the order ${l.loaded.path} has no tests condition naming acceptance tests` };
  return { ok: true, ids };
}
