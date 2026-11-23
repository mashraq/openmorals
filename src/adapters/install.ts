import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as codex from './codex/index.js';
import * as gemini from './gemini-cli/index.js';
import * as opencode from './opencode/index.js';

export type AgentName = 'claude-code' | 'codex' | 'gemini-cli' | 'opencode';
export const AGENT_NAMES: readonly AgentName[] = ['claude-code', 'codex', 'gemini-cli', 'opencode'];

export function isAgentName(v: string): v is AgentName {
  return (AGENT_NAMES as readonly string[]).includes(v);
}

/** What the user must still do in the host after the file is written. */
export const AGENT_FOLLOW_UP: Readonly<Record<Exclude<AgentName, 'claude-code'>, string>> = {
  codex: 'In Codex, open /hooks and trust the new hook: Codex skips hooks that are not trusted, and loads project hooks only in a trusted project.',
  'gemini-cli': 'Gemini CLI fingerprints project hooks and warns you before a new one runs; accept it there.',
  opencode: 'opencode loads .opencode/plugins/ when it starts or reloads; restart it.',
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

/**
 * Installs the openmorals hook for Codex, Gemini CLI or opencode in a project folder, from each
 * adapter's installSnippet and mergeConfig. An existing file is parsed and merged (never replaced),
 * and copied to `<file>.openmorals-backup-<time>` first. A file that does not parse, or that the
 * merge refuses, is left untouched and the snippet is returned for the user to merge by hand.
 */
export function installAgentHook(dir: string, agent: Exclude<AgentName, 'claude-code'>, opts: AgentInstallOptions = {}): AgentInstallResult {
  return agent === 'opencode' ? installOpencode(dir, opts) : installJson(dir, agent, opts);
}
