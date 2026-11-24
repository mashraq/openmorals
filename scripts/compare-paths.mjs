// Path normalisation for compare-binary.mjs: the Node CLI and the binary run in two different temporary folders, so a
// folder name in their output is not a difference. A folder can appear in several spellings: as given, JSON-escaped
// (backslashes doubled, as in `sandbox plan --json` on Windows), with forward slashes, and on Windows in its long form
// (C:\Users\runneradmin\...) or its 8.3 short form (C:\Users\RUNNER~1\...), in any letter case.

import { realpathSync } from 'node:fs';

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Every spelling of `dir` that may appear in output. `extra` adds spellings the caller knows (tests pass a short or long form). */
export function pathSpellings(dir, platform = process.platform, extra = []) {
  const bases = new Set([dir, ...extra]);
  for (const resolve of [realpathSync.native, realpathSync]) {
    try {
      bases.add(resolve(dir));
    } catch {
      // A folder that cannot be resolved keeps the spellings it has.
    }
  }
  const out = new Set();
  for (const b of bases) {
    if (b === '') continue;
    out.add(b);
    out.add(JSON.stringify(b).slice(1, -1));
    if (platform === 'win32') out.add(b.replace(/\\/g, '/'));
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** Replaces every spelling of each folder in `text` with its token (for example `<cwd>`); case-insensitive on Windows. */
export function normalisePaths(text, folders, platform = process.platform) {
  let out = text;
  for (const { dir, token, extra } of folders) {
    for (const spelling of pathSpellings(dir, platform, extra ?? [])) {
      out = out.replace(new RegExp(escapeRegExp(spelling), platform === 'win32' ? 'gi' : 'g'), token);
    }
  }
  return out;
}
