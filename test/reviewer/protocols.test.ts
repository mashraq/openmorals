import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DEFAULT_BYLAWS, parseBylaws, resolveBylaws } from '../../src/bylaws.js';
import { makeAuditRecord } from '../../src/audit.js';
import type { FetchLike, ProviderRequest, ProviderResult } from '../../src/reviewer/index.js';
import { baseUrlProblem, createAnthropicProvider, createGeminiProvider, createOpenAIChatProvider, reviewerProvider, reviewVerdict } from '../../src/reviewer/index.js';
import type { ReviewerBylaws } from '../../src/types.js';
import { decisionRank } from '../../src/types.js';
import { tempDir } from '../helpers.js';

const FAKE_KEY = 'FAKE-not-a-real-key-0000000000';
const REQ: ProviderRequest = { model: 'test-model', system: 'SYS', user: 'USER', maxTokens: 256 };
const signal = new AbortController().signal;

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
  redirect: string;
}

function fakeFetch(status: number, body: string, cap: Captured[] = []): FetchLike {
  return (url, init) => {
    cap.push({ url, headers: init.headers, body: init.body, redirect: init.redirect });
    return Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(body) });
  };
}

let realFetch: typeof globalThis.fetch;
let globalCalls = 0;
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    globalCalls++;
    return Promise.reject(new Error('no network in tests'));
  }) as typeof globalThis.fetch;
});
after(() => {
  globalThis.fetch = realFetch;
  assert.equal(globalCalls, 0, 'a test reached the global fetch');
});

const CHAT_OK = (content: string, finish = 'stop', extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ id: 'chatcmpl-x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content, refusal: null, ...extra }, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
const GEMINI_OK = (text: string, finish = 'STOP'): string =>
  JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'thinking...', thought: true }, { text }] }, finishReason: finish }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });

describe('reviewer protocols: request shapes (golden, fake fetch)', () => {
  it('openai-chat: POST {base}/chat/completions, Bearer key, system then user, max_tokens', async () => {
    const cap: Captured[] = [];
    const r = await createOpenAIChatProvider({ env: { OPENAI_API_KEY: FAKE_KEY }, fetch: fakeFetch(200, CHAT_OK('{"verdict":"escalate","reason":"r"}'), cap) }).complete(REQ, signal);
    assert.deepEqual(r, { ok: true, text: '{"verdict":"escalate","reason":"r"}' });
    assert.equal(cap[0]?.url, 'https://api.openai.com/v1/chat/completions');
    assert.deepEqual(cap[0]?.headers, { 'content-type': 'application/json', authorization: `Bearer ${FAKE_KEY}` });
    assert.deepEqual(JSON.parse(cap[0]?.body ?? ''), { model: 'test-model', messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'USER' }], max_tokens: 256 });
    assert.equal(cap[0]?.redirect, 'error');
  });
  it('openai-chat compat: max_completion_tokens and the developer role', async () => {
    const cap: Captured[] = [];
    await createOpenAIChatProvider({ env: { OPENAI_API_KEY: FAKE_KEY }, tokenParam: 'max_completion_tokens', systemRole: 'developer', fetch: fakeFetch(200, CHAT_OK('x'), cap) }).complete(REQ, signal);
    assert.deepEqual(JSON.parse(cap[0]?.body ?? ''), { model: 'test-model', messages: [{ role: 'developer', content: 'SYS' }, { role: 'user', content: 'USER' }], max_completion_tokens: 256 });
  });
  it('openai-chat with no key (a local server such as Ollama): no Authorization header, loopback http allowed', async () => {
    const cap: Captured[] = [];
    const r = await createOpenAIChatProvider({ baseUrl: 'http://127.0.0.1:11434/v1/', apiKeyEnv: null, env: { OPENAI_API_KEY: FAKE_KEY }, fetch: fakeFetch(200, CHAT_OK('x'), cap) }).complete(REQ, signal);
    assert.ok(r.ok);
    assert.equal(cap[0]?.url, 'http://127.0.0.1:11434/v1/chat/completions');
    assert.deepEqual(cap[0]?.headers, { 'content-type': 'application/json' });
    assert.ok(!JSON.stringify(cap).includes(FAKE_KEY));
  });
  it('gemini: POST {base}/v1beta/models/{model}:generateContent, key in x-goog-api-key, never in the URL', async () => {
    const cap: Captured[] = [];
    const r = await createGeminiProvider({ env: { GEMINI_API_KEY: FAKE_KEY }, fetch: fakeFetch(200, GEMINI_OK('{"verdict":"escalate","reason":"r"}'), cap) }).complete(REQ, signal);
    assert.deepEqual(r, { ok: true, text: '{"verdict":"escalate","reason":"r"}' });
    assert.equal(cap[0]?.url, 'https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent');
    assert.deepEqual(cap[0]?.headers, { 'content-type': 'application/json', 'x-goog-api-key': FAKE_KEY });
    assert.deepEqual(JSON.parse(cap[0]?.body ?? ''), { systemInstruction: { parts: [{ text: 'SYS' }] }, contents: [{ role: 'user', parts: [{ text: 'USER' }] }], generationConfig: { maxOutputTokens: 256 } });
    assert.ok(!(cap[0]?.url ?? '').includes(FAKE_KEY));
  });
  it('gemini refuses a model id that would change the URL path', async () => {
    const cap: Captured[] = [];
    for (const model of ['../x', 'a/b', 'm?key=1', 'm#x', '']) {
      const r = await createGeminiProvider({ env: { GEMINI_API_KEY: FAKE_KEY }, fetch: fakeFetch(200, GEMINI_OK('x'), cap) }).complete({ ...REQ, model }, signal);
      assert.equal(r.ok, false, model);
    }
    assert.equal(cap.length, 0);
  });
});

