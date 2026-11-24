export const MAX_EVIDENCE_CHARS = 200;

const REDACTED = "[REDACTED]";

/** Vendor token shapes (also used by the inbound prompt check in src/inbound/scan.ts). */
export const TOKEN_PATTERNS: readonly RegExp[] = [
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
];

const AUTH_SCHEME = /\b(Bearer|Basic|Token)(\s+)([A-Za-z0-9._~+/=-]{12,})/gi;

const KEY_VALUE =
  /((?:api[_-]?key|apikey|secret|token|password|passwd|pwd|auth|credential|private[_-]?key|access[_-]?key|client[_-]?secret)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?)(?![$%]|process\.env|os\.environ|\[REDACTED|(?:Bearer|Basic|Token)\s)([^\s"',;}]{6,})/gi;

const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]+)(@)/gi;

const LONG_BLOB = /[A-Za-z0-9+/=_-]{32,}/g;

function looksLikeSecretBlob(s: string): boolean {
  return /[0-9]/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s);
}

export function redactSecrets(input: string): string {
  let out = input;
  for (const p of TOKEN_PATTERNS) {
    out = out.replace(p, REDACTED);
  }
  out = out.replace(AUTH_SCHEME, (_m: string, scheme: string, sp: string) => `${scheme}${sp}${REDACTED}`);
  out = out.replace(URL_CREDENTIALS, (_m: string, head: string, _pw: string, at: string) => `${head}${REDACTED}${at}`);
  out = out.replace(KEY_VALUE, (_m: string, head: string) => `${head}${REDACTED}`);
  out = out.replace(LONG_BLOB, (m: string) => (looksLikeSecretBlob(m) ? `[REDACTED:${m.length} chars]` : m));
  return out;
}

function isInvisibleOrControl(cp: number): boolean {
  if (cp === 0x09) return false;
  if (cp < 0x20 || cp === 0x7f) return true;
  if (cp >= 0x200b && cp <= 0x200f) return true;
  if (cp >= 0x202a && cp <= 0x202e) return true;
  if (cp >= 0x2060 && cp <= 0x2069) return true;
  if (cp === 0xfeff) return true;
  if (cp >= 0xe0000 && cp <= 0xe007f) return true;
  return false;
}

export function escapeInvisible(input: string): string {
  let out = "";
  for (const ch of input) {
    const cp = ch.codePointAt(0) ?? 0;
    out += isInvisibleOrControl(cp) ? `<U+${cp.toString(16).toUpperCase().padStart(4, "0")}>` : ch;
  }
  return out;
}

export function makeEvidence(line: string, matchIndex = 0): string {
  const safe = escapeInvisible(redactSecrets(line)).trim();
  if (safe.length <= MAX_EVIDENCE_CHARS) return safe;
  const ratio = line.length > 0 ? matchIndex / line.length : 0;
  const centre = Math.floor(ratio * safe.length);
  const start = Math.max(0, Math.min(safe.length - MAX_EVIDENCE_CHARS, centre - Math.floor(MAX_EVIDENCE_CHARS / 3)));
  const body = safe.slice(start, start + MAX_EVIDENCE_CHARS);
  return `${start > 0 ? "..." : ""}${body}${start + MAX_EVIDENCE_CHARS < safe.length ? "..." : ""}`;
}
