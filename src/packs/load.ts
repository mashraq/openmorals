import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { parseBylaws } from '../bylaws.js';
import type { BylawsLoad } from '../types.js';
import { readPrinciples, type Activity, type Principle } from './schema.js';

export const PACK_NAMES = ['solo-dev', 'strict', 'ci-unattended', 'production-ops', 'beginner', 'test-lock', 'information-security', 'outward-actions', 'daily', 'privacy', 'health-data', 'regulated-software'] as const;
export type PackName = (typeof PACK_NAMES)[number];

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_PACK_BYTES = 64 * 1024;

export interface PackInfo {
  name: string;
  file: string;
  description: string;
}

export type PackText = { ok: true; name: string; file: string; text: string } | { ok: false; error: string };

export function describePack(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? '';
  const m = /^#\s*pack:\s*[a-z0-9-]+\s*-\s*(.+)$/.exec(first);
  return m?.[1]?.trim() ?? '';
}

/** The packs built into a single executable as assets named `packs/<name>.yaml`, or null when not running as one. */
export interface EmbeddedPacks {
  names: string[];
  read(name: string): string | null;
}

export function embeddedPacks(): EmbeddedPacks | null {
  let sea: typeof import('node:sea') | undefined;
  try {
    sea = process.getBuiltinModule?.('node:sea');
  } catch {
    return null;
  }
  if (sea === undefined || !sea.isSea()) return null;
  const api = sea;
  let keys: string[] = PACK_NAMES.map((n) => `packs/${n}.yaml`);
  try {
    if (typeof api.getAssetKeys === 'function') keys = api.getAssetKeys();
  } catch {
    // keep the shipped names; a missing one reads as null below
  }
  const names = keys.filter((k) => k.startsWith('packs/') && k.endsWith('.yaml')).map((k) => k.slice('packs/'.length, -'.yaml'.length));
  return {
    names,
    read(name: string): string | null {
      try {
        return api.getAsset(`packs/${name}.yaml`, 'utf8');
      } catch {
        return null;
      }
    },
  };
}

export function defaultPacksDir(): string | null {
  let dir: string;
  try {
    dir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'packs', 'solo-dev.yaml'))) return path.join(dir, 'packs');
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

function resolveDir(dir: string | undefined): string | null {
  return dir ?? defaultPacksDir();
}

