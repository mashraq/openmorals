import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, tempDir } from './helpers.js';

// 0.42.0: what `npm pack` would put in the tarball, read from npm itself (`npm pack --dry-run --json`), with scripts
// ignored (no rebuild while the tests run), offline, and with an empty user config in a temp folder, so no registry,
// account or credential is read or needed. The list must hold everything the package needs at run time and nothing
// it should not ship. The needed list for src/, packs/, cases/ and skills/ is what git tracks (`git ls-files`, local and
// offline), so a stray or untracked file in a shipped folder is red, not packed.

interface PackFile {
  path: string;
  size: number;
}

interface PackResult {
  files: PackFile[];
  size: number;
  unpackedSize: number;
  entryCount: number;
}

interface PackageJson {
  main: string;
  types: string;
  bin: Record<string, string>;
  exports: unknown;
  files: string[];
  scripts: Record<string, string>;
}

/** The smallest number of files a real pack can have: the built engine alone is over 300 files. */
export const PACK_FLOOR = 300;

const FORBIDDEN: readonly { re: RegExp; why: string }[] = [
  { re: /^dist\/test\//, why: 'compiled tests' },
  { re: /^(test|src|scripts|build|python|docs|node_modules|coverage)\//, why: 'a folder the package does not ship' },
  { re: /\.map$/, why: 'a source map' },
  { re: /(^|\/)\./, why: 'a dotfile or dot folder' },
  { re: /\.(tgz|log|pem|key|p12|pfx)$/i, why: 'an archive, a log or a key file' },
  { re: /\.test\.(js|d\.ts)$/, why: 'a test file' },
  { re: /(?<!\.d)\.ts$/, why: 'a TypeScript source (only .d.ts ships)' },
];

/** The shipped folders whose every file ships: the needed list for them is the files git tracks there, never what is on disk. */
export const SHIPPED_DIRS = ['packs', 'cases', 'skills'] as const;

const DOCS = ['package.json', 'README.md', 'LICENSE', 'NOTICE', 'CHANGELOG.md', 'API.md'];

function norm(p: string): string {
  return p.replace(/^\.\//, '');
}

function exportTargets(e: unknown): string[] {
  if (typeof e === 'string') return [norm(e)];
  if (e !== null && typeof e === 'object') return Object.values(e).flatMap(exportTargets);
  return [];
}

/** The files git tracks under src/ and the shipped folders, read offline from the local index. Fails, never returns empty, when git cannot run. */
export function trackedFiles(root: string): string[] {
  const r = spawnSync('git', ['-C', root, 'ls-files', '-z', '--', 'src', ...SHIPPED_DIRS], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 0, `git ls-files failed (${r.error?.message ?? `exit ${r.status}`}): ${r.stderr}`);
  const out = r.stdout.split('\0').filter((f) => f !== '');
  assert.ok(out.length > 0, 'git tracks no file under src/, packs/, cases/ or skills/');
  return out.sort();
}

/** Every file the package needs: the docs, the bin, main, types and export targets, a .js and .d.ts per source module git tracks, and every pack, case file and skill file git tracks. */
export function neededFiles(pkg: PackageJson, root: string, tracked: readonly string[] = trackedFiles(root)): string[] {
  const need = new Set<string>(DOCS);
  for (const b of Object.values(pkg.bin)) need.add(norm(b));
  need.add(norm(pkg.main));
  need.add(norm(pkg.types));
  for (const t of exportTargets(pkg.exports)) need.add(t);
  for (const f of tracked) {
    if (!f.startsWith('src/') || !f.endsWith('.ts') || f.endsWith('.d.ts')) continue;
    const base = `dist/${f.slice(0, -3)}`;
    need.add(`${base}.js`);
    need.add(`${base}.d.ts`);
  }
  for (const f of tracked) if (SHIPPED_DIRS.some((d) => f.startsWith(`${d}/`))) need.add(f);
  return [...need].sort();
}

/** What is wrong with a pack list: a needed file missing, a file it must not hold, or fewer files than the floor. The list must be exactly the needed files. */
export function packProblems(files: readonly string[], need: readonly string[]): string[] {
  const have = new Set(files);
  const out: string[] = [];
  if (files.length < PACK_FLOOR) out.push(`only ${files.length} files, under the floor of ${PACK_FLOOR}`);
  for (const n of need) if (!have.has(n)) out.push(`missing ${n}`);
  for (const f of files) {
    const bad = FORBIDDEN.find((x) => x.re.test(f));
    if (bad) out.push(`must not ship ${f} (${bad.why})`);
    else if (need.includes(f)) continue;
    else if (f.startsWith('dist/')) out.push(`must not ship ${f} (a built file with no source: build from a clean folder)`);
    else if (SHIPPED_DIRS.some((d) => f.startsWith(`${d}/`))) out.push(`must not ship ${f} (git does not track it: a stray or scratch file)`);
    else out.push(`must not ship ${f} (not a file the package needs)`);
  }
  return out;
}

function npmCommand(): { cmd: string; pre: string[]; shell: boolean } {
  const cli = process.env['npm_execpath'];
  if (cli && /npm-cli\.js$/.test(cli)) return { cmd: process.execPath, pre: [cli], shell: false };
  return { cmd: 'npm', pre: [], shell: process.platform === 'win32' };
}

/** Runs npm's own dry run over the repository and returns what it would pack. Fails, never returns empty, when npm cannot run. */
export function npmPackList(root: string): PackResult {
  const tmp = tempDir('om-pack-');
  const rc = join(tmp, 'npmrc');
  const grc = join(tmp, 'global-npmrc');
  writeFileSync(rc, '');
  writeFileSync(grc, '');
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^npm_/i.test(k)) env[k] = v;
  Object.assign(env, { npm_config_userconfig: rc, npm_config_globalconfig: grc, npm_config_cache: join(tmp, 'cache'), npm_config_offline: 'true', npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' });
  const { cmd, pre, shell } = npmCommand();
  const r = spawnSync(cmd, [...pre, 'pack', '--dry-run', '--json', '--ignore-scripts', '--offline'], { cwd: root, env, encoding: 'utf8', shell, timeout: 60_000 });
  assert.equal(r.status, 0, `npm pack --dry-run failed (${r.error?.message ?? `exit ${r.status}`}): ${r.stderr}`);
  const parsed = JSON.parse(r.stdout) as PackResult[];
  const first = parsed[0];
  assert.ok(first && Array.isArray(first.files), 'npm pack --dry-run --json printed no file list');
  return first;
}

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as PackageJson;

describe('the npm tarball holds what the package needs and nothing else (0.42.0)', () => {
  const pack = npmPackList(REPO_ROOT);
  const files = pack.files.map((f) => f.path).sort();
  const need = neededFiles(pkg, REPO_ROOT);

  it('npm would pack every needed file and none it must not', (t) => {
    t.diagnostic(`packed ${pack.entryCount} files, ${pack.size} bytes, ${pack.unpackedSize} unpacked`);
    assert.deepEqual(packProblems(files, need), []);
    assert.equal(files.length, pack.entryCount);
  });

  it('the list of needed files is not empty or partial', () => {
    assert.ok(need.length >= PACK_FLOOR, `needed list has ${need.length} files`);
    for (const f of ['dist/src/cli.js', 'dist/src/index.js', 'dist/src/index.d.ts', 'packs/solo-dev.yaml', 'cases/destructive.cases.yaml']) assert.ok(need.includes(f), f);
    assert.ok(need.some((f) => f.startsWith('skills/') && f.endsWith('SKILL.md')), 'a skill file');
  });

  it('the bin starts with a node shebang', () => {
    for (const b of Object.values(pkg.bin)) assert.match(readFileSync(join(REPO_ROOT, b), 'utf8').split('\n')[0] ?? '', /^#!\/usr\/bin\/env node\b/);
  });

  it('packing rebuilds from a clean folder first', () => {
    assert.equal(pkg.scripts['prepack'], 'npm run clean && npm run build');
    assert.match(pkg.scripts['clean'] ?? '', /rmSync\('dist'/);
  });

  it('the check is not blind: each planted fault is found', () => {
    const planted: readonly [string, string[]][] = [
      ['a dotfile', [...files, '.npmrc']],
      ['a dot folder', [...files, 'dist/src/.cache/x.js']],
      ['compiled tests', [...files, 'dist/test/engine.test.js']],
      ['a source map', [...files, 'dist/src/index.js.map']],
      ['a TypeScript source', [...files, 'src/index.ts']],
      ['an untracked file in a shipped folder', [...files, 'cases/attack-notes.md']],
      ['an untracked pack backup', [...files, 'packs/daily.yaml.orig']],
      ['a top-level file nobody listed', [...files, 'plan.md']],
      ['a key file', [...files, 'cases/server.pem']],
      ['a stale built file', [...files, 'dist/src/gone.js']],
      ['no bin target', files.filter((f) => f !== 'dist/src/cli.js')],
      ['no type file', files.filter((f) => f !== 'dist/src/engine.d.ts')],
      ['no pack', files.filter((f) => f !== 'packs/daily.yaml')],
      ['no case file', files.filter((f) => f !== 'cases/secrets.cases.yaml')],
      ['no skill', files.filter((f) => !f.startsWith('skills/'))],
      ['no README', files.filter((f) => f !== 'README.md')],
      ['no CHANGELOG', files.filter((f) => f !== 'CHANGELOG.md')],
      ['too few files', ['package.json', 'README.md']],
    ];
    for (const [name, list] of planted) assert.ok(packProblems(list, need).length > 0, `not found: ${name}`);
  });
});
