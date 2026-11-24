import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { runClaudeCodeHook } from '../src/adapters/claude-code.js';
import { DEFAULT_BYLAWS } from '../src/bylaws.js';
import { decide } from '../src/engine.js';
import type { Where } from '../src/guard.js';
import { makeWhere, resolveLinks } from '../src/guard.js';
import type { Action } from '../src/types.js';

const STATE = { toolCalls: 1, tokens: 0, prevTokens: 0 };
const IS_WIN = process.platform === 'win32';

// Every link and folder here lives in one fresh temp folder, removed at the end.
const root = mkdtempSync(join(tmpdir(), 'om-links-'));
const cfg = join(root, 'state-any-name');
const work = join(root, 'work');
let fileLinks = true;

before(() => {
  mkdirSync(join(cfg, 'sessions'), { recursive: true });
  writeFileSync(join(cfg, 'audit.jsonl'), '');
  mkdirSync(work, { recursive: true });
  // a directory link needs no privilege on Windows when it is a junction
  symlinkSync(cfg, join(work, 'd'), IS_WIN ? 'junction' : 'dir');
  try {
    symlinkSync(join(cfg, 'not-yet.jsonl'), join(work, 'dangling'), 'file');
  } catch {
    // Windows without Developer Mode refuses file links (EPERM); the dangling-link row is skipped there
    fileLinks = false;
  }
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

function where(over: Partial<Where> = {}): Partial<Where> {
  return { configDir: cfg, cwd: work, home: root, ...over };
}

function exec(command: string): Action {
  return { kind: 'exec', command, shell: IS_WIN ? 'powershell' : 'posix', tool: IS_WIN ? 'PowerShell' : 'Bash' };
}

function write(path: string): Action {
  return { kind: 'write', path, tool: 'Write' };
}

describe('self-protect resolves symbolic links before matching', () => {
  it('asks for a write through a link into the config directory, and only because the link is resolved', () => {
    const target = join(work, 'd', 'audit.jsonl');
    assert.equal(decide(write(target), DEFAULT_BYLAWS, STATE, undefined, where()).decision, 'ask');
    const blind = decide(write(target), DEFAULT_BYLAWS, STATE, undefined, where({ realpath: (p: string) => p }));
    assert.equal(blind.decision, 'allow', 'without link resolution the folder name gives nothing away');
  });
  it('asks for a new file under a linked folder, which does not exist yet', () => {
    const v = decide(write(join(work, 'd', 'sessions', 'new.json')), DEFAULT_BYLAWS, STATE, undefined, where());
    assert.equal(v.decision, 'ask');
    assert.equal(v.rule, 'self-protect.write');
  });
  it('asks for a link whose target is missing but lies in the config directory', (t) => {
    if (!fileLinks) {
      t.skip('this Windows account may not create file symbolic links');
      return;
    }
    assert.equal(decide(write(join(work, 'dangling')), DEFAULT_BYLAWS, STATE, undefined, where()).decision, 'ask');
  });
  it('asks for a command that writes, copies onto or links through the linked folder', () => {
    const rel = IS_WIN ? 'd\\audit.jsonl' : 'd/audit.jsonl';
    for (const c of [`echo x > ${rel}`, IS_WIN ? `Copy-Item x.txt ${rel}` : `cp x.txt ${rel}`, IS_WIN ? `New-Item -ItemType SymbolicLink -Path l -Target d\\sessions` : 'ln -s d/sessions l']) {
      const v = decide(exec(c), DEFAULT_BYLAWS, STATE, undefined, where());
      assert.equal(v.decision, 'ask', c);
      assert.equal(v.rule, 'self-protect.write', `${c}: ${v.reason}`);
    }
  });
  it('still lets the agent read and list through the link', () => {
    for (const c of [IS_WIN ? 'Get-Content d\\audit.jsonl' : 'cat d/audit.jsonl', IS_WIN ? 'Get-ChildItem d' : 'ls d']) {
      assert.equal(decide(exec(c), DEFAULT_BYLAWS, STATE, undefined, where()).decision, 'allow', c);
    }
    assert.equal(decide(write(join(work, 'notes.md')), DEFAULT_BYLAWS, STATE, undefined, where()).decision, 'allow');
  });
  it('resolveLinks appends the missing part of a path to its resolved folder', () => {
    const r = resolveLinks(join(work, 'd', 'a', 'b.txt'));
    assert.equal(r, join(resolveLinks(cfg), 'a', 'b.txt'));
    assert.equal(resolveLinks(join(root, 'nothing', 'here')), join(resolveLinks(root), 'nothing', 'here'));
  });
  it('makeWhere takes the config directory from OPENMORALS_HOME', () => {
    assert.equal(makeWhere({}, { OPENMORALS_HOME: cfg }).configDir, cfg);
  });
});

describe('the Claude Code hook protects the config directory it was given', () => {
  it('asks for a write into OPENMORALS_HOME whatever the folder is called', () => {
    const input = JSON.stringify({ session_id: 's-links', cwd: work, hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: join(cfg, 'audit.jsonl'), content: '' } });
    const run = runClaudeCodeHook(input, { env: { OPENMORALS_HOME: cfg } });
    assert.equal(run.verdict.decision, 'ask');
    assert.equal(run.verdict.rule, 'self-protect.write');
  });
});

describe('self-protect reads a bare word as a file only when it is there', () => {
  it('with the working directory inside the config directory, asks for an existing file and not for other words', () => {
    const here = where({ cwd: cfg });
    assert.equal(decide(exec(IS_WIN ? 'Remove-Item audit.jsonl' : 'rm audit.jsonl'), DEFAULT_BYLAWS, STATE, undefined, here).decision, 'ask');
    for (const c of ['npm test', 'git status', `python3 -c "print('test')"`]) {
      assert.equal(decide(exec(c), DEFAULT_BYLAWS, STATE, undefined, here).decision, 'allow', c);
    }
  });
});
