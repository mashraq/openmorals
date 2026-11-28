import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse as parseYaml, stringify } from 'yaml';
import { runClaudeCodeHook } from '../src/adapters/claude-code.js';
import { guardCall } from '../src/embed.js';
import { parseSessionFile } from '../src/eval/sessions.js';
import type { SessionCase } from '../src/eval/sessions.js';
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
// One rule name differs and is counted as the same answer: the hook's `adapter.unknown-tool` and guardCall's
// `embed.unknown-tool` read the same user setting (guards.unknown-tools); the hook asks once per name per session,
// guardCall every call.
//
// Differences allowed are pinned by row, with the exact answer on both sides (PINNED below); any other difference, a
// pinned row that no longer differs, or a pinned row whose answer changes on either side fails. All of them are one
// kind: guardCall asks (or denies, under a user file that says deny) about a tool name it does not map, where the hook
// knows the name as a Claude Code tool (TodoWrite, Agent, ...) or as an MCP tool. Each one is stricter on guardCall.
//
// Session rows (cases/multi-step.sessions.yaml) whose steps are all tool calls of the main agent are run step by step
// through both, one session per row, and compared the same way. A row with a host event other than a tool call
// (post-tool, compaction, prompt, sub-agent stop) is left out by name: guardCall has no such event, and on the hook an
// asked call's private-data mark waits for its post-tool event while guardCall makes it at once. A row with a sub-agent
// id, or that starts sub-agents (Agent), is left out by name: per-agent, spawn and fan-out counts are the Claude Code
// hook's token control.
//
// The four things only the Claude Code hook has: deferred asks (queued under `defer: true`), the reviewer, the token
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

/** True when the two answers are the same: the same decision and rule, the unknown-tool rule counted as one. */
export function sameAnswer(hook: Verdict, embed: Verdict): boolean {
  if (hook.decision !== embed.decision) return false;
  return hook.rule === embed.rule || (hook.rule === 'adapter.unknown-tool' && embed.rule === 'embed.unknown-tool');
}

function shown(hook: Verdict, embed: Verdict): string {
  return `hook ${hook.decision} [${hook.rule}], guardCall ${embed.decision} [${embed.rule}]`;
}

const ASK_UNKNOWN = 'hook allow [none], guardCall ask [embed.unknown-tool]';

