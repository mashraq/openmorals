// The work order (Q6): its format, the fixed vocabulary of conditions, validation and the condition-by-condition
// comparison an edit after approval is shown with. Pure: no file is read here.
import { parse as parseYaml } from 'yaml';
import { REPORT_FORMATS, isReportFormat } from '../tests/report.js';
import type { ReportFormat } from '../tests/report.js';
import { extOf } from './files.js';

export const ORDER_VERSION = 1;
export const ORDER_KINDS = ['code', 'document', 'spreadsheet', 'data', 'email', 'other'] as const;
export type OrderKind = (typeof ORDER_KINDS)[number];
export const ORDER_KEYS = ['version', 'kind', 'title', 'template', 'inputs', 'outputs', 'conditions'] as const;
export const TEMPLATE_KEYS = ['version', 'conditions'] as const;

/** The file types `exists` can confirm, each by its content and not only its name. */
export const FILE_TYPES = ['csv', 'tsv', 'json', 'md', 'txt', 'html', 'docx', 'xlsx', 'pptx', 'pdf', 'eml'] as const;
export type FileType = (typeof FILE_TYPES)[number];

/** File endings each reader takes. */
/** Endings `no_placeholders` refuses: containers whose text it cannot read yet. Any other file is read as UTF-8 text (a binary one fails). */
export const NOT_TEXT_EXTS: readonly string[] = ['xlsx', 'xls', 'pptx', 'ppt', 'pdf', 'doc', 'odt', 'ods', 'odp', 'rtf', 'zip', 'png', 'jpg', 'jpeg', 'gif'];
export const HEADING_EXTS = ['md', 'markdown', 'docx'] as const;
export const CSV_EXTS = ['csv', 'tsv'] as const;
export const MAIL_EXTS = ['eml'] as const;
/** Files `before_after` compares with their baseline (0.30.0). */
export const OFFICE_EXTS = ['xlsx', 'docx'] as const;

/** The fixed vocabulary. Each condition's own keys are listed; nothing outside these is accepted. */
export const CONDITION_KEYS = {
  exists: ['file', 'type'],
  headings: ['file', 'include', 'in_order'],
  no_placeholders: ['file', 'also'],
  recipients: ['file', 'to', 'cc', 'bcc'],
  attachments: ['file', 'files'],
  rows: ['input', 'kept', 'dropped', 'reason_column', 'filters', 'key'],
  unique: ['file', 'columns'],
  not_null: ['file', 'columns'],
  accepted_values: ['file', 'column', 'values'],
  relationships: ['file', 'column', 'to'],
  freshness: ['file', 'column', 'max_age_days'],
  total: ['file', 'column', 'equals', 'equals_sum', 'tolerance'],
  tests: ['before', 'after', 'ids', 'format', 'before_root', 'after_root'],
  before_after: ['file', 'before', 'inputs', 'redline'],
} as const;
export type ConditionKind = keyof typeof CONDITION_KEYS;
export const CONDITION_KINDS = Object.keys(CONDITION_KEYS) as ConditionKind[];

/** Conditions of the ruling's list that are not built yet, refused by name (none in 0.27.0; kept so a refusal is one line). */
export const NOT_BUILT: Readonly<Record<string, string>> = {};

export interface ColumnRef {
  file: string;
  column: string;
}

export type Condition =
  | { kind: 'exists'; file: string; type: FileType | null }
  | { kind: 'headings'; file: string; include: string[]; in_order: boolean }
  | { kind: 'no_placeholders'; file: string; also: string[] }
  | { kind: 'recipients'; file: string; to: string[]; cc: string[]; bcc: string[] }
  | { kind: 'attachments'; file: string; files: { name: string; sha256: string }[] }
  | { kind: 'rows'; input: string; kept: string; dropped: string | null; reason_column: string; filters: string[]; key: string | null }
  | { kind: 'unique'; file: string; columns: string[] }
  | { kind: 'not_null'; file: string; columns: string[] }
  | { kind: 'accepted_values'; file: string; column: string; values: string[] }
  | { kind: 'relationships'; file: string; column: string; to: ColumnRef }
  | { kind: 'freshness'; file: string; column: string; max_age_days: number }
  | { kind: 'total'; file: string; column: string; equals: string | null; equals_sum: ColumnRef | null; tolerance: string }
  | { kind: 'tests'; before: string; after: string; ids: string[]; format: ReportFormat | null; before_root: string | null; after_root: string | null }
  | { kind: 'before_after'; file: string; before: string; inputs: string[]; redline: boolean };

export interface OrderInput {
  path: string;
  sha256: string;
}

/** A condition with where it came from: the order itself or its template. */
export interface Placed {
  condition: Condition;
  from: 'order' | 'template';
}

