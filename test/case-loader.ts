import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { CaseFile } from '../src/eval/cases.js';
import { folderSource, loadCasesFrom } from '../src/eval/cases.js';
import { REPO_ROOT } from './helpers.js';

export type { Case, CaseFile } from '../src/eval/cases.js';
export { CASE_CONFIG_DIR, CASE_CWD, CASE_HOME } from '../src/eval/cases.js';
export const MIN_CASES_PER_GUARD = 15;

/** The guard case files of the repository (the loader lives in src/eval, where `openmorals eval` uses it too). */
export function loadCaseFiles(): CaseFile[] {
  const r = loadCasesFrom(folderSource(join(REPO_ROOT, 'cases')));
  assert.ok(r.ok, r.ok ? '' : r.error);
  return r.value.guardFiles;
}