/** Every row allowed to differ, with the exact answers. Rows are `file#n` (1-based) or `session name#step`. */
export const PINNED: Readonly<Record<string, string>> = Object.freeze({
  'content-rules.cases.yaml#16': ASK_UNKNOWN,
  'content-rules.cases.yaml#17': ASK_UNKNOWN,
  'content-rules.cases.yaml#19': ASK_UNKNOWN,
  'delete.cases.yaml#31': ASK_UNKNOWN,
  'delete.cases.yaml#121': ASK_UNKNOWN,
  'delete.cases.yaml#122': ASK_UNKNOWN,
  'detectors.cases.yaml#4': ASK_UNKNOWN,
  'detectors.cases.yaml#23': ASK_UNKNOWN,
  'document.cases.yaml#17': ASK_UNKNOWN,
  'hold.cases.yaml#1': ASK_UNKNOWN,
  'hold.cases.yaml#2': ASK_UNKNOWN,
  'hold.cases.yaml#13': ASK_UNKNOWN,
  'hold.cases.yaml#14': ASK_UNKNOWN,
  'hold.cases.yaml#15': ASK_UNKNOWN,
  'hold.cases.yaml#16': ASK_UNKNOWN,
  'hold.cases.yaml#17': ASK_UNKNOWN,
  'hold.cases.yaml#18': ASK_UNKNOWN,
  'hold.cases.yaml#19': ASK_UNKNOWN,
  'hold.cases.yaml#20': ASK_UNKNOWN,
  'hold.cases.yaml#21': ASK_UNKNOWN,
  'hold.cases.yaml#22': ASK_UNKNOWN,
  'hold.cases.yaml#24': ASK_UNKNOWN,
  'hold.cases.yaml#25': ASK_UNKNOWN,
  'hold.cases.yaml#26': ASK_UNKNOWN,
  'hold.cases.yaml#30': ASK_UNKNOWN,
  'hold.cases.yaml#32': ASK_UNKNOWN,
  'online-delete.cases.yaml#50': ASK_UNKNOWN,
  'online-delete.cases.yaml#51': ASK_UNKNOWN,
  'online-delete.cases.yaml#52': ASK_UNKNOWN,
  'outbound.cases.yaml#5': ASK_UNKNOWN,
  'outbound.cases.yaml#7': ASK_UNKNOWN,
  'outbound.cases.yaml#12': ASK_UNKNOWN,
  'outbound.cases.yaml#38': ASK_UNKNOWN,
  'outbound.cases.yaml#42': ASK_UNKNOWN,
  'outbound.cases.yaml#53': ASK_UNKNOWN,
  'outbound.cases.yaml#54': ASK_UNKNOWN,
  'outbound.cases.yaml#55': ASK_UNKNOWN,
  'outbound.cases.yaml#56': ASK_UNKNOWN,
  'outbound.cases.yaml#57': ASK_UNKNOWN,
  'outbound.cases.yaml#58': ASK_UNKNOWN,
  'outbound.cases.yaml#59': ASK_UNKNOWN,
  'outbound.cases.yaml#62': ASK_UNKNOWN,
  'outbound.cases.yaml#63': ASK_UNKNOWN,
  'outbound.cases.yaml#65': ASK_UNKNOWN,
  'outbound.cases.yaml#66': ASK_UNKNOWN,
  'outbound.cases.yaml#67': ASK_UNKNOWN,
  'outbound.cases.yaml#68': ASK_UNKNOWN,
  'outbound.cases.yaml#69': ASK_UNKNOWN,
  'outbound.cases.yaml#71': ASK_UNKNOWN,
  'outbound.cases.yaml#81': ASK_UNKNOWN,
  'outbound.cases.yaml#83': ASK_UNKNOWN,
  'outbound.cases.yaml#84': ASK_UNKNOWN,
  'outbound.cases.yaml#85': ASK_UNKNOWN,
  'outbound.cases.yaml#86': ASK_UNKNOWN,
  'outbound.cases.yaml#87': ASK_UNKNOWN,
  'privacy.cases.yaml#15': ASK_UNKNOWN,
  'privacy.cases.yaml#19': ASK_UNKNOWN,
  'secrets.cases.yaml#18': ASK_UNKNOWN,
  'secrets.cases.yaml#19': ASK_UNKNOWN,
  'unknown-tools.cases.yaml#1': ASK_UNKNOWN,
  'unknown-tools.cases.yaml#2': ASK_UNKNOWN,
  'unknown-tools.cases.yaml#3': ASK_UNKNOWN,
  'unknown-tools.cases.yaml#4': ASK_UNKNOWN,
  'unknown-tools.cases.yaml#9': ASK_UNKNOWN,
  'unknown-tools.cases.yaml#10': ASK_UNKNOWN,
  'unknown-tools.cases.yaml#11': ASK_UNKNOWN,
  'unknown-tools.cases.yaml#21': 'hook ask [adapter.mcp-delete], guardCall deny [embed.unknown-tool]',
});

export interface SessionRun {
  name: string;
  steps: { hook: Verdict; embed: Verdict }[];
}

/** The session rows the test runs, and the rows left out with the reason. */
export function sessionRows(): { rows: SessionCase[]; left: { name: string; why: string }[] } {
  const file = 'multi-step.sessions.yaml';
  const parsed = parseSessionFile(readFileSync(join(REPO_ROOT, 'cases', file), 'utf8'), file);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
  const rows: SessionCase[] = [];
  const left: { name: string; why: string }[] = [];
  for (const c of parsed.value.cases) {
    if (c.steps.some((st) => st.event !== 'PreToolUse')) left.push({ name: c.name, why: 'a host event other than a tool call' });
    else if (c.steps.some((st) => st.agent !== null)) left.push({ name: c.name, why: 'a sub-agent id' });
    else if (c.steps.some((st) => st.tool === 'Agent')) left.push({ name: c.name, why: 'sub-agent spawns, counted by token control' });
    else rows.push(c);
  }
  return { rows, left };
}

function fill<T>(v: T, project: string, home: string): T {
  if (typeof v === 'string') return v.split('{project}').join(project).split('{home}').join(home) as T;
  if (Array.isArray(v)) return v.map((x: unknown) => fill(x, project, home)) as T;
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, project, home)])) as T;
  return v;
}

/** Runs one session row through one path in its own temporary home and project. */
function runSession(c: SessionCase, base: string, path: 'hook' | 'embed'): Verdict[] {
  const home = join(base, 'home');
  const project = join(base, 'project');
  const cfg = join(home, '.config', 'openmorals');
  mkdirSync(cfg, { recursive: true });
  mkdirSync(project, { recursive: true });
  if (c.bylaws !== null) writeFileSync(join(cfg, 'openmorals.yaml'), stringify(c.bylaws));
  if (c.projectBylaws !== null) writeFileSync(join(project, 'openmorals.yaml'), stringify(c.projectBylaws));
  for (const [p, text] of Object.entries(c.files)) {
    const abs = p.startsWith('~/') ? join(home, p.slice(2)) : join(project, p);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, fill(text, project, home));
  }
  const env: Record<string, string> = { HOME: home, USERPROFILE: home, OPENMORALS_HOME: cfg, PATH: process.env['PATH'] ?? '' };
  return c.steps.map((st, i) => {
    const session = `row${st.session !== null ? `-${st.session}` : ''}`;
    const tool = st.tool ?? '';
    const input = fill(st.input, project, home);
    if (path === 'embed') return guardCall({ session, cwd: project, tool, input }, { env, unattended: c.unattended, now: NOW });
    const stdin = JSON.stringify({ session_id: session, cwd: project, hook_event_name: 'PreToolUse', tool_use_id: `call-${i}`, tool_name: tool, tool_input: input });
    return runClaudeCodeHook(stdin, { env, cwd: project, unattended: c.unattended, now: NOW }).verdict;
  });
}

