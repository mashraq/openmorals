import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LineCounter, parse as parseYaml, parseDocument, isMap, isSeq } from 'yaml';
import { toActions } from '../adapters/claude-code.js';
import { createHash } from 'node:crypto';
import type { FileProbe, HashProbe, Where } from '../guard.js';
import { makeWhere } from '../guard.js';
import type { DiffClassCase, DiffClassFile } from '../diffclass/rows.js';
import { DIFF_CLASS_TABLE, toDiffClassCase } from '../diffclass/rows.js';
import { readPackText } from '../packs/load.js';
import type { OutboundSketch } from '../outbound/memory.js';
import { sketchMemory } from '../outbound/memory.js';
import { overFloor, validateBylaws } from '../bylaws.js';
import type { Action, BylawsLoad, Decision, SessionState, ShellKind } from '../types.js';
import { isDecision } from '../types.js';

/** The keys a row of a `*.cases.yaml` file may carry; any other key makes the file unreadable. */
export const CASE_KEYS: readonly string[] = ['cmd', 'shell', 'tool', 'input', 'expect', 'rule', 'rule_any', 'bylaws', 'pack', 'state', 'note', 'config_dir', 'cwd', 'also', 'files', 'outbound', 'project'];
const INBOUND_KEYS: readonly string[] = ['name', 'origin', 'expect', 'rule', 'text', 'note'];

/** Case rows are judged in a fixed, made-up place, never the machine's own home or config directory; links are not resolved and every path is taken to exist. */
export const CASE_HOME = '/home/u';
export const CASE_CONFIG_DIR = '/home/u/.config/openmorals';
export const CASE_CWD = '/work/app';

/**
 * The files a row says are on disk (0.18.0, for the document guard), by path (relative to the row's working folder, or
 * absolute, or under `~`): a string is the file's text; a mapping gives `text` repeated `repeat` times, or `bytes` of
 * filler, or `error` (the file cannot be read) or `folder: true`. Every other path is missing: a row never reads the
 * machine's own disk.
 */
export function caseFiles(raw: unknown, cwd: string, home: string): { ok: true; value: (p: string, maxText: number) => FileProbe } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: () => ({ kind: 'missing' }) };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'files must be a mapping of path to text' };
  const table = new Map<string, FileProbe & { full?: string }>();
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const abs = path.resolve(cwd, k.startsWith('~/') ? `${home}${k.slice(1)}` : k);
    if (typeof v === 'string') {
      table.set(abs, { kind: 'file', bytes: Buffer.byteLength(v, 'utf8'), full: v });
      continue;
    }
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, error: `files.${k} must be a string or a mapping` };
    const o = v as Record<string, unknown>;
    for (const key of Object.keys(o)) if (!['text', 'repeat', 'bytes', 'error', 'folder', 'volume'].includes(key)) return { ok: false, error: `files.${k} has unknown key ${key}` };
    if (o['volume'] !== undefined && !(typeof o['volume'] === 'number' && Number.isInteger(o['volume']) && o['volume'] >= 0)) return { ok: false, error: `files.${k}.volume must be a whole number` };
    if (typeof o['error'] === 'string') table.set(abs, { kind: 'error', error: o['error'] });
    else if (o['folder'] === true) table.set(abs, { kind: 'other' });
    else if (typeof o['text'] === 'string') {
      const times = typeof o['repeat'] === 'number' && Number.isInteger(o['repeat']) && o['repeat'] > 0 ? o['repeat'] : 1;
      const full = o['text'].repeat(times);
      table.set(abs, { kind: 'file', bytes: Buffer.byteLength(full, 'utf8'), full });
    } else if (typeof o['bytes'] === 'number' && Number.isInteger(o['bytes']) && o['bytes'] >= 0) table.set(abs, { kind: 'file', bytes: o['bytes'] });
    else return { ok: false, error: `files.${k} needs text, bytes, error or folder` };
  }
  return {
    ok: true,
    value: (p: string, maxText: number): FileProbe => {
      const f = table.get(path.resolve(p));
      if (f === undefined) return { kind: 'missing' };
      if (f.kind !== 'file') return f;
      if (maxText <= 0 || f.bytes > maxText) return { kind: 'file', bytes: f.bytes };
      return { kind: 'file', bytes: f.bytes, text: f.full ?? 'x'.repeat(f.bytes) };
    },
  };
}

