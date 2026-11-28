import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './helpers.js';

// 0.42.0: API.md's "Stability" section puts every export of the package entry point in one tier: Stable, Preview or
// Internal. The export list is read from the built entry point (dist/src/index.d.ts, by the TypeScript checker, so
// types and namespaces count), never written by hand here. A removed or renamed Stable name fails; a new export
// with no tier fails; a name in a tier that is not exported fails.

/** The Stable exports. Changing this list is a change to what the package promises before 1.0. */
export const STABLE: readonly string[] = ['Action', 'Bylaws', 'BylawsLoad', 'Decision', 'SessionState', 'Verdict', 'decide', 'resolveBylaws'];

/** The Preview exports (0.43.0): may change in a 0.x minor release, each change with a changelog line. */
export const PREVIEW: readonly string[] = ['GuardCallAction', 'GuardCallOptions', 'GuardCallRequest', 'guardCall'];

const TIERS = ['stable', 'preview', 'internal'] as const;
type Tier = (typeof TIERS)[number];

/** The backticked names between `<!-- tier:NAME -->` and `<!-- /tier:NAME -->` in API.md, per tier. */
export function readTiers(md: string): Record<Tier, string[]> {
  const out = {} as Record<Tier, string[]>;
  for (const t of TIERS) {
    const m = new RegExp(`<!-- tier:${t} -->([\\s\\S]*?)<!-- /tier:${t} -->`).exec(md);
    assert.ok(m, `API.md has no ${t} tier block`);
    out[t] = [...(m[1] ?? '').matchAll(/`([A-Za-z_$][\w$]*)`/g)].map((x) => x[1] ?? '');
  }
  return out;
}

/** Every problem with a tier table against the export list. */
export function tierProblems(tiers: Record<Tier, readonly string[]>, exported: readonly string[], stable: readonly string[], preview: readonly string[] = PREVIEW): string[] {
  const out: string[] = [];
  const ex = new Set(exported);
  const seen = new Map<string, Tier>();
  for (const t of TIERS) {
    for (const n of tiers[t]) {
      const was = seen.get(n);
      if (was) out.push(`${n} is in both ${was} and ${t}`);
      seen.set(n, t);
      if (!ex.has(n)) out.push(`${n} (${t}) is not exported`);
    }
  }
  for (const n of exported) if (!seen.has(n)) out.push(`${n} is exported with no tier`);
  const got = [...tiers.stable].sort();
  const want = [...stable].sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) out.push(`stable tier is ${got.join(', ')}; pinned ${want.join(', ')}`);
  const gotP = [...tiers.preview].sort();
  const wantP = [...preview].sort();
  if (JSON.stringify(gotP) !== JSON.stringify(wantP)) out.push(`preview tier is ${gotP.join(', ')}; pinned ${wantP.join(', ')}`);
  return out;
}

interface TsSymbol {
  name: string;
}

/** The names the built entry point exports, values, types and namespaces, read by the TypeScript checker. */
export function exportedNames(root: string): string[] {
  const require = createRequire(join(root, 'package.json'));
  const ts = require('typescript') as {
    createProgram(files: string[], opts: Record<string, unknown>): { getTypeChecker(): unknown; getSourceFile(f: string): unknown };
  };
  const file = join(root, 'dist', 'src', 'index.d.ts');
  const prog = ts.createProgram([file], { noEmit: true, skipLibCheck: true });
  const checker = prog.getTypeChecker() as { getSymbolAtLocation(n: unknown): unknown; getExportsOfModule(s: unknown): TsSymbol[] };
  const sym = checker.getSymbolAtLocation(prog.getSourceFile(file));
  assert.ok(sym, 'the TypeScript checker could not read dist/src/index.d.ts');
  return checker.getExportsOfModule(sym).map((s) => s.name).sort();
}

describe('every export has a stability tier, and the Stable list is pinned (0.42.0)', async () => {
  const exported = exportedNames(REPO_ROOT);
  const runtime = Object.keys(await import(pathToFileURL(join(REPO_ROOT, 'dist', 'src', 'index.js')).href)).sort();
  const tiers = readTiers(readFileSync(join(REPO_ROOT, 'API.md'), 'utf8'));

  it('the export list is the real one', (t) => {
    t.diagnostic(`${exported.length} exports; stable ${tiers.stable.length}, preview ${tiers.preview.length}, internal ${tiers.internal.length}`);
    assert.ok(exported.length >= 400, `only ${exported.length} exports read`);
    assert.ok(runtime.length >= 250, `only ${runtime.length} runtime exports`);
    for (const n of runtime) assert.ok(exported.includes(n), `${n} is a runtime export the checker did not list`);
  });

  it('API.md places every export in exactly one tier, and Stable is the pinned list', () => {
    assert.deepEqual(tierProblems(tiers, exported, STABLE), []);
  });

  it('every Stable value is a runtime export', () => {
    for (const n of ['decide', 'resolveBylaws']) assert.ok(runtime.includes(n), n);
  });

  it('the Stable list is still the 8 names of 0.42.0, and guardCall is a Preview runtime export (0.43.0)', () => {
    assert.equal(STABLE.length, 8);
    assert.ok(runtime.includes('guardCall'), 'guardCall');
    assert.ok(tiers.preview.includes('guardCall'));
  });

  it('the check is not blind: each planted fault is found', () => {
    const drop = (list: readonly string[], n: string): string[] => list.filter((x) => x !== n);
    const cases: readonly [string, Record<Tier, readonly string[]>, readonly string[]][] = [
      ['a Stable export removed', tiers, drop(exported, 'decide')],
      ['a Stable export renamed', { ...tiers, stable: [...drop(tiers.stable, 'decide'), 'decideAction'] }, [...drop(exported, 'decide'), 'decideAction']],
      ['a new export with no tier', tiers, [...exported, 'brandNewExport']],
      ['an Internal export removed', tiers, drop(exported, 'parseCommand')],
      ['a name in two tiers', { ...tiers, preview: ['parseCommand'] }, exported],
      ['a Preview export dropped from its tier', { ...tiers, preview: drop(tiers.preview, 'guardCall'), internal: [...tiers.internal, 'guardCall'] }, exported],
      ['Stable grown', { ...tiers, stable: [...tiers.stable, 'parseCommand'], internal: drop(tiers.internal, 'parseCommand') }, exported],
    ];
    for (const [name, tt, ex] of cases) assert.ok(tierProblems(tt, ex, STABLE).length > 0, `not found: ${name}`);
  });
});
