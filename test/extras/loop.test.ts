import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Action, ShellKind } from '../../src/types.js';
import { detectLoop, isPolling, type HistoryEntry, type LoopKind, type LoopOptions } from '../../src/loop/index.js';

function ex(command: string, shell: ShellKind = 'posix'): Action {
  return { kind: 'exec', command, shell, tool: 'Bash' };
}
const h = (a: Action, error?: string): HistoryEntry => (error === undefined ? { action: a } : { action: a, outcome: { ok: false, error } });
const okRun = (a: Action): HistoryEntry => ({ action: a, outcome: { ok: true } });
const write = (path: string): HistoryEntry => h({ kind: 'write', path, tool: 'Edit' });
const read = (path: string): Action => ({ kind: 'read', path, tool: 'Read' });
const times = (n: number, f: (i: number) => HistoryEntry): HistoryEntry[] => Array.from({ length: n }, (_, i) => f(i));

interface LoopCase {
  name: string;
  history: HistoryEntry[];
  next: Action;
  expect: LoopKind;
  count?: number;
  options?: Partial<LoopOptions>;
}

export const LOOP_CASES: LoopCase[] = [
  { name: 'first command', history: [], next: ex('npm test'), expect: 'none' },
  { name: 'third identical run is fine', history: times(2, () => h(ex('npm test'))), next: ex('npm test'), expect: 'none' },
  { name: 'fourth identical run with no edit asks', history: times(3, () => h(ex('npm test'))), next: ex('npm test'), expect: 'repeat', count: 4 },
  { name: 'an edit between runs is progress', history: [h(ex('npm test')), h(ex('npm test')), write('src/a.ts'), h(ex('npm test'))], next: ex('npm test'), expect: 'none' },
  { name: 'whitespace variants are the same command', history: [h(ex('npm  test')), h(ex(' npm test')), h(ex('npm\ttest'))], next: ex('npm test'), expect: 'repeat', count: 4 },
  { name: 'interleaved reads do not hide the repeat', history: [h(ex('npm test')), h(ex('git status')), h(ex('npm test')), h(ex('git diff')), h(ex('npm test'))], next: ex('npm test'), expect: 'repeat' },
  { name: 'same file read four times', history: times(3, () => h(read('src/a.ts'))), next: read('src/a.ts'), expect: 'repeat' },
  { name: 'same URL fetched four times', history: times(3, () => h({ kind: 'fetch', url: 'https://example.test/doc', tool: 'WebFetch' })), next: { kind: 'fetch', url: 'https://example.test/doc', tool: 'WebFetch' }, expect: 'repeat' },
  { name: 'opaque tools are not tracked', history: times(6, () => h({ kind: 'other', tool: 'TodoWrite' })), next: { kind: 'other', tool: 'TodoWrite' }, expect: 'none' },
  { name: 'writes are never a loop', history: times(6, () => write('a.txt')), next: { kind: 'write', path: 'a.txt', tool: 'Edit' }, expect: 'none' },
  { name: 'sleep and tail cycle asks at six', history: times(5, (i) => h(ex(i % 2 === 0 ? `sleep ${10 + i}` : `tail -n ${20 + i} build.log`))), next: ex('sleep 30'), expect: 'polling', count: 6 },
  { name: 'a short wait is fine', history: times(3, (i) => h(ex(i % 2 === 0 ? `sleep ${10 + i}` : 'tail -n 20 build.log'))), next: ex('sleep 9'), expect: 'none' },
  { name: 'sleep then health check, varying delay', history: times(5, (i) => h(ex(`sleep ${5 * (i + 1)} && curl -s localhost:3000/health`))), next: ex('sleep 30 && curl -s localhost:3000/health'), expect: 'polling' },
  { name: 'ps piped to grep, varying pattern', history: times(5, (i) => h(ex(`ps aux | grep worker${i}`))), next: ex('ps aux | grep worker9'), expect: 'polling' },
  { name: 'PowerShell sleep and process check', history: times(5, (i) => h(ex(`Start-Sleep -Seconds ${i + 2}; Get-Process node`, 'powershell'))), next: ex('Start-Sleep -Seconds 9; Get-Process node', 'powershell'), expect: 'polling' },
  { name: 'cmd timeout used as sleep', history: times(5, (i) => h(ex(`timeout /t ${i + 2}`, 'cmd'))), next: ex('timeout /t 9', 'cmd'), expect: 'polling' },
  { name: 'gh run view polling', history: times(5, (i) => h(ex(`gh run view 12345${i}`))), next: ex('gh run view 123459'), expect: 'polling' },
  { name: 'an edit resets the polling count', history: [...times(4, (i) => h(ex(`sleep ${i + 1}`))), write('x.ts'), h(ex('sleep 5'))], next: ex('sleep 6'), expect: 'none' },
  { name: 'near-identical requests differing by id', history: times(4, (i) => h(ex(`curl -s localhost:3000/api/items/${i + 1}`))), next: ex('curl -s localhost:3000/api/items/5'), expect: 'near-repeat', count: 5 },
  { name: 'near-identical commits differing in message', history: times(4, (i) => h(ex(`git commit -m "try ${i}"`))), next: ex('git commit -m "another try"'), expect: 'near-repeat' },
  { name: 'three near-identical steps are fine', history: times(3, (i) => h(ex(`curl -s localhost:3000/api/items/${i + 1}`))), next: ex('curl -s localhost:3000/api/items/5'), expect: 'none' },
  { name: 'same failure three times, even with edits between', history: [h(ex('npm test'), 'Expected 3 to equal 4'), write('a.ts'), h(ex('npm test'), 'Expected 3 to equal 4'), write('a.ts'), h(ex('npm test'), 'Expected 3 to equal 4'), write('a.ts')], next: ex('npm test'), expect: 'repeated-failure', count: 3 },
  { name: 'failures that differ only in line numbers', history: [h(ex('npm run build'), 'error at line 12'), write('a.ts'), h(ex('npm run build'), 'error at line 14'), write('a.ts'), h(ex('npm run build'), 'error at line 15')], next: ex('npm run build'), expect: 'repeated-failure' },
  { name: 'different errors mean progress', history: [h(ex('npm test'), 'Expected 3 to equal 4'), write('a.ts'), h(ex('npm test'), 'Cannot find module x'), write('a.ts'), h(ex('npm test'), 'Timeout in test y')], next: ex('npm test'), expect: 'none' },
  { name: 'failures of another command do not count', history: [h(ex('npm run lint'), 'E1'), write('a'), h(ex('npm run lint'), 'E1'), write('a'), h(ex('npm run lint'), 'E1')], next: ex('npm test'), expect: 'none' },
  { name: 'successes are not failures', history: [okRun(ex('npm test')), write('a'), okRun(ex('npm test')), write('a'), okRun(ex('npm test'))], next: ex('npm test'), expect: 'none' },
  { name: 'old repeats fall out of the window', history: [...times(3, () => h(ex('npm test'))), ...times(20, (i) => h(read(`f${i}.ts`)))], next: ex('npm test'), expect: 'none' },
  { name: 'a stricter limit asks sooner', history: [h(ex('npm test'))], next: ex('npm test'), expect: 'repeat', options: { repeatLimit: 2 } },
  { name: 'nonsense limits fall back to defaults', history: times(2, () => h(ex('npm test'))), next: ex('npm test'), expect: 'none', options: { repeatLimit: Number.NaN, window: 0, nearLimit: -3 } },
];

