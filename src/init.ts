import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { DEFAULT_BYLAWS_YAML, findBylaws } from './bylaws.js';
import { restore, trash } from './undo/index.js';

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

/**
 * The Claude Code allow rule for the recoverable delete: with it, the agent can take the trash command that a delete's
 * reason offers without a second prompt from Claude Code. The allow is Claude Code's; OpenMorals' own hook still runs
 * first and asks about a trash call that names a path outside the project, sets --root or names a path built at run
 * time (the delete guard), and the trash itself refuses a path outside the project.
 */
export const TRASH_ALLOW_RULE = 'Bash(openmorals trash:*)';

/** What `init` did about the trash allow rule. */
export type TrashAllow =
  | { status: 'added' | 'present' }
  | { status: 'skipped' | 'failed'; why: string };

/**
 * Trashes and restores a throwaway file in a fresh temp folder, to show the recoverable delete works on this machine
 * before `init` lets the agent use it without asking. Nothing in the project is touched; the temp folder is removed.
 */
export function trashRoundTrip(base: string = tmpdir()): { ok: true } | { ok: false; why: string } {
  let dir: string | null = null;
  try {
    dir = realpathSync(mkdtempSync(join(base, 'openmorals-trash-check-')));
    const file = join(dir, 'probe.txt');
    const text = `openmorals trash check ${process.pid}\n`;
    writeFileSync(file, text);
    const t = trash(file, { root: dir, cwd: dir });
    if (!t.ok) return { ok: false, why: `the trash refused a test file (${t.message})` };
    if (existsSync(file)) return { ok: false, why: 'the test file was still in place after the trash' };
    const r = restore(t.value.id, { root: dir });
    if (!r.ok) return { ok: false, why: `the test file could not be restored (${r.message})` };
    if (!existsSync(file) || readFileSync(file, 'utf8') !== text) return { ok: false, why: 'the restored test file did not match the original' };
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, why: `the trash check failed (${e instanceof Error ? e.message : String(e)})` };
  } finally {
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
  }
}

/** The project folder is the home folder or above it, where `openmorals trash` does not work. */
function rootedAtHome(dir: string, home: string): boolean {
  const rel = relative(resolve(dir), resolve(home));
  return rel === '' || !(rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel));
}

/**
 * Adds the trash allow rule to Claude Code settings (a copy; the input is not changed), after `check` passes. A
 * `permissions` or `permissions.allow` of the wrong type is left alone and the rule is skipped.
 */
export function mergeTrashAllow(settings: Json, check: () => { ok: true } | { ok: false; why: string }): { settings: Json; changed: boolean; result: TrashAllow } {
  const permsRaw = settings['permissions'];
  if (permsRaw !== undefined && !isObj(permsRaw)) return { settings, changed: false, result: { status: 'skipped', why: '"permissions" in settings.json is not an object' } };
  const allowRaw = isObj(permsRaw) ? permsRaw['allow'] : undefined;
  if (allowRaw !== undefined && !Array.isArray(allowRaw)) return { settings, changed: false, result: { status: 'skipped', why: '"permissions.allow" in settings.json is not a list' } };
  const allow = (allowRaw ?? []) as unknown[];
  if (allow.includes(TRASH_ALLOW_RULE)) return { settings, changed: false, result: { status: 'present' } };
  const c = check();
  if (!c.ok) return { settings, changed: false, result: { status: 'failed', why: c.why } };
  const out = JSON.parse(JSON.stringify(settings)) as Json;
  const perms = isObj(out['permissions']) ? out['permissions'] : {};
  perms['allow'] = [...allow, TRASH_ALLOW_RULE];
  out['permissions'] = perms;
  return { settings: out, changed: true, result: { status: 'added' } };
}

export interface InitOptions {
  hookCommand?: string;
  installHook?: boolean;
  now?: Date;
  bylawsText?: string;
  hookEvents?: readonly HookEvent[];
  /** Add the trash allow rule to Claude Code settings after a trash and restore check (default true). */
  trashAllow?: boolean;
  /** The check run before the allow is added (default `trashRoundTrip`); for tests. */
  trashCheck?: () => { ok: true } | { ok: false; why: string };
  /** The home folder (default the user's); a project rooted there gets no trash allow. */
  home?: string;
}

export type InitResult =
  | { ok: true; bylawsPath: string; bylawsWritten: boolean; settingsPath: string | null; settingsChanged: boolean; backupPath: string | null; hookChanged?: boolean; trashAllow?: TrashAllow }
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
  let settings = merged.settings;
  let trashAllow: TrashAllow | undefined;
  if (opts.trashAllow === false) trashAllow = { status: 'skipped', why: 'turned off with --no-trash-allow' };
  else if (rootedAtHome(dir, opts.home ?? homedir())) trashAllow = { status: 'skipped', why: 'the project folder is your home folder or above it, where openmorals trash does not work' };
  else {
    const t = mergeTrashAllow(settings, opts.trashCheck ?? (() => trashRoundTrip()));
    settings = t.settings;
    trashAllow = t.result;
  }
  const changed = merged.changed || trashAllow.status === 'added';
  if (!changed) return { ok: true, bylawsPath, bylawsWritten, settingsPath, settingsChanged: false, backupPath: null, hookChanged: false, trashAllow };
  let backupPath: string | null = null;
  if (existsSync(settingsPath)) {
    backupPath = `${settingsPath}.openmorals-backup-${now.toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(settingsPath, backupPath);
  }
  writeAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  return { ok: true, bylawsPath, bylawsWritten, settingsPath, settingsChanged: true, backupPath, hookChanged: merged.changed, trashAllow };
}
