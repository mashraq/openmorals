import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { configDir } from './paths.js';
import type { ParsedCommand } from './shell.js';
import type { Action, Bylaws, Decision, SessionState } from './types.js';

export interface Finding {
  decision: Decision;
  rule: string;
  reason: string;
}


export interface Guard {
  id: string;
  isHard(bylaws: Bylaws): boolean;
  evaluate(ctx: GuardContext): Finding[];
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
}

export function isOption(w: string): boolean {
  return w.startsWith('-') && w !== '-' && w !== '--';
}

export function quoteForReason(s: string, max = 80): string {
  const t = s.length > max ? `${s.slice(0, max - 1)}…` : s;
  return `'${t}'`;
}

/**
 * Where a decision is taken: the real config directory (from `configDir()`, so `OPENMORALS_HOME` counts),
 * the working directory relative arguments are read against, the home directory and the folder variables
 * (`~`, `$HOME`, `%APPDATA%` ...) an argument may name, and the link resolver. `decide()` fills it from the
 * process when the caller does not.
 */
export interface Where {
  configDir: string;
  cwd: string;
  home: string;
  /** Lower-case variable name (home, userprofile, appdata, xdg_config_home, openmorals_home) to its value. */
  vars: Readonly<Record<string, string>>;
  /** Resolves symbolic links in an absolute path; see `resolveLinks`. */
  realpath: (p: string) => string;
  /** Whether a path exists: a bare word such as `test` is read as a file in the working directory only when one is there. */
  exists: (p: string) => boolean;
}

export interface GuardContext {
  action: Action;
  parsed: ParsedCommand | null;
  bylaws: Bylaws;
  state: SessionState;
  /** Absent only when a caller builds a context by hand; then the guards use `makeWhere()`. */
  where?: Where;
}

const MAX_LINK_HOPS = 40;

type LinkStat = 'missing' | 'link' | 'other';

function statOf(p: string): LinkStat {
  try {
    const st = lstatSync(p, { throwIfNoEntry: false });
    return st === undefined ? 'missing' : st.isSymbolicLink() ? 'link' : 'other';
  } catch {
    return 'missing';
  }
}

export function pathExists(p: string): boolean {
  return statOf(p) !== 'missing';
}

/**
 * Resolves symbolic links in an absolute path, including a path that does not exist yet: the deepest part
 * that exists is resolved and the rest is appended, and a link whose target is missing is followed by reading
 * it. Only reads the file system (lstat, realpath, readlink); returns the path unchanged when nothing resolves.
 */
export function resolveLinks(p: string): string {
  let head = p;
  const tail: string[] = [];
  for (let hop = 0; hop < MAX_LINK_HOPS; hop++) {
    const kind = statOf(head);
    if (kind !== 'missing') {
      try {
        const real = realpathSync.native(head);
        return tail.length === 0 ? real : join(real, ...[...tail].reverse());
      } catch {
        if (kind !== 'link') return p;
        try {
          const target = readlinkSync(head);
          head = isAbsolute(target) ? target : resolve(dirname(head), target);
          continue;
        } catch {
          return p;
        }
      }
    }
    const parent = dirname(head);
    if (parent === head) return p;
    tail.push(basename(head));
    head = parent;
  }
  return p;
}

function nonEmpty(v: string | undefined): string | undefined {
  return v !== undefined && v !== '' ? v : undefined;
}

/** The `Where` of a process with this environment and working directory; `configDir` defaults to `configDir(env)`. */
export function makeWhere(over: Partial<Where> = {}, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Where {
  const home = over.home ?? homedir();
  const cfg = over.configDir ?? configDir(env, platform, home);
  const vars: Record<string, string> = { home, userprofile: nonEmpty(env['USERPROFILE']) ?? home, openmorals_home: cfg };
  vars['xdg_config_home'] = nonEmpty(env['XDG_CONFIG_HOME']) ?? join(home, '.config');
  vars['appdata'] = nonEmpty(env['APPDATA']) ?? join(home, 'AppData', 'Roaming');
  const localAppData = nonEmpty(env['LOCALAPPDATA']);
  if (localAppData !== undefined) vars['localappdata'] = localAppData;
  return { configDir: cfg, cwd: over.cwd ?? process.cwd(), home, vars: over.vars ?? vars, realpath: over.realpath ?? resolveLinks, exists: over.exists ?? pathExists };
}
