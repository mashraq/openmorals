import type { ReviewVerdict } from './types.js';

export const MAX_REASON_CHARS = 300;

export type ParsedReply = { ok: true; verdict: ReviewVerdict; reason: string } | { ok: false; error: string };

/**
 * Strict: the whole reply (after trimming outer whitespace) must be one JSON object with
 * exactly the keys "verdict" and "reason"; verdict is "escalate" or "no-objection"; reason
 * is a non-empty single-line string of at most 300 characters. Anything else is an error,
 * which the reviewer turns into 'escalate'.
 */
export function parseReviewReply(text: string, maxChars: number): ParsedReply {
  if (text.length > maxChars) return { ok: false, error: `reply longer than ${maxChars} characters` };
  const t = text.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return { ok: false, error: 'reply is not a bare JSON object' };
  let raw: unknown;
  try {
    raw = JSON.parse(t);
  } catch {
    return { ok: false, error: 'reply is not valid JSON' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'reply is not a JSON object' };
  const keys = Object.keys(raw).sort();
  if (keys.length !== 2 || keys[0] !== 'reason' || keys[1] !== 'verdict') return { ok: false, error: `reply keys must be exactly reason and verdict, got ${keys.join(',') || 'none'}` };
  const o = raw as Record<string, unknown>;
  const verdict = o['verdict'];
  const reason = o['reason'];
  if (verdict !== 'escalate' && verdict !== 'no-objection') return { ok: false, error: 'verdict must be "escalate" or "no-objection"' };
  if (typeof reason !== 'string' || reason.trim() === '') return { ok: false, error: 'reason must be a non-empty string' };
  if (reason.length > MAX_REASON_CHARS) return { ok: false, error: `reason longer than ${MAX_REASON_CHARS} characters` };
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(reason)) return { ok: false, error: 'reason contains control characters' };
  return { ok: true, verdict, reason };
}
