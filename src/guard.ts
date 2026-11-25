import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { configDir } from './paths.js';
import type { ParsedCommand } from './shell.js';
import type { OutboundView } from './outbound/memory.js';
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
  /**
   * What is at an absolute path (0.18.0, the document guard): its size, and its text when `maxText` is above 0 and the
   * file is no larger. Never writes; reads at most `maxText` bytes. See `probeFile`.
   */
  readFile: (p: string, maxText: number) => FileProbe;
  /**
   * The volume (device number) an absolute path is on, or null when it cannot be told (0.21.0, the delete guard: a move
   * into the trash is a rename, which cannot cross volumes). One `stat`; never writes. See `volumeOf`.
   */
  volume?: (p: string) => number | null;
  /**
   * What this session remembers for the outbound guard (0.20.0) and the time it is judged at. Absent when there is no
   * session (a case row, `openmorals check`): the guard then judges from the action alone.
   */
  outbound?: OutboundView;
  /**
   * The sha256 of what is at an absolute path (0.24.0, the replace guard), reading at most `maxBytes` (a larger file is
   * `large`, unread). Never writes. See `hashFile`.
   */
  hash?: (p: string, maxBytes: number) => HashProbe;
  /** Content this session put in a file whole, as the post-tool event saw it (0.24.0, the replace guard). Absent outside a session. */
  wrote?: readonly WroteWhole[];
}

/** A file this session replaced or made whole (0.24.0): its absolute path and the sha256 of what it held after the call. */
export interface WroteWhole {
  p: string;
  h: string;
}

/** What `Where.hash` found: as `FileProbe`, with `large` for a file over the limit and `hash` with the sha256 of its bytes. */
export type HashProbe = { kind: 'missing' } | { kind: 'other' } | { kind: 'error'; error: string } | { kind: 'large'; bytes: number } | { kind: 'hash'; bytes: number; sha256: string };

/** The sha256 of a regular file's bytes, reading at most `maxBytes` (0.24.0). One open, reads in 1 MiB pieces, never writes. */
export function hashFile(p: string, maxBytes: number): HashProbe {
  let fd: number | null = null;
  try {
    const st = statSync(p);
    if (!st.isFile()) return { kind: 'other' };
    if (st.size > maxBytes) return { kind: 'large', bytes: st.size };
    fd = openSync(p, 'r');
    if (!fstatSync(fd).isFile()) return { kind: 'other' };
    const h = createHash('sha256');
    const buf = Buffer.alloc(Math.min(1 << 20, Math.max(1, maxBytes + 1)));
    let got = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      got += n;
      if (got > maxBytes) return { kind: 'large', bytes: got };
      h.update(buf.subarray(0, n));
    }
    return { kind: 'hash', bytes: got, sha256: h.digest('hex') };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    return { kind: 'error', error: code ?? (err instanceof Error ? err.message : String(err)) };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * What `Where.readFile` found: nothing there; something that is not a regular file (a folder, a device); an error other
 * than "not found" (no permission, a loop of links); or a file with its size in bytes and, when asked for and no larger
 * than the limit, its text (UTF-8).
 */
export type FileProbe = { kind: 'missing' } | { kind: 'other' } | { kind: 'error'; error: string } | { kind: 'file'; bytes: number; text?: string };

/**
 * Reads what is at a path for the document guard: one `stat`, and when `maxText` is above 0 and the file is at most that
 * size, its text, reading at most `maxText + 1` bytes (a file that grew past the limit after the stat gets no text).
 */
export function probeFile(p: string, maxText: number): FileProbe {
  let size: number;
  try {
    const st = statSync(p);
    if (!st.isFile()) return { kind: 'other' };
    size = st.size;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    return { kind: 'error', error: code ?? (err instanceof Error ? err.message : String(err)) };
  }
  if (maxText <= 0 || size > maxText) return { kind: 'file', bytes: size };
  let fd: number | null = null;
  try {
    fd = openSync(p, 'r');
    const buf = Buffer.alloc(maxText + 1);
    let got = 0;
    for (;;) {
      const n = readSync(fd, buf, got, buf.length - got, null);
      if (n === 0) break;
      got += n;
      if (got >= buf.length) break;
    }
    if (got > maxText) return { kind: 'file', bytes: got };
    return { kind: 'file', bytes: got, text: buf.subarray(0, got).toString('utf8') };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    return { kind: 'error', error: code ?? (err instanceof Error ? err.message : String(err)) };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The device number of what is at a path (following links), or null when it cannot be read. */
export function volumeOf(p: string): number | null {
  try {
    return statSync(p).dev;
  } catch {
    return null;
  }
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
  const out: Where = { configDir: cfg, cwd: over.cwd ?? process.cwd(), home, vars: over.vars ?? vars, realpath: over.realpath ?? resolveLinks, exists: over.exists ?? pathExists, readFile: over.readFile ?? probeFile, volume: over.volume ?? volumeOf };
  if (over.outbound !== undefined) out.outbound = over.outbound;
  out.hash = over.hash ?? hashFile;
  if (over.wrote !== undefined) out.wrote = over.wrote;
  return out;
}
