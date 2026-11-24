#!/usr/bin/env node
// Builds the openmorals single executable for the OS and CPU this runs on, with
// Node's own single executable application support (node --build-sea, Node >= 25.5).
//
//   npm run build && node scripts/build-binary.mjs [--release-name] [--allow-shared-node]
//
// The compiled CLI (dist/src/cli.js) is bundled into one CommonJS file with esbuild,
// because a single executable loads only Node's built-in modules from inside itself;
// the bylaws packs travel inside the binary as assets (packs/<name>.yaml).
// Output: build/openmorals (build/openmorals.exe on Windows), or with --release-name
// build/openmorals-<os>-<arch>[.exe] where <os> is linux, macos or windows.
//
// --allow-shared-node: build even when this Node links libnode as a shared library
// (Homebrew and some distro builds). That binary needs those libraries at run time,
// so it is for local testing only and must never be published.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HELP = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  .split('\n')
  .slice(1)
  .filter((l) => l.startsWith('//'))
  .map((l) => l.replace(/^\/\/ ?/, ''))
  .join('\n');

const OS_NAMES = { linux: 'linux', darwin: 'macos', win32: 'windows' };

function fail(msg) {
  process.stderr.write(`build-binary: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { releaseName: false, allowShared: false };
  for (const a of argv) {
    if (a === '--help' || a === '-h') {
      process.stdout.write(`${HELP}\n`);
      process.exit(0);
    } else if (a === '--release-name') opts.releaseName = true;
    else if (a === '--allow-shared-node') opts.allowShared = true;
    else fail(`unknown argument ${a} (see --help)`);
  }
  return opts;
}

export function supportsBuildSea(version) {
  const m = /^v(\d+)\.(\d+)\./.exec(version);
  if (m === null) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 25 || (major === 25 && minor >= 5);
}

export function binaryName(platform, arch, releaseName) {
  const ext = platform === 'win32' ? '.exe' : '';
  if (!releaseName) return `openmorals${ext}`;
  const os = OS_NAMES[platform];
  if (os === undefined) return null;
  return `openmorals-${os}-${arch}${ext}`;
}

function run(cmd, args, what) {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.error !== undefined) fail(`${what}: ${r.error.message}`);
  if (r.status !== 0) fail(`${what} exited with ${r.status ?? r.signal}`);
}

/** The binary contains Node.js and the yaml package; their licences travel with it as one text file. */
export function writeThirdPartyNotices(file) {
  const dir = dirname(process.execPath);
  const nodeLicense = [join(dir, 'LICENSE'), join(dir, '..', 'LICENSE')].find((f) => existsSync(f));
  if (nodeLicense === undefined) return null;
  const yamlLicense = join(ROOT, 'node_modules', 'yaml', 'LICENSE');
  const text = [
    `The openmorals single executable contains Node.js ${process.version} and the yaml package, under the licences below.`,
    `openmorals itself is under the Apache License 2.0 (LICENSE and NOTICE in the source repository).`,
    '',
    '===== Node.js =====',
    readFileSync(nodeLicense, 'utf8'),
    '===== yaml (https://www.npmjs.com/package/yaml) =====',
    readFileSync(yamlLicense, 'utf8'),
  ].join('\n');
  writeFileSync(file, text);
  return file;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!supportsBuildSea(process.version)) fail(`Node ${process.version} has no --build-sea; use Node 25.5 or later (the release workflow uses Node 26).`);
  const shared = process.config?.variables?.node_shared === true;
  if (shared && !opts.allowShared) {
    fail(`this Node (${process.execPath}) links libnode as a shared library, so the binary would not be a single file. Use an official Node build from nodejs.org, or pass --allow-shared-node for a local test binary that must not be published.`);
  }
  const name = binaryName(process.platform, process.arch, opts.releaseName);
  if (name === null) fail(`no release name for platform ${process.platform}`);

  const entry = join(ROOT, 'dist', 'src', 'cli.js');
  if (!existsSync(entry)) fail('dist/src/cli.js is missing; run npm run build first');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

  const work = join(ROOT, 'build', 'sea');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const bundle = join(work, 'openmorals.cjs');

  const esbuild = await import('esbuild');
  const major = Number(/^v(\d+)/.exec(process.version)[1]);
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: `node${major}`,
    outfile: bundle,
    logLevel: 'warning',
    // src/packs/load.ts reads import.meta.url only outside a single executable, and copes with it being empty.
    logOverride: { 'empty-import-meta': 'silent' },
  });

  const packsDir = join(ROOT, 'packs');
  const assets = {};
  for (const f of readdirSync(packsDir).sort()) if (f.endsWith('.yaml')) assets[`packs/${f}`] = join(packsDir, f);
  if (Object.keys(assets).length === 0) fail('no packs/*.yaml to embed');

  const output = join(ROOT, 'build', name);
  rmSync(output, { force: true });
  const config = {
    main: bundle,
    output,
    disableExperimentalSEAWarning: true,
    useCodeCache: true,
    useSnapshot: false,
    assets,
  };
  const configFile = join(work, 'sea-config.json');
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);

  run(process.execPath, ['--build-sea', configFile], 'node --build-sea');
  if (process.platform === 'darwin') run('codesign', ['--sign', '-', '--force', output], 'codesign (ad hoc)');

  const v = spawnSync(output, ['--version'], { encoding: 'utf8' });
  if (v.error !== undefined) fail(`the built binary did not start: ${v.error.message}`);
  if (v.status !== 0 || v.stdout.trim() !== pkg.version) fail(`the built binary answered --version with ${JSON.stringify(v.stdout.trim())} (exit ${v.status}); expected ${pkg.version}`);

  const notices = writeThirdPartyNotices(join(ROOT, 'build', 'THIRD-PARTY-LICENSES.txt'));
  if (notices === null && !shared) fail(`no Node.js LICENSE file next to ${process.execPath}; the binary embeds Node.js and must ship its licence`);

  const bytes = readFileSync(output);
  const sha = createHash('sha256').update(bytes).digest('hex');
  process.stdout.write(`built ${output}\n  node ${process.version} ${process.platform}-${process.arch}${shared ? ' (SHARED libnode: local test only, do not publish)' : ''}\n  size ${statSync(output).size} bytes\n  sha256 ${sha}\n  packs embedded: ${Object.keys(assets).length}\n  third-party licences: ${notices ?? 'NOT WRITTEN'}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
}
