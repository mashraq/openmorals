import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { runClaudeCodeHookReviewed } from '../src/adapters/claude-code.js';
import { parseBylaws, resolveBylaws, validateBylaws } from '../src/bylaws.js';
import { decide } from '../src/engine.js';
import { keyEnvNameProblem, readKey } from '../src/reviewer/http.js';
import { EMPTY_STATE } from '../src/types.js';
import { REPO_ROOT, tempDir } from './helpers.js';

const CLI = join(REPO_ROOT, 'dist', 'src', 'cli.js');

// Every value below is fake and built by concatenation, so no key-shaped literal sits in the source.
const FAKE_GOOGLE = 'AIza' + 'Fake0Example'.repeat(3);
const FAKE_AWS_ID = 'AKIA' + 'FAKE'.repeat(4);
const FAKE_GITHUB = 'ghp_' + 'FakeToken0'.repeat(3);
const FAKE_NPM = 'npm_' + 'fake0'.repeat(7);
const FAKE_HEX = 'deadbeef'.repeat(5);
const FAKE_BASE32 = 'ABCDEFGHJKMNPQRSTVWXYZ234567ABCD';
const FAKE_MIXED_SHORT = 'Xk' + '9fQ' + 'Lm2' + 'Pz7';

const REFUSED: { name: string; value: string }[] = [
  { name: 'a Google-style key (mixed case, letters, digits and underscores only)', value: FAKE_GOOGLE },
  { name: 'an AWS access key id (upper case, caught by the redactor)', value: FAKE_AWS_ID },
  { name: 'a GitHub token', value: FAKE_GITHUB },
  { name: 'an npm token', value: FAKE_NPM },
  { name: 'a 40-character lower-case hex secret', value: FAKE_HEX },
  { name: 'a 32-character upper-case base32 secret', value: FAKE_BASE32 },
  { name: 'a short mixed-case random string', value: FAKE_MIXED_SHORT },
  { name: 'a CamelCase name', value: 'MyReviewKey' },
  { name: 'longer than 64 characters', value: `REVIEW_${'KEY_'.repeat(15)}X` },
  { name: 'starts with a digit', value: '1REVIEW_KEY' },
  { name: 'has a hyphen', value: 'REVIEW-KEY' },
  { name: 'empty', value: '' },
];

const ACCEPTED: string[] = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'MY_REVIEW_KEY',
  'OM_TEST_REVIEW_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'AZURE_OPENAI_API_KEY',
  'GPT4_KEY',
  '_PRIVATE_REVIEW_KEY',
  'my_review_key',
  'review_key_2',
  'X',
];

let realFetch: typeof globalThis.fetch;
let fetchCalls = 0;
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    fetchCalls++;
    return Promise.reject(new Error('no network in tests'));
  }) as typeof globalThis.fetch;
});
after(() => {
  globalThis.fetch = realFetch;
  assert.equal(fetchCalls, 0, 'a test reached the global fetch');
});

function cliEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/KEY|TOKEN|SECRET|PASSWORD|OPENMORALS/i.test(k)) env[k] = v;
  return { ...env, OPENMORALS_HOME: home };
}

function reviewerYaml(value: string): string {
  return `version: 1\nreviewer: { enabled: true, provider: anthropic, api_key_env: "${value}" }\n`;
}

describe('reviewer.api_key_env must be a variable name, never a key', () => {
  for (const c of REFUSED) {
    it(`refuses ${c.name}, naming the setting and never the value`, () => {
      const r = validateBylaws({ version: 1, reviewer: { api_key_env: c.value } });
      assert.equal(r.ok, false, `accepted ${c.name}`);
      if (r.ok) return;
      assert.match(r.error, /reviewer\.api_key_env/);
      if (c.value !== '') assert.ok(!r.error.includes(c.value), `the error echoes the value: ${r.error}`);
      assert.notEqual(keyEnvNameProblem(c.value), null);
    });
  }
  for (const name of ACCEPTED) {
    it(`accepts the name ${name}`, () => {
      const r = parseBylaws(reviewerYaml(name));
      assert.ok(r.ok, r.ok ? '' : r.error);
      assert.equal(r.bylaws.reviewer.api_key_env, name);
      assert.equal(keyEnvNameProblem(name), null);
    });
  }
  it('a project file is checked the same way', () => {
    const r = parseBylaws(reviewerYaml(FAKE_GOOGLE), '<memory>', undefined, true);
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(!r.error.includes(FAKE_GOOGLE));
  });
  it('readKey refuses a key-shaped name without reading the environment or echoing it', () => {
    const r = readKey(FAKE_GOOGLE, { [FAKE_GOOGLE]: 'fake-value-never-read' });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.result.ok, false);
      assert.ok(!JSON.stringify(r.result).includes(FAKE_GOOGLE));
    }
  });
});

describe('a refused value never reaches stderr, stdout, a verdict reason or the audit file', () => {
  for (const [label, value] of [['Google-style', FAKE_GOOGLE], ['hex (unknown to the redactors)', FAKE_HEX]] as const) for (const where of ['user', 'project'] as const) {
    it(`a ${label} api_key_env in the ${where} file`, async () => {
      const cwd = tempDir('keyname-proj');
      const home = tempDir('keyname-home');
      writeFileSync(join(home, 'openmorals.yaml'), where === 'user' ? reviewerYaml(value) : 'version: 1\nreviewer: { enabled: true, provider: anthropic, api_key_env: USER_REVIEW_KEY }\n');
      writeFileSync(join(cwd, 'openmorals.yaml'), where === 'project' ? reviewerYaml(value) : 'version: 1\n');
      const seen: string[] = [];
      for (const args of [['check', 'rm -rf build'], ['check', '--json', 'rm -rf build'], ['validate'], ['validate', join(where === 'user' ? home : cwd, 'openmorals.yaml')]]) {
        const r = spawnSync(process.execPath, [CLI, ...args], { cwd, env: cliEnv(home), encoding: 'utf8' });
        seen.push(r.stdout, r.stderr);
      }
      const load = resolveBylaws(cwd, { OPENMORALS_HOME: home });
      seen.push(JSON.stringify(load));
      seen.push(decide({ kind: 'exec', command: 'rm -rf build', shell: 'posix', tool: 'Bash' }, load, { ...EMPTY_STATE, toolCalls: 1 }).reason);
      const input = JSON.stringify({ session_id: 'keyname', cwd, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, tool_use_id: 'toolu_keyname' });
      const run = await runClaudeCodeHookReviewed(input, { env: { OPENMORALS_HOME: home } });
      seen.push(run.stdout, run.verdict.reason);
      const audit = join(home, 'audit.jsonl');
      assert.ok(existsSync(audit), 'the hook wrote an audit record');
      seen.push(readFileSync(audit, 'utf8'));
      for (const s of seen) assert.ok(!s.includes(value), `the value leaked: ${s.slice(0, 400)}`);
    });
  }
});
