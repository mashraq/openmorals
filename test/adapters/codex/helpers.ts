import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Decision } from '../../../src/types.js';

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `openmorals-adapt-${prefix}-`));
}

/** One row of an adapter case table: what the host sends, the decision and rule openmorals must reach. */
export interface HookCase {
  name: string;
  stdin: string;
  decision: Decision;
  rule: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string>;
}

export const PROJECT = '/work/app';
