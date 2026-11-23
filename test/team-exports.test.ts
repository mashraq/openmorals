import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decide } from '../src/engine.js';
import { parseBylaws } from '../src/bylaws.js';
import { isSafeAllowTarget, matchesAllowTarget, normalizeAllowTarget } from '../src/guards/destructive.js';
import { ALL_HOOK_EVENTS, hasOpenMoralsHook, mergeClaudeSettings } from '../src/init.js';
import { EMPTY_STATE } from '../src/types.js';

const NORMALIZE: [string, string][] = [
  ['dist', 'dist'],
  ['./dist', 'dist'],
  ['dist/', 'dist'],
  ['dist///', 'dist'],
  ['build\\out', 'build/out'],
  ['.\\dist', 'dist'],
  ['././dist', './dist'],
  ['DIST', 'DIST'],
];

interface MatchCase {
  target: string;
  allow: string[];
  match: boolean;
}

const MATCH: MatchCase[] = [
  { target: 'dist', allow: ['dist'], match: true },
  { target: './dist/', allow: ['dist'], match: true },
  { target: 'packages/web/dist', allow: ['dist'], match: true },
  { target: 'packages/web/dist', allow: ['web/dist'], match: true },
  { target: 'distro', allow: ['dist'], match: false },
  { target: 'mydist', allow: ['dist'], match: false },
  { target: 'DIST', allow: ['dist'], match: false },
  { target: 'node_modules', allow: ['dist', 'node_modules'], match: true },
  { target: 'src', allow: ['dist'], match: false },
  { target: 'build\\out', allow: ['out'], match: true },
];

describe('allow-target normaliser and matcher (exported for the team package)', () => {
  for (const [input, want] of NORMALIZE) it(`normalizeAllowTarget(${JSON.stringify(input)})`, () => assert.equal(normalizeAllowTarget(input), want));
  for (const c of MATCH) {
    it(`${c.target} against [${c.allow.join(', ')}] is ${c.match ? 'a match' : 'no match'}, and the engine agrees`, () => {
      assert.equal(matchesAllowTarget(c.target, c.allow), c.match);
      const b = parseBylaws(`version: 1\nguards:\n  destructive: { allow_targets: [${c.allow.map((a) => JSON.stringify(a)).join(', ')}] }\n`);
      assert.ok(b.ok, b.ok ? '' : b.error);
      const v = decide({ kind: 'exec', command: `rm -rf '${c.target}'`, shell: 'posix', tool: 'Bash' }, b, EMPTY_STATE);
      assert.equal(v.decision === 'allow', c.match && isSafeAllowTarget(c.target), v.reason);
    });
  }
  it('isSafeAllowTarget refuses the forms the engine never allows', () => {
    for (const t of ['', '*', 'dist/*', '../dist', '/abs', '~/x', '$HOME', 'C:\\x', '%TEMP%']) assert.equal(isSafeAllowTarget(t), false, t);
    for (const t of ['dist', 'a/b', './dist']) assert.equal(isSafeAllowTarget(t), true, t);
  });
});

const ours = { type: 'command', command: 'openmorals hook claude-code', timeout: 30 };
const SETTINGS: { name: string; settings: unknown; pre: boolean; all: boolean }[] = [
  { name: 'nothing', settings: {}, pre: false, all: false },
  { name: 'not an object', settings: [], pre: false, all: false },
  { name: 'hooks not an object', settings: { hooks: [] }, pre: false, all: false },
  { name: 'PreToolUse only', settings: { hooks: { PreToolUse: [{ matcher: '*', hooks: [ours] }] } }, pre: true, all: false },
  { name: 'all three events', settings: { hooks: Object.fromEntries(ALL_HOOK_EVENTS.map((e) => [e, [{ matcher: '*', hooks: [ours] }]])) }, pre: true, all: true },
  { name: 'a full path to the CLI is not recognised without that exact command', settings: { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node /opt/openmorals/dist/src/cli.js hook claude-code' }] }] } }, pre: false, all: false },
  { name: 'a path ending in openmorals is recognised', settings: { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: '/opt/bin/openmorals hook claude-code --unattended' }] }] } }, pre: true, all: false },
  { name: 'someone else hook', settings: { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'lint-staged' }] }] } }, pre: false, all: false },
  { name: 'the codex hook does not count for Claude Code', settings: { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'openmorals hook codex' }] }] } }, pre: false, all: false },
];

describe('hasOpenMoralsHook (exported for the team package)', () => {
  for (const c of SETTINGS) {
    it(c.name, () => {
      assert.equal(hasOpenMoralsHook(c.settings), c.pre);
      assert.equal(hasOpenMoralsHook(c.settings, ALL_HOOK_EVENTS), c.all);
      const m = mergeClaudeSettings(c.settings);
      if (m.ok) assert.equal(!m.changed, c.pre, 'agrees with mergeClaudeSettings');
      const mAll = mergeClaudeSettings(c.settings, undefined, ALL_HOOK_EVENTS);
      if (mAll.ok) assert.equal(!mAll.changed, c.all, 'agrees with mergeClaudeSettings for all events');
    });
  }
  it('a full-path install is recognised when its command is passed', () => {
    const cmd = 'node /opt/openmorals/dist/src/cli.js hook claude-code';
    assert.equal(hasOpenMoralsHook({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: cmd }] }] } }, ['PreToolUse'], cmd), true);
  });
});
