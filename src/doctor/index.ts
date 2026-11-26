import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandResult } from '../defer/command.js';
import { deferDir, readQueue } from '../defer/store.js';
import { ALL_HOOK_EVENTS, FAIL_CLOSED_EVENTS } from '../init.js';
import type { HookEvent } from '../init.js';
import { configDir, sessionStatePath } from '../paths.js';
import { redactSecrets } from '../scanner/redact.js';

/**
 * `openmorals doctor`: is the guard really live in this project? Read-only apart from the self-test, which runs this
 * package's own hook (never a command taken from the project) on three synthetic events, unattended so the reviewer is
 * off and nothing goes over the network. Nothing in the project is touched; the hook writes its usual audit lines under
 * a session named openmorals-doctor-..., whose session file and any request it held for approval are removed.
 */

export type CheckStatus = 'ok' | 'problem' | 'warn' | 'note' | 'skipped';

export interface DoctorCheck {
  host: string;
  check: string;
  status: CheckStatus;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  dir: string;
  hosts: string[];
  checks: DoctorCheck[];
  problems: number;
  warnings: number;
  /** Hosts found in the project that run a call when its hook fails or times out. */
  failOpenHosts: string[];
}

export interface SpawnResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
}

export type Spawner = (file: string, args: readonly string[], input: string, cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv) => SpawnResult;

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  /** Run the self-test (default true). */
  selfTest?: boolean;
  spawn?: Spawner;
  /** Name of the self-test session (default openmorals-doctor-<pid>-<time>). */
  sessionId?: string;
  /** This openmorals: what the self-test runs and what the settings' command must resolve to (default: this package's CLI). */
  self?: SelfCli | null;
}

/** How to run this openmorals' own hook: `file` with `args` before `hook claude-code`; `identity` is the real path a settings command must resolve to. */
export interface SelfCli {
  file: string;
  args: string[];
  identity: string;
}

/** This package's own CLI (dist/src/cli.js next to dist/src/doctor/), or the single executable itself. */
export function ownCli(): SelfCli | null {
  try {
    const sea = process.getBuiltinModule?.('node:sea');
    if (sea !== undefined && sea.isSea()) return { file: process.execPath, args: [], identity: realpathSync(process.execPath) };
  } catch {
    // not a single executable
  }
  try {
    const cli = realpathSync(fileURLToPath(new URL('../cli.js', import.meta.url)));
    return { file: process.execPath, args: [cli], identity: cli };
  } catch {
    return null;
  }
}