type Kind = Exclude<ProviderResult, { ok: true }>['kind'];
const PARSE_CASES: { protocol: 'openai-chat' | 'gemini'; name: string; status: number; body: string; kind: Kind }[] = [
  { protocol: 'openai-chat', name: 'empty text', status: 200, body: CHAT_OK(''), kind: 'bad-response' },
  { protocol: 'openai-chat', name: 'null content', status: 200, body: JSON.stringify({ choices: [{ message: { content: null }, finish_reason: 'stop' }] }), kind: 'bad-response' },
  { protocol: 'openai-chat', name: 'refusal field', status: 200, body: CHAT_OK('', 'stop', { refusal: 'I cannot help with that' }), kind: 'refusal' },
  { protocol: 'openai-chat', name: 'content_filter', status: 200, body: CHAT_OK('x', 'content_filter'), kind: 'refusal' },
  { protocol: 'openai-chat', name: 'truncated (length)', status: 200, body: CHAT_OK('{"verdict":"no-ob', 'length'), kind: 'incomplete' },
  { protocol: 'openai-chat', name: 'tool_calls', status: 200, body: CHAT_OK('x', 'tool_calls'), kind: 'incomplete' },
  { protocol: 'openai-chat', name: 'no choices', status: 200, body: JSON.stringify({ choices: [] }), kind: 'bad-response' },
  { protocol: 'openai-chat', name: 'HTML error page', status: 200, body: '<html><body>Bad gateway</body></html>', kind: 'bad-response' },
  { protocol: 'openai-chat', name: 'HTTP 429', status: 429, body: '{"error":{"message":"rate limited"}}', kind: 'http' },
  { protocol: 'openai-chat', name: 'HTTP 401 echoing the key', status: 401, body: `{"error":"bad key ${FAKE_KEY}"}`, kind: 'http' },
  { protocol: 'openai-chat', name: 'oversize body', status: 200, body: CHAT_OK('x'.repeat(300000)), kind: 'bad-response' },
  { protocol: 'gemini', name: 'prompt blocked', status: 200, body: JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }), kind: 'refusal' },
  { protocol: 'gemini', name: 'SAFETY stop', status: 200, body: GEMINI_OK('x', 'SAFETY'), kind: 'refusal' },
  { protocol: 'gemini', name: 'RECITATION stop', status: 200, body: GEMINI_OK('x', 'RECITATION'), kind: 'refusal' },
  { protocol: 'gemini', name: 'PROHIBITED_CONTENT stop', status: 200, body: GEMINI_OK('x', 'PROHIBITED_CONTENT'), kind: 'refusal' },
  { protocol: 'gemini', name: 'MAX_TOKENS', status: 200, body: GEMINI_OK('{"verdict":"no', 'MAX_TOKENS'), kind: 'incomplete' },
  { protocol: 'gemini', name: 'missing finishReason', status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }), kind: 'incomplete' },
  { protocol: 'gemini', name: 'only a thought part', status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hmm', thought: true }] }, finishReason: 'STOP' }] }), kind: 'bad-response' },
  { protocol: 'gemini', name: 'no candidates', status: 200, body: JSON.stringify({ candidates: [] }), kind: 'bad-response' },
  { protocol: 'gemini', name: 'not JSON', status: 200, body: 'Service Unavailable', kind: 'bad-response' },
  { protocol: 'gemini', name: 'HTTP 503', status: 503, body: '{}', kind: 'http' },
];

