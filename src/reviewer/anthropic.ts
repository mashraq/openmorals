import type { ProviderRequest, ProviderResult, ReviewProvider } from './types.js';

/** Request shape per the Messages API docs; see docs/reviewer.md for the source and date. */
export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_DEFAULT_VERSION = '2026-10-21';
export const ANTHROPIC_DEFAULT_KEY_ENV = 'ANTHROPIC_API_KEY';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'error' }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface AnthropicProviderOptions {
  /** Name of the environment variable holding the key (default ANTHROPIC_API_KEY). */
  apiKeyEnv?: string;
  /** The environment to read the key from (default process.env). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: FetchLike;
  baseUrl?: string;
  anthropicVersion?: string;
  /** Largest response body accepted, in characters. */
  maxResponseChars?: number;
}

export interface MessagesRequestBody {
  model: string;
  max_tokens: number;
  system: string;
  messages: { role: 'user'; content: string }[];
}

export function messagesRequestBody(req: ProviderRequest): MessagesRequestBody {
  return { model: req.model, max_tokens: req.maxTokens, system: req.system, messages: [{ role: 'user', content: req.user }] };
}

/** Reads a Messages API response body. Pure. */
export function readMessagesResponse(bodyText: string): ProviderResult {
  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return { ok: false, kind: 'bad-response', error: 'response is not JSON' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, kind: 'bad-response', error: 'response is not an object' };
  const o = raw as Record<string, unknown>;
  if (o['type'] !== 'message') return { ok: false, kind: 'bad-response', error: 'response type is not "message"' };
  const stop = o['stop_reason'];
  if (stop === 'refusal') return { ok: false, kind: 'refusal', error: 'the reviewer model declined to respond' };
  if (stop !== 'end_turn') return { ok: false, kind: 'incomplete', error: `stop_reason is ${typeof stop === 'string' ? stop : 'missing'}, not end_turn` };
  const content = o['content'];
  if (!Array.isArray(content)) return { ok: false, kind: 'bad-response', error: 'content is not an array' };
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) return { ok: false, kind: 'bad-response', error: 'content block is not an object' };
    const b = block as Record<string, unknown>;
    if (b['type'] === 'text') {
      if (typeof b['text'] !== 'string') return { ok: false, kind: 'bad-response', error: 'text block without text' };
      texts.push(b['text']);
    }
  }
  if (texts.length === 0) return { ok: false, kind: 'bad-response', error: 'no text block in the response' };
  return { ok: true, text: texts.join('') };
}

const defaultFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, init);
  return { ok: res.ok, status: res.status, text: () => res.text() };
};

/**
 * A ReviewProvider over the Anthropic Messages API using fetch. The key is read from the
 * environment at call time and only ever placed in the x-api-key header; no error message
 * includes it. Only https base URLs are accepted.
 */
export function createAnthropicProvider(opts: AnthropicProviderOptions = {}): ReviewProvider {
  const keyEnv = opts.apiKeyEnv ?? ANTHROPIC_DEFAULT_KEY_ENV;
  const baseUrl = (opts.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const version = opts.anthropicVersion ?? ANTHROPIC_DEFAULT_VERSION;
  const maxChars = opts.maxResponseChars ?? 200000;
  const doFetch = opts.fetch ?? defaultFetch;
  return {
    name: 'anthropic',
    async complete(req: ProviderRequest, signal: AbortSignal): Promise<ProviderResult> {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(keyEnv)) return { ok: false, kind: 'missing-key', error: 'the API key variable name is invalid' };
      const env = opts.env ?? process.env;
      const key = env[keyEnv];
      if (key === undefined || key.trim() === '') return { ok: false, kind: 'missing-key', error: `no API key: ${keyEnv} is not set` };
      if (!/^https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?(\/[A-Za-z0-9._~/-]*)?$/.test(baseUrl)) return { ok: false, kind: 'network', error: 'refused: the base URL must be https' };
      if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(version)) return { ok: false, kind: 'network', error: 'refused: anthropic-version must be a date' };
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await doFetch(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': key.trim(), 'anthropic-version': version },
          body: JSON.stringify(messagesRequestBody(req)),
          signal,
          redirect: 'error',
        });
      } catch (e: unknown) {
        const name = e instanceof Error ? e.name : 'Error';
        return { ok: false, kind: 'network', error: `request failed (${name})` };
      }
      if (!res.ok) return { ok: false, kind: 'http', error: `HTTP ${res.status}` };
      let body: string;
      try {
        body = await res.text();
      } catch {
        return { ok: false, kind: 'network', error: 'could not read the response body' };
      }
      if (body.length > maxChars) return { ok: false, kind: 'bad-response', error: `response longer than ${maxChars} characters` };
      return readMessagesResponse(body);
    },
  };
}
