import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DECISIONS, decisionRank } from '../../src/types.js';
import type { Decision, Verdict } from '../../src/types.js';
import {
  ANTHROPIC_DEFAULT_VERSION,
  DEFAULT_REVIEW_LIMITS,
  DEFAULT_REVIEW_MODEL,
  REVIEW_VERDICTS,
  applyReview,
  buildReviewPrompt,
  createAnthropicProvider,
  createFakeProvider,
  parseReviewReply,
  readMessagesResponse,
  reviewAction,
} from '../../src/reviewer/index.js';
import type { FetchLike, ProviderRequest, Review, ReviewSource, ReviewVerdict } from '../../src/reviewer/index.js';
import { NONCE, REVIEW_CASES } from './cases.js';

const SOURCES: ReviewSource[] = ['model', 'timeout', 'http-error', 'network-error', 'missing-key', 'refusal', 'unparseable', 'incomplete', 'too-large', 'provider-error', 'bad-config'];
const FAKE_KEY = 'FAKE-KEY-for-tests-only-0000';

let realFetch: typeof globalThis.fetch;
let globalFetchCalls = 0;
before(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    globalFetchCalls += 1;
    return Promise.reject(new Error('network is not allowed in tests'));
  }) as typeof globalThis.fetch;
});
after(() => {
  globalThis.fetch = realFetch;
  assert.equal(globalFetchCalls, 0, 'a test reached the global fetch');
});

function verdict(decision: Decision): Verdict {
  return { decision, rule: decision === 'allow' ? 'none' : 'destructive.recursive-delete', reason: 'guard reason' };
}

describe('reviewer case table', () => {
  it('has at least 20 cases', () => assert.ok(REVIEW_CASES.length >= 20, `${REVIEW_CASES.length}`));
  for (const c of REVIEW_CASES) {
    it(c.name, async () => {
      const provider = createFakeProvider(c.behaviour);
      const out = await reviewAction({ action: c.action, verdict: verdict(c.decision), ...(c.context !== undefined ? { context: c.context } : {}) }, provider, { nonce: NONCE, ...(c.opts ?? {}) });
      assert.equal(out.sent, c.expect.sent, 'sent');
      assert.equal(provider.calls.length, c.expect.providerCalls, 'provider calls');
      assert.equal(out.review?.verdict ?? null, c.expect.review, `review: ${JSON.stringify(out.review)}`);
      if (c.expect.source !== undefined) assert.equal(out.review?.source, c.expect.source, 'source');
      assert.equal(out.final.decision, c.expect.final, 'final decision');
      assert.ok(decisionRank(out.final.decision) >= decisionRank(c.decision), 'never looser than the input');
      for (const call of provider.calls) {
        const sentText = `${call.system}\n${call.user}`;
        for (const s of c.expect.promptExcludes ?? []) assert.ok(!sentText.includes(s), `sent text contains ${JSON.stringify(s)}`);
        for (const s of c.expect.promptIncludes ?? []) assert.ok(call.user.includes(s), `user message lacks ${JSON.stringify(s)}`);
        const lines = call.user.split('\n');
        assert.equal(lines.length, 5, 'frame has exactly five lines');
        assert.equal(lines[1], `<<<OPENMORALS-DATA-${NONCE}`);
        assert.equal(lines[3], `OPENMORALS-DATA-${NONCE}>>>`);
        assert.equal(call.user.split(`OPENMORALS-DATA-${NONCE}`).length, 3, 'boundary appears exactly twice');
        assert.doesNotThrow(() => JSON.parse(lines[2] ?? ''), 'data line is one JSON value');
        assert.equal(call.model, DEFAULT_REVIEW_MODEL);
      }
    });
  }
});