/** The sha256 a row's fake disk gives a file (0.24.0, the replace guard): of its text as UTF-8 bytes, or `large` over the limit. */
export function caseHash(readFile: (p: string, maxText: number) => FileProbe): (p: string, maxBytes: number) => HashProbe {
  return (p: string, maxBytes: number): HashProbe => {
    const st = readFile(p, 0);
    if (st.kind !== 'file') return st;
    if (st.bytes > maxBytes) return { kind: 'large', bytes: st.bytes };
    const full = readFile(p, st.bytes);
    const text = full.kind === 'file' ? (full.text ?? '') : '';
    return { kind: 'hash', bytes: st.bytes, sha256: createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex') };
  };
}

/**
 * The volume of each path a row's `files` names with a `volume` number (0.21.0, for the delete guard: a mapping such as
 * `{ bytes: 10, volume: 2 }`, or `.: { folder: true, volume: 1 }` for the project folder). Every other path: unknown.
 */
export function caseVolumes(raw: unknown, cwd: string, home: string): (p: string) => number | null {
  const table = new Map<string, number>();
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) continue;
      const vol = (v as Record<string, unknown>)['volume'];
      if (typeof vol === 'number') table.set(path.resolve(cwd, k.startsWith('~/') ? `${home}${k.slice(1)}` : k), vol);
    }
  }
  return (p: string): number | null => table.get(path.resolve(p)) ?? null;
}

/** The time a row with an `outbound` session is judged at, so a code's age in minutes is fixed. */
export const CASE_NOW = new Date('2026-01-15T12:00:00.000Z');

const SKETCH_KEYS = ['page', 'via', 'source', 'typed', 'seen', 'mentioned', 'headers', 'deceptive', 'cred_refs', 'codes', 'approved'];

/**
 * What a row says this session has already seen (0.20.0, for the outbound guard), in plain words: the page a browser is
 * on and how it was reached (`via`: typed, untrusted, other), hosts and addresses typed or seen, codes from messages with
 * the sites they named and their age, approved keys. Absent: the row is judged with no session, from the action alone.
 */
export function caseOutbound(raw: unknown): { ok: true; value: OutboundSketch | null } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'outbound must be a mapping' };
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!SKETCH_KEYS.includes(k)) return { ok: false, error: `outbound has unknown key ${k}` };
  if (o['via'] !== undefined && o['via'] !== 'typed' && o['via'] !== 'untrusted' && o['via'] !== 'other') return { ok: false, error: 'outbound.via must be typed, untrusted or other' };
  for (const k of ['typed', 'mentioned', 'headers', 'deceptive', 'cred_refs', 'approved']) {
    const v = o[k];
    if (v !== undefined && (!Array.isArray(v) || !v.every((x) => typeof x === 'string'))) return { ok: false, error: `outbound.${k} must be a list of strings` };
  }
  return { ok: true, value: o as OutboundSketch };
}

/**
 * The policy a row is judged under: its `bylaws` read as the user-level file (`base` when it has none), then (0.23.0) its
 * `project` block read over that as a project file and merged by `overFloor`, the code `resolveBylaws` uses for a folder.
 */
export function caseBylaws(c: { bylaws: unknown; project: unknown }, source: string, base?: BylawsLoad): BylawsLoad {
  const user = c.bylaws === null && base !== undefined ? base : validateBylaws(c.bylaws, source);
  if (c.project === null || !user.ok) return user;
  return overFloor(validateBylaws(c.project, `${source} (project)`, user.bylaws, true), user.bylaws, user.source);
}

/** Largest case file read, so a mistaken `--cases` folder cannot make the scorer read a huge file. */
export const MAX_CASE_FILE_BYTES = 4 * 1024 * 1024;

export interface Case {
  /** The call's first action (the one a built-in tool maps to, or `other` for a tool without its own mapping). */
  action: Action;
  /** Every action the Claude Code adapter judges the call as (`action` first; MCP arguments lifted since 0.8.1). */
  actions: Action[];
  /** The tool the row names (`Bash` or `PowerShell` for a `cmd` row). */
  tool: string;
  expect: Decision;
  rule: string | null;
  ruleAny: boolean;
  /** The row's own bylaws (its `bylaws`, or the text of the shipped pack its `pack` names), or null to use the bylaws the scorer was given (the defaults unless told otherwise). */
  bylaws: unknown;
  /** The row's project file (0.23.0), read over its `bylaws` the way a project file is read over the user-level file; null when it has none. */
  project: unknown;
  state: SessionState;
  where: Where;
  /** Other guards that rightly catch the row too (removing the file's own guard leaves it caught by these). */
  also: string[];
  label: string;
  /** 1-based line of the row in its file, or null when unknown. */
  line: number | null;
}