export interface Order {
  version: 1;
  kind: OrderKind;
  title: string | null;
  template: string | null;
  inputs: OrderInput[];
  outputs: string[];
  /** The template's conditions first, then the order's own. */
  conditions: Placed[];
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const HEX64 = /^[0-9a-f]{64}$/;
export const TEMPLATE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_LIST = 1000;
const MAX_STRING = 1024;
const NUMBER = /^-?\d+(\.\d+)?$/;
/** An input range of `before_after`: `Sheet!A1:B9` (quoted sheet names allowed, `$` allowed) or a defined name. */
const INPUT_RANGE = /^(?:(?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_. ]*)!\$?[A-Za-z]{1,3}\$?\d{1,7}(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?|[A-Za-z_\\][A-Za-z0-9_.\\]{0,254})$/;

/** The words of a list printed in an error. */
function listed(xs: readonly string[]): string {
  return xs.join(', ');
}

class Errors {
  readonly list: string[] = [];
  add(where: string, what: string): void {
    this.list.push(`${where}: ${what}`);
  }
}

function isMap(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, where: string, e: Errors, opts: { path?: boolean } = {}): string | null {
  if (typeof v !== 'string' || v.trim() === '') {
    e.add(where, 'must be a non-empty string');
    return null;
  }
  if (v.length > MAX_STRING || /[\u0000-\u001f\u007f]/.test(v)) {
    e.add(where, `must be at most ${MAX_STRING} characters with no control characters`);
    return null;
  }
  if (opts.path === true && v !== v.trim()) {
    e.add(where, 'must not start or end with a space');
    return null;
  }
  return v;
}

function strList(v: unknown, where: string, e: Errors, opts: { nonEmpty: boolean; scalars?: boolean }): string[] | null {
  if (!Array.isArray(v)) {
    e.add(where, 'must be a list');
    return null;
  }
  if (opts.nonEmpty && v.length === 0) {
    e.add(where, 'must name at least one');
    return null;
  }
  if (v.length > MAX_LIST) {
    e.add(where, `may hold at most ${MAX_LIST}`);
    return null;
  }
  const out: string[] = [];
  v.forEach((x: unknown, i) => {
    const y = opts.scalars === true && (typeof x === 'number' || typeof x === 'boolean') ? String(x) : x;
    const s = str(y, `${where}.${i}`, e);
    if (s !== null) out.push(s);
  });
  if (new Set(out).size !== out.length) e.add(where, 'names one value twice');
  return out.length === v.length ? out : null;
}

function bool(v: unknown, where: string, e: Errors, dflt: boolean): boolean {
  if (v === undefined) return dflt;
  if (typeof v !== 'boolean') {
    e.add(where, 'must be true or false');
    return dflt;
  }
  return v;
}

function decimal(v: unknown, where: string, e: Errors, opts: { min?: number }): string | null {
  const s = typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v.trim() : null;
  if (s === null || !NUMBER.test(s) || s.length > 40) {
    e.add(where, 'must be a number written with digits and an optional decimal point');
    return null;
  }
  if (opts.min !== undefined && Number(s) < opts.min) {
    e.add(where, `must be at least ${opts.min}`);
    return null;
  }
  return s;
}

function withExt(path: string | null, exts: readonly string[], where: string, what: string, e: Errors): string | null {
  if (path === null) return null;
  const x = extOf(path);
  if (!exts.includes(x)) {
    e.add(where, `${what} from a .${x === '' ? '(no ending)' : x} file is not built yet; built for: ${exts.map((t) => `.${t}`).join(', ')}`);
    return null;
  }
  return path;
}

function columnRef(v: unknown, where: string, e: Errors): ColumnRef | null {
  if (!isMap(v)) {
    e.add(where, 'must be a mapping with file and column');
    return null;
  }
  for (const k of Object.keys(v)) if (k !== 'file' && k !== 'column') e.add(where, `unknown key ${JSON.stringify(k)}; allowed: file, column`);
  const file = withExt(str(v['file'], `${where}.file`, e, { path: true }), CSV_EXTS, `${where}.file`, 'reading columns', e);
  const column = str(v['column'], `${where}.column`, e);
  return file !== null && column !== null ? { file, column } : null;
}

/** Validates one condition entry: a mapping with exactly one key, the condition's name, holding its settings. */
function parseCondition(raw: unknown, where: string, e: Errors): Condition | null {
  if (!isMap(raw) || Object.keys(raw).length !== 1) {
    e.add(where, `must be a mapping with one condition name; conditions: ${listed(CONDITION_KINDS)}`);
    return null;
  }
  const name = Object.keys(raw)[0] ?? '';
  const body = raw[name];
  const at = `${where}.${name}`;
  if (NOT_BUILT[name] !== undefined) {
    e.add(at, `the condition ${name} is not built yet (${NOT_BUILT[name] ?? ''})`);
    return null;
  }
  if (!(CONDITION_KINDS as string[]).includes(name)) {
    e.add(where, `unknown condition ${JSON.stringify(name)}; conditions: ${listed(CONDITION_KINDS)}`);
    return null;
  }
  const kind = name as ConditionKind;
  if (!isMap(body)) {
    e.add(at, `must be a mapping; keys: ${listed(CONDITION_KEYS[kind])}`);
    return null;
  }
  const allowed: readonly string[] = CONDITION_KEYS[kind];
  const before = e.list.length;
  for (const k of Object.keys(body)) if (!allowed.includes(k)) e.add(at, `unknown key ${JSON.stringify(k)}; allowed: ${listed(allowed)}`);
  const file = (key = 'file'): string | null => str(body[key], `${at}.${key}`, e, { path: true });
  let c: Condition | null = null;
  switch (kind) {
    case 'exists': {
      const f = file();
      let type: FileType | null = null;
      if (body['type'] !== undefined) {
        const t = body['type'];
        if (typeof t === 'string' && (FILE_TYPES as readonly string[]).includes(t)) type = t as FileType;
        else e.add(`${at}.type`, `must be one of ${listed(FILE_TYPES)}`);
      }
      if (f !== null) c = { kind, file: f, type };
      break;
    }
    case 'headings': {
      const f = withExt(file(), HEADING_EXTS, `${at}.file`, 'reading headings', e);
      const include = strList(body['include'], `${at}.include`, e, { nonEmpty: true });
      const in_order = bool(body['in_order'], `${at}.in_order`, e, false);
      if (f !== null && include !== null) c = { kind, file: f, include, in_order };
      break;
    }
    case 'no_placeholders': {
      const raw = file();
      const x = raw !== null ? extOf(raw) : '';
      const f = raw !== null && NOT_TEXT_EXTS.includes(x) ? null : raw;
      if (raw !== null && f === null) e.add(`${at}.file`, `reading text from a .${x} file is not built yet; built for: UTF-8 text files of any ending, and .docx`);
      const also = body['also'] === undefined ? [] : strList(body['also'], `${at}.also`, e, { nonEmpty: false });
      if (f !== null && also !== null) c = { kind, file: f, also };
      break;
    }
    case 'recipients': {
      const f = withExt(file(), MAIL_EXTS, `${at}.file`, 'reading recipients', e);
      const lists = (['to', 'cc', 'bcc'] as const).map((k) => (body[k] === undefined ? [] : strList(body[k], `${at}.${k}`, e, { nonEmpty: false })));
      const [to, cc, bcc] = lists;
      if (to !== null && to !== undefined && cc !== null && cc !== undefined && bcc !== null && bcc !== undefined) {
        if (to.length + cc.length + bcc.length === 0) e.add(at, 'names no recipient (to, cc or bcc)');
        else if (f !== null) {
          const low = (xs: string[]): string[] => xs.map((x) => x.trim().toLowerCase());
          c = { kind, file: f, to: low(to), cc: low(cc), bcc: low(bcc) };
        }
      }
      break;
    }
    case 'attachments': {
      const f = withExt(file(), MAIL_EXTS, `${at}.file`, 'reading attachments', e);
      const v = body['files'];
      const files: { name: string; sha256: string }[] = [];
      if (!Array.isArray(v)) e.add(`${at}.files`, 'must be a list of {name, sha256} (an empty list means no attachment)');
      else
        v.forEach((x: unknown, i) => {
          const w = `${at}.files.${i}`;
          if (!isMap(x)) return e.add(w, 'must be a mapping with name and sha256');
          for (const k of Object.keys(x)) if (k !== 'name' && k !== 'sha256') e.add(w, `unknown key ${JSON.stringify(k)}; allowed: name, sha256`);
          const n = str(x['name'], `${w}.name`, e);
          const h = x['sha256'];
          if (typeof h !== 'string' || !HEX64.test(h)) e.add(`${w}.sha256`, 'must be 64 lower-case hex characters');
          else if (n !== null) files.push({ name: n, sha256: h });
        });
      if (f !== null && Array.isArray(v) && files.length === v.length) c = { kind, file: f, files };
      break;
    }
    case 'rows': {
      const input = withExt(file('input'), CSV_EXTS, `${at}.input`, 'counting rows', e);
      const kept = withExt(file('kept'), CSV_EXTS, `${at}.kept`, 'counting rows', e);
      const dropped = body['dropped'] === undefined ? null : withExt(file('dropped'), CSV_EXTS, `${at}.dropped`, 'counting rows', e);
      const reason = body['reason_column'] === undefined ? 'reason' : str(body['reason_column'], `${at}.reason_column`, e);
      const filters = body['filters'] === undefined ? [] : strList(body['filters'], `${at}.filters`, e, { nonEmpty: false });
      const key = body['key'] === undefined ? null : str(body['key'], `${at}.key`, e);
      if (body['dropped'] !== undefined && filters !== null && filters.length === 0) e.add(`${at}.filters`, 'must name the reason of each filter that drops rows');
      if (body['dropped'] === undefined && filters !== null && filters.length > 0) e.add(`${at}.dropped`, 'is needed when filters are named: the file of dropped rows with their reason');
      if (input !== null && kept !== null && reason !== null && filters !== null && (body['dropped'] === undefined || dropped !== null) && (body['key'] === undefined || key !== null)) c = { kind, input, kept, dropped, reason_column: reason, filters, key };
      break;
    }
    case 'unique':
    case 'not_null': {
      const f = withExt(file(), CSV_EXTS, `${at}.file`, 'reading columns', e);
      const columns = strList(body['columns'], `${at}.columns`, e, { nonEmpty: true });
      if (f !== null && columns !== null) c = { kind, file: f, columns };
      break;
    }
    case 'accepted_values': {
      const f = withExt(file(), CSV_EXTS, `${at}.file`, 'reading columns', e);
      const column = str(body['column'], `${at}.column`, e);
      const values = strList(body['values'], `${at}.values`, e, { nonEmpty: true, scalars: true });
      if (f !== null && column !== null && values !== null) c = { kind, file: f, column, values };
      break;
    }
    case 'relationships': {
      const f = withExt(file(), CSV_EXTS, `${at}.file`, 'reading columns', e);
      const column = str(body['column'], `${at}.column`, e);
      const to = columnRef(body['to'], `${at}.to`, e);
      if (f !== null && column !== null && to !== null) c = { kind, file: f, column, to };
      break;
    }
    case 'freshness': {
      const f = withExt(file(), CSV_EXTS, `${at}.file`, 'reading columns', e);
      const column = str(body['column'], `${at}.column`, e);
      const m = body['max_age_days'];
      let max: number | null = null;
      if (typeof m === 'number' && Number.isFinite(m) && m > 0 && m <= 36500) max = m;
      else e.add(`${at}.max_age_days`, 'must be a number of days above 0 and at most 36500');
      if (f !== null && column !== null && max !== null) c = { kind, file: f, column, max_age_days: max };
      break;
    }
    case 'total': {
      const f = withExt(file(), CSV_EXTS, `${at}.file`, 'reading columns', e);
      const column = str(body['column'], `${at}.column`, e);
      const hasEq = body['equals'] !== undefined;
      const hasSum = body['equals_sum'] !== undefined;
      if (hasEq === hasSum) e.add(at, 'needs exactly one of equals (a stated control total) and equals_sum (a column of a source file)');
      const equals = hasEq ? decimal(body['equals'], `${at}.equals`, e, {}) : null;
      const equals_sum = hasSum ? columnRef(body['equals_sum'], `${at}.equals_sum`, e) : null;
      const tolerance = body['tolerance'] === undefined ? '0' : decimal(body['tolerance'], `${at}.tolerance`, e, { min: 0 });
      if (f !== null && column !== null && tolerance !== null && hasEq !== hasSum && (hasEq ? equals !== null : equals_sum !== null)) c = { kind, file: f, column, equals, equals_sum, tolerance };
      break;
    }
    case 'before_after': {
      const f = withExt(file(), OFFICE_EXTS, `${at}.file`, 'comparing with a baseline', e);
      const before = body['before'] === undefined ? f : withExt(file('before'), OFFICE_EXTS, `${at}.before`, 'comparing with a baseline', e);
      const inputs = body['inputs'] === undefined ? [] : strList(body['inputs'], `${at}.inputs`, e, { nonEmpty: true });
      const redline = bool(body['redline'], `${at}.redline`, e, false);
      if (f !== null && before !== null && extOf(f) !== extOf(before)) e.add(`${at}.before`, `must be the same kind of file as ${f} (a .${extOf(f)})`);
      if (f !== null && extOf(f) !== 'xlsx' && body['inputs'] !== undefined) e.add(`${at}.inputs`, 'input ranges are for workbooks (.xlsx)');
      if (f !== null && extOf(f) !== 'docx' && body['redline'] !== undefined) e.add(`${at}.redline`, 'redline is for Word documents (.docx)');
      if (inputs !== null) for (const [i, r] of inputs.entries()) if (!INPUT_RANGE.test(r) || /^[A-Za-z]{1,3}\d{1,7}$/.test(r)) e.add(`${at}.inputs.${i}`, `${JSON.stringify(r)} is not a range with its sheet (Inputs!B2:B9) or a defined name`);
      if (f !== null && before !== null && inputs !== null) c = { kind, file: f, before, inputs, redline };
      break;
    }
    case 'tests': {
      const b = file('before');
      const a = file('after');
      const ids = strList(body['ids'], `${at}.ids`, e, { nonEmpty: true });
      let format: ReportFormat | null = null;
      if (body['format'] !== undefined) {
        const fm = body['format'];
        if (typeof fm === 'string' && isReportFormat(fm)) format = fm;
        else e.add(`${at}.format`, `must be one of ${listed(REPORT_FORMATS)}`);
      }
      const br = body['before_root'] === undefined ? null : str(body['before_root'], `${at}.before_root`, e);
      const ar = body['after_root'] === undefined ? null : str(body['after_root'], `${at}.after_root`, e);
      if (b !== null && a !== null && ids !== null) c = { kind, before: b, after: a, ids, format, before_root: br, after_root: ar };
      break;
    }
  }
  return e.list.length === before ? c : null;
}

/** What makes two conditions the same condition, so an edit can be compared condition by condition. */
export function conditionKey(c: Condition): string {
  switch (c.kind) {
    case 'rows':
      return `rows ${c.input} -> ${c.kept}`;
    case 'unique':
      return `unique ${c.file} [${[...c.columns].sort().join(', ')}]`;
    case 'accepted_values':
    case 'relationships':
    case 'freshness':
    case 'total':
      return `${c.kind} ${c.file} ${c.column}`;
    case 'tests':
      return `tests ${c.before} -> ${c.after}`;
    default:
      return `${c.kind} ${c.file}`;
  }
}

function parseYamlText(text: string): { ok: true; raw: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, raw: parseYaml(text, { strict: true, uniqueKeys: true, maxAliasCount: 0 }) as unknown };
  } catch (err: unknown) {
    return { ok: false, error: `YAML parse error: ${err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err)}` };
  }
}