describe('applyReview can never loosen a decision', () => {
  it('exhaustive over decision x verdict x source x onEscalate', () => {
    let n = 0;
    for (const d of DECISIONS) {
      for (const v of REVIEW_VERDICTS) {
        for (const source of SOURCES) {
          for (const onEscalate of ['ask', 'deny'] as const) {
            const out = applyReview(verdict(d), { verdict: v, reason: 'r', source }, onEscalate);
            assert.ok(decisionRank(out.decision) >= decisionRank(d), `${d}/${v}/${source}/${onEscalate} -> ${out.decision}`);
            if (v === 'escalate') assert.ok(decisionRank(out.decision) >= decisionRank(onEscalate));
            if (v === 'no-objection') assert.equal(out.decision, d);
            assert.notEqual(out.decision === 'allow' && d !== 'allow', true);
            n += 1;
          }
        }
      }
    }
    assert.equal(n, 3 * 2 * SOURCES.length * 2);
  });
  it('the review verdict type cannot hold "allow" (checked by tsc)', () => {
    // @ts-expect-error 'allow' is not a ReviewVerdict
    const bad: ReviewVerdict = 'allow';
    // @ts-expect-error a Review cannot carry 'allow'
    const badReview: Review = { verdict: 'allow', reason: 'r', source: 'model' };
    assert.equal(String(bad), 'allow');
    assert.equal(String(badReview.verdict), 'allow');
    assert.deepEqual([...REVIEW_VERDICTS].sort(), ['escalate', 'no-objection']);
  });
});

describe('strict reply parser', () => {
  const good = '{"verdict":"no-objection","reason":"ok"}';
  it('accepts exactly the documented object, with outer whitespace', () => {
    assert.deepEqual(parseReviewReply(` ${good}\n`, 2000), { ok: true, verdict: 'no-objection', reason: 'ok' });
    assert.deepEqual(parseReviewReply('{"reason":"r","verdict":"escalate"}', 2000), { ok: true, verdict: 'escalate', reason: 'r' });
  });
  for (const bad of ['', 'null', '[]', '"no-objection"', 'no-objection', '{"verdict":"no-objection"}', '{"verdict":"no-objection","reason":""}', '{"verdict":"no-objection","reason":5}', '{"verdict":"no-objection","reason":"a\\nb"}', '{"verdict":"proceed","reason":"r"}', `${good} `.repeat(2)]) {
    it(`rejects ${JSON.stringify(bad).slice(0, 60)}`, () => assert.equal(parseReviewReply(bad, 2000).ok, false));
  }
  it('rejects a reply over the size cap', () => assert.equal(parseReviewReply(good, 10).ok, false));
});

describe('frame', () => {
  it('puts the action only inside the data line, JSON-encoded', () => {
    const r = buildReviewPrompt({ action: { kind: 'exec', command: 'rm -rf "a b"', shell: 'posix', tool: 'Bash' }, verdict: verdict('ask') }, DEFAULT_REVIEW_LIMITS, NONCE);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.ok(!r.framed.system.includes('rm -rf'));
    const data = JSON.parse(r.framed.user.split('\n')[2] ?? '') as Record<string, unknown>;
    assert.equal(data['action'], 'rm -rf "a b"');
    assert.equal(data['kind'], 'exec');
  });
  it('refuses a prompt over the total cap', () => {
    const r = buildReviewPrompt({ action: { kind: 'exec', command: 'rm -rf x', shell: 'posix', tool: 'Bash' }, verdict: verdict('ask'), context: 'c'.repeat(500) }, { ...DEFAULT_REVIEW_LIMITS, maxPromptChars: 300 }, NONCE);
    assert.equal(r.ok, false);
  });
});

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
  redirect: string;
}

function fakeFetch(status: number, body: string, captured: Captured[]): FetchLike {
  return (url, init) => {
    captured.push({ url, headers: init.headers, body: init.body, redirect: init.redirect });
    return Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(body) });
  };
}

const REQ: ProviderRequest = { model: 'claude-haiku-5-5', system: 'SYS', user: 'USER', maxTokens: 256 };
const MESSAGE = (text: string, stop = 'end_turn'): string =>
  JSON.stringify({ id: 'msg_x', type: 'message', role: 'assistant', content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text }], stop_reason: stop, stop_sequence: null, stop_details: null, usage: { input_tokens: 1, output_tokens: 1 } });

