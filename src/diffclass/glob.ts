/**
 * Path globs for the merge verdict, matched against the POSIX paths of a diff (case-insensitive, so a file system that
 * ignores case cannot be used to step around a rule).
 *
 * - A glob with no `/` (other than a trailing one) matches a file or folder name at any depth: `README*`, `.claude/`.
 * - A glob with a `/` is anchored at the repository root: `docs/adr/0013-*`, `src/**`.
 * - `*` matches within one path segment, `?` one character of it, `**` any number of whole segments.
 * - A glob that matches a folder matches everything under it.
 */

const MAX_GLOB = 256;

/** Why a glob cannot be used, or null when it can. */
export function globProblem(glob: string): string | null {
  if (glob.trim() === '') return 'is empty';
  if (glob.length > MAX_GLOB) return `is longer than ${MAX_GLOB} characters`;
  if (/[\u0000-\u001f\u007f]/.test(glob)) return 'has a control character';
  if (glob.startsWith('/')) return 'must be relative to the repository root (no leading /)';
  if (glob.includes('\\')) return 'must use / between folders';
  if (/(^|\/)\.\.(\/|$)/.test(glob)) return 'must not contain ..';
  if (/[[\]{}]/.test(glob) || glob.startsWith('!')) return 'uses [ ] { } or a leading !, which are not supported (use * ? and **)';
  return null;
}

function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

function segmentRe(seg: string): string {
  let out = '';
  for (const ch of seg) {
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += escapeRe(ch);
  }
  return out;
}

/** Compiles a glob (assumed to pass `globProblem`) to a test over one path. */
export function compileGlob(glob: string): (path: string) => boolean {
  const g = glob.replace(/\/+$/, '');
  const anchored = g.includes('/');
  const segs = g.split('/');
  let body = '';
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i] ?? '';
    const last = i === segs.length - 1;
    if (s === '**') body += last ? '.*' : '(?:[^/]+/)*';
    else body += segmentRe(s) + (last ? '' : '/');
  }
  const re = new RegExp(anchored ? `^${body}$` : `^(?:.*/)?${body}$`, 'i');
  return (path: string): boolean => {
    const parts = path.split('/');
    for (let n = 1; n <= parts.length; n++) {
      if (re.test(parts.slice(0, n).join('/'))) return true;
    }
    return false;
  };
}

/** The first glob of the list that matches the path, or null. */
export function firstMatch(globs: readonly string[], path: string): string | null {
  for (const g of globs) if (compileGlob(g)(path)) return g;
  return null;
}
