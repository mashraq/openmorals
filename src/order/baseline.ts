// The office baseline of a work order (0.30.0): a copy of each .xlsx and .docx file the order names, taken by the
// person at the order's start (`openmorals order baseline`), that `before_after` conditions compare against.
//
// Where it lives and what protects it: the config directory, as the approval store does. Copies are stored under their
// own SHA-256 (`orders/baselines/<sha256>`), so no name from the order or from inside a file ever becomes a path, and a
// copy changed after it was taken no longer matches its name and fails every check that reads it. The index
// `orders/baselines.jsonl` is append-only; each baseline is also a chained audit record (`order.baseline`). The
// self-protect guard asks when an agent runs `order baseline` (refused unattended) and asks on any write into the config
// directory. CLI only: no hook module imports this file.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { resolveLinks } from '../guard.js';
import { readsAs } from '../office/index.js';
import type { OfficeFormat } from '../office/index.js';
import { configDir } from '../paths.js';
import { MAX_FILE_BYTES, extOf, readBytes, sha256Hex } from './files.js';
import { orderItems } from './model.js';
import { ORDERS_DIR } from './store.js';
import type { LoadedOrder } from './store.js';

export const BASELINES_FILE = 'baselines.jsonl';
export const BASELINE_COPIES = 'baselines';
const HEX64 = /^[0-9a-f]{64}$/;

export interface BaselineFile {
  /** The file's real path when the baseline was taken. */
  path: string;
  format: OfficeFormat;
  /** SHA-256 of the copy, or null when the file was not there. */
  sha256: string | null;
  bytes: number;
}

export interface StoredBaseline {
  v: 1;
  ts: string;
  /** The order's real path. */
  order: string;
  /** The order's hash when the baseline was taken. */
  order_sha256: string;
  files: BaselineFile[];
}

export type BaselinesRead = { ok: true; list: StoredBaseline[]; file: string } | { ok: false; file: string; error: string };

export function baselinesFile(env: NodeJS.ProcessEnv): string {
  return join(configDir(env), ORDERS_DIR, BASELINES_FILE);
}

export function copyPath(env: NodeJS.ProcessEnv, sha256: string): string {
  return join(configDir(env), ORDERS_DIR, BASELINE_COPIES, sha256);
}

/** The .xlsx and .docx files an order names (inputs, outputs, files its conditions read), by real path. */
export function officeFiles(o: LoadedOrder): { path: string; real: string; format: OfficeFormat }[] {
  const out: { path: string; real: string; format: OfficeFormat }[] = [];
  for (const it of orderItems(o.order)) {
    const x = extOf(it.path);
    if (x !== 'xlsx' && x !== 'docx') continue;
    const real = resolveLinks(isAbsolute(it.path) ? it.path : resolve(o.dir, it.path));
    if (!out.some((f) => f.real === real)) out.push({ path: it.path, real, format: x });
  }
  return out;
}

function isFile(v: unknown): v is BaselineFile {
  const f = v as Partial<BaselineFile>;
  return typeof v === 'object' && v !== null && typeof f.path === 'string' && (f.format === 'xlsx' || f.format === 'docx') && (f.sha256 === null || (typeof f.sha256 === 'string' && HEX64.test(f.sha256))) && typeof f.bytes === 'number';
}

