import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_BYLAWS_YAML, findBylaws } from './bylaws.js';

export const DEFAULT_HOOK_COMMAND = 'openmorals hook claude-code';

type Json = Record<string, unknown>;

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'UserPromptSubmit';

export type MergeResult = { ok: true; settings: Json; changed: boolean } | { ok: false; error: string };

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function ourHooks(entries: unknown[], command: string): Json[] {
  const out: Json[] = [];
  for (const e of entries) {
    if (!isObj(e)) continue;
    const hooks = e['hooks'];
    if (!Array.isArray(hooks)) continue;
    for (const h of hooks) if (isObj(h) && typeof h['command'] === 'string' && (h['command'] === command || /\bopenmorals(\.js)?["']?\s+hook\s+claude-code\b/.test(h['command']))) out.push(h);
  }
  return out;
}

/**
 * The events whose hook must block when it fails (0.36.0): Claude Code runs a PreToolUse call whose hook crashed, timed
 * out or printed something unreadable, and passes a prompt the same way, unless the hook sets `onFailure: "block"`
 * (hooks reference, Claude Code v2.1.295 and later; older versions ignore the field). The post-tool hooks run after
 * the call, so there is nothing left to block.
 */
export const FAIL_CLOSED_EVENTS: readonly HookEvent[] = ['PreToolUse', 'UserPromptSubmit'];

function hasOurHook(entries: unknown[], command: string, ev: HookEvent): boolean {
  const ours = ourHooks(entries, command);
  if (ours.length === 0) return false;
  return !FAIL_CLOSED_EVENTS.includes(ev) || ours.some((h) => h['onFailure'] === 'block');
}

/**
 * True when a parsed Claude Code settings object already runs the openmorals hook for every listed
 * event (default PreToolUse), by the same test `mergeClaudeSettings` uses to decide whether to add it:
 * a command hook equal to `command`, or any command that runs `openmorals ... hook claude-code`; for PreToolUse and
 * UserPromptSubmit it must also block on failure (`onFailure: "block"`, 0.36.0).
 */
export function hasOpenMoralsHook(settings: unknown, events: readonly HookEvent[] = ['PreToolUse'], command: string = DEFAULT_HOOK_COMMAND): boolean {
  if (!isObj(settings)) return false;
  const hooks = settings['hooks'];
  if (!isObj(hooks)) return false;
  return events.every((ev) => {
    const list = hooks[ev];
    return Array.isArray(list) && hasOurHook(list, command, ev);
  });
}

export const ALL_HOOK_EVENTS: readonly HookEvent[] = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit'];

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
    if (hasOurHook(list, command, ev)) continue;
    const existing = ourHooks(list, command);
    if (existing.length > 0) {
      // Installed before 0.36.0: the hook is there but a failure of it lets the call run.
      for (const h of existing) h['onFailure'] = 'block';
      hooks[ev] = list;
      changed = true;
      continue;
    }
    const hook = FAIL_CLOSED_EVENTS.includes(ev) ? { type: 'command', command, timeout: 30, onFailure: 'block' } : { type: 'command', command, timeout: 30 };
    list.push(ev === 'UserPromptSubmit' ? { hooks: [hook] } : { matcher: '*', hooks: [hook] });
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