function client(protocol: 'openai-chat' | 'gemini', f: FetchLike): { complete(r: ProviderRequest, s: AbortSignal): Promise<ProviderResult> } {
  return protocol === 'gemini' ? createGeminiProvider({ env: { GEMINI_API_KEY: FAKE_KEY }, fetch: f }) : createOpenAIChatProvider({ env: { OPENAI_API_KEY: FAKE_KEY }, fetch: f });
}

describe('reviewer protocols: every odd reply is a failure (so the review escalates), never with the key in it', () => {
  for (const c of PARSE_CASES) {
    it(`${c.protocol}: ${c.name} -> ${c.kind}`, async () => {
      const r = await client(c.protocol, fakeFetch(c.status, c.body)).complete(REQ, signal);
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.kind, c.kind);
        assert.ok(!r.error.includes(FAKE_KEY));
      }
    });
  }
  it('extra fields in a good reply are ignored', async () => {
    const r = await client('openai-chat', fakeFetch(200, CHAT_OK('ok', 'stop', { annotations: [], audio: null }))).complete(REQ, signal);
    assert.deepEqual(r, { ok: true, text: 'ok' });
  });
  it('a redirect (fetch rejects with redirect: error) is a network failure', async () => {
    const redirecting: FetchLike = () => Promise.reject(new TypeError('fetch failed: unexpected redirect'));
    for (const p of ['openai-chat', 'gemini'] as const) {
      const r = await client(p, redirecting).complete(REQ, signal);
      assert.ok(!r.ok && r.kind === 'network');
    }
  });
});

describe('reviewer protocols: key hygiene', () => {
  it('missing or blank key: missing-key and no request, on every protocol', async () => {
    for (const env of [{}, { OPENAI_API_KEY: '', GEMINI_API_KEY: ' ', ANTHROPIC_API_KEY: '' }]) {
      const cap: Captured[] = [];
      for (const p of [createOpenAIChatProvider({ env, fetch: fakeFetch(200, CHAT_OK('x'), cap) }), createGeminiProvider({ env, fetch: fakeFetch(200, GEMINI_OK('x'), cap) }), createAnthropicProvider({ env, fetch: fakeFetch(200, '{}', cap) })]) {
        const r = await p.complete(REQ, signal);
        assert.ok(!r.ok && r.kind === 'missing-key', p.name);
      }
      assert.equal(cap.length, 0);
    }
  });
  it('the key never reaches the verdict, the outcome or the audit record, whatever the server answers', async () => {
    const bodies: [number, string][] = [[401, `{"error":"${FAKE_KEY}"}`], [200, CHAT_OK('{"verdict":"escalate","reason":"r"}')], [200, GEMINI_OK('{"verdict":"escalate","reason":"r"}')], [200, 'not json']];
    for (const provider of ['openai-chat', 'gemini', 'anthropic-messages'] as const) {
      for (const [status, body] of bodies) {
        const cfg: ReviewerBylaws = { ...DEFAULT_BYLAWS.reviewer, enabled: true, provider, model: 'test-model', api_key_env: 'OM_TEST_REVIEW_KEY' };
        const res = await reviewVerdict({ kind: 'exec', command: 'rm -rf build', shell: 'posix', tool: 'Bash' }, { decision: 'ask', rule: 'destructive.x', reason: 'r' }, cfg, { env: { OM_TEST_REVIEW_KEY: FAKE_KEY }, fetch: fakeFetch(status, body) });
        assert.equal(res.verdict.decision, 'ask');
        const rec = makeAuditRecord({ source: 'check', session: null, tool: 'Bash', action: 'rm -rf build', decision: res.verdict.decision, rule: res.verdict.rule, reason: res.verdict.reason, cwd: null, budget: null });
        assert.ok(!JSON.stringify(res).includes(FAKE_KEY), `${provider} ${status}: key in the outcome`);
        assert.ok(!JSON.stringify(rec).includes(FAKE_KEY), `${provider} ${status}: key in the audit record`);
      }
    }
  });
});

