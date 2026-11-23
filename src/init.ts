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

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure';

/**
 * True when a parsed Claude Code settings object already runs the openmorals hook for every listed
 * event (default PreToolUse), by the same test `mergeClaudeSettings` uses to decide whether to add it:
 * a command hook equal to `command`, or any command that runs `openmorals ... hook claude-code`.
 */
export function hasOpenMoralsHook(settings: unknown, events: readonly HookEvent[] = ['PreToolUse'], command: string = DEFAULT_HOOK_COMMAND): boolean {
  if (!isObj(settings)) return false;
  const hooks = settings['hooks'];
  if (!isObj(hooks)) return false;
  return events.every((ev) => {
    const list = hooks[ev];
    return Array.isArray(list) && hasOurHook(list, command);
  });
}

export const ALL_HOOK_EVENTS: readonly HookEvent[] = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'];

export function mergeClaudeSettings(existing: unknown, command: string = DEFAULT_HOOK_COMMAND, events: readonly HookEvent[] = ['PreToolUse']): MergeResult {
  if (existing !== undefined && !isObj(existing)) return { ok: false, error: 'settings.json is not a JSON object' };
  const settings: Json = existing === undefined ? {} : (JSON.parse(JSON.stringify(existing)) as Json);
  const hooksRaw = settings['hooks'];
  if (hooksRaw !== undefined && !isObj(hooksRaw)) return { ok: false, error: '"hooks" in settings.json is not an object' };
  const hooks: Json = hooksRaw === undefined ? {} : hooksRaw;
  let changed = false;
  for (const ev of events) {
    const raw = hooks[ev];
    if (raw !== undefined && !Array.isArray(raw)) return { ok: false, error: `"hooks.${ev}" in settings.json is not a list` };
    const list: unknown[] = raw === undefined ? [] : (raw as unknown[]);
    if (hasOurHook(list, command)) continue;
    list.push({ matcher: '*', hooks: [{ type: 'command', command, timeout: 30 }] });
    hooks[ev] = list;
    changed = true;
  }
  if (changed) settings['hooks'] = hooks;
  return { ok: true, settings, changed };
}

export interface InitOptions {
  hookCommand?: string;
  installHook?: boolean;
  now?: Date;
  bylawsText?: string;
  hookEvents?: readonly HookEvent[];
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
    writeAtomic(bylawsPath, opts.bylawsText ?? DEFAULT_BYLAWS_YAML);
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
  const merged = mergeClaudeSettings(existing, opts.hookCommand ?? DEFAULT_HOOK_COMMAND, opts.hookEvents ?? ALL_HOOK_EVENTS);
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
