import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { runCodexHook } from '../src/adapters/codex/index.js';
import { hostConfigVerdicts } from '../src/adapters/codex/pipeline.js';
import { runGeminiHook } from '../src/adapters/gemini-cli/index.js';
import { installAgentHook, opencodeCommand } from '../src/adapters/install.js';
import { PLUGIN_MARKER, runOpencodeHook } from '../src/adapters/opencode/index.js';
import { DEFAULT_BYLAWS } from '../src/bylaws.js';
import type { Verdict } from '../src/types.js';
import { REPO_ROOT, tempDir, withOpenmoralsOnPath } from './helpers.js';

const CLI = join(REPO_ROOT, 'dist', 'src', 'cli.js');

type Host = 'codex' | 'gemini-cli' | 'opencode';
type Call = { kind: 'shell'; command: string } | { kind: 'read'; path: string } | { kind: 'fetch'; url: string };

/** One host event in each host's documented input shape. */
function event(host: Host, call: Call, cwd: string, session: string): string {
  if (host === 'codex') {
    const base = { session_id: session, transcript_path: null, cwd, hook_event_name: 'PreToolUse', model: 'm', permission_mode: 'default', turn_id: 't', tool_use_id: `c${Math.random()}` };
    if (call.kind === 'shell') return JSON.stringify({ ...base, tool_name: 'Bash', tool_input: { command: call.command } });
    if (call.kind === 'read') return JSON.stringify({ ...base, tool_name: 'mcp__fs__read_file', tool_input: { path: call.path } });
    return JSON.stringify({ ...base, tool_name: 'mcp__web__fetch', tool_input: { url: call.url } });
  }
  if (host === 'gemini-cli') {
    const base = { session_id: session, transcript_path: '/tmp/t.json', cwd, hook_event_name: 'BeforeTool', timestamp: '2026-01-01T00:00:00.000Z' };
    if (call.kind === 'shell') return JSON.stringify({ ...base, tool_name: 'run_shell_command', tool_input: { command: call.command } });
    if (call.kind === 'read') return JSON.stringify({ ...base, tool_name: 'read_file', tool_input: { file_path: call.path } });
    return JSON.stringify({ ...base, tool_name: 'web_fetch', tool_input: { prompt: `summarise ${call.url}` } });
  }
  const base = { event: 'tool.execute.before', api: 'v1', sessionID: session, callID: `c${Math.random()}`, cwd };
  if (call.kind === 'shell') return JSON.stringify({ ...base, tool: 'bash', args: { command: call.command } });
  if (call.kind === 'read') return JSON.stringify({ ...base, tool: 'read', args: { filePath: call.path } });
  return JSON.stringify({ ...base, tool: 'webfetch', args: { url: call.url } });
}

function run(host: Host, stdin: string, home: string, extra: { unattended?: boolean; env?: Record<string, string>; platform?: NodeJS.Platform } = {}): { verdict: Verdict; stdout: string } {
  const opts = { env: { OPENMORALS_HOME: home, ...(extra.env ?? {}) }, ...(extra.unattended === true ? { unattended: true } : {}), ...(extra.platform === undefined ? {} : { platform: extra.platform }) };
  if (host === 'codex') return runCodexHook(stdin, opts);
  if (host === 'gemini-cli') return runGeminiHook(stdin, opts);
  return runOpencodeHook(stdin, opts);
}

const HOSTS: readonly Host[] = ['codex', 'gemini-cli', 'opencode'];
/** The host shell dialect follows the platform, so the session cases run as macOS and as Windows on every machine. */
const PLATFORMS: readonly NodeJS.Platform[] = ['darwin', 'win32'];

interface SessionCase {
  name: string;
  calls: Call[];
  last: { decision: 'ask' | 'deny' | 'allow'; rule: string };
  /** 0.41.3: on Codex and opencode V1 an ask is sent as a block, so the asked call never runs and leaves no taint mark. */
  lastWhereAskBlocks?: { decision: 'ask' | 'deny' | 'allow'; rule: string };
  /** The user-level bylaws, written to the temp home. */
  userBylaws?: string;
  unattended?: boolean;
}

