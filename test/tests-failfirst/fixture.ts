import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tempDir } from '../helpers.js';

/** The environment without git's own redirections, so a fixture's git calls stay inside the fixture. */
export function cleanGitEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_') && k !== 'NODE_TEST_CONTEXT') out[k] = v;
  return out;
}

export function git(dir: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: dir, encoding: 'utf8', env: cleanGitEnv(), timeout: 30000 });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** Writes the files and commits exactly those paths (named one by one: no `git add .`). */
export function commit(dir: string, files: Readonly<Record<string, string>>, message: string): string {
  const paths = Object.keys(files);
  for (const p of paths) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), files[p] ?? '');
  }
  git(dir, 'add', '--', ...paths);
  git(dir, 'commit', '-q', '-m', message);
  return git(dir, 'rev-parse', 'HEAD').trim();
}

export const HEADER = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n";

export const BASE_FILES: Readonly<Record<string, string>> = {
  'lib.mjs': 'export function add(a, b) { return a + b; }\nexport function clamp(x, lo, hi) { return x; }\n',
  'test/add.test.mjs': `${HEADER}import { add } from '../lib.mjs';\ntest('adds', () => { assert.equal(add(1, 2), 3); });\n`,
};

export const HEAD_FILES: Readonly<Record<string, string>> = {
  'lib.mjs': 'export function add(a, b) { return a + b; }\nexport function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }\nexport function mul(a, b) { return a * b; }\n',
  'test/add.test.mjs': `${BASE_FILES['test/add.test.mjs'] ?? ''}test('adds negatives', () => { assert.equal(add(-1, -2), -3); });\n`,
  'test/clamp.test.mjs': `${HEADER}import { clamp } from '../lib.mjs';\ntest('clamps high', () => { assert.equal(clamp(5, 0, 3), 3); });\n`,
  'test/mul.test.mjs': `${HEADER}import * as lib from '../lib.mjs';\ntest('multiplies', () => { assert.equal(lib.mul(2, 3), 6); });\n`,
  'test/named.test.mjs': `${HEADER}import { mul } from '../lib.mjs';\ntest('multiplies by name', () => { assert.equal(mul(2, 4), 8); });\n`,
  'test/helpers/data.json': '{"n": 1}\n',
};

/** A repository with one base commit and one change on top. */
export function fixtureRepo(head: Readonly<Record<string, string>> = HEAD_FILES): { repo: string; base: string; head: string } {
  const repo = tempDir('ff-repo');
  git(repo, 'init', '-q', '-b', 'main');
  const base = commit(repo, BASE_FILES, 'base');
  const h = commit(repo, head, 'change');
  return { repo, base, head: h };
}

export const NODE_COMMAND = `${JSON.stringify(process.execPath)} --test --test-reporter=junit --test-reporter-destination="$OPENMORALS_REPORT" "$@"`;

export function writeSettings(home: string, command: string, extra = ''): void {
  writeFileSync(join(home, 'tests.yaml'), `fail_first:\n  command: ${JSON.stringify(command)}\n${extra}`);
}

/** Every file under a folder (including .git) with its hash, and the index's modification time: equal before and after means nothing was written. */
export function snapshot(dir: string): string {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(`${createHash('sha256').update(readFileSync(p)).digest('hex')}  ${p.slice(dir.length)}`);
      else out.push(`link  ${p.slice(dir.length)}`);
    }
  };
  walk(dir);
  out.push(`index mtime ${statSync(join(dir, '.git', 'index')).mtimeMs}`);
  return out.join('\n');
}
