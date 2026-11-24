import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { toAction } from '../src/adapters/claude-code.js';
import type { Where } from '../src/guard.js';
import { makeWhere } from '../src/guard.js';
import type { Action, SessionState, ShellKind } from '../src/types.js';
import { isDecision } from '../src/types.js';
import { REPO_ROOT } from './helpers.js';

const CASE_KEYS = new Set(['cmd', 'shell', 'tool', 'input', 'expect', 'rule', 'rule_any', 'bylaws', 'state', 'note', 'config_dir', 'cwd', 'also']);

/** Case rows are judged in a fixed, made-up place, never the machine's own home or config directory; links are not resolved and every path is taken to exist (a unit test does both with real files). */
export const CASE_HOME = '/home/u';
export const CASE_CONFIG_DIR = '/home/u/.config/openmorals';
export const CASE_CWD = '/work/app';
export const MIN_CASES_PER_GUARD = 15;

export interface Case {
  action: Action;
  expect: 'allow' | 'ask' | 'deny';
  rule: string | null;
  ruleAny: boolean;
  bylaws: unknown;
  state: SessionState;
  where: Where;
  /** Other guards that rightly catch the row too (removing the file's own guard leaves it caught by these). */
  also: string[];
  label: string;
}

function toCase(raw: unknown, idx: number, file: string): Case {
  assert.ok(typeof raw === 'object' && raw !== null && !Array.isArray(raw), `${file}[${idx}] is not a mapping`);
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) assert.ok(CASE_KEYS.has(k), `${file}[${idx}] has unknown key ${k}`);
  const expect = o['expect'];
  assert.ok(isDecision(expect), `${file}[${idx}] expect must be allow/ask/deny`);
  let action: Action;
  if (typeof o['cmd'] === 'string') {
    const shell = (o['shell'] ?? 'posix') as ShellKind;
    assert.ok(shell === 'posix' || shell === 'powershell' || shell === 'cmd', `${file}[${idx}] bad shell`);
    action = { kind: 'exec', command: o['cmd'], shell, tool: shell === 'powershell' ? 'PowerShell' : 'Bash' };
  } else {
    assert.ok(typeof o['tool'] === 'string', `${file}[${idx}] needs cmd or tool`);
    const input = o['input'];
    assert.ok(typeof input === 'object' && input !== null, `${file}[${idx}] tool case needs input`);
    action = toAction(o['tool'], input as Record<string, unknown>);
  }
  const st = (o['state'] ?? {}) as Record<string, unknown>;
  const num = (k: string): number => (typeof st[k] === 'number' ? (st[k] as number) : 0);
  const state: SessionState = { toolCalls: num('toolCalls') || 1, tokens: num('tokens'), prevTokens: num('prevTokens') };
  const str = (k: string): string | undefined => {
    const v = o[k];
    assert.ok(v === undefined || typeof v === 'string', `${file}[${idx}] ${k} must be a string`);
    return v;
  };
  const where = makeWhere({ home: CASE_HOME, configDir: str('config_dir') ?? CASE_CONFIG_DIR, cwd: str('cwd') ?? CASE_CWD, realpath: (p: string) => p, exists: () => true }, {});
  const alsoRaw = o['also'] ?? [];
  assert.ok(Array.isArray(alsoRaw) && alsoRaw.every((x) => typeof x === 'string'), `${file}[${idx}] also must be a list of guard ids`);
  const also = alsoRaw as string[];
  const label = typeof o['cmd'] === 'string' ? o['cmd'] : `${String(o['tool'])} ${JSON.stringify(o['input'])}`;
  return { action, expect, rule: typeof o['rule'] === 'string' ? o['rule'] : null, ruleAny: o['rule_any'] === true, bylaws: o['bylaws'] ?? null, state, where, also, label };
}

export function loadCaseFiles(): { guard: string; file: string; cases: Case[] }[] {
  const dir = join(REPO_ROOT, 'cases');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.cases.yaml'))
    .sort()
    .map((f) => {
      const doc = parse(readFileSync(join(dir, f), 'utf8')) as { guard: unknown; cases: unknown };
      assert.ok(typeof doc.guard === 'string', `${f} needs guard`);
      assert.ok(Array.isArray(doc.cases), `${f} needs cases`);
      return { guard: doc.guard, file: f, cases: (doc.cases as unknown[]).map((c, i) => toCase(c, i, f)) };
    });
}