describe('Anthropic provider (fake fetch, no network)', () => {
  const signal = new AbortController().signal;
  it('sends the documented request shape with the key only in x-api-key', async () => {
    const cap: Captured[] = [];
    const p = createAnthropicProvider({ env: { ANTHROPIC_API_KEY: FAKE_KEY }, fetch: fakeFetch(200, MESSAGE('{"verdict":"escalate","reason":"r"}'), cap) });
    const r = await p.complete(REQ, signal);
    assert.deepEqual(r, { ok: true, text: '{"verdict":"escalate","reason":"r"}' });
    assert.equal(cap.length, 1);
    const c = cap[0];
    assert.ok(c !== undefined);
    assert.equal(c.url, 'https://api.anthropic.com/v1/messages');
    assert.deepEqual(c.headers, { 'content-type': 'application/json', 'x-api-key': FAKE_KEY, 'anthropic-version': ANTHROPIC_DEFAULT_VERSION });
    assert.deepEqual(JSON.parse(c.body), { model: 'claude-haiku-5-5', max_tokens: 256, system: 'SYS', messages: [{ role: 'user', content: 'USER' }] });
    assert.ok(!c.body.includes(FAKE_KEY));
    assert.equal(c.redirect, 'error');
  });
  it('reads the key from the configured variable name', async () => {
    const cap: Captured[] = [];
    const p = createAnthropicProvider({ apiKeyEnv: 'OM_REVIEW_KEY', env: { OM_REVIEW_KEY: FAKE_KEY }, fetch: fakeFetch(200, MESSAGE('x'), cap) });
    await p.complete(REQ, signal);
    assert.equal(cap[0]?.headers['x-api-key'], FAKE_KEY);
  });
  const failures: [string, number, string, string][] = [
    ['HTTP 500', 500, '{"type":"error"}', 'http'],
    ['HTTP 401', 401, `{"error":"${FAKE_KEY}"}`, 'http'],
    ['refusal', 200, MESSAGE('', 'refusal'), 'refusal'],
    ['max_tokens', 200, MESSAGE('{"verdict":"no-ob', 'max_tokens'), 'incomplete'],
    ['not JSON', 200, '<html>', 'bad-response'],
    ['no text block', 200, JSON.stringify({ type: 'message', content: [], stop_reason: 'end_turn' }), 'bad-response'],
    ['wrong type', 200, JSON.stringify({ type: 'error', content: [], stop_reason: 'end_turn' }), 'bad-response'],
  ];
  for (const [name, status, body, kind] of failures) {
    it(`${name} is a failure of kind ${kind}, without the key in the message`, async () => {
      const p = createAnthropicProvider({ env: { ANTHROPIC_API_KEY: FAKE_KEY }, fetch: fakeFetch(status, body, []) });
      const r = await p.complete(REQ, signal);
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.kind, kind);
        assert.ok(!r.error.includes(FAKE_KEY));
      }
    });
  }
  it('missing or blank key: no request is made', async () => {
    for (const env of [{}, { ANTHROPIC_API_KEY: '' }, { ANTHROPIC_API_KEY: '   ' }]) {
      const cap: Captured[] = [];
      const r = await createAnthropicProvider({ env, fetch: fakeFetch(200, MESSAGE('x'), cap) }).complete(REQ, signal);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.kind, 'missing-key');
      assert.equal(cap.length, 0);
    }
  });
  it('a non-https base URL is refused before any request', async () => {
    const cap: Captured[] = [];
    const r = await createAnthropicProvider({ env: { ANTHROPIC_API_KEY: FAKE_KEY }, baseUrl: 'http://api.example.invalid', fetch: fakeFetch(200, MESSAGE('x'), cap) }).complete(REQ, signal);
    assert.equal(r.ok, false);
    assert.equal(cap.length, 0);
  });
  it('a fetch that throws is a network failure without the key', async () => {
    const p = createAnthropicProvider({ env: { ANTHROPIC_API_KEY: FAKE_KEY }, fetch: () => Promise.reject(new TypeError(`connect failed ${FAKE_KEY}`)) });
    const r = await p.complete(REQ, signal);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.kind, 'network');
      assert.ok(!r.error.includes(FAKE_KEY));
    }
  });
  it('end to end through reviewAction with a fake fetch: missing key escalates and keeps ask', async () => {
    const out = await reviewAction({ action: { kind: 'exec', command: 'rm -rf build', shell: 'posix', tool: 'Bash' }, verdict: verdict('ask') }, createAnthropicProvider({ env: {}, fetch: fakeFetch(200, MESSAGE('x'), []) }), { nonce: NONCE });
    assert.equal(out.review?.source, 'missing-key');
    assert.equal(out.final.decision, 'ask');
  });
  it('readMessagesResponse joins text blocks and skips thinking blocks', () => {
    assert.deepEqual(readMessagesResponse(MESSAGE('abc')), { ok: true, text: 'abc' });
  });
});
