import { redact } from '../audit.js';
import { redactSecrets } from '../scanner/redact.js';
import type { ProviderResult } from './types.js';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'error' }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export const defaultFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, init);
  return { ok: res.ok, status: res.status, text: () => res.text() };
};

/** A letter or underscore, then letters, digits and underscores; 64 characters at most. */
export const KEY_ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Longest run between underscores: real names use words (ANTHROPIC, CREDENTIALS); secrets are long unbroken runs. */
const KEY_ENV_MAX_WORD = 24;

/**
 * Why a value is refused as the name of an environment variable, or null when it may be one.
 * A name is all upper case or all lower case (Windows names are case-insensitive, so an upper-case
 * name finds a mixed-case variable there), has no run of more than 24 characters between
 * underscores, and is left unchanged by both of the package's redactors. Mixed case is where
 * key-shaped values hide (Google, GitHub and most random keys). The reason never includes the value.
 */
export function keyEnvNameProblem(name: string): string | null {
  if (!KEY_ENV_PATTERN.test(name)) return 'must be 1-64 letters, digits and underscores, not starting with a digit';
  if (/[a-z]/.test(name) && /[A-Z]/.test(name)) return 'must be all upper case (or all lower case); mixed case looks like a key';
  if (name.split('_').some((w) => w.length > KEY_ENV_MAX_WORD)) return `must not have more than ${KEY_ENV_MAX_WORD} characters between underscores; that looks like a key`;
  if (redact(name) !== name || redactSecrets(name) !== name) return 'looks like a credential';
  return null;
}

function isLoopback(host: string): boolean {
  if (host === 'localhost' || host === '[::1]') return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return m !== null && m.slice(1).every((x) => Number(x) <= 255);
}

/**
 * Why a reviewer base URL is refused, or null when it may be used: https to any host, or http
 * only to this machine (localhost, 127.0.0.0/8, [::1]); no user name or password, query or
 * fragment. Applied when the bylaws load and again before every request.
 */
export function baseUrlProblem(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'is not a URL';
  }
  if (u.username !== '' || u.password !== '') return 'must not contain a user name or password';
  if (u.search !== '' || u.hash !== '' || url.includes('?') || url.includes('#')) return 'must not contain a query or fragment';
  if (u.hostname === '' || u.hostname.endsWith('.')) return 'needs a host name';
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:') return isLoopback(u.hostname) ? null : 'must be https (http is allowed only for localhost, 127.0.0.0/8 and [::1])';
  return 'must be https';
}

export function trimBase(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Reads the key at call time. Never returns or reports the value in an error. */
export function readKey(keyEnv: string, env: Readonly<Record<string, string | undefined>>): { ok: true; key: string } | { ok: false; result: ProviderResult } {
  if (keyEnvNameProblem(keyEnv) !== null) return { ok: false, result: { ok: false, kind: 'missing-key', error: 'the API key variable name is invalid' } };
  const key = env[keyEnv];
  if (key === undefined || key.trim() === '') return { ok: false, result: { ok: false, kind: 'missing-key', error: `no API key: ${keyEnv} is not set` } };
  return { ok: true, key: key.trim() };
}

/**
 * One POST of a JSON body. Follows no redirect, so the request (and the key in its header) only
 * ever reaches `url`. Errors name the failure kind, never the URL's secrets or the key.
 */
export async function postJson(doFetch: FetchLike, url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal, maxChars: number): Promise<{ ok: true; body: string } | { ok: false; result: ProviderResult }> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await doFetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal, redirect: 'error' });
  } catch (e: unknown) {
    const name = e instanceof Error ? e.name : 'Error';
    return { ok: false, result: { ok: false, kind: 'network', error: `request failed (${name})` } };
  }
  if (!res.ok) return { ok: false, result: { ok: false, kind: 'http', error: `HTTP ${res.status}` } };
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { ok: false, result: { ok: false, kind: 'network', error: 'could not read the response body' } };
  }
  if (text.length > maxChars) return { ok: false, result: { ok: false, kind: 'bad-response', error: `response longer than ${maxChars} characters` } };
  return { ok: true, body: text };
}

export function parseObject(bodyText: string): { ok: true; o: Record<string, unknown> } | { ok: false; result: ProviderResult } {
  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return { ok: false, result: { ok: false, kind: 'bad-response', error: 'response is not JSON' } };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, result: { ok: false, kind: 'bad-response', error: 'response is not an object' } };
  return { ok: true, o: raw as Record<string, unknown> };
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