export function readPackText(name: string, dir?: string): PackText {
  if (!NAME_RE.test(name)) return { ok: false, error: `pack names are lower-case letters, digits and dashes (got ${JSON.stringify(name).slice(0, 80)})` };
  const embedded = dir === undefined ? embeddedPacks() : null;
  if (embedded !== null) {
    if (!embedded.names.includes(name)) return { ok: false, error: `no pack named ${name}` };
    const text = embedded.read(name);
    if (text === null) return { ok: false, error: `the built-in pack ${name} could not be read` };
    if (Buffer.byteLength(text, 'utf8') > MAX_PACK_BYTES) return { ok: false, error: `${name}.yaml is larger than ${MAX_PACK_BYTES} bytes` };
    return { ok: true, name, file: `(built in)/packs/${name}.yaml`, text };
  }
  const d = resolveDir(dir);
  if (d === null) return { ok: false, error: 'the packs folder was not found next to the installed package' };
  const file = path.join(d, `${name}.yaml`);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return { ok: false, error: `no pack named ${name}` };
  }
  if (!st.isFile()) return { ok: false, error: `${name}.yaml is not a regular file` };
  if (st.size > MAX_PACK_BYTES) return { ok: false, error: `${name}.yaml is larger than ${MAX_PACK_BYTES} bytes` };
  try {
    return { ok: true, name, file, text: fs.readFileSync(file, 'utf8') };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function loadPack(name: string, dir?: string): BylawsLoad {
  const t = readPackText(name, dir);
  if (!t.ok) return { ok: false, error: t.error, source: `pack:${name}` };
  return parseBylaws(t.text, `pack:${name}`);
}

export function listPacks(dir?: string): PackInfo[] {
  const embedded = dir === undefined ? embeddedPacks() : null;
  if (embedded !== null) {
    const out: PackInfo[] = [];
    for (const name of [...embedded.names].sort()) {
      const t = readPackText(name);
      if (t.ok) out.push({ name, file: t.file, description: describePack(t.text) });
    }
    return out;
  }
  const d = resolveDir(dir);
  if (d === null) return [];
  let names: string[];
  try {
    names = fs.readdirSync(d);
  } catch {
    return [];
  }
  const out: PackInfo[] = [];
  for (const f of names.sort()) {
    if (!f.endsWith('.yaml')) continue;
    const name = f.slice(0, -'.yaml'.length);
    const t = readPackText(name, d);
    if (!t.ok) continue;
    out.push({ name, file: t.file, description: describePack(t.text) });
  }
  return out;
}

/** What `openmorals packs show` prints for one pack (0.25.0): its principles, split into checked and advice only, and its disclaimer. */
export type PackSummary =
  | { ok: true; source: string; description: string; checked: Principle[]; advisory: Principle[]; disclaimer: string | null; principles: Principle[] }
  | { ok: false; source: string; error: string };

/**
 * Reads a pack (or any bylaws file) the way the hook does, so a pack the loader rejects is rejected here too: a principle
 * with neither `checked_by` nor `advisory`, a `checked_by` id that is not a rule or guard of the file, or a malformed
 * `disclaimer` makes it invalid.
 */
export function packSummary(text: string, source: string): PackSummary {
  const load = parseBylaws(text, source);
  if (!load.ok) return { ok: false, source, error: load.error };
  const raw: unknown = parseYaml(text, { strict: true, uniqueKeys: true, maxAliasCount: 50 });
  const pr = readPrinciples(typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}, load.bylaws);
  if (pr.errors.length > 0) return { ok: false, source, error: pr.errors.join('; ') };
  return { ok: true, source, description: describePack(text), checked: pr.principles.filter((p) => p.checked_by !== undefined), advisory: pr.principles.filter((p) => p.advisory !== undefined), disclaimer: pr.disclaimer, principles: pr.principles };
}

/** The text `openmorals packs show` prints. */
export function formatPackSummary(s: Extract<PackSummary, { ok: true }>, name: string): string {
  const lines: string[] = [`${name}${s.description !== '' ? ` - ${s.description}` : ''}`, `file: ${s.source}`, ''];
  const src = (p: Principle): string => (p.source !== undefined ? ` (${p.source})` : '');
  lines.push(`checked (${s.checked.length}): each is enforced by the rules or guards named, and only as far as they reach`);
  if (s.checked.length === 0) lines.push('  none');
  for (const p of s.checked) lines.push(`  ${p.id}: by ${(p.checked_by ?? []).join(', ')}${src(p)}`);
  lines.push('');
  lines.push(`advice only, not checked (${s.advisory.length}): text for you; no rule or guard enforces it, and the agent is not held to it`);
  if (s.advisory.length === 0) lines.push('  none');
  for (const p of s.advisory) lines.push(`  ${p.id}: ${p.advisory ?? ''}${src(p)}`);
  lines.push('');
  const guided = s.principles.filter((p) => p.guidance !== undefined);
  if (guided.length > 0) {
    const count = (a: Activity): number => guided.filter((p) => (p.activities ?? []).includes(a)).length;
    lines.push(`guidance for the agent (${guided.length} lines): advice only, not checked; written into the agent's instructions only by openmorals init with this pack`);
    lines.push(`  always on: ${count('always')} lines; skills: documents ${count('documents')}, forms ${count('forms')}, email-and-links ${count('email-and-links')}`);
    lines.push('  a line is checked only where its principle above names a guard, and only as far as that guard reaches');
    lines.push('');
  }
  if (s.disclaimer === null) lines.push('disclaimer: none');
  else {
    lines.push('disclaimer:');
    for (const l of s.disclaimer.split(/\r?\n/)) lines.push(`  ${l}`);
  }
  return `${lines.join('\n')}\n`;
}
