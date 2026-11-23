import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_BYLAWS, parseBylaws } from '../src/bylaws.js';
import { decide } from '../src/engine.js';
import type { BylawsLoad, ShellKind } from '../src/types.js';
import { EMPTY_STATE } from '../src/types.js';

const CASES: { cmd: string; shell?: ShellKind; hint: string | null }[] = [
  { cmd: 'rm -rf build', hint: 'openmorals trash build`' },
  { cmd: 'rm -rf build dist', hint: 'openmorals trash build dist`' },
  { cmd: 'rm -f notes.txt', hint: 'openmorals trash notes.txt`' },
  { cmd: 'rm -rf ~', hint: 'openmorals trash <path>`' },
  { cmd: 'rm -rf ../other', hint: 'openmorals trash <path>`' },
  { cmd: 'rm -rf /srv/app', hint: 'openmorals trash <path>`' },
  { cmd: 'rm *.log', hint: 'openmorals trash <path>`' },
  { cmd: 'rm -rf -- -x', hint: 'openmorals trash <path>`' },
  { cmd: 'Remove-Item -Recurse -Force build', shell: 'powershell', hint: 'openmorals trash build`' },
  { cmd: 'rd /s /q build', shell: 'cmd', hint: 'openmorals trash build`' },
  { cmd: 'del /s /q out', shell: 'cmd', hint: 'openmorals trash out`' },
  { cmd: 'git reset --hard', hint: null },
  { cmd: 'git clean -fd', hint: null },
  { cmd: 'psql -c "DROP TABLE users"', hint: null },
];

function run(cmd: string, shell: ShellKind, bylaws: BylawsLoad | typeof DEFAULT_BYLAWS = DEFAULT_BYLAWS): { decision: string; reason: string } {
  return decide({ kind: 'exec', command: cmd, shell, tool: shell === 'powershell' ? 'PowerShell' : 'Bash' }, bylaws, EMPTY_STATE);
}

describe('a delete the destructive guard stops points at the trash command', () => {
  for (const c of CASES) {
    it(`${c.cmd} -> ${c.hint ?? 'no hint'}`, () => {
      const v = run(c.cmd, c.shell ?? 'posix');
      assert.notEqual(v.decision, 'allow');
      if (c.hint === null) assert.doesNotMatch(v.reason, /openmorals trash/);
      else {
        assert.ok(v.reason.includes(c.hint), v.reason);
        assert.match(v.reason, /openmorals restore <id>/);
      }
    });
  }
  it('keeps the hint when the bylaws deny deletes outright', () => {
    const deny = parseBylaws('version: 1\nguards:\n  destructive: { decision: deny }\n');
    const v = run('rm -rf build', 'posix', deny);
    assert.equal(v.decision, 'deny');
    assert.match(v.reason, /openmorals trash build/);
  });
});
