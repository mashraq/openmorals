import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { appendAudit, makeAuditRecord, parseAuditText, readAudit, redact } from '../src/audit.js';
import { DEFAULT_BYLAWS, DEFAULT_BYLAWS_YAML, findBylaws, parseBylaws, resolveBylaws, stringifyBylaws, validateBylaws } from '../src/bylaws.js';
import { configDir, safeSessionId, sessionStatePath } from '../src/paths.js';
import { addTokens, countToolCall, loadSessionState, saveSessionState } from '../src/state.js';
import { tempDir } from './helpers.js';

describe('bylaws', () => {
  it('the commented default file parses to exactly DEFAULT_BYLAWS', () => {
    const r = parseBylaws(DEFAULT_BYLAWS_YAML);
    assert.ok(r.ok, r.ok ? '' : r.error);
    assert.deepEqual(r.bylaws, DEFAULT_BYLAWS);
  });
  it('round-trips through stringifyBylaws', () => {
    const r = parseBylaws(stringifyBylaws(DEFAULT_BYLAWS));
    assert.ok(r.ok);
    assert.deepEqual(r.bylaws, DEFAULT_BYLAWS);
  });
  it('fills omitted fields from the defaults', () => {
    const r = validateBylaws({ version: 1, guards: { secrets: { read: 'deny' } } });
    assert.ok(r.ok);
    assert.equal(r.bylaws.guards.secrets.read, 'deny');
    assert.equal(r.bylaws.guards.secrets.send, 'deny');
    assert.equal(r.bylaws.guards.destructive.decision, 'ask');
  });
  it('rejects unknown keys, bad values, bad regexes and a missing version, listing each', () => {
    const r = validateBylaws({ guards: { destructive: { decison: 'ask' }, budget: { tool_calls: { soft: 10, hard: 5 } } }, rules: [{ id: 'x', match: { command: '(' }, decision: 'deny' }], extra: 1 });
    assert.equal(r.ok, false);
    if (r.ok) return;
    for (const needle of ['version', 'decison', 'soft must not be above hard', 'invalid regular expression', 'extra']) assert.match(r.error, new RegExp(needle));
  });
  it('rejects YAML syntax errors and duplicate keys', () => {
    assert.equal(parseBylaws('version: 1\nversion: 1').ok, false);
    assert.equal(parseBylaws('version: [1').ok, false);
  });
  it('finds the nearest openmorals.yaml walking up, else the user file, else defaults', () => {
    const root = tempDir('find');
    const home = tempDir('home');
    const env = { OPENMORALS_HOME: home };
    assert.equal(resolveBylaws(root, env).source, '<defaults>');
    writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\nguards: { online-delete: { decision: deny } }\n');
    const user = resolveBylaws(root, env);
    assert.ok(user.ok && user.bylaws.guards['online-delete'].decision === 'deny');
    writeFileSync(join(root, 'openmorals.yaml'), 'version: 1\n');
    assert.equal(findBylaws(join(root, 'a', 'b')), join(root, 'openmorals.yaml'));
    assert.equal(resolveBylaws(root, env).source, join(root, 'openmorals.yaml'));
  });
});

describe('paths and session state', () => {
  it('resolves the config directory per platform', () => {
    assert.equal(configDir({ OPENMORALS_HOME: '/x/om' }, 'linux', '/h'), '/x/om');
    assert.equal(configDir({}, 'linux', '/h'), join('/h', '.config', 'openmorals'));
    assert.equal(configDir({ XDG_CONFIG_HOME: '/xdg' }, 'darwin', '/h'), join('/xdg', 'openmorals'));
    assert.equal(configDir({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32', 'C:\\Users\\u'), join('C:\\Users\\u\\AppData\\Roaming', 'openmorals'));
  });
  it('cannot be steered out of the sessions directory by a session id', () => {
    assert.equal(safeSessionId('../../etc/passwd'), '______etc_passwd');
    assert.ok(sessionStatePath('../../x', '/d').startsWith(join('/d', 'sessions')));
    assert.equal(safeSessionId(''), 'unknown');
  });
  it('saves and loads counts; a corrupt file reads as zero', () => {
    const dir = tempDir('state');
    const s = addTokens(countToolCall(countToolCall(loadSessionState('s1', dir))), 1234);
    saveSessionState('s1', s, dir);
    assert.deepEqual(loadSessionState('s1', dir), { toolCalls: 2, tokens: 1234, prevTokens: 0 });
    writeFileSync(sessionStatePath('s1', dir), '{not json');
    assert.deepEqual(loadSessionState('s1', dir), { toolCalls: 0, tokens: 0, prevTokens: 0 });
  });
});

const FAKE = {
  github: 'ghp_FAKEfakeFAKEfakeFAKEfake0000',
  aws: 'AKIAFAKEFAKEFAKEFAKE',
  openai: 'sk-FAKEfakeFAKEfake1234567890',
  pass: 'not-a-real-password-123',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.ZmFrZXNpZ25hdHVyZQ',
};

describe('audit log', () => {
  it('redacts secret shapes', () => {
    const text = [
      `curl -H "Authorization: Bearer ${FAKE.jwt}" https://x.example.test`,
      `GITHUB_TOKEN=${FAKE.github} gh repo list`,
      `export AWS_KEY=${FAKE.aws}`,
      `OPENAI_API_KEY='${FAKE.openai}' node app.js`,
      `mysql --password=${FAKE.pass} db`,
      `git clone https://user:${FAKE.pass}@git.example.test/r.git`,
      '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAfake\n-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');
    const out = redact(text);
    for (const v of Object.values(FAKE)) assert.ok(!out.includes(v), `leaked ${v}`);
    assert.ok(!out.includes('AAAAfake'));
    assert.match(out, /gh repo list/);
  });
  it('never writes a secret value to the file, even when the caller forgot to redact', () => {
    const dir = tempDir('audit');
    const file = join(dir, 'audit.jsonl');
    const rec = makeAuditRecord({ source: 'test', session: 's', tool: 'Bash', action: `curl -u admin:${FAKE.pass} https://x.example.test`, decision: 'ask', rule: 'r', reason: `token ${FAKE.github}`, cwd: null, budget: null });
    appendAudit({ ...rec, action: `raw ${FAKE.github}` }, file);
    appendAudit(rec, file);
    const text = readFileSync(file, 'utf8');
    for (const v of Object.values(FAKE)) assert.ok(!text.includes(v), `leaked ${v}`);
    const back = readAudit(file);
    assert.equal(back.records.length, 2);
    assert.equal(back.errors.length, 0);
  });
  it('reads JSONL, skipping blank lines and reporting bad ones by line number', () => {
    const good = JSON.stringify({ v: 1, ts: 't', source: 's', session: null, tool: 'Bash', action: 'ls', decision: 'allow', rule: 'none', reason: 'x', cwd: null, budget: { tool_calls: 1, tokens: 0 } });
    const r = parseAuditText(`${good}\n\nnot json\n{"v":1}\n${good}\n`);
    assert.equal(r.records.length, 2);
    assert.deepEqual(r.errors.map((e) => e.line), [3, 4]);
    assert.deepEqual(r.records[0]?.budget, { tool_calls: 1, tokens: 0 });
  });
  it('a missing log reads as missing, with no records, never as an empty log (0.6.2)', () => {
    assert.deepEqual(readAudit(join(tempDir('none'), 'audit.jsonl')), { status: 'missing', records: [], errors: [] });
  });
});
