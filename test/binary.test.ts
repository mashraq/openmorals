import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { embeddedPacks, listPacks, PACK_NAMES } from '../src/packs/index.js';
import { REPO_ROOT } from './helpers.js';

interface BuildScript {
  supportsBuildSea(version: string): boolean;
  binaryName(platform: string, arch: string, releaseName: boolean): string | null;
}

async function buildScript(): Promise<BuildScript> {
  const mod: BuildScript = await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'build-binary.mjs')).href);
  return mod;
}

describe('single executable build', () => {
  it('needs Node 25.5 or later for --build-sea', async () => {
    const s = await buildScript();
    assert.equal(s.supportsBuildSea('v24.19.0'), false);
    assert.equal(s.supportsBuildSea('v25.4.9'), false);
    assert.equal(s.supportsBuildSea('v25.5.0'), true);
    assert.equal(s.supportsBuildSea('v26.13.1'), true);
    assert.equal(s.supportsBuildSea('nonsense'), false);
  });

  it('names release binaries by OS and CPU, with .exe on Windows', async () => {
    const s = await buildScript();
    assert.equal(s.binaryName('linux', 'x64', true), 'openmorals-linux-x64');
    assert.equal(s.binaryName('linux', 'arm64', true), 'openmorals-linux-arm64');
    assert.equal(s.binaryName('darwin', 'arm64', true), 'openmorals-macos-arm64');
    assert.equal(s.binaryName('darwin', 'x64', true), 'openmorals-macos-x64');
    assert.equal(s.binaryName('win32', 'x64', true), 'openmorals-windows-x64.exe');
    assert.equal(s.binaryName('win32', 'x64', false), 'openmorals.exe');
    assert.equal(s.binaryName('freebsd', 'x64', true), null);
  });

  it('answers --help without building anything', () => {
    const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'build-binary.mjs'), '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--build-sea/);
    const c = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'compare-binary.mjs'), '--help'], { encoding: 'utf8' });
    assert.equal(c.status, 0);
    assert.match(c.stdout, /same answers/);
  });

  it('refuses an unknown argument', () => {
    const r = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'build-binary.mjs'), '--publish'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown argument/);
  });

  it('outside a single executable the packs come from the folder, not from assets', () => {
    assert.equal(embeddedPacks(), null);
    assert.deepEqual(listPacks().map((p) => p.name).sort(), [...PACK_NAMES].sort());
    assert.ok(listPacks().every((p) => !p.file.startsWith('(built in)')));
  });

  it('pins the bundler to an exact version and keeps build output out of git', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { devDependencies: Record<string, string>; dependencies: Record<string, string> };
    assert.match(pkg.devDependencies['esbuild'] ?? '', /^\d+\.\d+\.\d+$/);
    assert.deepEqual(Object.keys(pkg.dependencies), ['yaml']);
    assert.match(readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8'), /^build\/$/m);
  });
});

describe('third-party licences', () => {
  it('the build writes the Node.js and yaml licences next to the binary', async () => {
    const mod: { writeThirdPartyNotices(file: string): string | null } = await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'build-binary.mjs')).href);
    const dir = mkdtempSync(join(tmpdir(), 'openmorals-test-notices-'));
    try {
      const file = mod.writeThirdPartyNotices(join(dir, 'THIRD-PARTY-LICENSES.txt'));
      assert.notEqual(file, null, `no Node.js LICENSE next to ${process.execPath}`);
      const text = readFileSync(file ?? '', 'utf8');
      assert.match(text, /===== Node\.js =====/);
      assert.match(text, /===== yaml/);
      assert.match(text, /Eemeli Aro/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('compare-binary path normalisation (Windows-shaped output)', () => {
  interface PathsModule {
    normalisePaths(text: string, folders: { dir: string; token: string; extra?: string[] }[], platform?: string): string;
  }
  const load = async (): Promise<PathsModule> => (await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'compare-paths.mjs')).href)) as PathsModule;
  it('replaces a folder written raw, JSON-escaped, with forward slashes and in its 8.3 short form, in any case', async () => {
    const { normalisePaths } = await load();
    const long = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\openmorals-compare-J4BNuW\\cwd-node-WIBbxn';
    const short = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\openmorals-compare-J4BNuW\\cwd-node-WIBbxn';
    const json = `{"projectRoot": ${JSON.stringify(short)}, "writable": [${JSON.stringify(`${long}\\out`)}], "raw": "${short.toLowerCase()}", "fwd": "${long.replace(/\\/g, '/')}"}`;
    const out = normalisePaths(json, [{ dir: short, token: '<cwd>', extra: [long] }], 'win32');
    assert.equal(out, '{"projectRoot": "<cwd>", "writable": ["<cwd>\\\\out"], "raw": "<cwd>", "fwd": "<cwd>"}');
  });
  it('the two sides of a comparison normalise to the same text', async () => {
    const { normalisePaths } = await load();
    const side = (d: string): string => `{"projectRoot": ${JSON.stringify(d)}}`;
    const a = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\openmorals-compare-X\\cwd-node-AAAA';
    const b = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\openmorals-compare-X\\cwd-bin-BBBB';
    assert.equal(normalisePaths(side(a), [{ dir: a, token: '<cwd>' }], 'win32'), normalisePaths(side(b), [{ dir: b, token: '<cwd>' }], 'win32'));
  });
  it('stays case-sensitive and slash-exact on POSIX', async () => {
    const { normalisePaths } = await load();
    assert.equal(normalisePaths('/tmp/x/cwd-a and /TMP/X/CWD-A', [{ dir: '/tmp/x/cwd-a', token: '<cwd>' }], 'linux'), '<cwd> and /TMP/X/CWD-A');
  });
});
