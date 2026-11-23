import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_BYLAWS_YAML, findBylaws } from './bylaws.js';

export const DEFAULT_HOOK_COMMAND = 'openmorals hook claude-code';

type Json = Record<string, unknown>;

export type MergeResult = { ok: true; settings: Json; changed: boolean } | { ok: false; error: string };

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hasOurHook(entries: unknown[], command: string): boolean {
  return entries.some((e) => {
    if (!isObj(e)) return false;
    const hooks = e['hooks'];
    if (!Array.isArray(hooks)) return false;
    return hooks.some((h: unknown) => isObj(h) && typeof h['command'] === 'string' && (h['command'] === command || /\bopenmorals(\.js)?["']?\s+hook\s+claude-code\b/.test(h['command'])));
  });
}

export function mergeClaudeSettings(existing: unknown, command: string = DEFAULT_HOOK_COMMAND): MergeResult {
  if (existing !== undefined && !isObj(existing)) return { ok: false, error: 'settings.json is not a JSON object' };
  const settings: Json = existing === undefined ? {} : (JSON.parse(JSON.stringify(existing)) as Json);
  const hooksRaw = settings['hooks'];
  if (hooksRaw !== undefined && !isObj(hooksRaw)) return { ok: false, error: '"hooks" in settings.json is not an object' };
  const hooks: Json = hooksRaw === undefined ? {} : hooksRaw;
  const preRaw = hooks['PreToolUse'];
  if (preRaw !== undefined && !Array.isArray(preRaw)) return { ok: false, error: '"hooks.PreToolUse" in settings.json is not a list' };
  const pre: unknown[] = preRaw === undefined ? [] : (preRaw as unknown[]);
  if (hasOurHook(pre, command)) return { ok: true, settings, changed: false };
  pre.push({ matcher: '*', hooks: [{ type: 'command', command, timeout: 30 }] });
  hooks['PreToolUse'] = pre;
  settings['hooks'] = hooks;
  return { ok: true, settings, changed: true };
}

export interface InitOptions {
  hookCommand?: string;
  installHook?: boolean;
  now?: Date;
}

export type InitResult =
  | { ok: true; bylawsPath: string; bylawsWritten: boolean; settingsPath: string | null; settingsChanged: boolean; backupPath: string | null }
  | { ok: false; error: string };

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

export function initProject(dir: string, opts: InitOptions = {}): InitResult {
  const now = opts.now ?? new Date();
  const existingBylaws = findBylaws(dir);
  const bylawsPath = existingBylaws !== null && dirname(existingBylaws) === dir ? existingBylaws : join(dir, 'openmorals.yaml');
  let bylawsWritten = false;
  if (!existsSync(bylawsPath)) {
    writeAtomic(bylawsPath, DEFAULT_BYLAWS_YAML);
    bylawsWritten = true;
  }
  if (opts.installHook === false) return { ok: true, bylawsPath, bylawsWritten, settingsPath: null, settingsChanged: false, backupPath: null };
  const settingsPath = join(dir, '.claude', 'settings.json');
  let existing: unknown = undefined;
  if (existsSync(settingsPath)) {
    const text = readFileSync(settingsPath, 'utf8');
    if (text.trim() !== '') {
      try {
        existing = JSON.parse(text);
      } catch (err: unknown) {
        return { ok: false, error: `${settingsPath} is not valid JSON (${err instanceof Error ? err.message : String(err)}); it was left untouched` };
      }
    }
  }
  const merged = mergeClaudeSettings(existing, opts.hookCommand ?? DEFAULT_HOOK_COMMAND);
  if (!merged.ok) return { ok: false, error: `${merged.error}; ${settingsPath} was left untouched` };
  if (!merged.changed) return { ok: true, bylawsPath, bylawsWritten, settingsPath, settingsChanged: false, backupPath: null };
  let backupPath: string | null = null;
  if (existsSync(settingsPath)) {
    backupPath = `${settingsPath}.openmorals-backup-${now.toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(settingsPath, backupPath);
  }
  writeAtomic(settingsPath, `${JSON.stringify(merged.settings, null, 2)}\n`);
  return { ok: true, bylawsPath, bylawsWritten, settingsPath, settingsChanged: true, backupPath };
}