const SESSION_CASES: SessionCase[] = [
  { name: 'loop: the 4th identical command asks', calls: [1, 2, 3, 4].map(() => ({ kind: 'shell', command: 'npm run lint' }) as Call), last: { decision: 'ask', rule: 'loop.repeat' } },
  { name: 'loop: three identical commands are fine', calls: [1, 2, 3].map(() => ({ kind: 'shell', command: 'npm run lint' }) as Call), last: { decision: 'allow', rule: 'none' } },
  {
    name: 'taint: web page, then .env, then a network call asks',
    calls: [{ kind: 'fetch', url: 'https://pages.example.test/a' }, { kind: 'read', path: '/work/app/.env' }, { kind: 'shell', command: 'curl "https://x.example.test/?q=1"' }],
    last: { decision: 'ask', rule: 'taint.rule-of-two' },
    lastWhereAskBlocks: { decision: 'allow', rule: 'none' },
  },
  {
    name: 'taint: web page, then an allowed .env read, then a network call asks',
    calls: [{ kind: 'fetch', url: 'https://pages.example.test/a' }, { kind: 'read', path: '/work/app/.env' }, { kind: 'shell', command: 'curl "https://x.example.test/?q=1"' }],
    last: { decision: 'ask', rule: 'taint.rule-of-two' },
    userBylaws: 'version: 1\nguards:\n  secrets:\n    read: allow\n',
  },
  { name: 'taint: a network call with nothing untrusted before it is fine', calls: [{ kind: 'shell', command: 'curl "https://x.example.test/?q=1"' }], last: { decision: 'allow', rule: 'none' } },
  { name: 'unattended: an ask becomes deny', calls: [{ kind: 'shell', command: 'rm -rf build' }], last: { decision: 'deny', rule: 'destructive.recursive-delete' }, unattended: true },
  { name: 'unattended: a loop ask becomes deny', calls: [1, 2, 3, 4].map(() => ({ kind: 'shell', command: 'npm run lint' }) as Call), last: { decision: 'deny', rule: 'loop.repeat' }, unattended: true },
];

describe('loop detector, taint judge and unattended mode on the other hosts', () => {
  for (const host of HOSTS) {
    for (const c of SESSION_CASES) for (const platform of PLATFORMS) {
      it(`${host}: ${c.name} [${platform}]`, () => {
        const home = tempDir('agent-home');
        const cwd = tempDir('agent-proj');
        if (c.userBylaws !== undefined) writeFileSync(join(home, 'openmorals.yaml'), c.userBylaws);
        let last: Verdict | null = null;
        for (const call of c.calls) last = run(host, event(host, call, cwd, 'sess'), home, { platform, ...(c.unattended === true ? { unattended: true } : {}) }).verdict;
        const want = host !== 'gemini-cli' && c.lastWhereAskBlocks !== undefined ? c.lastWhereAskBlocks : c.last;
        assert.equal(last?.decision, want.decision, last?.reason);
        assert.equal(last?.rule, want.rule, last?.reason);
      });
    }
    it(`${host}: OPENMORALS_UNATTENDED=1 also turns a fail-closed ask into deny`, () => {
      const r = run(host, 'not json', tempDir('agent-home'), { env: { OPENMORALS_UNATTENDED: '1' } });
      assert.equal(r.verdict.decision, 'deny');
      assert.equal(r.verdict.rule, 'hook.bad-input');
    });
  }
  for (const platform of PLATFORMS) it(`gemini-cli prints decision deny under unattended [${platform}]`, () => {
    const cwd = tempDir('agent-proj');
    const r = run('gemini-cli', event('gemini-cli', { kind: 'shell', command: 'rm -rf build' }, cwd, 's'), tempDir('agent-home'), { unattended: true, platform });
    assert.equal((JSON.parse(r.stdout) as { decision: string }).decision, 'deny');
  });
  it('opencode: the permission check of the same call is not counted as a repeat', () => {
    const home = tempDir('agent-home');
    const cwd = tempDir('agent-proj');
    const perm = JSON.stringify({ event: 'permission.evaluate', sessionID: 's', action: 'shell', resources: ['npm run lint'], effect: 'ask', cwd });
    for (let i = 0; i < 3; i++) {
      assert.equal(run('opencode', event('opencode', { kind: 'shell', command: 'npm run lint' }, cwd, 's'), home).verdict.rule, 'none');
      assert.equal(run('opencode', perm, home).verdict.rule, 'none');
    }
    assert.equal(run('opencode', event('opencode', { kind: 'shell', command: 'npm run lint' }, cwd, 's'), home).verdict.rule, 'loop.repeat');
  });
  it('the adapters still carry their own host-config check behind the core guard', () => {
    const v = hostConfigVerdicts([{ kind: 'write', path: '/home/dev/.config/codex/hooks.json', tool: 'write' }], DEFAULT_BYLAWS);
    assert.equal(v[0]?.rule, 'adapter.host-config');
  });
});

