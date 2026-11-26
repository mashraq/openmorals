import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { sessionStatePath } from '../../src/paths.js';
import { EMPTY_MEMORY, recordAction } from '../../src/session.js';
import { loadSession, mergeSession, saveSession, withSessionLock } from '../../src/state.js';
import { CLEAN_TAINT, mergeTaint, reduceTaint } from '../../src/taint/index.js';
import type { Action } from '../../src/types.js';
import { tempDir } from '../helpers.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli.js');
const ctx = { projectRoot: '/work/app' };
const allow = { decision: 'allow' as const, rule: 'none', reason: '' };
const fetchOf = (url: string): Action => ({ kind: 'fetch', url, tool: 'WebFetch' });
const bash = (command: string): Action => ({ kind: 'exec', command, shell: 'posix', tool: 'Bash' });

describe('sessions written by sub-agents at the same time (0.32.1)', () => {
  it('a save that overlapped another keeps the other save\'s taint marks, history and counts', () => {
    const dir = tempDir('conc');
    const base = loadSession('s', dir);
    // Writer B (a sub-agent) reads a web page and saves first.
    const b = loadSession('s', dir);
    saveSession('s', { ...b.state, toolCalls: b.state.toolCalls + 1 }, recordAction(b.memory, fetchOf('https://evil.example.test/'), allow, ctx, null), dir, new Date(), b);
    // Writer A loaded before B saved, runs a harmless command, and saves.
    saveSession('s', { ...base.state, toolCalls: base.state.toolCalls + 1 }, recordAction(base.memory, bash('ls'), allow, ctx, null), dir, new Date(), base);
    const after = loadSession('s', dir);
    assert.equal(after.memory.taint.untrustedCount, 1, 'B\'s untrusted mark survives A\'s save');
    assert.equal(after.memory.taint.untrusted[0]?.source, 'web-fetch');
    assert.equal(after.state.toolCalls, 2, 'both calls are counted');
    assert.equal(after.memory.history.length, 2, 'both calls are in the history');
    assert.equal(after.rev, 2);
  });

  it('without a base the later save still overwrites (the 0.31.0 behaviour this fixes)', () => {
    const dir = tempDir('conc');
    const base = loadSession('s', dir);
    const b = loadSession('s', dir);
    saveSession('s', b.state, recordAction(b.memory, fetchOf('https://evil.example.test/'), allow, ctx, null), dir);
    saveSession('s', base.state, recordAction(base.memory, bash('ls'), allow, ctx, null), dir);
    assert.equal(loadSession('s', dir).memory.taint.untrustedCount, 0);
  });

  it('mergeTaint keeps both writers\' marks and a reset on one side only drops what that side had seen', () => {
    const one = reduceTaint(CLEAN_TAINT, { type: 'untrusted', source: 'web-fetch', detail: 'a' }, ctx);
    const disk = reduceTaint(one, { type: 'private', detail: 'p' }, ctx);
    const ours = reduceTaint(one, { type: 'injected', detail: 'x' }, ctx);
    const m = mergeTaint(one, disk, ours);
    assert.equal(m.untrustedCount, 2);
    assert.equal(m.privateCount, 1);
    assert.equal(m.injectedCount, 1);
    const reset = mergeTaint(one, disk, CLEAN_TAINT);
    assert.equal(reset.untrustedCount, 0);
    assert.equal(reset.privateCount, 1, 'the mark added by the other writer after the reset point stays');
  });

  it('mergeSession adds both writers\' token and call increases', () => {
    const base = { state: { toolCalls: 10, tokens: 1000, prevTokens: 1000 }, memory: EMPTY_MEMORY };
    const disk = { state: { toolCalls: 12, tokens: 1500, prevTokens: 1500 }, memory: EMPTY_MEMORY };
    const ours = { state: { toolCalls: 11, tokens: 1200, prevTokens: 1200 }, memory: EMPTY_MEMORY };
    const m = mergeSession(base, disk, ours);
    assert.deepEqual(m.state, { toolCalls: 13, tokens: 1700, prevTokens: 1700 });
  });

  it('a stale lock left by a dead process is removed; a held one makes the save throw after the wait', () => {
    const dir = tempDir('conc');
    const file = sessionStatePath('s', dir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.lock`, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, old, old);
    saveSession('s', { toolCalls: 1, tokens: 0, prevTokens: 0 }, EMPTY_MEMORY, dir);
    assert.equal(existsSync(`${file}.lock`), false);
    assert.throws(() => withSessionLock(file, () => withSessionLock(file, () => 1)), /held its saved state for too long/);
  });

  it('mergeSession keeps a command this writer ran again that was already in the history', () => {
    const one = recordAction(EMPTY_MEMORY, bash('npm test'), allow, ctx, null);
    const ours = { state: { toolCalls: 2, tokens: 0, prevTokens: 0 }, memory: recordAction(one, bash('npm test'), allow, ctx, null) };
    const disk = { state: { toolCalls: 2, tokens: 0, prevTokens: 0 }, memory: recordAction(one, bash('ls'), allow, ctx, null) };
    const base = { state: { toolCalls: 1, tokens: 0, prevTokens: 0 }, memory: one };
    const m = mergeSession(base, disk, ours);
    assert.equal(m.state.toolCalls, 3);
    assert.equal(m.memory.history.length, 3, 'the repeated npm test is not dropped');
  });

  it('a stale lock that cannot be removed as a file still ends in a throw within the wait, never a hang', () => {
    const dir = tempDir('conc');
    const file = sessionStatePath('s', dir);
    mkdirSync(`${file}.lock`, { recursive: true });
    writeFileSync(join(`${file}.lock`, 'x'), '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${file}.lock`, old, old);
    const t0 = Date.now();
    try {
      withSessionLock(file, () => 1);
    } catch (err) {
      assert.match(String(err), /held its saved state for too long|EISDIR|EEXIST/);
    }
    assert.ok(Date.now() - t0 < 5000, 'it returned or threw within the wait');
  });

  it('releasing the lock leaves alone a lock that another call now holds', () => {
    const dir = tempDir('conc');
    const file = sessionStatePath('s', dir);
    mkdirSync(dirname(file), { recursive: true });
    withSessionLock(file, () => writeFileSync(`${file}.lock`, 'someone else'));
    assert.equal(readFileSync(`${file}.lock`, 'utf8'), 'someone else');
  });

  it('twelve hook processes of one session started together lose no taint mark and no count', async () => {
    const home = tempDir('conc');
    const cwd = tempDir('conc');
    const runs = Array.from({ length: 12 }, (_, i) => {
      const tool = i % 2 === 0 ? 'WebFetch' : 'Read';
      const tool_input = i % 2 === 0 ? { url: `https://site${i}.example.test/`, prompt: 'read' } : { file_path: join(cwd, `f${i}.txt`) };
      const input = JSON.stringify({ session_id: 'swarm', cwd, hook_event_name: 'PreToolUse', tool_name: tool, tool_input, tool_use_id: `toolu_${i}` });
      return new Promise<number>((resolve) => {
        const p = spawn(process.execPath, [CLI, 'hook', 'claude-code'], { cwd, env: { ...process.env, OPENMORALS_HOME: home, OPENMORALS_UNATTENDED: '' } });
        p.stdin.end(input);
        p.stdout.resume();
        p.stderr.resume();
        p.on('close', (code) => resolve(code ?? -1));
      });
    });
    const codes = await Promise.all(runs);
    assert.deepEqual(codes, codes.map(() => 0));
    const s = loadSession('swarm', home);
    assert.equal(s.state.toolCalls, 12);
    // A call that asked (a lock wait can make one ask) holds its mark until it runs (0.36.2): marked or held, none is lost.
    const held = s.memory.history.filter((e) => e.held === true && e.action.kind === 'fetch').length;
    assert.equal(s.memory.taint.untrustedCount + held, 6, 'every web page read left its mark');
    assert.equal(existsSync(`${sessionStatePath('swarm', home)}.lock`), false);
  });
});
