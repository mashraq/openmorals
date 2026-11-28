import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `openmorals-test-${prefix}-`));
}

/**
 * A folder holding a stand-in `openmorals` that does nothing, for tests that run `openmorals init`: since 0.41.2 init
 * refuses to write a hook command that is not on PATH. Returns the folder.
 */
export function stubOpenmoralsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openmorals-test-stub-bin-'));
  if (process.platform === 'win32') writeFileSync(join(dir, 'openmorals.cmd'), '@exit /b 0\r\n');
  else {
    writeFileSync(join(dir, 'openmorals'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(dir, 'openmorals'), 0o755);
  }
  return dir;
}

/** The environment with a stand-in `openmorals` first on PATH (see `stubOpenmoralsDir`). */
let stubDir: string | null = null;
export function withOpenmoralsOnPath(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  stubDir ??= stubOpenmoralsDir();
  const key = process.platform === 'win32' && env['PATH'] === undefined && env['Path'] !== undefined ? 'Path' : 'PATH';
  return { ...env, [key]: `${stubDir}${delimiter}${env[key] ?? ''}` };
}