function conditionList(v: unknown, e: Errors, where: string): Condition[] {
  if (!Array.isArray(v)) {
    e.add(where, `must be a list of conditions; conditions: ${listed(CONDITION_KINDS)}`);
    return [];
  }
  if (v.length > MAX_LIST) {
    e.add(where, `may hold at most ${MAX_LIST} conditions`);
    return [];
  }
  const out: Condition[] = [];
  v.forEach((x: unknown, i) => {
    const c = parseCondition(x, `${where}.${i}`, e);
    if (c !== null) out.push(c);
  });
  return out;
}

/** A template: a user-level list of conditions every order naming it carries (ADR 0010: never from a project file). */
export function parseTemplate(text: string): Parsed<Condition[]> {
  const y = parseYamlText(text);
  if (!y.ok) return { ok: false, errors: [y.error] };
  const e = new Errors();
  if (!isMap(y.raw)) return { ok: false, errors: [`a template must be a mapping; keys: ${listed(TEMPLATE_KEYS)}`] };
  for (const k of Object.keys(y.raw)) if (!(TEMPLATE_KEYS as readonly string[]).includes(k)) e.add('template', `unknown key ${JSON.stringify(k)}; allowed: ${listed(TEMPLATE_KEYS)}`);
  if (y.raw['version'] !== ORDER_VERSION) e.add('version', `must be ${ORDER_VERSION}`);
  const conds = conditionList(y.raw['conditions'], e, 'conditions');
  const keys = new Set<string>();
  conds.forEach((c, i) => {
    const k = conditionKey(c);
    if (keys.has(k)) e.add(`conditions.${i}`, `repeats the condition ${k}`);
    keys.add(k);
  });
  return e.list.length > 0 ? { ok: false, errors: e.list } : { ok: true, value: conds };
}