describe('reviewer protocols: base URL policy', () => {
  const ACCEPT = ['https://api.openai.com/v1', 'https://gateway.example.com:8443/openai/v1', 'http://localhost:11434/v1', 'http://127.0.0.1:1234/v1', 'http://127.255.0.9/v1', 'http://[::1]:8080/v1'];
  const REFUSE = [
    'http://api.example.com/v1',
    'http://localhost.attacker.example/v1',
    'http://127.0.0.1.nip.io/v1',
    'http://localhost./v1',
    'https://user:pass@api.example.com/v1',
    'https://api.example.com/v1?key=abc',
    'https://api.example.com/v1#x',
    'ftp://api.example.com',
    'file:///etc/passwd',
    'api.example.com',
    'http://10.0.0.5/v1',
    'http://[::ffff:10.0.0.5]/v1',
  ];
  for (const u of ACCEPT) it(`accepts ${u}`, () => assert.equal(baseUrlProblem(u), null));
  for (const u of REFUSE) it(`refuses ${u}`, () => assert.notEqual(baseUrlProblem(u), null));
  it('a refused base URL makes no request, on every protocol', async () => {
    const cap: Captured[] = [];
    const env = { OPENAI_API_KEY: FAKE_KEY, GEMINI_API_KEY: FAKE_KEY, ANTHROPIC_API_KEY: FAKE_KEY };
    for (const p of [createOpenAIChatProvider({ env, baseUrl: 'http://api.example.com/v1', fetch: fakeFetch(200, '{}', cap) }), createGeminiProvider({ env, baseUrl: 'https://u:p@x.example.com', fetch: fakeFetch(200, '{}', cap) }), createAnthropicProvider({ env, baseUrl: 'http://x.example.com', fetch: fakeFetch(200, '{}', cap) })]) {
      const r = await p.complete(REQ, signal);
      assert.ok(!r.ok && r.kind === 'network', p.name);
    }
    assert.equal(cap.length, 0);
  });
});

