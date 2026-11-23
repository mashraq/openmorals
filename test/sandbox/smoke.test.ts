import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_BYLAWS } from '../../src/bylaws.js';
import { planSandbox, runSandboxed } from '../../src/sandbox/index.js';
import type { SpawnLike } from '../../src/sandbox/index.js';

// A real run under sandbox-exec. Off by default; set OPENMORALS_SANDBOX_SMOKE=1 on macOS to run it.
// It touches nothing outside the temp directory it creates, and removes that directory at the end.
const enabled = process.env['OPENMORALS_SANDBOX_SMOKE'] === '1' && process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');

it('macOS smoke: echo runs, a write outside the project fails, a write inside succeeds', { skip: enabled ? false : 'set OPENMORALS_SANDBOX_SMOKE=1 on macOS with /usr/bin/sandbox-exec' }, async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'omr-smoke-')));
  try {
    const project = path.join(base, 'project');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(project);
    fs.mkdirSync(outside);
    const plan = planSandbox(DEFAULT_BYLAWS, 'darwin', project, { home: fs.realpathSync(os.homedir()), tmpDirs: [] });
    assert.ok(plan.ok, plan.ok ? '' : plan.error);
    const out: string[] = [];
    const capture: SpawnLike = (file, args, options) =>
      new Promise((resolve) => {
        execFile(file, args, { cwd: options.cwd, env: options.env }, (err, stdout, stderr) => {
          out.push(`$ ${path.basename(file)} -p <profile> ${args.slice(2).join(' ')}\n${stdout}${stderr}`.trimEnd());
          const code = err === null ? 0 : typeof err.code === 'number' ? err.code : 1;
          resolve({ code, signal: null });
        });
      });
    const echo = await runSandboxed('/bin/echo', ['hello from the sandbox'], plan, { spawn: capture });
    const forbidden = path.join(outside, 'forbidden.txt');
    const denied = await runSandboxed('/usr/bin/touch', [forbidden], plan, { spawn: capture });
    const allowedFile = path.join(project, 'allowed.txt');
    const allowed = await runSandboxed('/usr/bin/touch', [allowedFile], plan, { spawn: capture });
    fs.writeFileSync(path.join(outside, 'control.txt'), 'written without the sandbox\n');
    for (const line of out) t.diagnostic(line);
    t.diagnostic(`exit codes: echo=${echo.exitCode} outside-write=${denied.exitCode} inside-write=${allowed.exitCode}; forbidden exists=${fs.existsSync(forbidden)}; allowed exists=${fs.existsSync(allowedFile)}; control write outside without sandbox ok=${fs.existsSync(path.join(outside, 'control.txt'))}`);
    assert.equal(echo.exitCode, 0);
    assert.match(out[0] ?? '', /hello from the sandbox/);
    assert.notEqual(denied.exitCode, 0);
    assert.equal(fs.existsSync(forbidden), false);
    assert.equal(allowed.exitCode, 0);
    assert.equal(fs.existsSync(allowedFile), true);
  } finally {
    if (path.basename(base).startsWith('omr-smoke-')) fs.rmSync(base, { recursive: true, force: true });
  }
});