export interface CaseFile {
  guard: string;
  file: string;
  cases: Case[];
}

export type InboundExpect = 'strong' | 'weak' | 'none';

export interface InboundCase {
  name: string;
  origin: 'tool-result' | 'prompt';
  expect: InboundExpect;
  rule: string | null;
  text: string;
  line: number | null;
}

export interface InboundFile {
  file: string;
  cases: InboundCase[];
}

export interface EvalCases {
  /** Where the rows came from: a folder, or `(built in)` inside the single executable. */
  source: string;
  guardFiles: CaseFile[];
  inbound: InboundFile[];
  /** Merge-verdict rows (`classifier: diff-class`), scored apart from the guards. */
  diffClass: DiffClassFile[];
}

export type CasesResult = { ok: true; value: EvalCases } | { ok: false; error: string };

/** A folder of case files, or the files built into a single executable. */
export interface CaseSource {
  name: string;
  list(): string[] | null;
  read(file: string): string | null;
}

type Row<T> = { ok: true; value: T } | { ok: false; error: string };

function rowError(file: string, idx: number, msg: string): { ok: false; error: string } {
  return { ok: false, error: `${file}[${idx}] ${msg}` };
}

function toCase(raw: unknown, idx: number, file: string, line: number | null): Row<Case> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return rowError(file, idx, 'is not a mapping');
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!CASE_KEYS.includes(k)) return rowError(file, idx, `has unknown key ${k}`);
  const expect = o['expect'];
  if (!isDecision(expect)) return rowError(file, idx, 'expect must be allow/ask/deny');
  let actions: Action[];
  if (typeof o['cmd'] === 'string') {
    const shell = (o['shell'] ?? 'posix') as ShellKind;
    if (shell !== 'posix' && shell !== 'powershell' && shell !== 'cmd') return rowError(file, idx, 'bad shell');
    actions = [{ kind: 'exec', command: o['cmd'], shell, tool: shell === 'powershell' ? 'PowerShell' : 'Bash' }];
  } else {
    if (o['cmd'] !== undefined) return rowError(file, idx, 'cmd must be a string');
    if (typeof o['tool'] !== 'string') return rowError(file, idx, 'needs cmd or tool');
    const input = o['input'];
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return rowError(file, idx, 'tool case needs input');
    actions = toActions(o['tool'], input as Record<string, unknown>);
  }
  const action = actions[0];
  if (action === undefined) return rowError(file, idx, 'maps to no action');
  const stRaw = o['state'] ?? {};
  if (typeof stRaw !== 'object' || stRaw === null || Array.isArray(stRaw)) return rowError(file, idx, 'state must be a mapping');
  const st = stRaw as Record<string, unknown>;
  const num = (k: string): number => (typeof st[k] === 'number' ? (st[k] as number) : 0);
  const state: SessionState = { toolCalls: num('toolCalls') || 1, tokens: num('tokens'), prevTokens: num('prevTokens') };
  for (const k of ['rule', 'config_dir', 'cwd', 'note']) {
    if (o[k] !== undefined && typeof o[k] !== 'string') return rowError(file, idx, `${k} must be a string`);
  }
  if (o['rule_any'] !== undefined && typeof o['rule_any'] !== 'boolean') return rowError(file, idx, 'rule_any must be true or false');
  const str = (k: string): string | undefined => (typeof o[k] === 'string' ? (o[k] as string) : undefined);
  const cwd = str('cwd') ?? CASE_CWD;
  const files = caseFiles(o['files'], cwd, CASE_HOME);
  if (!files.ok) return rowError(file, idx, files.error);
  const sketch = caseOutbound(o['outbound']);
  if (!sketch.ok) return rowError(file, idx, sketch.error);
  const where = makeWhere({ home: CASE_HOME, configDir: str('config_dir') ?? CASE_CONFIG_DIR, cwd, realpath: (p: string) => p, exists: () => true, readFile: files.value, hash: caseHash(files.value), volume: caseVolumes(o['files'], cwd, CASE_HOME), ...(sketch.value !== null ? { outbound: { memory: sketchMemory(sketch.value, CASE_NOW), now: CASE_NOW.getTime() } } : {}) }, {});
  const alsoRaw = o['also'] ?? [];
  if (!Array.isArray(alsoRaw) || !alsoRaw.every((x) => typeof x === 'string')) return rowError(file, idx, 'also must be a list of guard ids');
  let bylaws: unknown = o['bylaws'] ?? null;
  const packName = o['pack'];
  if (packName !== undefined) {
    if (typeof packName !== 'string') return rowError(file, idx, 'pack must be a string (the name of a shipped pack)');
    if (bylaws !== null) return rowError(file, idx, 'has both pack and bylaws; give one');
    const t = readPackText(packName);
    if (!t.ok) return rowError(file, idx, `pack ${packName}: ${t.error}`);
    try {
      bylaws = parseYaml(t.text, { strict: true, uniqueKeys: true, maxAliasCount: 50 }) as unknown;
    } catch (e: unknown) {
      return rowError(file, idx, `pack ${packName} is not valid YAML: ${e instanceof Error ? (e.message.split('\n')[0] ?? '') : String(e)}`);
    }
  }
  const label = typeof o['cmd'] === 'string' ? o['cmd'] : `${String(o['tool'])} ${JSON.stringify(o['input'])}`;
  return {
    ok: true,
    value: { action, actions, tool: action.tool, expect, rule: str('rule') ?? null, ruleAny: o['rule_any'] === true, bylaws, project: o['project'] ?? null, state, where, also: alsoRaw as string[], label, line },
  };
}

