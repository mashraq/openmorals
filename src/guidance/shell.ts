import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Bylaws } from '../types.js';
import { mergeGuidance, removeGuidance, type MergeResult } from './merge.js';
import { renderGuidance, type GuidanceOptions } from './render.js';
import { DAILY_ACTIVITIES, estimateTokens, GENERATED_MARK, renderSkills, tierZero } from './daily.js';
import type { Principle } from '../packs/schema.js';

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

/** Writes an already rendered block (the `daily` form, 0.29.0) into an instructions file, replacing any openmorals block there. */
export function writeGuidanceBlock(file: string, block: string): WriteResult {
  return applyMerge(file, (text) => mergeGuidance(text, block), true);
}

export type SkillsResult =
  | { ok: true; written: string[]; unchanged: string[] }
  | { ok: false; code: 'not-ours' | 'not-a-regular-file' | 'io-error'; message: string; written: string[] };

function writeFileAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, text, { flag: 'wx', mode: 0o644 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* the temp file was never created */
    }
    throw e;
  }
}

/**
 * Writes rendered skill files under `root` (0.29.0). A skill folder that already exists is replaced only when its
 * README.md carries `mark` (openmorals wrote it); any other existing folder, a symlink, or a file that is not a regular
 * file stops the write with nothing of that skill changed.
 */
export function writeSkills(root: string, files: readonly { path: string; text: string }[], mark: string): SkillsResult {
  const written: string[] = [];
  const unchanged: string[] = [];
  const folders = [...new Set(files.map((f) => f.path.split('/')[0] ?? ''))].filter((f) => f !== '');
  for (const folder of folders) {
    const dir = path.join(root, folder);
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(dir);
    } catch {
      st = null;
    }
    if (st !== null) {
      if (!st.isDirectory()) return { ok: false, code: 'not-a-regular-file', message: `${dir} exists and is not a folder; nothing was written there`, written };
      let readme = '';
      try {
        const rs = fs.lstatSync(path.join(dir, 'README.md'));
        if (rs.isFile()) readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
      } catch {
        readme = '';
      }
      if (!readme.includes(mark)) return { ok: false, code: 'not-ours', message: `${dir} exists and was not written by openmorals; it was left as it is`, written };
    }
    for (const f of files.filter((x) => (x.path.split('/')[0] ?? '') === folder)) {
      const file = path.join(root, ...f.path.split('/'));
      let cur: string | null = null;
      try {
        const fst = fs.lstatSync(file);
        if (!fst.isFile()) return { ok: false, code: 'not-a-regular-file', message: `${file} is a symlink or not a regular file; refusing to write through it`, written };
        cur = fs.readFileSync(file, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, code: 'io-error', message: errText(e), written };
      }
      if (cur === f.text) {
        unchanged.push(file);
        continue;
      }
      try {
        writeFileAtomic(file, f.text);
      } catch (e) {
        return { ok: false, code: 'io-error', message: errText(e), written };
      }
      written.push(file);
    }
  }
  return { ok: true, written, unchanged };
}

export function clearGuidance(file: string): WriteResult {
  return applyMerge(file, (text) => (text === null ? { ok: true, text: '', changed: false } : removeGuidance(text)), false);
}

/** The instructions file each agent reads, for the daily tier 0 block (0.29.0). */
export function dailyInstructionsFile(agent: string): string {
  if (agent === 'claude-code') return 'CLAUDE.md';
  if (agent === 'gemini-cli') return 'GEMINI.md';
  return 'AGENTS.md';
}

export type DailyInstall = { ok: true; lines: string[] } | { ok: false; error: string; lines: string[] };

/**
 * What `openmorals init` writes for a pack with daily guidance (0.29.0), and only then: the tier 0 block in the agent's
 * instructions file, and for Claude Code the three skills under `.claude/skills/`. Returns the lines `init` prints, each
 * size measured from the text written.
 */
export function installDaily(dir: string, agent: string, principles: readonly Principle[]): DailyInstall {
  const lines: string[] = [];
  const t0 = tierZero(principles);
  if (!t0.ok) return { ok: false, error: `the daily guidance could not be rendered (${t0.error}); no guidance was written`, lines };
  const file = path.join(dir, dailyInstructionsFile(agent));
  const w = writeGuidanceBlock(file, t0.text);
  if (!w.ok) return { ok: false, error: `${file}: ${w.message}; no guidance was written`, lines };
  lines.push(`${w.changed ? (w.created ? 'created' : 'updated') : 'kept'} the daily guidance block in ${file}: ${t0.text.length} characters, about ${estimateTokens(t0.text.length)} tokens re-sent with every model call`);
  if (agent !== 'claude-code') {
    lines.push(`skills are written for Claude Code only; for ${agent}, copy the skills folder of the openmorals package if your agent reads skills`);
    return { ok: true, lines };
  }
  const root = path.join(dir, '.claude', 'skills');
  const sk = writeSkills(root, renderSkills(principles), GENERATED_MARK);
  if (!sk.ok) return { ok: false, error: `${sk.message}; the other skills were ${sk.written.length > 0 ? 'partly ' : 'not '}written`, lines };
  const desc = DAILY_ACTIVITIES.map((a) => estimateTokens(a.description.length));
  lines.push(`${sk.written.length > 0 ? 'wrote' : 'kept'} ${DAILY_ACTIVITIES.length} skills in ${root} (${DAILY_ACTIVITIES.map((a) => a.skill).join(', ')}): descriptions about ${Math.min(...desc)}-${Math.max(...desc)} tokens each whenever skills are listed; a body only when used`);
  return { ok: true, lines };
}