describe('reviewer protocols: bylaws', () => {
  it('loads each protocol from a user file, with that protocol\'s own key variable by default', () => {
    for (const [provider, keyEnv] of [['openai-chat', 'OPENAI_API_KEY'], ['gemini', 'GEMINI_API_KEY'], ['anthropic-messages', 'ANTHROPIC_API_KEY'], ['anthropic', 'ANTHROPIC_API_KEY']] as const) {
      const r = parseBylaws(`version: 1\nreviewer: { enabled: true, provider: ${provider}, model: m-1 }\n`);
      assert.ok(r.ok, r.ok ? '' : r.error);
      if (r.ok) {
        assert.equal(r.bylaws.reviewer.provider, provider);
        assert.equal(r.bylaws.reviewer.api_key_env, keyEnv, `${provider} must not inherit another vendor's key variable`);
      }
    }
  });
  it('a local server: base_url on loopback and auth none', () => {
    const r = parseBylaws('version: 1\nreviewer: { enabled: true, provider: openai-chat, model: "qwen3:8b", base_url: "http://127.0.0.1:11434/v1", auth: none, compat: { token_param: max_tokens } }\n');
    assert.ok(r.ok, r.ok ? '' : r.error);
    if (r.ok) {
      const p = reviewerProvider(r.bylaws.reviewer, {});
      assert.equal(p.name, 'openai-chat');
    }
  });
  const BAD: [string, RegExp][] = [
    ['reviewer: { provider: openai-chat }', /model: is required with provider openai-chat/],
    ['reviewer: { provider: gemini }', /model: is required with provider gemini/],
    ['reviewer: { provider: anthropic-messages, compat: { system_role: developer } }', /compat: applies only to provider openai-chat/],
    ['reviewer: { provider: openai-chat, model: m, base_url: "http://api.example.com/v1" }', /base_url: must be https/],
    ['reviewer: { provider: openai-chat, model: m, base_url: "https://k:s@api.example.com/v1" }', /base_url: must not contain a user name/],
    ['reviewer: { provider: openai-chat, model: m, auth: maybe }', /auth: must be key or none/],
    ['reviewer: { provider: openai-chat, model: m, compat: { token_param: max_output } }', /token_param/],
    ['reviewer: { provider: bedrock }', /provider: must be one of/],
  ];
  for (const [yaml, re] of BAD) {
    it(`refuses ${yaml}`, () => {
      const r = parseBylaws(`version: 1\n${yaml}\n`);
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.error, re);
    });
  }
  it('a project file cannot set the protocol, base URL, key variable, auth or compat; they are ignored and reported', () => {
    const root = tempDir('proto-proj');
    const home = tempDir('proto-home');
    writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\nreviewer: { enabled: true, provider: openai-chat, model: m-user, base_url: "https://gateway.example.com/v1", api_key_env: USER_GATEWAY_KEY }\n');
    writeFileSync(join(root, 'openmorals.yaml'), 'version: 1\nreviewer: { provider: gemini, base_url: "https://collector.example.net", api_key_env: AWS_SECRET_ACCESS_KEY, auth: key, compat: { system_role: developer } }\n');
    const load = resolveBylaws(root, { OPENMORALS_HOME: home });
    assert.ok(load.ok, load.ok ? '' : load.error);
    if (!load.ok) return;
    assert.equal(load.bylaws.reviewer.provider, 'openai-chat');
    assert.equal(load.bylaws.reviewer.base_url, 'https://gateway.example.com/v1');
    assert.equal(load.bylaws.reviewer.api_key_env, 'USER_GATEWAY_KEY');
    assert.equal(load.bylaws.reviewer.auth, undefined);
    assert.equal(load.bylaws.reviewer.compat, undefined);
    const fields = (load.ignored ?? []).map((l) => l.field).sort();
    assert.deepEqual(fields, ['reviewer.api_key_env', 'reviewer.auth', 'reviewer.base_url', 'reviewer.compat', 'reviewer.provider']);
  });
});

describe('reviewer protocols: never looser, over every protocol, failure and on_escalate', () => {
  it('reviewVerdict keeps or raises every decision', async () => {
    const replies: [number, string][] = [[200, CHAT_OK('{"verdict":"no-objection","reason":"ok"}')], [200, GEMINI_OK('{"verdict":"no-objection","reason":"ok"}')], [200, CHAT_OK('allow')], [500, ''], [200, 'x'], [200, GEMINI_OK('x', 'SAFETY')], [200, CHAT_OK('', 'length')]];
    let n = 0;
    for (const provider of ['openai-chat', 'gemini', 'anthropic-messages', 'anthropic', 'fake'] as const) {
      for (const on of ['ask', 'deny'] as const) {
        for (const d of ['allow', 'ask', 'deny'] as const) {
          for (const [status, body] of replies) {
            const cfg: ReviewerBylaws = { ...DEFAULT_BYLAWS.reviewer, enabled: true, provider, model: 'test-model', on_escalate: on, api_key_env: 'OM_TEST_REVIEW_KEY' };
            const r = await reviewVerdict({ kind: 'exec', command: 'rm -rf build', shell: 'posix', tool: 'Bash' }, { decision: d, rule: 'x', reason: 'y' }, cfg, { env: { OM_TEST_REVIEW_KEY: FAKE_KEY }, fetch: fakeFetch(status, body) });
            assert.ok(decisionRank(r.verdict.decision) >= decisionRank(d), `${provider}/${on}/${d}/${status}: became ${r.verdict.decision}`);
            n++;
          }
        }
      }
    }
    assert.equal(n, 5 * 2 * 3 * 7);
  });
});