function toInboundCase(raw: unknown, idx: number, file: string, line: number | null): Row<InboundCase> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return rowError(file, idx, 'is not a mapping');
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!INBOUND_KEYS.includes(k)) return rowError(file, idx, `has unknown key ${k}`);
  const { name, origin, expect, rule, text } = o;
  if (typeof name !== 'string') return rowError(file, idx, 'needs a name');
  if (origin !== 'tool-result' && origin !== 'prompt') return rowError(file, idx, 'origin must be tool-result or prompt');
  if (expect !== 'strong' && expect !== 'weak' && expect !== 'none') return rowError(file, idx, 'expect must be strong/weak/none');
  if (rule !== undefined && typeof rule !== 'string') return rowError(file, idx, 'rule must be a string');
  if (typeof text !== 'string') return rowError(file, idx, 'needs text');
  return { ok: true, value: { name, origin, expect, rule: rule ?? null, text, line } };
}

/** Parses one file's text into its top-level mapping and the 1-based line of each row of its `cases` list. */
function parseFile(text: string, file: string): Row<{ doc: Record<string, unknown>; lines: (number | null)[] }> {
  const lc = new LineCounter();
  let parsed;
  try {
    parsed = parseDocument(text, { lineCounter: lc, prettyErrors: false });
  } catch (e: unknown) {
    return { ok: false, error: `${file}: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (parsed.errors.length > 0) return { ok: false, error: `${file}: ${parsed.errors[0]?.message ?? 'YAML error'}` };
  const contents = parsed.contents;
  if (!isMap(contents)) return { ok: false, error: `${file}: the file is not a mapping` };
  const doc = parsed.toJS() as Record<string, unknown>;
  const seq = contents.get('cases', true);
  const lines = isSeq(seq) ? seq.items.map((it) => (it !== null && typeof it === 'object' && 'range' in it && Array.isArray(it.range) ? lc.linePos(it.range[0] as number).line : null)) : [];
  return { ok: true, value: { doc, lines } };
}

/** Reads every `*.cases.yaml` and `*.table.yaml` file of a source. Any unreadable file or row fails the whole load. */
export function loadCasesFrom(src: CaseSource): CasesResult {
  const names = src.list();
  if (names === null) return { ok: false, error: `cannot read the case folder ${src.name}` };
  const caseNames = names.filter((f) => f.endsWith('.cases.yaml')).sort();
  const tableNames = names.filter((f) => f.endsWith('.table.yaml')).sort();
  if (caseNames.length === 0 && tableNames.length === 0) return { ok: false, error: `no *.cases.yaml or *.table.yaml files in ${src.name}` };
  const guardFiles: CaseFile[] = [];
  const inbound: InboundFile[] = [];
  const diffClass: DiffClassFile[] = [];
  for (const f of [...caseNames, ...tableNames]) {
    const text = src.read(f);
    if (text === null) return { ok: false, error: `cannot read ${f} in ${src.name}` };
    const p = parseFile(text, f);
    if (!p.ok) return p;
    const { doc, lines } = p.value;
    if (!Array.isArray(doc['cases'])) return { ok: false, error: `${f} needs cases (a list)` };
    const rows = doc['cases'] as unknown[];
    if (f.endsWith('.cases.yaml') && doc['classifier'] !== undefined) {
      if (doc['classifier'] !== DIFF_CLASS_TABLE || doc['guard'] !== undefined) return { ok: false, error: `${f}: classifier must be ${DIFF_CLASS_TABLE}, without guard` };
      const cases: DiffClassCase[] = [];
      for (let i = 0; i < rows.length; i++) {
        const r = toDiffClassCase(rows[i], i, f, lines[i] ?? null);
        if (!r.ok) return r;
        cases.push(r.value);
      }
      diffClass.push({ file: f, cases });
    } else if (f.endsWith('.cases.yaml')) {
      if (typeof doc['guard'] !== 'string' || doc['guard'] === '') return { ok: false, error: `${f} needs guard` };
      const cases: Case[] = [];
      for (let i = 0; i < rows.length; i++) {
        const r = toCase(rows[i], i, f, lines[i] ?? null);
        if (!r.ok) return r;
        cases.push(r.value);
      }
      guardFiles.push({ guard: doc['guard'], file: f, cases });
    } else {
      if (doc['table'] !== 'inbound') return { ok: false, error: `${f} needs table: inbound (the only table kind)` };
      const cases: InboundCase[] = [];
      for (let i = 0; i < rows.length; i++) {
        const r = toInboundCase(rows[i], i, f, lines[i] ?? null);
        if (!r.ok) return r;
        cases.push(r.value);
      }
      inbound.push({ file: f, cases });
    }
  }
  return { ok: true, value: { source: src.name, guardFiles, inbound, diffClass } };
}

/** A folder on disk; files larger than MAX_CASE_FILE_BYTES or not regular files read as unreadable. */
export function folderSource(dir: string): CaseSource {
  return {
    name: dir,
    list(): string[] | null {
      try {
        return fs.readdirSync(dir);
      } catch {
        return null;
      }
    },
    read(file: string): string | null {
      const full = path.join(dir, file);
      try {
        const st = fs.statSync(full);
        if (!st.isFile() || st.size > MAX_CASE_FILE_BYTES) return null;
        return fs.readFileSync(full, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

/** The case files built into a single executable as assets named `cases/<file>`, or null when not running as one. */
export function embeddedCaseSource(): CaseSource | null {
  let sea: typeof import('node:sea') | undefined;
  try {
    sea = process.getBuiltinModule?.('node:sea');
  } catch {
    return null;
  }
  if (sea === undefined || !sea.isSea()) return null;
  const api = sea;
  return {
    name: '(built in)/cases',
    list(): string[] | null {
      try {
        if (typeof api.getAssetKeys !== 'function') return null;
        return api.getAssetKeys().filter((k) => k.startsWith('cases/')).map((k) => k.slice('cases/'.length));
      } catch {
        return null;
      }
    },
    read(file: string): string | null {
      try {
        return api.getAsset(`cases/${file}`, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

/** The `cases` folder shipped next to the installed package (or the source checkout), or null when there is none. */
export function defaultCasesDir(): string | null {
  let dir: string;
  try {
    dir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'cases', 'destructive.cases.yaml'))) return path.join(dir, 'cases');
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** The given folder, else the cases built into the single executable, else the ones shipped with the package. */
export function loadCases(dir?: string): CasesResult {
  if (dir !== undefined) return loadCasesFrom(folderSource(dir));
  const embedded = embeddedCaseSource();
  if (embedded !== null) return loadCasesFrom(embedded);
  const d = defaultCasesDir();
  if (d === null) return { ok: false, error: 'the cases folder was not found next to the installed package; pass --cases <dir>' };
  return loadCasesFrom(folderSource(d));
}