/** The environment the self-test's hook runs with: enough to find the config folder, and the reviewer off (unattended). */
export function probeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const k of ['PATH', 'Path', 'HOME', 'USERPROFILE', 'APPDATA', 'XDG_CONFIG_HOME', 'OPENMORALS_HOME', 'SystemRoot']) {
    const v = env[k];
    if (v !== undefined && v !== '') out[k] = v;
  }
  out['OPENMORALS_UNATTENDED'] = '1';
  return out;
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `openmorals hook claude-code`, or a checkout's or install's `cli.js hook claude-code` (init --hook-command). */
const OUR_CLAUDE_COMMAND = /\b(openmorals(\.js)?|cli\.(c|m)?js)["']?\s+hook\s+claude-code\b/;
const SHELL_SPECIAL = /[;&|`$<>()\\{}*?!#~\n]/;
const SLOW_MS = 5000;
/** A leading `NAME=value` word: an environment assignment for the command, not the program. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Text from the settings or the hook, safe to print: secrets masked. */
function safe(text: string): string {
  return redactSecrets(text);
}

function readJson(path: string): { ok: true; value: unknown } | { ok: false; error: string } | null {
  if (!existsSync(path)) return null;
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, '')) };
  } catch (e) {
    // Only where the error is: a parser's message can quote the file's text.
    const m = /position (\d+)|line (\d+) column (\d+)/.exec(e instanceof Error ? e.message : String(e));
    return { ok: false, error: m === null ? 'parse error' : m[1] !== undefined ? `at position ${m[1]}` : `at line ${m[2] ?? ''} column ${m[3] ?? ''}` };
  }
}

/** Splits a hook command into words when it is a plain command: spaces between words, optional double quotes, no shell syntax. */
export function plainWords(command: string): string[] | null {
  const words: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  let rest = command;
  while ((m = re.exec(command)) !== null) {
    const w = m[1] ?? m[2] ?? m[3] ?? '';
    if (m[3] !== undefined && SHELL_SPECIAL.test(w)) return null;
    words.push(w);
    rest = rest.replace(m[0], '');
  }
  if (rest.trim() !== '' || words.length === 0) return null;
  return words;
}

function isExecutable(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform === 'win32') return true;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Finds a program the way a shell would: a path with a slash as given (relative to `dir`), else each absolute PATH entry. */
export function resolveProgram(word: string, dir: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  const exts = platform === 'win32' ? ['', ...(env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((e) => e !== '')] : [''];
  if (word.includes('/') || (platform === 'win32' && word.includes('\\'))) {
    const p = isAbsolute(word) ? word : resolve(dir, word);
    for (const e of exts) if (isExecutable(p + e, platform)) return p + e;
    return null;
  }
  const pathVar = env['PATH'] ?? env['Path'] ?? '';
  for (const d of pathVar.split(platform === 'win32' ? ';' : delimiter)) {
    if (d === '' || !isAbsolute(d)) continue;
    for (const e of exts) {
      const p = join(d, word + e);
      if (isExecutable(p, platform)) return p;
    }
  }
  return null;
}

/** The words after the program are the openmorals hook arguments (`hook claude-code`, optionally `--unattended`). */
function isOpenMoralsClaudeHook(words: string[]): boolean {
  const base = (w: string): string => w.split(/[\\/]/).pop() ?? w;
  let i = 0;
  const first = base(words[0] ?? '');
  if (/^node(\.exe)?$/i.test(first)) {
    const script = base(words[1] ?? '');
    if (!/^(cli|openmorals)\.(c|m)?js$/.test(script)) return false;
    i = 2;
  } else if (/^openmorals(\.cmd|\.exe)?$/i.test(first)) {
    i = 1;
  } else {
    return false;
  }
  const rest = words.slice(i);
  return rest[0] === 'hook' && rest[1] === 'claude-code' && rest.slice(2).every((w) => w === '--unattended');
}

const defaultSpawn: Spawner = (file, args, input, cwd, timeoutMs, env) => {
  const t0 = Date.now();
  const r = spawnSync(file, [...args], { input, cwd, env, timeout: timeoutMs, encoding: 'utf8', windowsHide: true });
  const timedOut = r.error !== undefined && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error?.message ?? ''), timedOut, ms: Date.now() - t0 };
};

interface OurHook {
  event: HookEvent;
  file: string;
  matcher: unknown;
  command: string;
  onFailure: unknown;
  timeout: unknown;
}

function ourClaudeHooks(settings: unknown, file: string): OurHook[] {
  const found: OurHook[] = [];
  if (!isObj(settings) || !isObj(settings['hooks'])) return found;
  const hooks = settings['hooks'];
  for (const event of ALL_HOOK_EVENTS) {
    const list = hooks[event];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!isObj(entry) || !Array.isArray(entry['hooks'])) continue;
      for (const h of entry['hooks']) {
        if (isObj(h) && typeof h['command'] === 'string' && OUR_CLAUDE_COMMAND.test(h['command'])) {
          found.push({ event, file, matcher: entry['matcher'], command: h['command'], onFailure: h['onFailure'], timeout: h['timeout'] });
        }
      }
    }
  }
  return found;
}

function coversEveryTool(matcher: unknown): boolean {
  return matcher === undefined || matcher === '' || matcher === '*' || matcher === '.*';
}

type Opts = Required<Pick<DoctorOptions, 'env' | 'home' | 'platform' | 'selfTest' | 'spawn'>> & { sessionId: string; self: SelfCli | null };

function claudeChecks(dir: string, o: Opts, add: (c: DoctorCheck) => void): boolean {
  const H = 'claude-code';
  const files = [join(dir, '.claude', 'settings.json'), join(dir, '.claude', 'settings.local.json')];
  const userFile = join(o.env['CLAUDE_CONFIG_DIR'] ?? join(o.home, '.claude'), 'settings.json');
  const parsed: { file: string; value: unknown }[] = [];
  for (const f of [...files, userFile]) {
    const r = readJson(f);
    if (r === null) continue;
    if (!r.ok) {
      add({ host: H, check: 'settings', status: 'problem', detail: `${f} is not valid JSON (${r.error}); Claude Code may ignore it`, fix: 'fix the file, then run openmorals doctor again' });
      continue;
    }
    parsed.push({ file: f, value: r.value });
  }
  const ours = parsed.flatMap((p) => ourClaudeHooks(p.value, p.file));
  const projectHasClaude = files.some((f) => existsSync(f));
  if (ours.length === 0 && !projectHasClaude) return false;

  if (ours.length === 0) {
    add({ host: H, check: 'hook installed', status: 'problem', detail: 'no OpenMorals hook in .claude/settings.json or .claude/settings.local.json', fix: 'run openmorals init in this folder' });
  } else {
    for (const event of ALL_HOOK_EVENTS) {
      const hs = ours.filter((h) => h.event === event);
      const needed = event === 'PreToolUse';
      if (hs.length === 0) {
        add({ host: H, check: `${event} hook`, status: needed ? 'problem' : 'warn', detail: needed ? 'missing: tool calls are not checked' : `missing: ${event === 'UserPromptSubmit' ? 'prompts are not scanned' : 'tool results are not scanned and repeated failures are not counted'}`, fix: 'run openmorals init again (it adds what is missing and keeps your other hooks)' });
        continue;
      }
      // Matchers do not apply to prompts; for tool events only a hook entry that covers every tool counts.
      const wide = event === 'UserPromptSubmit' ? hs : hs.filter((h) => coversEveryTool(h.matcher));
      if (event !== 'UserPromptSubmit' && wide.length === 0) {
        add({ host: H, check: `${event} covers every tool`, status: needed ? 'problem' : 'warn', detail: `the hook only runs for matcher ${safe(JSON.stringify(hs[0]?.matcher) ?? '')}; other tools are not checked`, fix: 'set the matcher to "*" (openmorals init writes it that way)' });
      }
      if (FAIL_CLOSED_EVENTS.includes(event)) {
        const blocks = wide.some((h) => h.onFailure === 'block');
        const which = event === 'UserPromptSubmit' ? 'no' : 'no hook entry that covers every tool has';
        add(blocks
          ? { host: H, check: `${event} blocks on failure`, status: 'ok', detail: 'onFailure: "block" (Claude Code v2.1.295 and later; older versions ignore it and run the call)' }
          : { host: H, check: `${event} blocks on failure`, status: 'problem', detail: `${which} onFailure: "block": if the hook crashes, times out or cannot start, Claude Code runs the call anyway`, fix: 'run openmorals init again, or add "onFailure": "block" to that hook' });
      } else {
        add({ host: H, check: `${event} hook`, status: 'ok', detail: 'installed' });
      }
    }
    selfTest(dir, ours, o, add);
  }

  // The host's sandbox: a note, never a failure.
  const sandboxOn = parsed.some((p) => isObj(p.value) && isObj(p.value['sandbox']) && p.value['sandbox']['enabled'] === true);
  if (!sandboxOn) {
    add({ host: H, check: 'host sandbox', status: 'note', detail: 'Claude Code\'s own sandbox is not turned on in these settings. OpenMorals is a set of rules, not a sandbox; the two work together', fix: 'consider "sandbox": { "enabled": true } (see Claude Code\'s sandboxing docs)' });
  }
  return true;
}

function claudeEvent(sessionId: string, dir: string, event: 'PreToolUse' | 'UserPromptSubmit', extra: Json): string {
  return JSON.stringify({ session_id: sessionId, transcript_path: '', cwd: dir, hook_event_name: event, permission_mode: 'default', ...extra });
}

function decisionOf(stdout: string): string | null {
  const text = stdout.trim();
  if (text === '') return null;
  try {
    const v: unknown = JSON.parse(text);
    if (isObj(v)) {
      const hso = v['hookSpecificOutput'];
      if (isObj(hso) && typeof hso['permissionDecision'] === 'string') return hso['permissionDecision'];
      if (v['decision'] === 'block') return 'block';
      if (typeof v['decision'] === 'string') return v['decision'];
    }
    return 'other';
  } catch {
    return 'unreadable';
  }
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Whether `prog` (a resolved program) is this openmorals: the same file, or an npm launcher next to it on Windows. */
function isSelfProgram(prog: string, self: SelfCli, platform: NodeJS.Platform): boolean {
  if (realOrNull(prog) === self.identity) return true;
  if (platform !== 'win32') return false;
  // npm's Windows launchers (openmorals.cmd and friends) start node on the package's cli.js; only that file is compared, never run.
  const near = dirname(prog);
  const cli = join('openmorals', 'dist', 'src', 'cli.js');
  return [join(near, 'node_modules', cli), join(near, '..', cli)].some((p) => realOrNull(p) === self.identity);
}

type CommandLook =
  | { kind: 'self'; unattended: boolean }
  | { kind: 'other'; why: string }
  | { kind: 'unknown' }
  | { kind: 'missing' };

/** Looks at one hook command without running it and without resolving anything inside the project. */
function lookAtCommand(command: string, ours: OurHook[], dir: string, o: Opts, add: (c: DoctorCheck) => void): CommandLook {
  const H = 'claude-code';
  const shown = safe(command);
  const all = plainWords(command);
  if (all === null) {
    add({ host: H, check: 'hook command found', status: 'warn', detail: `cannot check "${shown}": it is not a plain command (it uses shell syntax)` });
    return { kind: 'unknown' };
  }
  let i = 0;
  while (i < all.length && ENV_ASSIGNMENT.test(all[i] ?? '')) i++;
  const words = all.slice(i);
  const first = words[0];
  if (first === undefined) {
    add({ host: H, check: 'hook command found', status: 'warn', detail: `cannot check "${shown}": it names no program` });
    return { kind: 'unknown' };
  }
  const isRelativePath = (w: string): boolean => !isAbsolute(w) && (w.includes('/') || (o.platform === 'win32' && w.includes('\\')));
  if (isRelativePath(first)) {
    add({ host: H, check: 'hook command found', status: 'warn', detail: `"${safe(first)}" in "${shown}" is a path inside the project; doctor does not look inside the project or run anything from it` });
    return { kind: 'other', why: 'it names a program inside the project' };
  }
  const prog = resolveProgram(first, dir, o.env, o.platform);
  if (prog === null) {
    add({ host: H, check: 'hook command found', status: 'problem', detail: `"${safe(first)}" in "${shown}" is not on PATH or not executable, so every hook call fails${ours.some((h) => h.command === command && h.onFailure === 'block') ? ' and Claude Code blocks each prompt and tool call' : ''}`, fix: 'install openmorals so it is on PATH, or run openmorals init --hook-command "node /absolute/path/to/cli.js hook claude-code"' });
    return { kind: 'missing' };
  }
  let target = prog;
  let viaNode = false;
  if (/^node(\.exe)?$/i.test(first.split(/[\\/]/).pop() ?? '') && words[1] !== undefined) {
    viaNode = true;
    const script = words[1];
    if (!isAbsolute(script)) {
      add({ host: H, check: 'hook command found', status: 'warn', detail: `the script "${safe(script)}" in "${shown}" is relative to the project; doctor does not look inside the project or run anything from it` });
      return { kind: 'other', why: 'its script is a path inside the project' };
    }
    if (!existsSync(script)) {
      add({ host: H, check: 'hook command found', status: 'problem', detail: `the script ${safe(script)} in "${shown}" does not exist`, fix: 'point --hook-command at the built cli.js, or install openmorals' });
      return { kind: 'missing' };
    }
    target = script;
  }
  add({ host: H, check: 'hook command found', status: 'ok', detail: `${safe(first)} -> ${safe(prog)}${viaNode ? ` ${safe(target)}` : ''}` });
  if (o.self === null) return { kind: 'other', why: 'doctor cannot find its own CLI to compare with' };
  const same = viaNode ? realOrNull(target) === o.self.identity : isSelfProgram(prog, o.self, o.platform);
  if (!same) return { kind: 'other', why: `it runs ${safe(target)}, not ${safe(o.self.identity)}` };
  if (!isOpenMoralsClaudeHook(words)) return { kind: 'other', why: 'its arguments are not hook claude-code' };
  return { kind: 'self', unattended: words.includes('--unattended') };
}

/** Removes what the self-test's session left: its session file and any request the hook held for approval. */
function cleanUp(o: Opts): void {
  const cfg = configDir(o.env, o.platform, o.home);
  try {
    rmSync(sessionStatePath(o.sessionId, cfg), { force: true });
  } catch {
    // the hook may keep its session file elsewhere
  }
  try {
    const dir = deferDir(cfg);
    for (const v of readQueue(cfg).items) {
      if (v.item.session !== o.sessionId) continue;
      for (const ext of ['json', 'approved', 'used', 'refused', 'void', 'reminded']) rmSync(join(dir, `${v.item.id}.${ext}`), { force: true });
    }
  } catch {
    // nothing held, or the folder cannot be read
  }
}

function selfTest(dir: string, ours: OurHook[], o: Opts, add: (c: DoctorCheck) => void): void {
  const H = 'claude-code';
  const preHooks = ours.filter((h) => h.event === 'PreToolUse');
  const pre = preHooks.find((h) => coversEveryTool(h.matcher) && h.onFailure === 'block') ?? preHooks.find((h) => coversEveryTool(h.matcher)) ?? preHooks[0] ?? ours[0];
  if (pre === undefined) return;
  const commands = [...new Set(ours.map((h) => h.command))];
  let look: CommandLook = { kind: 'unknown' };
  for (const command of commands) {
    const l = lookAtCommand(command, ours, dir, o, add);
    if (command === pre.command) look = l;
  }
  if (look.kind === 'other') {
    add({ host: H, check: 'hook is this openmorals', status: 'problem', detail: `the hook command is not this openmorals (${look.why}), so the self-test was skipped`, fix: 'run this openmorals\' init again, or run doctor from the openmorals the hook uses' });
  } else if (look.kind === 'self') {
    add({ host: H, check: 'hook is this openmorals', status: 'ok', detail: o.self?.identity ?? '' });
  }
  if (!o.selfTest) {
    add({ host: H, check: 'self-test', status: 'skipped', detail: '--no-run' });
    return;
  }
  if (look.kind !== 'self' || o.self === null) {
    add({ host: H, check: 'self-test', status: 'skipped', detail: look.kind === 'other' ? 'the hook command is not this openmorals' : 'the PreToolUse hook command could not be checked, so the self-test was not run' });
    return;
  }
  const self = o.self;
  const args = [...self.args, 'hook', 'claude-code', ...(look.unattended ? ['--unattended'] : [])];
  const env = probeEnv(o.env);
  const timeoutMs = typeof pre.timeout === 'number' && pre.timeout > 0 ? Math.max(1, Math.min(pre.timeout, 60)) * 1000 : 30000;
  const probes: { name: string; input: string; expect: (d: string | null) => boolean; want: string; miss: 'warn' | 'problem' }[] = [
    { name: 'harmless tool call (ls)', input: claudeEvent(o.sessionId, dir, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }), expect: (d) => d === null || d === 'allow', want: 'allowed', miss: 'warn' },
    { name: 'risky tool call (rm -rf of a folder)', input: claudeEvent(o.sessionId, dir, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf ./openmorals-doctor-probe' } }), expect: (d) => d === 'ask' || d === 'deny', want: 'ask or deny', miss: 'problem' },
    { name: 'prompt', input: claudeEvent(o.sessionId, dir, 'UserPromptSubmit', { prompt: 'openmorals doctor self-test' }), expect: (d) => d === null || d === 'other', want: 'passed through', miss: 'warn' },
  ];
  try {
    for (const p of probes) {
      const r = o.spawn(self.file, args, p.input, dir, timeoutMs, env);
      const d = decisionOf(r.stdout);
      if (r.timedOut) {
        add({ host: H, check: `self-test: ${p.name}`, status: 'problem', detail: `timed out after ${Math.round(timeoutMs / 1000)} s`, fix: 'run the hook command by hand to see where it hangs' });
      } else if (r.status !== 0) {
        add({ host: H, check: `self-test: ${p.name}`, status: 'problem', detail: `exited ${String(r.status)}${r.stderr.trim() !== '' ? `: ${safe(r.stderr.trim().split('\n')[0] ?? '')}` : ''}`, fix: 'run openmorals validate, then the hook command by hand' });
      } else if (d === 'unreadable') {
        add({ host: H, check: `self-test: ${p.name}`, status: 'problem', detail: 'printed something Claude Code cannot read as hook output' });
      } else if (!p.expect(d)) {
        add(p.miss === 'problem'
          ? { host: H, check: `self-test: ${p.name}`, status: 'problem', detail: `answered ${d ?? 'allow'}, expected ${p.want}: a delete like this would run without a question`, fix: 'openmorals check "rm -rf ./x" shows which rule decides; check your bylaws' }
          : { host: H, check: `self-test: ${p.name}`, status: 'warn', detail: `answered ${d ?? 'allow'}, expected ${p.want}; your bylaws may be set that way`, fix: 'openmorals check "<command>" shows which rule decides' });
      } else {
        add({ host: H, check: `self-test: ${p.name}`, status: r.ms > SLOW_MS ? 'warn' : 'ok', detail: `${d ?? 'allow'} in ${r.ms} ms${r.ms > SLOW_MS ? ' (slow: every tool call waits this long)' : ''}` });
      }
    }
  } finally {
    cleanUp(o);
  }
}

interface OtherHost {
  host: string;
  files: string[];
  marker: RegExp;
  failMode: string;
  failOpen: boolean;
  after: string;
}

const OTHER_HOSTS: readonly OtherHost[] = [
  { host: 'codex', files: ['.codex/hooks.json', '.codex/config.toml'], marker: /\bopenmorals(\.js)?["']?\s+hook\s+codex\b/, failMode: 'Codex runs the call when a hook fails or times out', failOpen: true, after: 'trust the hook in Codex with /hooks; Codex loads project hooks only in a trusted project' },
  { host: 'gemini-cli', files: ['.gemini/settings.json'], marker: /\bopenmorals(\.js)?["']?\s+hook\s+gemini-cli\b/, failMode: 'Gemini CLI runs the call when a hook times out', failOpen: true, after: 'accept the hook when Gemini CLI warns about it' },
  { host: 'opencode', files: ['.opencode/plugins/openmorals.js'], marker: /openmorals/, failMode: 'opencode blocks the call when the plugin throws', failOpen: false, after: 'restart opencode so it loads the plugin' },
  { host: 'openclaw', files: ['.openclaw/plugins/openmorals/index.js'], marker: /openmorals/, failMode: 'OpenClaw blocks the call when the plugin throws or times out', failOpen: false, after: 'install and enable the plugin in your OpenClaw Gateway; doctor cannot see whether the Gateway loaded it' },
];

function otherChecks(dir: string, o: { env: NodeJS.ProcessEnv; platform: NodeJS.Platform }, add: (c: DoctorCheck) => void): string[] {
  const found: string[] = [];
  for (const h of OTHER_HOSTS) {
    const present = h.files.map((f) => join(dir, ...f.split('/'))).filter((f) => existsSync(f));
    if (present.length === 0) continue;
    const text = present.map((f) => {
      try {
        return readFileSync(f, 'utf8');
      } catch {
        return '';
      }
    }).join('\n');
    if (!h.marker.test(text)) {
      add({ host: h.host, check: 'hook installed', status: 'problem', detail: `${present.join(', ')} exists but has no OpenMorals hook`, fix: `run openmorals init --agent ${h.host}` });
      found.push(h.host);
      continue;
    }
    found.push(h.host);
    add({ host: h.host, check: 'hook installed', status: 'ok', detail: present.join(', ') });
    add({ host: h.host, check: 'on failure', status: h.failOpen ? 'warn' : 'note', detail: h.failMode, ...(h.failOpen ? { fix: 'keep openmorals on PATH; doctor cannot change how this host treats a failed hook' } : {}) });
    if (h.host === 'codex' || h.host === 'gemini-cli') {
      const usesBare = new RegExp(`(^|["'\\s])openmorals\\s+hook\\s+${h.host}\\b`).test(text);
      if (usesBare && resolveProgram('openmorals', dir, o.env, o.platform) === null) {
        add({ host: h.host, check: 'hook command found', status: 'problem', detail: 'openmorals is not on PATH, so this host\'s hook cannot start', fix: 'install openmorals so it is on PATH' });
      }
    }
    add({ host: h.host, check: 'next step', status: 'note', detail: h.after });
  }
  return found;
}

export function runDoctor(dirIn: string, opts: DoctorOptions = {}): DoctorReport {
  const dir = resolve(dirIn);
  const env = opts.env ?? process.env;
  const o = {
    env,
    home: opts.home ?? homedir(),
    platform: opts.platform ?? process.platform,
    selfTest: opts.selfTest ?? true,
    spawn: opts.spawn ?? defaultSpawn,
    sessionId: opts.sessionId ?? `openmorals-doctor-${process.pid}-${Date.now()}`,
    self: opts.self === undefined ? ownCli() : opts.self,
  };
  const checks: DoctorCheck[] = [];
  const add = (c: DoctorCheck): void => {
    checks.push(c);
  };
  const hosts: string[] = [];
  if (claudeChecks(dir, o, add)) hosts.push('claude-code');
  hosts.push(...otherChecks(dir, o, add));
  if (hosts.length === 0) {
    add({ host: '-', check: 'hook installed', status: 'problem', detail: `no agent settings with an OpenMorals hook found in ${dir}`, fix: 'run openmorals init (add --agent codex, gemini-cli, opencode or openclaw for another agent)' });
  }
  if (!existsSync(join(dir, 'openmorals.yaml'))) {
    add({ host: '-', check: 'bylaws', status: 'note', detail: 'no openmorals.yaml in this folder: the hook looks for the nearest one above it, else uses the built-in defaults' });
  }
  const failOpenHosts = OTHER_HOSTS.filter((h) => h.failOpen && hosts.includes(h.host)).map((h) => h.host);
  const claudeOpen = checks.some((c) => c.host === 'claude-code' && c.check.endsWith('blocks on failure') && c.status === 'problem');
  if (claudeOpen) failOpenHosts.unshift('claude-code');
  return {
    dir,
    hosts,
    checks,
    problems: checks.filter((c) => c.status === 'problem').length,
    warnings: checks.filter((c) => c.status === 'warn').length,
    failOpenHosts,
  };
}

const MARK: Record<CheckStatus, string> = { ok: 'ok     ', problem: 'PROBLEM', warn: 'warn   ', note: 'note   ', skipped: 'skipped' };

export function formatDoctor(r: DoctorReport): string {
  const lines = [`openmorals doctor: ${r.dir}`];
  let host = '';
  for (const c of r.checks) {
    if (c.host !== host) {
      host = c.host;
      if (host !== '-') lines.push('', host);
    }
    lines.push(`  ${MARK[c.status]}  ${c.check}: ${c.detail}`);
    if (c.fix !== undefined && (c.status === 'problem' || c.status === 'warn')) lines.push(`           what to do: ${c.fix}`);
  }
  lines.push('');
  if (r.failOpenHosts.length > 0) lines.push(`Hosts here that run a call when the hook fails: ${r.failOpenHosts.join(', ')}.`);
  const selfTestSkipped = r.checks.some((c) => c.host === 'claude-code' && c.check === 'self-test' && c.status === 'skipped' && c.detail !== '--no-run');
  lines.push(r.problems === 0 && selfTestSkipped
    ? `No problems found${r.warnings > 0 ? `, ${r.warnings} warning${r.warnings === 1 ? '' : 's'}` : ''}, but the self-test did not run, so this does not show that the guard is live.`
    : r.problems === 0
    ? `Guard live${r.hosts.length > 0 ? ` for ${r.hosts.join(', ')}` : ''}: no problems${r.warnings > 0 ? `, ${r.warnings} warning${r.warnings === 1 ? '' : 's'}` : ''}. This checks the install, not whether the project is safe.`
    : `${r.problems} problem${r.problems === 1 ? '' : 's'}${r.warnings > 0 ? `, ${r.warnings} warning${r.warnings === 1 ? '' : 's'}` : ''}: the guard is not fully live here.`);
  return lines.join('\n') + '\n';
}

export const DOCTOR_USAGE = `  openmorals doctor [DIR] [--json] [--no-run]
      Check that the guard is really live in a project (default: this folder).
      Claude Code: the hook is installed for every event and every tool, blocks
      the call when it fails, and its command can be found. Codex, Gemini CLI,
      opencode, OpenClaw: the hook is there, how the agent treats a failed hook,
      and (Codex, Gemini CLI) openmorals on PATH. On Claude Code, when the hook
      command is this openmorals, doctor then runs this openmorals' own hook (never a command
      from the project) on a harmless call, a risky one and a prompt, all made
      up, unattended and with no network call (nothing in the project is
      touched; the hook logs them as usual under a session named
      openmorals-doctor-...). It also notes when the agent's own sandbox is off.
      --no-run skips the self-test; --json prints the report as JSON.
      Exit 0 when nothing needs fixing, 1 when something does.`;

export function doctorCommand(argv: readonly string[], opts: DoctorOptions & { cwd?: string } = {}): CommandResult {
  let json = false;
  let selfTest = opts.selfTest ?? true;
  let dir: string | undefined;
  for (const a of argv) {
    if (a === '--json') json = true;
    else if (a === '--no-run') selfTest = false;
    else if (a.startsWith('-')) return { stdout: '', stderr: `openmorals doctor: unknown option ${a}; nothing was done\nUsage:\n${DOCTOR_USAGE}\n`, exitCode: 64 };
    else if (dir === undefined) dir = a;
    else return { stdout: '', stderr: `openmorals doctor: one folder at most; nothing was done\nUsage:\n${DOCTOR_USAGE}\n`, exitCode: 64 };
  }
  const target = resolve(opts.cwd ?? process.cwd(), dir ?? '.');
  if (!existsSync(target) || !statSync(target).isDirectory()) return { stdout: '', stderr: `openmorals doctor: ${target} is not a folder\n`, exitCode: 64 };
  const report = runDoctor(target, { ...opts, selfTest });
  return { stdout: json ? JSON.stringify(report, null, 2) + '\n' : formatDoctor(report), stderr: '', exitCode: report.problems > 0 ? 1 : 0 };
}