describe('installAgentHook (temp folders only)', () => {
  for (const agent of ['codex', 'gemini-cli'] as const) {
    const rel = agent === 'codex' ? '.codex/hooks.json' : '.gemini/settings.json';
    const cmd = agent === 'codex' ? 'openmorals hook codex' : 'openmorals hook gemini-cli';
    it(`${agent}: creates the file, then changes nothing on a second run`, () => {
      const dir = tempDir('inst');
      const a = installAgentHook(dir, agent);
      assert.ok(a.ok && a.changed && a.backupPath === null);
      assert.match(readFileSync(join(dir, rel), 'utf8'), new RegExp(cmd));
      const b = installAgentHook(dir, agent);
      assert.ok(b.ok && !b.changed);
    });
    it(`${agent}: merges into an existing file, keeps its keys and backs it up`, () => {
      const dir = tempDir('inst');
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      const before = JSON.stringify({ model: 'x', hooks: { Other: [{ hooks: [{ type: 'command', command: 'lint' }] }] } });
      writeFileSync(join(dir, rel), before);
      const r = installAgentHook(dir, agent, { now: new Date('2026-01-01T00:00:00Z') });
      assert.ok(r.ok && r.changed && r.backupPath !== null);
      assert.equal(readFileSync(r.backupPath, 'utf8'), before);
      const after = JSON.parse(readFileSync(join(dir, rel), 'utf8')) as { model: string; hooks: Record<string, unknown> };
      assert.equal(after.model, 'x');
      assert.ok('Other' in after.hooks);
    });
    it(`${agent}: a file that is not plain JSON is left untouched and the snippet is returned`, () => {
      const dir = tempDir('inst');
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      const text = '{ // a comment\n  "model": "x" }\n';
      writeFileSync(join(dir, rel), text);
      const r = installAgentHook(dir, agent);
      assert.ok(!r.ok);
      assert.match(r.snippet, new RegExp(cmd));
      assert.equal(readFileSync(join(dir, rel), 'utf8'), text);
      assert.deepEqual(readdirSync(join(dir, rel, '..')).length, 1);
    });
  }
  it('opencode: writes the plugin, refreshes its own copy, refuses a foreign file', () => {
    const dir = tempDir('inst');
    const a = installAgentHook(dir, 'opencode');
    assert.ok(a.ok && a.changed);
    const file = join(dir, '.opencode', 'plugins', 'openmorals.js');
    assert.ok(readFileSync(file, 'utf8').startsWith(PLUGIN_MARKER));
    assert.ok(installAgentHook(dir, 'opencode').ok);
    writeFileSync(file, 'export default {}\n');
    const c = installAgentHook(dir, 'opencode');
    assert.ok(!c.ok);
    assert.equal(readFileSync(file, 'utf8'), 'export default {}\n');
  });
  it('opencode: the hook command is a JSON array or words', () => {
    assert.deepEqual(opencodeCommand('["node", "/opt/om dir/cli.js", "hook", "opencode"]'), ['node', '/opt/om dir/cli.js', 'hook', 'opencode']);
    assert.deepEqual(opencodeCommand('node cli.js hook opencode'), ['node', 'cli.js', 'hook', 'opencode']);
    assert.equal(opencodeCommand('  '), null);
    assert.equal(opencodeCommand('[1]'), null);
    const dir = tempDir('inst');
    const r = installAgentHook(dir, 'opencode', { hookCommand: '["node","/opt/om/cli.js","hook","opencode"]' });
    assert.ok(r.ok);
    assert.match(readFileSync(join(dir, '.opencode', 'plugins', 'openmorals.js'), 'utf8'), /\/opt\/om\/cli\.js/);
  });
});

function cli(args: string[], cwd: string, input?: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, input, env: { PATH: withOpenmoralsOnPath()['PATH'] ?? '', OPENMORALS_HOME: tempDir('agent-cli-home') }, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('the CLI for the other hosts', () => {
  it('hook codex blocks a force push (an ask is sent as deny) and exits 0', () => {
    const cwd = tempDir('agent-proj');
    const r = cli(['hook', 'codex'], cwd, event('codex', { kind: 'shell', command: 'git push --force origin main' }, cwd, 's'));
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /^openmorals ask \[destructive\.git-force-push\]/);
  });
  it('hook gemini-cli prints {} for allow and ask for a delete', () => {
    const cwd = tempDir('agent-proj');
    assert.equal(cli(['hook', 'gemini-cli'], cwd, event('gemini-cli', { kind: 'shell', command: 'ls' }, cwd, 's')).stdout.trim(), '{}');
    const r = cli(['hook', 'gemini-cli'], cwd, event('gemini-cli', { kind: 'shell', command: 'rm -rf build' }, cwd, 's'));
    assert.equal((JSON.parse(r.stdout) as { decision: string }).decision, 'ask');
  });
  it('hook opencode answers one JSON object', () => {
    const cwd = tempDir('agent-proj');
    const r = cli(['hook', 'opencode'], cwd, event('opencode', { kind: 'shell', command: 'rm -rf build' }, cwd, 's'));
    assert.equal(r.status, 0);
    const a = JSON.parse(r.stdout) as { decision: string; block: boolean };
    assert.equal(a.decision, 'ask');
    assert.equal(a.block, true);
  });
  it('init --agent codex writes the bylaws and the hook file; an unknown agent is a usage error', () => {
    const dir = tempDir('agent-init');
    const r = cli(['init', dir, '--agent', 'codex'], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(join(dir, 'openmorals.yaml')));
    assert.ok(existsSync(join(dir, '.codex', 'hooks.json')));
    assert.ok(!existsSync(join(dir, '.claude')));
    assert.match(r.stdout, /\/hooks/);
    assert.equal(cli(['init', dir, '--agent', 'cursor'], dir).status, 64);
  });
  it('init --agent gemini-cli prints the snippet and writes nothing when settings.json has comments', () => {
    const dir = tempDir('agent-init');
    mkdirSync(join(dir, '.gemini'));
    writeFileSync(join(dir, '.gemini', 'settings.json'), '{ // mine\n}\n');
    const r = cli(['init', dir, '--agent', 'gemini-cli'], dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /openmorals hook gemini-cli/);
    assert.equal(readFileSync(join(dir, '.gemini', 'settings.json'), 'utf8'), '{ // mine\n}\n');
  });
});