/**
 * Validates an order file's text. `template` is the template's conditions when the order names one (the caller reads the
 * user-level file); an order adds conditions to its template and cannot repeat or change one of them.
 */
export function parseOrder(text: string, template: (name: string) => Parsed<Condition[]>): Parsed<Order> {
  const y = parseYamlText(text);
  if (!y.ok) return { ok: false, errors: [y.error] };
  if (!isMap(y.raw)) return { ok: false, errors: [`an order must be a mapping; keys: ${listed(ORDER_KEYS)}`] };
  const o = y.raw;
  const e = new Errors();
  for (const k of Object.keys(o)) if (!(ORDER_KEYS as readonly string[]).includes(k)) e.add('order', `unknown key ${JSON.stringify(k)}; allowed: ${listed(ORDER_KEYS)}`);
  if (o['version'] !== ORDER_VERSION) e.add('version', `must be ${ORDER_VERSION}`);
  const kindRaw = o['kind'];
  const kind = typeof kindRaw === 'string' && (ORDER_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as OrderKind) : null;
  if (kind === null) e.add('kind', `must be one of ${listed(ORDER_KINDS)}`);
  const title = o['title'] === undefined ? null : str(o['title'], 'title', e);
  let templateName: string | null = null;
  if (o['template'] !== undefined) {
    const t = o['template'];
    if (typeof t === 'string' && TEMPLATE_NAME.test(t)) templateName = t;
    else e.add('template', 'must be a template name: lower-case letters, digits, - and _, at most 64');
  }
  const inputs: OrderInput[] = [];
  if (o['inputs'] !== undefined) {
    if (!Array.isArray(o['inputs'])) e.add('inputs', 'must be a list of {path, sha256}');
    else
      o['inputs'].forEach((x: unknown, i) => {
        const w = `inputs.${i}`;
        if (!isMap(x)) return e.add(w, 'must be a mapping with path and sha256');
        for (const k of Object.keys(x)) if (k !== 'path' && k !== 'sha256') e.add(w, `unknown key ${JSON.stringify(k)}; allowed: path, sha256`);
        const p = str(x['path'], `${w}.path`, e, { path: true });
        const h = x['sha256'];
        if (typeof h !== 'string' || !HEX64.test(h)) e.add(`${w}.sha256`, 'must be 64 lower-case hex characters (openmorals order new --input FILE prints it)');
        else if (p !== null) {
          if (inputs.some((q) => q.path === p)) e.add(`${w}.path`, `names ${p} twice`);
          else inputs.push({ path: p, sha256: h });
        }
      });
  }
  const outputs = o['outputs'] === undefined ? [] : (strList(o['outputs'], 'outputs', e, { nonEmpty: false }) ?? []);
  const own = o['conditions'] === undefined ? [] : conditionList(o['conditions'], e, 'conditions');
  let fromTemplate: Condition[] = [];
  if (templateName !== null) {
    const t = template(templateName);
    if (!t.ok) for (const m of t.errors) e.add(`template ${templateName}`, m);
    else fromTemplate = t.value;
  }
  const keys = new Map<string, string>();
  for (const c of fromTemplate) keys.set(conditionKey(c), 'template');
  own.forEach((c, i) => {
    const k = conditionKey(c);
    const had = keys.get(k);
    if (had === 'template') e.add(`conditions.${i}`, `the template already holds the condition ${k}; an order adds conditions to its template and cannot change one`);
    else if (had !== undefined) e.add(`conditions.${i}`, `repeats the condition ${k}`);
    keys.set(k, 'order');
  });
  if (e.list.length === 0 && fromTemplate.length + own.length === 0) e.add('conditions', 'an order with no condition checks nothing; name at least one');
  if (e.list.length > 0 || kind === null) return { ok: false, errors: e.list };
  return {
    ok: true,
    value: {
      version: 1,
      kind,
      title,
      template: templateName,
      inputs,
      outputs,
      conditions: [...fromTemplate.map((c): Placed => ({ condition: c, from: 'template' })), ...own.map((c): Placed => ({ condition: c, from: 'order' }))],
    },
  };
}

