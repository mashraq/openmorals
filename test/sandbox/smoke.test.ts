import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULT_BYLAWS } from '../../src/bylaws.js';
import { expandProtectedPaths, findProtectedPaths, planSandbox, runSandboxed } from '../../src/sandbox/index.js';
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

it('macOS smoke: protected paths (test-lock) stay read-only to a script, a rename of their parent is refused, other writes go through', { skip: enabled ? false : 'set OPENMORALS_SANDBOX_SMOKE=1 on macOS with /usr/bin/sandbox-exec' }, async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'omr-smoke-')));
  try {
    const project = path.join(base, 'project');
    for (const d of ['test/acceptance', 'src', 'web']) fs.mkdirSync(path.join(project, d), { recursive: true });
    const judged = path.join(project, 'test/acceptance/a.test.js');
    fs.writeFileSync(judged, 'original\n');
    fs.writeFileSync(path.join(project, 'vitest.config.ts'), 'original\n');
    const b = JSON.parse(JSON.stringify(DEFAULT_BYLAWS)) as typeof DEFAULT_BYLAWS;
    b.sandbox.write.protected_paths = ['test-lock'];
    const found = findProtectedPaths(project, expandProtectedPaths(['test-lock']));
    const plan = planSandbox(b, 'darwin', project, { home: fs.realpathSync(os.homedir()), tmpDirs: [], protectedFound: found.found });
    assert.ok(plan.ok, plan.ok ? '' : plan.error);
    const quiet: SpawnLike = (file, args, options) =>
      new Promise((resolve) => {
        execFile(file, args, { cwd: options.cwd, env: options.env }, (err) => resolve({ code: err === null ? 0 : typeof err.code === 'number' ? err.code : 1, signal: null }));
      });
    const sh = async (script: string): Promise<number> => (await runSandboxed('/bin/sh', ['-c', script], plan, { spawn: quiet })).exitCode;
    const q = (p: string): string => `'${p}'`;
    const results: Record<string, number> = {
      'new file in test/acceptance': await sh(`touch ${q(path.join(project, 'test/acceptance/new.test.js'))}`),
      'overwrite a judging test': await sh(`echo changed > ${q(judged)}`),
      'python writes a judging test': await sh(`/usr/bin/python3 -c "open('${judged}','w').write('py')"`),
      'rename the parent folder test/': await sh(`mv ${q(path.join(project, 'test'))} ${q(path.join(project, 'test2'))}`),
      'remove test/acceptance': await sh(`rm -rf ${q(path.join(project, 'test/acceptance'))}`),
      'new __snapshots__ folder and file': await sh(`mkdir -p ${q(path.join(project, 'web/__snapshots__'))} && touch ${q(path.join(project, 'web/__snapshots__/x.snap'))}`),
      'overwrite vitest.config.ts': await sh(`echo changed > ${q(path.join(project, 'vitest.config.ts'))}`),
      'new file in src/': await sh(`touch ${q(path.join(project, 'src/ok.ts'))}`),
      'new file beside the protected folder in test/': await sh(`touch ${q(path.join(project, 'test/unit.test.js'))}`),
    };
    t.diagnostic(`profile protected block:\n${plan.ok && plan.platform === 'darwin' ? plan.seatbelt.split(';; protected paths')[1]?.split(';;')[0] ?? '' : ''}`);
    for (const [k, v] of Object.entries(results)) t.diagnostic(`${v === 0 ? 'WROTE ' : 'DENIED'} ${k} (exit ${v})`);
    for (const k of ['new file in test/acceptance', 'overwrite a judging test', 'python writes a judging test', 'rename the parent folder test/', 'remove test/acceptance', 'new __snapshots__ folder and file', 'overwrite vitest.config.ts']) assert.notEqual(results[k], 0, k);
    assert.equal(results['new file in src/'], 0);
    assert.equal(results['new file beside the protected folder in test/'], 0);
    assert.equal(fs.readFileSync(judged, 'utf8'), 'original\n');
    assert.equal(fs.readFileSync(path.join(project, 'vitest.config.ts'), 'utf8'), 'original\n');
    assert.equal(fs.existsSync(path.join(project, 'test/acceptance/new.test.js')), false);
    assert.equal(fs.existsSync(path.join(project, 'test2')), false);
    assert.equal(fs.existsSync(path.join(project, 'web/__snapshots__/x.snap')), false);
    fs.writeFileSync(judged, 'written without the sandbox\n');
    assert.equal(fs.readFileSync(judged, 'utf8'), 'written without the sandbox\n', 'control: the same file is writable outside the sandbox');
  } finally {
    if (path.basename(base).startsWith('omr-smoke-')) fs.rmSync(base, { recursive: true, force: true });
  }
});
