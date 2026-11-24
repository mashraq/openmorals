import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as codex from './codex/index.js';
import * as gemini from './gemini-cli/index.js';
import * as opencode from './opencode/index.js';
import * as openclaw from './openclaw/index.js';

export type AgentName = 'claude-code' | 'codex' | 'gemini-cli' | 'opencode' | 'openclaw';
export const AGENT_NAMES: readonly AgentName[] = ['claude-code', 'codex', 'gemini-cli', 'opencode', 'openclaw'];

export function isAgentName(v: string): v is AgentName {
  return (AGENT_NAMES as readonly string[]).includes(v);
}

/** What the user must still do in the host after the file is written. */
export const AGENT_FOLLOW_UP: Readonly<Record<Exclude<AgentName, 'claude-code'>, string>> = {
  codex: 'In Codex, open /hooks and trust the new hook: Codex skips hooks that are not trusted, and loads project hooks only in a trusted project.',
  'gemini-cli': 'Gemini CLI fingerprints project hooks and warns you before a new one runs; accept it there.',
  opencode: 'opencode loads .opencode/plugins/ when it starts or reloads; restart it.',
  openclaw: 'Install the plugin into your OpenClaw Gateway with: openclaw plugins install <the plugin folder above> (OpenClaw only runs installed, enabled plugins).',
};

export type AgentInstallResult =
  | { ok: true; agent: Exclude<AgentName, 'claude-code'>; file: string; changed: boolean; backupPath: string | null; followUp: string }
  | { ok: false; agent: Exclude<AgentName, 'claude-code'>; file: string; error: string; snippet: string };

export interface AgentInstallOptions {
  /** The hook command; for opencode, an argument vector (a JSON array string or words split on spaces). */
  hookCommand?: string;
  now?: Date;
}

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function backup(file: string, now: Date): string | null {
  if (!existsSync(file)) return null;
  const path = `${file}.openmorals-backup-${now.toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(file, path);
  return path;
}

/** Splits an opencode hook command: a JSON array of strings, or words separated by spaces. */
export function opencodeCommand(text: string): string[] | null {
  const t = text.trim();
  if (t.startsWith('[')) {
    try {
      const v: unknown = JSON.parse(t);
      return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x !== '') ? (v as string[]) : null;
    } catch {
      return null;
    }
  }
  const words = t.split(/\s+/).filter((w) => w !== '');
  return words.length > 0 ? words : null;
}

function installJson(dir: string, agent: 'codex' | 'gemini-cli', opts: AgentInstallOptions): AgentInstallResult {
  let snippet: { file: string; text: string };
  let merge: (existing: unknown) => codex.MergeResult;
  if (agent === 'codex') {
    const sn = codex.installSnippet(opts.hookCommand);
    snippet = sn;
    merge = (e) => codex.mergeConfig(e, sn);
  } else {
    const sn = gemini.installSnippet(opts.hookCommand);
    snippet = sn;
    merge = (e) => gemini.mergeConfig(e, sn);
  }
  const file = join(dir, snippet.file);
  let existing: unknown = null;
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8');
    if (text.trim() !== '') {
      try {
        existing = JSON.parse(text);
      } catch (err: unknown) {
        return { ok: false, agent, file, error: `${file} is not plain JSON (${err instanceof Error ? err.message : String(err)}); it was left untouched, so merge the snippet by hand`, snippet: snippet.text };
      }
    }
  }
  const merged = merge(existing);
  if (!merged.ok) return { ok: false, agent, file, error: `${merged.error}; ${file} was left untouched`, snippet: snippet.text };
  if (!merged.changed) return { ok: true, agent, file, changed: false, backupPath: null, followUp: AGENT_FOLLOW_UP[agent] };
  const backupPath = backup(file, opts.now ?? new Date());
  writeAtomic(file, `${JSON.stringify(merged.config, null, 2)}\n`);
  return { ok: true, agent, file, changed: true, backupPath, followUp: AGENT_FOLLOW_UP[agent] };
}

function installOpencode(dir: string, opts: AgentInstallOptions): AgentInstallResult {
  const command = opts.hookCommand === undefined ? undefined : opencodeCommand(opts.hookCommand);
  if (command === null) return { ok: false, agent: 'opencode', file: join(dir, '.opencode', 'plugins', 'openmorals.js'), error: 'the hook command is empty or not a JSON array of strings', snippet: '' };
  const snippet = opencode.installSnippet(command);
  const file = join(dir, snippet.file);
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const merged = opencode.mergeConfig(existing, snippet);
  if (!merged.ok) return { ok: false, agent: 'opencode', file, error: `${merged.error}; ${file} was left untouched`, snippet: snippet.text };
  if (!merged.changed) return { ok: true, agent: 'opencode', file, changed: false, backupPath: null, followUp: AGENT_FOLLOW_UP.opencode };
  const backupPath = backup(file, opts.now ?? new Date());
  writeAtomic(file, merged.text);
  return { ok: true, agent: 'opencode', file, changed: true, backupPath, followUp: AGENT_FOLLOW_UP.opencode };
}

function installOpenclaw(dir: string, opts: AgentInstallOptions): AgentInstallResult {
  const command = opts.hookCommand === undefined ? undefined : opencodeCommand(opts.hookCommand);
  const folder = join(dir, ...openclaw.OPENCLAW_PLUGIN_DIR.split('/'));
  const index = join(folder, 'index.js');
  if (command === null) return { ok: false, agent: 'openclaw', file: index, error: 'the hook command is empty or not a JSON array of strings', snippet: '' };
  const snippet = openclaw.installSnippet(dir, command);
  const existing = existsSync(index) ? readFileSync(index, 'utf8') : null;
  if (existing !== null && !existing.startsWith(openclaw.OPENCLAW_PLUGIN_MARKER)) return { ok: false, agent: 'openclaw', file: index, error: `${index} exists and was not written by openmorals; it was left untouched`, snippet: snippet.files['index.js'] };
  const files = Object.entries(snippet.files).map(([name, text]) => ({ path: join(folder, name), text }));
  const changed = files.some((f) => !existsSync(f.path) || readFileSync(f.path, 'utf8') !== f.text);
  const followUp = AGENT_FOLLOW_UP.openclaw.replace('<the plugin folder above>', folder);
  if (!changed) return { ok: true, agent: 'openclaw', file: index, changed: false, backupPath: null, followUp };
  const now = opts.now ?? new Date();
  let backupPath: string | null = null;
  for (const f of files) {
    const b = backup(f.path, now);
    if (f.path === index) backupPath = b;
    writeAtomic(f.path, f.text);
  }
  return { ok: true, agent: 'openclaw', file: index, changed: true, backupPath, followUp };
}

/**
 * Installs the openmorals hook for Codex, Gemini CLI, opencode or OpenClaw in a project folder, from each
 * adapter's installSnippet and mergeConfig. An existing file is parsed and merged (never replaced),
 * and copied to `<file>.openmorals-backup-<time>` first. A file that does not parse, or that the
 * merge refuses, is left untouched and the snippet is returned for the user to merge by hand.
 */
export function installAgentHook(dir: string, agent: Exclude<AgentName, 'claude-code'>, opts: AgentInstallOptions = {}): AgentInstallResult {
  if (agent === 'openclaw') return installOpenclaw(dir, opts);
  return agent === 'opencode' ? installOpencode(dir, opts) : installJson(dir, agent, opts);
}
