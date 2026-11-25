import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from '../paths.js';

/** The held-tests file in the configuration directory (0.32.0): tests the person has put on hold as flaky. */
export const QUARANTINE_FILE = 'tests-quarantine.txt';

export interface Hold {
  id: string;
  /** Why it is held, from the text after " # " on its line; empty when none. */
  why: string;
  line: number;
}

/**
 * Reads a held-tests file: one test id per line, optionally followed by " # why". Blank lines and lines starting with #
 * are skipped. A held test's loss does not block a comparison, it never counts as a gain or as proof, and a held
 * acceptance test fails the fail-first gate. The file sits in the configuration directory, which the self-protect
 * guard keeps the agent from writing: only the person adds a hold.
 */
export function parseQuarantine(text: string): Hold[] {
  const out: Hold[] = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const cut = line.indexOf(' # ');
    const id = (cut === -1 ? line : line.slice(0, cut)).trim();
    if (id === '') continue;
    out.push({ id, why: cut === -1 ? '' : line.slice(cut + 3).trim(), line: i + 1 });
  }
  return out;
}

export function readQuarantine(env: NodeJS.ProcessEnv = process.env): { ok: true; holds: Hold[]; file: string; present: boolean } | { ok: false; error: string; file: string } {
  const file = join(configDir(env), QUARANTINE_FILE);
  try {
    return { ok: true, holds: parseQuarantine(readFileSync(file, 'utf8')), file, present: true };
  } catch (e: unknown) {
    if (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOENT') return { ok: true, holds: [], file, present: false };
    return { ok: false, error: `cannot read the held-tests file ${file}: ${e instanceof Error ? e.message : String(e)}`, file };
  }
}

export function heldSet(holds: readonly Hold[]): Set<string> {
  return new Set(holds.map((h) => h.id));
}
