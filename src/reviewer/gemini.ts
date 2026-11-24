import type { FetchLike } from './http.js';
import { baseUrlProblem, defaultFetch, isRecord, parseObject, postJson, readKey, trimBase } from './http.js';
import type { ProviderRequest, ProviderResult, ReviewProvider } from './types.js';

/** Request shape per the generateContent reference; see docs/reviewer.md for the source and date. */
export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com';
export const GEMINI_DEFAULT_KEY_ENV = 'GEMINI_API_KEY';

export interface GeminiProviderOptions {
  baseUrl?: string;
  apiKeyEnv?: string | null;
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: FetchLike;
  maxResponseChars?: number;
}

export function generateContentBody(req: ProviderRequest): Record<string, unknown> {
  return {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: [{ role: 'user', parts: [{ text: req.user }] }],
    generationConfig: { maxOutputTokens: req.maxTokens },
  };
}

const REFUSAL_REASONS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'LANGUAGE', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT']);

/** Reads a generateContent response body. Pure. Only a finished (STOP) text answer is a success. */
export function readGenerateContentResponse(bodyText: string): ProviderResult {
  const p = parseObject(bodyText);
  if (!p.ok) return p.result;
  const fb = p.o['promptFeedback'];
  if (isRecord(fb) && typeof fb['blockReason'] === 'string' && fb['blockReason'] !== '') return { ok: false, kind: 'refusal', error: `the prompt was blocked (${fb['blockReason'].slice(0, 40)})` };
  const cands = p.o['candidates'];
  if (!Array.isArray(cands) || cands.length === 0) return { ok: false, kind: 'bad-response', error: 'no candidates in the response' };
  const c = cands[0] as unknown;
  if (!isRecord(c)) return { ok: false, kind: 'bad-response', error: 'candidate is not an object' };
  const finish = c['finishReason'];
  if (typeof finish === 'string' && REFUSAL_REASONS.has(finish)) return { ok: false, kind: 'refusal', error: `the reply was withheld (${finish})` };
  if (finish !== 'STOP') return { ok: false, kind: 'incomplete', error: `finishReason is ${typeof finish === 'string' ? finish.slice(0, 40) : 'missing'}, not STOP` };
  const content = c['content'];
  if (!isRecord(content) || !Array.isArray(content['parts'])) return { ok: false, kind: 'bad-response', error: 'candidate has no content parts' };
  const texts: string[] = [];
  for (const part of content['parts'] as unknown[]) {
    if (!isRecord(part)) return { ok: false, kind: 'bad-response', error: 'content part is not an object' };
    if (part['thought'] === true) continue;
    if (typeof part['text'] === 'string') texts.push(part['text']);
  }
  if (texts.length === 0 || texts.join('') === '') return { ok: false, kind: 'bad-response', error: 'no text in the response' };
  return { ok: true, text: texts.join('') };
}

/**
 * A ReviewProvider over the Gemini API's generateContent. The key goes only in the
 * x-goog-api-key header (never in the URL, where it could end up in a log).
 */
export function createGeminiProvider(opts: GeminiProviderOptions = {}): ReviewProvider {
  const keyEnv = opts.apiKeyEnv === undefined ? GEMINI_DEFAULT_KEY_ENV : opts.apiKeyEnv;
  const baseUrl = trimBase(opts.baseUrl ?? GEMINI_DEFAULT_BASE_URL);
  const maxChars = opts.maxResponseChars ?? 200000;
  const doFetch = opts.fetch ?? defaultFetch;
  return {
    name: 'gemini',
    async complete(req: ProviderRequest, signal: AbortSignal): Promise<ProviderResult> {
      const headers: Record<string, string> = {};
      if (keyEnv !== null) {
        const key = readKey(keyEnv, opts.env ?? process.env);
        if (!key.ok) return key.result;
        headers['x-goog-api-key'] = key.key;
      }
      const bad = baseUrlProblem(baseUrl);
      if (bad !== null) return { ok: false, kind: 'network', error: `refused: the base URL ${bad}` };
      if (!/^[A-Za-z0-9._-]{1,128}$/.test(req.model)) return { ok: false, kind: 'network', error: 'refused: a Gemini model id may only hold letters, digits, dots, dashes and underscores' };
      const res = await postJson(doFetch, `${baseUrl}/v1beta/models/${req.model}:generateContent`, headers, generateContentBody(req), signal, maxChars);
      return res.ok ? readGenerateContentResponse(res.body) : res.result;
    },
  };
}
