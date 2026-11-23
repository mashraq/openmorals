import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { parseCommand } from '../src/shell.js';
import { REPO_ROOT } from './helpers.js';

const names = (text: string, shell: 'posix' | 'powershell' | 'cmd' = 'posix'): string[] => parseCommand(text, shell).commands.map((c) => c.name);

describe('command parser', () => {
  it('splits on every separator', () => {
    assert.deepEqual(names('a; b && c || d | e & f\ng'), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });
  it('removes quotes the way the shell does', () => {
    assert.deepEqual(parseCommand(`r"m" -'r'f "a b" 'c'd`).commands[0], { name: 'rm', args: ['-rf', 'a b', 'cd'], redirects: [], shell: 'posix', pipeIn: false, bulk: false, via: [] });
  });
  it('strips wrappers and records them', () => {
    const c = parseCommand('sudo -u root env A=1 nohup nice -n 5 timeout 10 rm x').commands[0];
    assert.equal(c?.name, 'rm');
    assert.deepEqual(c?.via, ['sudo', 'env', 'nohup', 'nice', 'timeout']);
  });
  it('reads cmd and PowerShell timeout as the Windows sleep command, not a wrapper', () => {
    for (const shell of ['cmd', 'powershell'] as const) {
      const c = parseCommand('timeout /t 5', shell).commands[0];
      assert.equal(c?.name, 'timeout', shell);
      assert.deepEqual(c?.args, ['/t', '5'], shell);
      assert.deepEqual(c?.via, [], shell);
    }
    assert.deepEqual(names('timeout /t 5 /nobreak & del /q x', 'cmd'), ['timeout', 'del']);
    assert.equal(parseCommand('timeout 5 rm -rf x').commands[0]?.name, 'rm');
  });
  it('reaches into substitutions, -c strings, eval, cmd /c and encoded PowerShell', () => {
    assert.ok(names('echo $(a1 `a2`)').includes('a1'));
    assert.ok(names('echo $(a1 `a2`)').includes('a2'));
    assert.ok(names("bash -c 'b1 && b2'").includes('b2'));
    assert.ok(names('eval "e1 x"').includes('e1'));
    assert.ok(names('cmd /c "c1 & c2"').includes('c2'));
    const enc = Buffer.from('p1 -x', 'utf16le').toString('base64');
    assert.ok(names(`powershell -enc ${enc}`).includes('p1'));
  });
  it('marks find -exec and xargs as bulk', () => {
    const c = parseCommand('find . -exec rm {} ;').commands.find((x) => x.name === 'rm');
    assert.equal(c?.bulk, true);
    assert.equal(parseCommand('ls | xargs rm').commands.find((x) => x.name === 'rm')?.bulk, true);
  });
  it('records redirects with their targets', () => {
    assert.deepEqual(parseCommand('cat < in.txt > out.txt 2>&1').commands[0]?.redirects.map((r) => [r.op, r.target]), [['<', 'in.txt'], ['>', 'out.txt'], ['>&', '1']]);
  });
  it('reads PowerShell and cmd quoting', () => {
    assert.deepEqual(parseCommand("Remove-Item 'a''b' `-Force", 'powershell').commands[0]?.args, ["a'b", '-Force']);
    assert.deepEqual(parseCommand('del ^"x^" /q', 'cmd').commands[0]?.args, ['"x"', '/q']);
  });
  it('does not loop forever on hostile input', () => {
    const deep = 'bash -c '.repeat(40) + 'x';
    assert.ok(parseCommand(deep).commands.length < 100);
    assert.ok(parseCommand('$('.repeat(500)).opaque.length >= 0);
    assert.ok(parseCommand('"'.repeat(1001)).commands.length >= 0);
  });
});

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith('.ts') ? [p] : [];
  });
}

const CORE_DIRS = ['src', join('src', 'guards'), join('src', 'adapters'), 'test'];

describe('code hygiene', () => {
  it('the core sources and tests never use the any type', () => {
    const files = CORE_DIRS.flatMap((d) => readdirSync(join(REPO_ROOT, d)).filter((f) => f.endsWith('.ts') && f !== 'parser-hygiene.test.ts').map((f) => join(REPO_ROOT, d, f)));
    assert.ok(files.length >= 15, `only ${files.length} files scanned`);
    const offenders = files.filter((f) => /(:\s*any\b|\bas\s+any\b|<any>|\bany\[\])/.test(readFileSync(f, 'utf8')));
    assert.deepEqual(offenders.map((f) => relative(REPO_ROOT, f)), []);
  });
  it('no source, test or case file carries a real-looking token', () => {
    const files = [...tsFiles(join(REPO_ROOT, 'src')), ...tsFiles(join(REPO_ROOT, 'test')), ...readdirSync(join(REPO_ROOT, 'cases')).map((f) => join(REPO_ROOT, 'cases', f))];
    const bad = files.filter((f) => /\bghp_(?!FAKE)[A-Za-z0-9]{20,}|\bAKIA(?!FAKE)[0-9A-Z]{16}\b/.test(readFileSync(f, 'utf8')));
    assert.deepEqual(bad.map((f) => relative(REPO_ROOT, f)), []);
  });
});
