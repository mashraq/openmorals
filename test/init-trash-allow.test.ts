import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { initProject, mergeTrashAllow, TRASH_ALLOW_RULE, trashRoundTrip } from '../src/init.js';
import { REPO_ROOT, tempDir } from './helpers.js';

const CLI = join(REPO_ROOT, 'dist', 'src', 'cli.js');
const PASS = (): { ok: true } => ({ ok: true });

function settings(dir: string): Record<string, any> {
  return JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8')) as Record<string, any>;
}

function backups(dir: string): number {
  return readdirSync(join(dir, '.claude')).filter((f) => f.includes('openmorals-backup')).length;
}

describe('init: the recoverable delete allowed in Claude Code', () => {
  it('the round trip trashes and restores a test file and leaves no folder behind', () => {
    const base = tempDir('om-trash-check');
    assert.deepEqual(trashRoundTrip(base), { ok: true });
    assert.deepEqual(readdirSync(base), [], 'the temp folder is removed');
  });

  it('the round trip fails, and says why, where the trash cannot work', () => {
    const r = trashRoundTrip(join(tempDir('om-trash-check-missing'), 'not-there'));
    assert.equal(r.ok, false);
  });

  it('adds the allow rule after the check passes, beside the hook', () => {
    const dir = tempDir('om-trash-allow');
    let checked = 0;
    const r = initProject(dir, { trashCheck: () => (checked++, { ok: true }) });
    assert.ok(r.ok);
    assert.equal(checked, 1);
    assert.deepEqual(r.trashAllow, { status: 'added' });
    assert.equal(r.hookChanged, true);
    assert.deepEqual(settings(dir)['permissions'], { allow: [TRASH_ALLOW_RULE] });
  });

  it('runs the real round trip by default', () => {
    const dir = tempDir('om-trash-allow-real');
    const r = initProject(dir);
    assert.ok(r.ok);
    assert.deepEqual(r.trashAllow, { status: 'added' });
    assert.deepEqual(readdirSync(dir).sort(), ['.claude', 'openmorals.yaml'], 'nothing else is written in the project');
  });

  it('does not add the rule when the check fails, and still installs the hook', () => {
    const dir = tempDir('om-trash-allow-fail');
    const r = initProject(dir, { trashCheck: () => ({ ok: false, why: 'the restored test file did not match the original' }) });
    assert.ok(r.ok);
    assert.deepEqual(r.trashAllow, { status: 'failed', why: 'the restored test file did not match the original' });
    assert.equal(settings(dir)['permissions'], undefined);
    assert.ok(settings(dir)['hooks']['PreToolUse'].length > 0);
  });

  it('is idempotent: a second run finds the rule and changes nothing', () => {
    const dir = tempDir('om-trash-allow-again');
    assert.ok(initProject(dir, { trashCheck: PASS }).ok);
    let checked = 0;
    const again = initProject(dir, { trashCheck: () => (checked++, { ok: true }) });
    assert.ok(again.ok && !again.settingsChanged);
    assert.deepEqual(again.trashAllow, { status: 'present' });
    assert.equal(checked, 0, 'no check when the rule is already there');
    assert.deepEqual(settings(dir)['permissions'], { allow: [TRASH_ALLOW_RULE] });
  });

  it('adds the rule to a project set up before it, with a backup, and keeps other rules', () => {
    const dir = tempDir('om-trash-allow-old');
    assert.ok(initProject(dir, { trashAllow: false }).ok);
    const s = settings(dir);
    s['permissions'] = { allow: ['Bash(npm test:*)'], deny: ['Bash(curl:*)'] };
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify(s));
    const r = initProject(dir, { trashCheck: PASS });
    assert.ok(r.ok && r.settingsChanged);
    assert.equal(r.hookChanged, false);
    assert.equal(backups(dir), 1);
    assert.deepEqual(settings(dir)['permissions'], { allow: ['Bash(npm test:*)', TRASH_ALLOW_RULE], deny: ['Bash(curl:*)'] });
  });

  it('leaves it out when turned off, for a project at or above the home folder, and for odd permissions', () => {
    const off = tempDir('om-trash-allow-off');
    const r1 = initProject(off, { trashAllow: false, trashCheck: () => assert.fail('no check when turned off') });
    assert.ok(r1.ok && r1.trashAllow?.status === 'skipped');
    assert.equal(settings(off)['permissions'], undefined);

    const home = tempDir('om-trash-allow-home');
    const r2 = initProject(home, { home, trashCheck: () => assert.fail('no check at the home folder') });
    assert.ok(r2.ok && r2.trashAllow?.status === 'skipped');
    const parent = tempDir('om-trash-allow-above');
    const nestedHome = join(parent, 'home', 'me');
    mkdirSync(nestedHome, { recursive: true });
    const r3 = initProject(parent, { home: nestedHome, trashCheck: () => assert.fail('no check above the home folder') });
    assert.ok(r3.ok && r3.trashAllow?.status === 'skipped');
    assert.equal(settings(parent)['permissions'], undefined);

    const odd = mergeTrashAllow({ permissions: { allow: 'Bash(*)' } }, PASS);
    assert.equal(odd.changed, false);
    assert.equal(odd.result.status, 'skipped');
    assert.equal(mergeTrashAllow({ permissions: [] }, PASS).result.status, 'skipped');
  });

  it('the CLI says what it did, and --no-trash-allow leaves the rule out', () => {
    const dir = tempDir('om-trash-allow-cli');
    const r = spawnSync(process.execPath, [CLI, 'init', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /allowed Bash\(openmorals trash:\*\)/);
    const again = spawnSync(process.execPath, [CLI, 'init', dir], { encoding: 'utf8' });
    assert.match(again.stdout, /nothing changed/);
    const off = tempDir('om-trash-allow-cli-off');
    const r2 = spawnSync(process.execPath, [CLI, 'init', off, '--no-trash-allow'], { encoding: 'utf8' });
    assert.equal(r2.status, 0, r2.stderr);
    assert.doesNotMatch(r2.stdout + r2.stderr, /trash:\*/);
    assert.equal(settings(off)['permissions'], undefined);
  });

  it('with the rule in place the hook still asks about a trash call outside the project', () => {
    const dir = tempDir('om-trash-allow-hook');
    assert.ok(initProject(dir, { trashCheck: PASS }).ok);
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.js'), 'x\n');
    const hook = (command: string): string => {
      const ev = { session_id: `trash-allow-${process.pid}-${command.length}`, cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } };
      const r = spawnSync(process.execPath, [CLI, 'hook', 'claude-code'], { input: JSON.stringify(ev), encoding: 'utf8', cwd: dir, env: { ...process.env, OPENMORALS_HOME: tempDir('om-trash-allow-home2') } });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout;
    };
    assert.equal(hook('openmorals trash src/a.js'), '', 'inside the project: no objection, so the host allow decides');
    for (const c of ['openmorals trash ../x.js', 'openmorals trash --root /tmp x', 'openmorals trash .']) {
      const out = JSON.parse(hook(c)) as { hookSpecificOutput: { permissionDecision: string } };
      assert.equal(out.hookSpecificOutput.permissionDecision, 'ask', c);
    }
  });
});