/** One line naming a condition and what it asks for. */
export function describeCondition(c: Condition): string {
  switch (c.kind) {
    case 'exists':
      return `exists ${c.file}${c.type !== null ? ` (a ${c.type} file)` : ''}`;
    case 'headings':
      return `headings ${c.file}: ${c.include.map((h) => JSON.stringify(h)).join(', ')}${c.in_order ? ', in this order' : ''}`;
    case 'no_placeholders':
      return `no_placeholders ${c.file}${c.also.length > 0 ? ` (also ${c.also.map((h) => JSON.stringify(h)).join(', ')})` : ''}`;
    case 'recipients':
      return `recipients ${c.file}: to ${c.to.join(', ') || '-'}; cc ${c.cc.join(', ') || '-'}; bcc ${c.bcc.join(', ') || '-'}`;
    case 'attachments':
      return `attachments ${c.file}: ${c.files.length === 0 ? 'none' : c.files.map((f) => `${f.name} (${f.sha256.slice(0, 12)})`).join(', ')}`;
    case 'rows':
      return `rows ${c.input} = ${c.kept} + ${c.dropped ?? '(nothing dropped)'}${c.filters.length > 0 ? `, reasons ${c.filters.map((f) => JSON.stringify(f)).join(', ')}` : ''}${c.key !== null ? `, by key ${c.key}` : ''}`;
    case 'unique':
      return `unique ${c.file}: ${c.columns.join(' + ')}`;
    case 'not_null':
      return `not_null ${c.file}: ${c.columns.join(', ')}`;
    case 'accepted_values':
      return `accepted_values ${c.file} ${c.column}: ${c.values.map((v) => JSON.stringify(v)).join(', ')}`;
    case 'relationships':
      return `relationships ${c.file} ${c.column} -> ${c.to.file} ${c.to.column}`;
    case 'freshness':
      return `freshness ${c.file} ${c.column}: newest within ${c.max_age_days} days`;
    case 'total':
      return `total ${c.file} ${c.column} = ${c.equals !== null ? c.equals : `sum of ${c.equals_sum?.file ?? ''} ${c.equals_sum?.column ?? ''}`} within ${c.tolerance}`;
    case 'tests':
      return `tests ${c.before} -> ${c.after}: ${c.ids.map((i) => JSON.stringify(i)).join(', ')} failed before and pass after`;
    case 'before_after':
      return `before_after ${c.file} against the baseline of ${c.before}${c.inputs.length > 0 ? `, inputs ${c.inputs.join(', ')} unchanged` : ''}${c.redline ? ', every change tracked (redline)' : ''}`;
  }
}

