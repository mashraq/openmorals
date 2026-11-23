import * as path from 'node:path';
import type { SandboxPlatform } from './types.js';

export type PathApi = typeof path.posix;

export function pathApi(platform: SandboxPlatform): PathApi {
  return platform === 'win32' ? path.win32 : path.posix;
}

/** Rejects characters no sandbox profile should have to quote: control characters, and on POSIX a double quote or backslash. */
export function unsafePathChar(p: string, platform: SandboxPlatform): string | null {
  if (/[\u0000-\u001f\u007f]/.test(p)) return 'a control character';
  if (platform !== 'win32' && p.includes('"')) return 'a double quote';
  if (platform !== 'win32' && p.includes('\\')) return 'a backslash';
  if (platform === 'win32' && /["*?<>|]/.test(p.replace(/^[A-Za-z]:/, ''))) return 'a character Windows does not allow in paths';
  return null;
}

export function isAbsoluteFor(p: string, platform: SandboxPlatform): boolean {
  if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(p);
  return p.startsWith('/');
}

/** macOS reaches /tmp, /var and /etc through firmlinks; Seatbelt sees the /private form. */
export function canonicalDarwin(p: string): string {
  return p.replace(/^\/(tmp|var|etc)(?=\/|$)/, '/private/$1');
}

export function normalizeFor(p: string, platform: SandboxPlatform): string {
  const api = pathApi(platform);
  let out = api.normalize(p);
  if (out.length > 1) out = out.replace(/[\\/]+$/, '');
  if (platform === 'win32' && /^[A-Za-z]:$/.test(out)) out = `${out}\\`;
  if (platform === 'darwin') out = canonicalDarwin(out);
  return out;
}

function cmpKey(p: string, platform: SandboxPlatform): string {
  return platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p;
}

/** True when `child` is `parent` or below it (case-insensitive on macOS and Windows). */
export function isInside(child: string, parent: string, platform: SandboxPlatform): boolean {
  const api = pathApi(platform);
  const rel = api.relative(cmpKey(parent, platform), cmpKey(child, platform));
  return rel === '' || (!rel.startsWith('..') && !api.isAbsolute(rel));
}

export function isFilesystemRoot(p: string, platform: SandboxPlatform): boolean {
  const api = pathApi(platform);
  return api.parse(p).root === p || api.dirname(p) === p;
}

/**
 * Resolves a configured path: `~` and `~/...` against home, relative paths against the
 * project root, absolute paths as given. `~user` forms are refused (null).
 */
export function resolveConfigured(p: string, root: string, home: string, platform: SandboxPlatform): string | null {
  const api = pathApi(platform);
  if (p === '~') return normalizeFor(home, platform);
  if (p.startsWith('~/') || (platform === 'win32' && p.startsWith('~\\'))) return normalizeFor(api.join(home, p.slice(2)), platform);
  if (p.startsWith('~')) return null;
  if (isAbsoluteFor(p, platform)) return normalizeFor(p, platform);
  if (platform === 'win32' && (/^[A-Za-z]:/.test(p) || p.startsWith('\\') || p.startsWith('/'))) return null;
  return normalizeFor(api.join(root, p), platform);
}
