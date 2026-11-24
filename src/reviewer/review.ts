import { randomBytes } from 'node:crypto';
import { redact } from '../audit.js';
import { applyReview } from './combine.js';
import { buildReviewPrompt } from './frame.js';
import { parseReviewReply } from './parse.js';
import type { ProviderFailureKind, ProviderResult, Review, ReviewLimits, ReviewOptions, ReviewOutcome, ReviewProvider, ReviewRequest, ReviewSource } from './types.js';
import { DEFAULT_REVIEW_LIMITS } from './types.js';

export const DEFAULT_REVIEW_MODEL = 'claude-haiku-5-5';
export const DEFAULT_REVIEW_TIMEOUT_MS = 20000;
export const DEFAULT_REVIEW_MAX_TOKENS = 1024;

const FAILURE_SOURCE: Record<ProviderFailureKind, ReviewSource> = {
  http: 'http-error',
  network: 'network-error',
  'missing-key': 'missing-key',
  refusal: 'refusal',
  'bad-response': 'unparseable',
  incomplete: 'incomplete',
};

function escalate(source: ReviewSource, reason: string): Review {
  return { verdict: 'escalate', reason: redact(reason).slice(0, 300), source };
}

function isWhole(n: number, lo: number, hi: number): boolean {
  return Number.isInteger(n) && n >= lo && n <= hi;
}

function resolveLimits(partial: Partial<ReviewLimits> | undefined): ReviewLimits | null {
  const l: ReviewLimits = { ...DEFAULT_REVIEW_LIMITS, ...(partial ?? {}) };
  const ok = isWhole(l.maxActionChars, 1, 100000) && isWhole(l.maxContextChars, 0, 100000) && isWhole(l.maxPromptChars, 1, 400000) && isWhole(l.maxReplyChars, 1, 100000);
  return ok ? l : null;
}

export type Raced = { kind: 'result'; result: ProviderResult } | { kind: 'timeout' } | { kind: 'threw'; error: string };

/** One provider call that is aborted after `timeoutMs`; a throw is caught and reported, never rethrown. */
export async function callWithTimeout(provider: ReviewProvider, req: Parameters<ReviewProvider['complete']>[0], timeoutMs: number): Promise<Raced> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<Raced>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: 'timeout' });
    }, timeoutMs);
  });
  const call = (async (): Promise<Raced> => {
    try {
      return { kind: 'result', result: await provider.complete(req, controller.signal) };
    } catch (e: unknown) {
      return { kind: 'threw', error: e instanceof Error ? e.message : String(e) };
    }
  })();
  try {
    return await Promise.race([call, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Reviews one guard verdict. Only an 'ask' is ever handed to the provider; 'allow' and
 * 'deny' come back unchanged with sent=false. Every failure (bad options, oversized
 * action, timeout, HTTP or network error, missing key, refusal, a throw, an unparseable
 * reply) is an 'escalate'. The final decision is applyReview(), never looser than the input.
 */
export async function reviewAction(req: ReviewRequest, provider: ReviewProvider, opts: ReviewOptions = {}): Promise<ReviewOutcome> {
  if (req.verdict.decision !== 'ask') return { sent: false, review: null, final: req.verdict, prompt: null };
  const onEscalate = opts.onEscalate === 'deny' ? 'deny' : 'ask';
  const done = (review: Review, sent: boolean, prompt: ReviewOutcome['prompt']): ReviewOutcome => ({ sent, review, final: applyReview(req.verdict, review, onEscalate), prompt });

  const timeoutMs = opts.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
  const maxTokens = opts.maxTokens ?? DEFAULT_REVIEW_MAX_TOKENS;
  const model = opts.model ?? DEFAULT_REVIEW_MODEL;
  const limits = resolveLimits(opts.limits);
  if (!isWhole(timeoutMs, 1, 600000) || !isWhole(maxTokens, 1, 128000) || limits === null || !/^[A-Za-z0-9._:@/-]{1,128}$/.test(model)) {
    return done(escalate('bad-config', 'reviewer options are invalid'), false, null);
  }
  const framed = buildReviewPrompt(req, limits, opts.nonce ?? randomBytes(12).toString('hex'));
  if (!framed.ok) return done(escalate(framed.error.startsWith('invalid') ? 'bad-config' : 'too-large', framed.error), false, null);
  const prompt = { system: framed.framed.system, user: framed.framed.user };

  const raced = await callWithTimeout(provider, { model, system: prompt.system, user: prompt.user, maxTokens }, timeoutMs);
  if (raced.kind === 'timeout') return done(escalate('timeout', `no reply within ${timeoutMs} ms`), true, prompt);
  if (raced.kind === 'threw') return done(escalate('provider-error', `provider failed: ${raced.error}`), true, prompt);
  const r = raced.result;
  if (!r.ok) return done(escalate(FAILURE_SOURCE[r.kind] ?? 'provider-error', r.error), true, prompt);
  const parsed = parseReviewReply(r.text, limits.maxReplyChars);
  if (!parsed.ok) return done(escalate('unparseable', parsed.error), true, prompt);
  return done({ verdict: parsed.verdict, reason: redact(parsed.reason), source: 'model' }, true, prompt);
}
