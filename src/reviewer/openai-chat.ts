import type { FetchLike } from './http.js';
import { baseUrlProblem, defaultFetch, isRecord, parseObject, postJson, readKey, trimBase } from './http.js';
import type { ProviderRequest, ProviderResult, ReviewProvider } from './types.js';

/** Request shape per the Chat Completions reference; see docs/reviewer.md for the source and date. */
export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const OPENAI_DEFAULT_KEY_ENV = 'OPENAI_API_KEY';

export type TokenParam = 'max_tokens' | 'max_completion_tokens';
export type SystemRole = 'system' | 'developer';

export interface OpenAIChatProviderOptions {
  /** Base URL up to and including the version segment, e.g. https://api.openai.com/v1 or http://127.0.0.1:11434/v1. */
  baseUrl?: string;
  /** Name of the variable holding the key; null sends no Authorization header (a local server). */
  apiKeyEnv?: string | null;
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: FetchLike;
  /** max_tokens (default: what most compatible servers accept) or max_completion_tokens (what OpenAI now prefers). */
  tokenParam?: TokenParam;
  /** system (default) or developer (OpenAI's newer models). */
  systemRole?: SystemRole;
  maxResponseChars?: number;
}

export function chatRequestBody(req: ProviderRequest, tokenParam: TokenParam = 'max_tokens', systemRole: SystemRole = 'system'): Record<string, unknown> {
  return {
    model: req.model,
    messages: [
      { role: systemRole, content: req.system },
      { role: 'user', content: req.user },
    ],
    [tokenParam]: req.maxTokens,
  };
}

/** Reads a Chat Completions response body. Pure. Anything but one finished text answer is a failure. */
export function readChatResponse(bodyText: string): ProviderResult {
  const p = parseObject(bodyText);
  if (!p.ok) return p.result;
  const choices = p.o['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return { ok: false, kind: 'bad-response', error: 'no choices in the response' };
  const c = choices[0] as unknown;
  if (!isRecord(c)) return { ok: false, kind: 'bad-response', error: 'choice is not an object' };
  const msg = c['message'];
  if (!isRecord(msg)) return { ok: false, kind: 'bad-response', error: 'choice has no message' };
  const refusal = msg['refusal'];
  if (typeof refusal === 'string' && refusal !== '') return { ok: false, kind: 'refusal', error: 'the reviewer model declined to respond' };
  const finish = c['finish_reason'];
  if (finish === 'content_filter') return { ok: false, kind: 'refusal', error: 'the reply was withheld by a content filter' };
  if (finish !== 'stop') return { ok: false, kind: 'incomplete', error: `finish_reason is ${typeof finish === 'string' ? finish : 'missing'}, not stop` };
  const content = msg['content'];
  if (typeof content !== 'string' || content === '') return { ok: false, kind: 'bad-response', error: 'message has no text content' };
  return { ok: true, text: content };
}

/**
 * A ReviewProvider for any server that speaks OpenAI's Chat Completions: OpenAI itself and the
 * many compatible services and local servers (Ollama, LM Studio, vLLM, llama.cpp) at their base
 * URL. The key goes only in the Authorization header of a request to the configured base URL.
 */
export function createOpenAIChatProvider(opts: OpenAIChatProviderOptions = {}): ReviewProvider {
  const keyEnv = opts.apiKeyEnv === undefined ? OPENAI_DEFAULT_KEY_ENV : opts.apiKeyEnv;
  const baseUrl = trimBase(opts.baseUrl ?? OPENAI_DEFAULT_BASE_URL);
  const maxChars = opts.maxResponseChars ?? 200000;
  const doFetch = opts.fetch ?? defaultFetch;
  return {
    name: 'openai-chat',
    async complete(req: ProviderRequest, signal: AbortSignal): Promise<ProviderResult> {
      const headers: Record<string, string> = {};
      if (keyEnv !== null) {
        const key = readKey(keyEnv, opts.env ?? process.env);
        if (!key.ok) return key.result;
        headers['authorization'] = `Bearer ${key.key}`;
      }
      const bad = baseUrlProblem(baseUrl);
      if (bad !== null) return { ok: false, kind: 'network', error: `refused: the base URL ${bad}` };
      const res = await postJson(doFetch, `${baseUrl}/chat/completions`, headers, chatRequestBody(req, opts.tokenParam, opts.systemRole), signal, maxChars);
      return res.ok ? readChatResponse(res.body) : res.result;
    },
  };
}