describe('guardCall gives the Claude Code hook answer on every shipped guard row (0.43.0)', () => {
  const { rows, left } = diffRows();

  it('no shipped row sets defer: true, so no deferred ask can make the paths differ', () => {
    for (const r of rows) for (const b of [r.user, r.project]) assert.ok(!(typeof b === 'object' && b !== null && (b as Record<string, unknown>)['defer'] === true), `${r.file}#${r.index + 1} sets defer`);
  });

  it('every row that is not left out by name gives the same decision and rule, but for the pinned rows', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'openmorals-test-embed-diff-'));
    const found: string[] = [];
    const differ: Record<string, string> = {};
    const sessions = sessionRows();
    let steps = 0;
    const tally: Record<string, number> = { allow: 0, ask: 0, deny: 0 };
    let asExpected = 0;
    try {
      rows.forEach((r, n) => {
        const hook = viaHook(r, join(root, `${n}-hook`));
        const embed = viaEmbed(r, join(root, `${n}-embed`));
        tally[embed.decision] = (tally[embed.decision] ?? 0) + 1;
        if (embed.decision === r.expect) asExpected++;
        note(`${r.file}#${r.index + 1}`, `${r.tool} ${r.label}`, hook, embed);
      });
      sessions.rows.forEach((c, n) => {
        const hook = runSession(c, join(root, `s${n}-hook`), 'hook');
        const embed = runSession(c, join(root, `s${n}-embed`), 'embed');
        hook.forEach((h, i) => {
          steps++;
          const e = embed[i];
          assert.ok(e !== undefined);
          note(`${c.name}#${i + 1}`, c.steps[i]?.tool ?? '', h, e);
        });
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    function note(key: string, what: string, hook: Verdict, embed: Verdict): void {
      if (process.platform === 'win32') {
        if ((RANK[embed.decision] ?? 0) < (RANK[hook.decision] ?? 0)) found.push(`${key} ${what}: ${shown(hook, embed)} ${embed.reason}`);
        return;
      }
      if (sameAnswer(hook, embed)) return;
      differ[key] = shown(hook, embed);
      if (PINNED[key] !== shown(hook, embed)) found.push(`${key} ${what}: ${shown(hook, embed)} ${embed.reason}`);
    }
    t.diagnostic(`${rows.length} rows and ${sessions.rows.length} session rows (${steps} steps) compared; ${left.length} rows left out (${[...new Set(left.map((l) => l.why))].join(', ')}); session rows left out: ${sessions.left.map((l) => `${l.name} (${l.why})`).join('; ')}; ${Object.keys(differ).length} pinned differences; guardCall allow ${tally['allow']}, ask ${tally['ask']}, deny ${tally['deny']}; ${asExpected} give the row's own expect on a real disk`);
    if (found.length > 0) t.diagnostic(`rows that differ now: ${JSON.stringify(differ)}`);
    assert.ok(rows.length > 0 && sessions.rows.length > 0 && steps > 0, 'nothing was compared');
    assert.ok((tally['allow'] ?? 0) > 100 && (tally['ask'] ?? 0) > 100 && (tally['deny'] ?? 0) > 10, 'the rows do not reach all three answers, so the comparison is too easy');
    assert.ok(rows.length >= 1000, `only ${rows.length} rows compared`);
    assert.deepEqual(found, []);
    if (process.platform !== 'win32') assert.deepEqual(Object.keys(differ).sort(), Object.keys(PINNED).sort(), 'the set of rows that differ changed');
  });

  it('every pinned difference is guardCall being stricter', () => {
    for (const [key, v] of Object.entries(PINNED)) {
      const m = /^hook (allow|ask|deny) \[[^\]]+\], guardCall (allow|ask|deny) \[[^\]]+\]$/.exec(v);
      assert.ok(m !== null, key);
      assert.ok((RANK[m[2] ?? ''] ?? 0) > (RANK[m[1] ?? ''] ?? 0), `${key}: ${v}`);
    }
  });
});