/** Every baseline, oldest first. A line that does not read makes the whole index unreadable: no baseline is assumed. */
export function readBaselines(env: NodeJS.ProcessEnv): BaselinesRead {
  const file = baselinesFile(env);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e: unknown) {
    if (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOENT') return { ok: true, list: [], file };
    return { ok: false, file, error: `cannot read ${file}: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (text.length > MAX_FILE_BYTES) return { ok: false, file, error: `${file} is larger than ${MAX_FILE_BYTES} bytes` };
  const list: StoredBaseline[] = [];
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
    const b = o as Partial<StoredBaseline>;
    if (typeof o !== 'object' || o === null || b.v !== 1 || typeof b.ts !== 'string' || typeof b.order !== 'string' || typeof b.order_sha256 !== 'string' || !HEX64.test(b.order_sha256) || !Array.isArray(b.files) || !b.files.every(isFile)) {
      return { ok: false, file, error: `${file} line ${i + 1} is not a baseline record` };
    }
    list.push({ v: 1, ts: b.ts, order: b.order, order_sha256: b.order_sha256, files: b.files });
  }
  return { ok: true, list, file };
}

export function latestBaseline(list: readonly StoredBaseline[], orderReal: string): StoredBaseline | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const b = list[i];
    if (b !== undefined && b.order === orderReal) return b;
  }
  return null;
}

export type Prepared = { ok: true; files: (BaselineFile & { data: Buffer | null })[] } | { ok: false; errors: string[] };

/** Reads each office file of the order now; a file that is there but does not read as its format refuses the baseline. */
export function prepareBaseline(o: LoadedOrder): Prepared {
  const files: (BaselineFile & { data: Buffer | null })[] = [];
  const errors: string[] = [];
  for (const f of officeFiles(o)) {
    const b = readBytes(f.real);
    if (!b.ok) {
      if (b.error === 'does not exist') files.push({ path: f.real, format: f.format, sha256: null, bytes: 0, data: null });
      else errors.push(`${f.path} ${b.error}`);
      continue;
    }
    const r = readsAs(f.format, b.value);
    if (!r.ok) {
      errors.push(`${f.path} does not read as a .${f.format} file: it ${r.error}`);
      continue;
    }
    files.push({ path: f.real, format: f.format, sha256: sha256Hex(b.value), bytes: b.value.length, data: b.value });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, files };
}

/** Stores the copies (each under its SHA-256, written once) and appends the index line. Returns the index file. */
export function storeBaseline(env: NodeJS.ProcessEnv, rec: StoredBaseline, data: ReadonlyMap<string, Buffer>): string {
  for (const [sha, buf] of data) {
    const p = copyPath(env, sha);
    mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
    try {
      writeFileSync(p, buf, { flag: 'wx', mode: 0o600 });
    } catch (e: unknown) {
      if (typeof e !== 'object' || e === null || (e as { code?: unknown }).code !== 'EEXIST') throw e;
      const have = readBytes(p);
      if (!have.ok || sha256Hex(have.value) !== sha) throw new Error(`the stored copy ${p} no longer matches its SHA-256; move it aside and take the baseline again`);
    }
  }
  const file = baselinesFile(env);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
  return file;
}

export type BaselineCopy = { ok: true; data: Buffer; ts: string; bytes: number } | { ok: false; error: string };

/**
 * The baseline copy of one file of an order: the latest baseline of the order must hold the file, and the copy must
 * still match the SHA-256 it is stored under.
 */
export function baselineCopy(env: NodeJS.ProcessEnv, orderReal: string, fileReal: string, orderPathShown: string): BaselineCopy {
  const store = readBaselines(env);
  if (!store.ok) return { ok: false, error: `the baseline index cannot be read (${store.error}), so there is nothing to compare against` };
  const b = latestBaseline(store.list, orderReal);
  if (b === null) return { ok: false, error: `no baseline was taken: run openmorals order baseline ${orderPathShown} yourself before the work starts` };
  const f = b.files.find((x) => x.path === fileReal);
  if (f === undefined) return { ok: false, error: `the baseline of ${b.ts} holds no copy of this file; take the baseline again before the work starts` };
  if (f.sha256 === null) return { ok: false, error: `the file did not exist when the baseline was taken (${b.ts}), so there is nothing to compare against` };
  const r = readBytes(copyPath(env, f.sha256));
  if (!r.ok) return { ok: false, error: `the baseline copy ${r.error}` };
  if (sha256Hex(r.value) !== f.sha256) return { ok: false, error: 'the baseline copy was changed after it was taken (its SHA-256 no longer matches)' };
  return { ok: true, data: r.value, ts: b.ts, bytes: f.bytes };
}
