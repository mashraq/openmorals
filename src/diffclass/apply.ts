import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { Hunk } from './parse.js';

/** Largest base file read to rebuild a changed file. */
export const MAX_BASE_FILE_BYTES = 4 * 1024 * 1024;

/** Reads a file of the base tree by its repository path, or says why it cannot. */
export interface BaseReader {
  name: string;
  read(path: string): { ok: true; bytes: Uint8Array } | { ok: false; error: string };
}

/** A folder holding the base tree. Only regular files inside the folder (after resolving links) are read. */
export function folderReader(dir: string): BaseReader {
  return {
    name: dir,
    read(path: string) {
      try {
        const root = realpathSync(dir);
        const full = join(root, ...path.split('/'));
        const real = realpathSync(full);
        if (real !== full || !real.startsWith(root + sep)) return { ok: false, error: `${path} in the base folder is or passes through a link` };
        const st = lstatSync(real);
        if (!st.isFile()) return { ok: false, error: `${path} in the base folder is not a regular file` };
        if (st.size > MAX_BASE_FILE_BYTES) return { ok: false, error: `${path} in the base folder is larger than ${MAX_BASE_FILE_BYTES} bytes` };
        return { ok: true, bytes: readFileSync(real) };
      } catch (e: unknown) {
        const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
        return { ok: false, error: code === 'ENOENT' ? `${path} is not in the base folder ${dir}` : `cannot read ${path} in the base folder: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  };
}

/** A reader over fixed contents (tests and case rows). */
export function memoryReader(files: Readonly<Record<string, string>>, name = '<memory>'): BaseReader {
  return {
    name,
    read(path: string) {
      const t = Object.prototype.hasOwnProperty.call(files, path) ? files[path] : undefined;
      return t === undefined ? { ok: false, error: `${path} is not in the base folder ${name}` } : { ok: true, bytes: new TextEncoder().encode(t) };
    },
  };
}

/** The git object id of a blob with this content, SHA-1 or SHA-256. */
export function gitBlobHash(bytes: Uint8Array, algo: 'sha1' | 'sha256'): string {
  return createHash(algo).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** True when an `index` line hash (full or abbreviated to at least 7 digits) names this content. */
export function hashNames(indexHash: string, bytes: Uint8Array): boolean {
  if (!/^[0-9a-f]{7,64}$/.test(indexHash)) return false;
  return [gitBlobHash(bytes, 'sha1'), gitBlobHash(bytes, 'sha256')].some((h) => h.startsWith(indexHash) && (indexHash.length <= 40 || h.length === 64));
}

/**
 * Applies the hunks of one file to its base text, checking every context and removed line. The caller also checks the
 * result against the diff's `index` hash, so a mistake here can only make a file need review.
 */
export function applyHunks(base: string, hunks: readonly Hunk[]): { ok: true; text: string } | { ok: false; error: string } {
  const hadEol = base === '' || base.endsWith('\n');
  const src = base === '' ? [] : (hadEol ? base.slice(0, -1) : base).split('\n');
  const out: string[] = [];
  let pos = 0;
  let lastNewNoEol = false;
  for (const h of hunks) {
    const start = h.oldLines === 0 ? h.oldStart : h.oldStart - 1;
    if (start < pos || start > src.length) return { ok: false, error: `the hunk at line ${h.line} starts outside the base file` };
    out.push(...src.slice(pos, start));
    pos = start;
    lastNewNoEol = false;
    for (const l of h.lines) {
      if (l.op !== '+') {
        if (src[pos] !== l.text) return { ok: false, error: `the hunk at line ${h.line} does not match the base file at line ${pos + 1}` };
        pos++;
        if (l.noEol && (pos !== src.length || hadEol)) return { ok: false, error: `the hunk at line ${h.line} says the base file has no final newline, and it has one` };
      }
      if (l.op !== '-') {
        out.push(l.text);
        lastNewNoEol = l.noEol;
      }
    }
  }
  const touchedEnd = pos === src.length;
  out.push(...src.slice(pos));
  const eol = touchedEnd ? !lastNewNoEol : hadEol;
  return { ok: true, text: out.length === 0 ? '' : `${out.join('\n')}${eol ? '\n' : ''}` };
}
