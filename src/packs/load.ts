import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBylaws } from '../bylaws.js';
import type { BylawsLoad } from '../types.js';

export const PACK_NAMES = ['solo-dev', 'strict', 'ci-unattended', 'production-ops', 'beginner'] as const;
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

export function defaultPacksDir(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
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
