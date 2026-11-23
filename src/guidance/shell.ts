import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Bylaws } from '../types.js';
import { mergeGuidance, removeGuidance, type MergeResult } from './merge.js';
import { renderGuidance, type GuidanceOptions } from './render.js';

export const GUIDANCE_FILES: readonly string[] = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md'];

export type WriteResult =
  | { ok: true; file: string; changed: boolean; created: boolean }
  | { ok: false; code: 'malformed-markers' | 'not-a-regular-file' | 'io-error'; message: string };

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function readExisting(file: string): { ok: true; text: string | null; mode: number | null } | { ok: false; code: 'not-a-regular-file' | 'io-error'; message: string } {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return { ok: true, text: null, mode: null };
  }
  if (!st.isFile()) return { ok: false, code: 'not-a-regular-file', message: `${path.basename(file)} is a symlink or not a regular file; refusing to write through it` };
  try {
    return { ok: true, text: fs.readFileSync(file, 'utf8'), mode: st.mode & 0o777 };
  } catch (e) {
    return { ok: false, code: 'io-error', message: errText(e) };
  }
}

function applyMerge(file: string, compute: (text: string | null) => MergeResult, createIfMissing: boolean): WriteResult {
  const cur = readExisting(file);
  if (!cur.ok) return cur;
  if (cur.text === null && !createIfMissing) return { ok: true, file, changed: false, created: false };
  const merged = compute(cur.text);
  if (!merged.ok) return merged;
  if (!merged.changed) return { ok: true, file, changed: false, created: false };
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, merged.text, { flag: 'wx', mode: cur.mode ?? 0o644 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* the temp file was never created */
    }
    return { ok: false, code: 'io-error', message: errText(e) };
  }
  return { ok: true, file, changed: true, created: cur.text === null };
}

export function writeGuidance(file: string, bylaws: Bylaws, opts: GuidanceOptions = {}): WriteResult {
  const block = renderGuidance(bylaws, opts);
  return applyMerge(file, (text) => mergeGuidance(text, block), true);
}

export function clearGuidance(file: string): WriteResult {
  return applyMerge(file, (text) => (text === null ? { ok: true, text: '', changed: false } : removeGuidance(text)), false);
}
