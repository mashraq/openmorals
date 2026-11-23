// The `apply_patch` envelope used by Codex and by opencode's apply_patch tool. Grammar (Codex codex-rs/apply-patch/src/parser.rs):
//   "*** Begin Patch" hunk+ "*** End Patch"; hunk = "*** Add File: " path | "*** Delete File: " path | "*** Update File: " path ["*** Move to: " path]
// Only the file names are needed here; the hunk bodies are never interpreted.

export type PatchOp = 'add' | 'delete' | 'update' | 'move';

export interface PatchFile {
  op: PatchOp;
  path: string;
}

export type PatchParse = { ok: true; files: PatchFile[] } | { ok: false; error: string };

const MARKERS: readonly [string, PatchOp][] = [
  ['*** Add File: ', 'add'],
  ['*** Delete File: ', 'delete'],
  ['*** Update File: ', 'update'],
  ['*** Move to: ', 'move'],
];

export function parsePatchFiles(text: string): PatchParse {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const begin = lines.indexOf('*** Begin Patch');
  if (begin < 0) return { ok: false, error: "the patch has no '*** Begin Patch' line" };
  const files: PatchFile[] = [];
  let ended = false;
  for (let i = begin + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line === '*** End Patch') {
      ended = true;
      break;
    }
    for (const [marker, op] of MARKERS) {
      if (line.startsWith(marker.trimEnd())) {
        const path = line.slice(marker.trimEnd().length).trim();
        if (path === '') return { ok: false, error: `a '${marker.trim()}' line has no file name` };
        files.push({ op, path });
        break;
      }
    }
  }
  if (!ended) return { ok: false, error: "the patch has no '*** End Patch' line" };
  if (files.length === 0) return { ok: false, error: 'the patch names no file' };
  return { ok: true, files };
}