// ---------------------------------------------------------------------------------------------------------------- edits

export type EditKind = 'loosening' | 'tightening' | 'change';

export interface Edit {
  kind: EditKind;
  what: string;
}

type Way = 'same' | 'tighter' | 'looser' | 'change';

function setWay(old: readonly string[], cur: readonly string[], biggerIs: 'tighter' | 'looser'): Way {
  const o = new Set(old);
  const n = new Set(cur);
  const added = [...n].some((x) => !o.has(x));
  const removed = [...o].some((x) => !n.has(x));
  if (!added && !removed) return 'same';
  if (added && removed) return 'change';
  const grew = added;
  return grew === (biggerIs === 'tighter') ? 'tighter' : 'looser';
}

function numWay(old: number, cur: number, smallerIs: 'tighter'): Way {
  if (old === cur) return 'same';
  return (cur < old) === (smallerIs === 'tighter') ? 'tighter' : 'looser';
}

function eqWay(a: unknown, b: unknown): Way {
  return JSON.stringify(a) === JSON.stringify(b) ? 'same' : 'change';
}

function boolWay(old: boolean, cur: boolean): Way {
  return old === cur ? 'same' : cur ? 'tighter' : 'looser';
}

/** Aspects of one condition compared field by field: which got stricter, which looser, which changed. */
function aspects(o: Condition, n: Condition): [string, Way][] {
  if (o.kind !== n.kind) return [['kind', 'change']];
  switch (o.kind) {
    case 'exists': {
      const m = n as typeof o;
      return [['type', o.type === m.type ? 'same' : o.type === null ? 'tighter' : m.type === null ? 'looser' : 'change']];
    }
    case 'headings': {
      const m = n as typeof o;
      return [['include', setWay(o.include, m.include, 'tighter')], ['in_order', boolWay(o.in_order, m.in_order)]];
    }
    case 'no_placeholders': {
      const m = n as typeof o;
      return [['also', setWay(o.also, m.also, 'tighter')]];
    }
    case 'recipients': {
      const m = n as typeof o;
      return [['to', eqWay([...o.to].sort(), [...m.to].sort())], ['cc', eqWay([...o.cc].sort(), [...m.cc].sort())], ['bcc', eqWay([...o.bcc].sort(), [...m.bcc].sort())]];
    }
    case 'attachments': {
      const m = n as typeof o;
      return [['files', eqWay(o.files.map((f) => `${f.name}\0${f.sha256}`).sort(), m.files.map((f) => `${f.name}\0${f.sha256}`).sort())]];
    }
    case 'rows': {
      const m = n as typeof o;
      return [
        ['dropped', eqWay(o.dropped, m.dropped)],
        ['reason_column', eqWay(o.reason_column, m.reason_column)],
        ['filters', setWay(o.filters, m.filters, 'looser')],
        ['key', o.key === m.key ? 'same' : o.key === null ? 'tighter' : m.key === null ? 'looser' : 'change'],
      ];
    }
    case 'unique':
      return [];
    case 'not_null': {
      const m = n as typeof o;
      return [['columns', setWay(o.columns, m.columns, 'tighter')]];
    }
    case 'accepted_values': {
      const m = n as typeof o;
      return [['values', setWay(o.values, m.values, 'looser')]];
    }
    case 'relationships': {
      const m = n as typeof o;
      return [['to', eqWay(o.to, m.to)]];
    }
    case 'freshness': {
      const m = n as typeof o;
      return [['max_age_days', numWay(o.max_age_days, m.max_age_days, 'tighter')]];
    }
    case 'total': {
      const m = n as typeof o;
      return [['equals', eqWay([o.equals, o.equals_sum], [m.equals, m.equals_sum])], ['tolerance', numWay(Number(o.tolerance), Number(m.tolerance), 'tighter')]];
    }
    case 'tests': {
      const m = n as typeof o;
      return [['ids', setWay(o.ids, m.ids, 'tighter')], ['format', eqWay(o.format, m.format)], ['roots', eqWay([o.before_root, o.after_root], [m.before_root, m.after_root])]];
    }
    case 'before_after': {
      const m = n as typeof o;
      return [['before', eqWay(o.before, m.before)], ['inputs', setWay(o.inputs, m.inputs, 'tighter')], ['redline', boolWay(o.redline, m.redline)]];
    }
  }
}

