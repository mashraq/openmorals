import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse as parseYaml, stringify } from 'yaml';
import { runClaudeCodeHook } from '../src/adapters/claude-code.js';
import { guardCall } from '../src/embed.js';
import type { Verdict } from '../src/types.js';
import { loadCaseFiles } from './case-loader.js';
import { REPO_ROOT } from './helpers.js';

// 0.43.0: every shipped guard row (cases/*.cases.yaml) is sent once through the Claude Code hook and once through
// `guardCall`, each in a fresh temporary config folder and a fresh session, with the row's own user file and project
// file written to disk, and the two answers must be the same decision and the same rule. Both read the real disk of a
// fresh temporary project, so a row's faked files, session sketch or counts are not applied: this compares the two
// paths with each other, not with the row's `expect` (cases.test.ts does that).
//
// Rows left out, by name: a row with `shell: cmd` (no Claude Code tool runs cmd.exe) and a row with `host: codex` or
// `host: gemini-cli` (its tool is another host's and is mapped by that host's adapter).
//
// Differences allowed, each tied to its rule so that any other difference fails:
// - the Claude Code hook asks about a tool name that is not one of Claude Code's built-in tools (`adapter.unknown-tool`).
//   A program's tools are its own, so `guardCall` has no host list to check them against.
// - the four things only the Claude Code hook has: deferred asks (queued under `defer: true`), the reviewer, the token
//   budget and the run budget. The hook here is the one without the reviewer, no row sets `defer: true` (checked
//   below), no run id is set, and a fresh session has no token count, so none of these can fire; if one does, its rule
//   names it and the test fails, which is a finding.
// On Windows the shared pipeline reads a command in every shell dialect and keeps the strictest answer while the Claude
// Code hook reads it once, so there `guardCall` must be at least as strict instead of equal.

const NOW = new Date('2026-01-15T12:00:00.000Z');
const RANK: Record<string, number> = { allow: 0, ask: 1, deny: 2 };

interface Row {
  file: string;
  index: number;
  label: string;
  tool: string;
  input: Record<string, unknown>;
  user: unknown;
  project: unknown;
  expect: string;
}

/** The rows the test runs, and the rows left out with the reason. */
export function diffRows(): { rows: Row[]; left: { file: string; index: number; why: string }[] } {
  const rows: Row[] = [];
  const left: { file: string; index: number; why: string }[] = [];
  for (const f of loadCaseFiles()) {
    const doc = parseYaml(readFileSync(join(REPO_ROOT, 'cases', f.file), 'utf8')) as { cases: Record<string, unknown>[] };
    assert.equal(doc.cases.length, f.cases.length, `${f.file}: raw rows and loaded rows differ in number`);
    f.cases.forEach((c, i) => {
      const raw = doc.cases[i] ?? {};
      if (raw['host'] === 'codex' || raw['host'] === 'gemini-cli') return void left.push({ file: f.file, index: i, why: `host: ${String(raw['host'])}` });
      if (raw['shell'] === 'cmd') return void left.push({ file: f.file, index: i, why: 'shell: cmd' });
      let tool: string;
      let input: Record<string, unknown>;
      if (typeof raw['cmd'] === 'string') {
        tool = raw['shell'] === 'powershell' ? 'PowerShell' : 'Bash';
        input = { command: raw['cmd'] };
      } else {
        tool = String(raw['tool']);
        input = raw['input'] as Record<string, unknown>;
      }
      rows.push({ file: f.file, index: i, label: c.label.slice(0, 80), tool, input, user: c.bylaws, project: c.project, expect: c.expect });
    });
  }
  return { rows, left };
}

function setUp(row: Row, base: string): { cfg: string; cwd: string } {
  const cfg = join(base, 'cfg');
  const cwd = join(base, 'project');
  mkdirSync(cfg, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  if (row.user !== null) writeFileSync(join(cfg, 'openmorals.yaml'), stringify(row.user));
  if (row.project !== null) writeFileSync(join(cwd, 'openmorals.yaml'), stringify(row.project));
  return { cfg, cwd };
}

export function viaHook(row: Row, base: string): Verdict {
  const { cfg, cwd } = setUp(row, base);
  const stdin = JSON.stringify({ session_id: 'diff-hook', cwd, hook_event_name: 'PreToolUse', tool_name: row.tool, tool_input: row.input, tool_use_id: 'call-1' });
  return runClaudeCodeHook(stdin, { env: { OPENMORALS_HOME: cfg }, cwd, now: NOW }).verdict;
}

export function viaEmbed(row: Row, base: string): Verdict {
  const { cfg, cwd } = setUp(row, base);
  return guardCall({ session: 'diff-embed', cwd, tool: row.tool, input: row.input }, { env: { OPENMORALS_HOME: cfg }, now: NOW });
}

/** Why a difference is allowed, or null when it is a finding. */
export function allowedDifference(hook: Verdict, embed: Verdict): string | null {
  if (hook.rule === 'adapter.unknown-tool') return 'unknown-tool';
  return null;
}

describe('guardCall gives the Claude Code hook answer on every shipped guard row (0.43.0)', () => {
  const { rows, left } = diffRows();

  it('no shipped row sets defer: true, so no deferred ask can make the paths differ', () => {
    for (const r of rows) for (const b of [r.user, r.project]) assert.ok(!(typeof b === 'object' && b !== null && (b as Record<string, unknown>)['defer'] === true), `${r.file}#${r.index + 1} sets defer`);
  });

  it('every row that is not left out by name gives the same decision and rule', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'openmorals-test-embed-diff-'));
    const found: string[] = [];
    const allowed = new Map<string, number>();
    const tally: Record<string, number> = { allow: 0, ask: 0, deny: 0 };
    let asExpected = 0;
    try {
      rows.forEach((r, n) => {
        const hook = viaHook(r, join(root, `${n}-hook`));
        const embed = viaEmbed(r, join(root, `${n}-embed`));
        tally[embed.decision] = (tally[embed.decision] ?? 0) + 1;
        if (embed.decision === r.expect) asExpected++;
        const same = process.platform === 'win32' ? (RANK[embed.decision] ?? 0) >= (RANK[hook.decision] ?? 0) : hook.decision === embed.decision && hook.rule === embed.rule;
        if (same) return;
        const why = allowedDifference(hook, embed);
        if (why !== null) allowed.set(why, (allowed.get(why) ?? 0) + 1);
        else found.push(`${r.file}#${r.index + 1} ${r.tool} ${r.label}: hook ${hook.decision} [${hook.rule}], guardCall ${embed.decision} [${embed.rule}] ${embed.reason}`);
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    t.diagnostic(`${rows.length} rows compared, ${left.length} left out (${[...new Set(left.map((l) => l.why))].join(', ')}); allowed differences: ${[...allowed].map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}; guardCall allow ${tally['allow']}, ask ${tally['ask']}, deny ${tally['deny']}; ${asExpected} give the row's own expect on a real disk`);
    assert.ok((tally['allow'] ?? 0) > 100 && (tally['ask'] ?? 0) > 100 && (tally['deny'] ?? 0) > 10, 'the rows do not reach all three answers, so the comparison is too easy');
    assert.ok(rows.length >= 1000, `only ${rows.length} rows compared`);
    assert.deepEqual(found, []);
  });
});
