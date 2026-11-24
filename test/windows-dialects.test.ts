import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runCodexHook } from '../src/adapters/codex/index.js';
import { runGeminiHook } from '../src/adapters/gemini-cli/index.js';
import { runOpencodeHook } from '../src/adapters/opencode/index.js';
import type { Verdict } from '../src/types.js';
import { decisionRank } from '../src/types.js';
import { loadCaseFiles } from './case-loader.js';
import { tempDir } from './helpers.js';

// On Windows, Codex, Gemini CLI and opencode do not say which shell will run a command: it may be PowerShell, cmd,
// Git Bash or WSL. The property: a command must get the same or a stricter verdict when the host runs on Windows as
// when it runs on macOS or Linux. Checked for every POSIX command in the guard case files, with the platform forced,
// so the Windows branch runs on every machine.

type Host = 'codex' | 'gemini-cli' | 'opencode';
const HOSTS: readonly Host[] = ['codex', 'gemini-cli', 'opencode'];

function event(host: Host, command: string, cwd: string, session: string): string {
  if (host === 'codex') return JSON.stringify({ session_id: session, cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } });
  if (host === 'gemini-cli') return JSON.stringify({ session_id: session, cwd, hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command } });
  return JSON.stringify({ event: 'tool.execute.before', api: 'v1', sessionID: session, callID: 'c', tool: 'bash', args: { command }, cwd });
}

function verdictOf(host: Host, stdin: string, home: string, platform: NodeJS.Platform): Verdict {
  const opts = { env: { OPENMORALS_HOME: home }, platform };
  if (host === 'codex') return runCodexHook(stdin, opts).verdict;
  if (host === 'gemini-cli') return runGeminiHook(stdin, opts).verdict;
  return runOpencodeHook(stdin, opts).verdict;
}

const COMMANDS: readonly string[] = [
  ...new Set(
    loadCaseFiles()
      .filter((f) => f.guard !== 'budget')
      .flatMap((f) => f.cases)
      .filter((c) => c.bylaws === null && c.action.kind === 'exec' && c.action.shell === 'posix')
      .map((c) => (c.action.kind === 'exec' ? c.action.command : '')),
  ),
];

describe('Windows hosts judge a command at least as strictly as macOS and Linux hosts', () => {
  it('has the case-file commands to check', () => {
    assert.ok(COMMANDS.length >= 100, `only ${COMMANDS.length} commands`);
  });
  for (const host of HOSTS) {
    it(`${host}: no case-file command is looser on win32 than on darwin or linux`, () => {
      const cwd = tempDir('windialect-proj');
      const homes = { darwin: tempDir('windialect-mac'), linux: tempDir('windialect-linux'), win32: tempDir('windialect-win') };
      const looser: string[] = [];
      COMMANDS.forEach((command, i) => {
        const session = `wd-${i}`;
        const win = verdictOf(host, event(host, command, cwd, session), homes.win32, 'win32');
        for (const p of ['darwin', 'linux'] as const) {
          const unix = verdictOf(host, event(host, command, cwd, session), homes[p], p);
          if (decisionRank(win.decision) < decisionRank(unix.decision)) looser.push(`${p} ${unix.decision} [${unix.rule}] but win32 ${win.decision}: ${command}`);
        }
      });
      assert.deepEqual(looser, []);
    });
  }
  it('rm -rf through each host on win32 asks, with the destructive rule', () => {
    for (const host of HOSTS) {
      const v = verdictOf(host, event(host, 'rm -rf build', tempDir('windialect-proj'), 's'), tempDir('windialect-home'), 'win32');
      assert.equal(v.decision, 'ask', `${host}: ${v.reason}`);
      assert.equal(v.rule, 'destructive.recursive-delete', host);
    }
  });
  it('a PowerShell-only delete on win32 still asks (the PowerShell reading is kept)', () => {
    for (const host of HOSTS) {
      const v = verdictOf(host, event(host, 'ri -r -fo .\\build', tempDir('windialect-proj'), 's'), tempDir('windialect-home'), 'win32');
      assert.equal(v.decision, 'ask', `${host}: ${v.reason}`);
    }
  });
});