function fieldValue(c: Condition, field: string): string {
  const o = c as unknown as Record<string, unknown>;
  const v = field === 'roots' ? [o['before_root'], o['after_root']] : field === 'equals' ? (o['equals'] ?? o['equals_sum']) : o[field];
  const s = v === undefined || v === null ? 'none' : JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

/**
 * The edits from the approved order to the current one, condition by condition. A condition removed, an input or output
 * dropped, or a setting made looser is a loosening; one added or made stricter is a tightening; a change openmorals
 * cannot show to be stricter (another file, other recipients, another control total) is a change, and is read as a
 * loosening until you approve it again.
 */
export function compareOrders(approved: Order, current: Order): Edit[] {
  const out: Edit[] = [];
  const keyed = (o: Order): Map<string, Placed> => new Map(o.conditions.map((p) => [conditionKey(p.condition), p]));
  const a = keyed(approved);
  const c = keyed(current);
  for (const [k, p] of a) {
    const q = c.get(k);
    if (q === undefined) {
      out.push({ kind: 'loosening', what: `condition removed: ${describeCondition(p.condition)}${p.from === 'template' ? ' (it came from the template)' : ''}` });
      continue;
    }
    for (const [field, way] of aspects(p.condition, q.condition)) {
      if (way === 'same') continue;
      const kind: EditKind = way === 'tighter' ? 'tightening' : way === 'looser' ? 'loosening' : 'change';
      out.push({ kind, what: `${k}: ${field} ${way === 'change' ? 'changed' : `made ${way}`} (${fieldValue(p.condition, field)} -> ${fieldValue(q.condition, field)})` });
    }
  }
  for (const [k, q] of c) if (!a.has(k)) out.push({ kind: 'tightening', what: `condition added: ${describeCondition(q.condition)}${q.from === 'template' ? ' (from the template)' : ''}` });
  const ins = new Map(approved.inputs.map((i) => [i.path, i.sha256]));
  const curIns = new Map(current.inputs.map((i) => [i.path, i.sha256]));
  for (const [p, h] of ins) {
    const now = curIns.get(p);
    if (now === undefined) out.push({ kind: 'loosening', what: `input no longer checked: ${p}` });
    else if (now !== h) out.push({ kind: 'change', what: `input ${p}: its sha256 in the order changed (${h.slice(0, 12)} -> ${now.slice(0, 12)})` });
  }
  for (const p of curIns.keys()) if (!ins.has(p)) out.push({ kind: 'tightening', what: `input added: ${p}` });
  for (const p of approved.outputs) if (!current.outputs.includes(p)) out.push({ kind: 'loosening', what: `output no longer required: ${p}` });
  for (const p of current.outputs) if (!approved.outputs.includes(p)) out.push({ kind: 'tightening', what: `output added: ${p}` });
  if (approved.kind !== current.kind) out.push({ kind: 'change', what: `kind ${approved.kind} -> ${current.kind}` });
  if (approved.template !== current.template) out.push({ kind: 'change', what: `template ${approved.template ?? '(none)'} -> ${current.template ?? '(none)'}` });
  if (approved.title !== current.title) out.push({ kind: 'change', what: 'title changed' });
  return out;
}

/** The role of a file an order names (0.28.0, the release hold): an input (an original, with its hash), an output, or a file a condition reads. */
export type ItemRole = 'input' | 'output' | 'condition';

export interface OrderItem {
  /** As the order writes it (relative to the order's folder, or absolute). */
  path: string;
  role: ItemRole;
}

/** The files a condition names: its own file, a rows condition's three files, a tests condition's two reports, a column reference's file. */
export function conditionFiles(c: Condition): string[] {
  switch (c.kind) {
    case 'rows':
      return [c.input, c.kept, ...(c.dropped !== null ? [c.dropped] : [])];
    case 'relationships':
      return [c.file, c.to.file];
    case 'total':
      return [c.file, ...(c.equals_sum !== null ? [c.equals_sum.file] : [])];
    case 'tests':
      return [c.before, c.after];
    case 'before_after':
      return c.before === c.file ? [c.file] : [c.file, c.before];
    default:
      return [c.file];
  }
}

/**
 * Every file an order names, once each (0.28.0): its inputs, its outputs, then the files its conditions read. A file
 * named in two places keeps the first role (input before output before condition).
 */
export function orderItems(order: Order): OrderItem[] {
  const out: OrderItem[] = [];
  const add = (path: string, role: ItemRole): void => {
    if (!out.some((x) => x.path === path)) out.push({ path, role });
  };
  for (const i of order.inputs) add(i.path, 'input');
  for (const o of order.outputs) add(o, 'output');
  for (const p of order.conditions) for (const f of conditionFiles(p.condition)) add(f, 'condition');
  return out;
}
