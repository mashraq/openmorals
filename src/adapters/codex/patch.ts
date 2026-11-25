// The `apply_patch` envelope used by Codex and by opencode's apply_patch tool. Grammar (Codex codex-rs/apply-patch/src/parser.rs):
//   "*** Begin Patch" hunk+ "*** End Patch"; hunk = "*** Add File: " path | "*** Delete File: " path | "*** Update File: " path ["*** Move to: " path]
// The file names, and (0.15.0) the lines each file's hunks add, for content rules; nothing else in a hunk is interpreted.

import { contentText } from '../../inbound/outbound.js';
import type { Action } from '../../types.js';

export type PatchOp = 'add' | 'delete' | 'update' | 'move';

export interface PatchFile {
  op: PatchOp;
  path: string;
}

export type PatchParse = { ok: true; files: PatchFile[] } | { ok: false; error: string };

/** A file a patch names, with the lines its hunks add (each `+` line without the `+`, joined by newlines; absent for a delete). */
export interface PatchFileContent extends PatchFile {
  added?: string;
}

export type PatchContentParse = { ok: true; files: PatchFileContent[] } | { ok: false; error: string };

const MARKERS: readonly [string, PatchOp][] = [
  ['*** Add File: ', 'add'],
  ['*** Delete File: ', 'delete'],
  ['*** Update File: ', 'update'],
  ['*** Move to: ', 'move'],
];

/**
 * Reads a patch's files and the lines each adds. A `*** Move to:` entry shares the added lines of the update it follows;
 * a `*** Delete File:` entry has none. Any other line of a hunk (context, removed lines, `@@` headers) is not content.
 */
export function parsePatchContent(text: string): PatchContentParse {
  const raw = text.split(/\r?\n/);
  const lines = raw.map((l) => l.trim());
  const begin = lines.indexOf('*** Begin Patch');
  if (begin < 0) return { ok: false, error: "the patch has no '*** Begin Patch' line" };
  const files: PatchFileContent[] = [];
  const added = new Map<PatchFileContent, string[]>();
  let current: PatchFileContent[] = [];
  let ended = false;
  for (let i = begin + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line === '*** End Patch') {
      ended = true;
      break;
    }
    let marked = false;
    for (const [marker, op] of MARKERS) {
      if (line.startsWith(marker.trimEnd())) {
        const path = line.slice(marker.trimEnd().length).trim();
        if (path === '') return { ok: false, error: `a '${marker.trim()}' line has no file name` };
        const f: PatchFileContent = { op, path };
        files.push(f);
        if (op === 'move') current.push(f);
        else current = op === 'delete' ? [] : [f];
        if (op !== 'delete') added.set(f, []);
        marked = true;
        break;
      }
    }
    if (marked || line.startsWith('***')) continue;
    const r = raw[i] ?? '';
    if (r.startsWith('+')) for (const f of current) added.get(f)?.push(r.slice(1));
  }
  if (!ended) return { ok: false, error: "the patch has no '*** End Patch' line" };
  if (files.length === 0) return { ok: false, error: 'the patch names no file' };
  for (const f of files) {
    const a = added.get(f);
    if (a !== undefined) f.added = a.join('\n');
  }
  return { ok: true, files };
}

/** The files a patch names (names only, as before 0.15.0). */
export function parsePatchFiles(text: string): PatchParse {
  const p = parsePatchContent(text);
  return p.ok ? { ok: true, files: p.files.map((f) => ({ op: f.op, path: f.path })) } : p;
}

/** One write action per file a patch names, each carrying the lines the patch adds to it as `content` (0.15.0). */
export function patchWrites(files: readonly PatchFileContent[], tool: string): Action[] {
  return files.map((f) => (f.added !== undefined ? { kind: 'write', path: f.path, tool, content: contentText(f.added) } : { kind: 'write', path: f.path, tool }));
}