describe('loop: detectLoop case table', () => {
  for (const c of LOOP_CASES) {
    it(`${c.name} -> ${c.expect}`, () => {
      const v = detectLoop(c.history, c.next, c.options);
      assert.equal(v.kind, c.expect, v.reason);
      assert.equal(v.decision, c.expect === 'none' ? 'allow' : 'ask');
      if (c.count !== undefined) assert.equal(v.count, c.count);
      if (c.expect !== 'none') assert.equal(v.rule, `loop.${c.expect}`);
    });
  }
  it('has at least 20 cases', () => assert.ok(LOOP_CASES.length >= 20));
  it('never returns deny', () => {
    for (const c of LOOP_CASES) assert.notEqual(detectLoop(c.history, c.next, c.options).decision, 'deny');
  });
});

describe('loop: isPolling', () => {
  const table: [string, ShellKind, boolean][] = [
    ['sleep 5', 'posix', true],
    ['tail -n 20 out.log', 'posix', true],
    ['sudo tail -n 20 out.log', 'posix', true],
    ['ps aux | grep node', 'posix', true],
    ['cat out.log | tail -5', 'posix', true],
    ['kubectl get pods', 'posix', true],
    ['Get-Content out.log -Tail 5', 'powershell', true],
    ['npm test', 'posix', false],
    ['ps aux | xargs kill', 'posix', false],
    ['cat README.md | grep install', 'posix', false],
    ['git status', 'posix', false],
  ];
  for (const [cmd, shell, want] of table) {
    it(`${cmd} -> ${want}`, () => assert.equal(isPolling(ex(cmd, shell)), want));
  }
});
