// Inbound content scanning: a pure function over text (a tool result, a fetched page, a submitted prompt) that looks for
// instructions hidden from a human reader. It reuses the install scanner's character sets and override phrases
// (src/scanner/rules.ts) and adds the context rules a stream of everyday content needs (see docs/scanner.md, "Inbound").
// It never returns or stores the text it scanned: findings carry a rule id, a fixed description and a line number.
import { TOKEN_PATTERNS } from '../scanner/redact.js';
import { BIDI_SET, OVERRIDE_PHRASES, ZW_SET, isEmojiContext, isTag, isVariationSelector } from '../scanner/rules.js';

export type InboundRule = 'inbound.hidden-characters' | 'inbound.html-comment' | 'inbound.encoded-instruction' | 'inbound.split-phrase' | 'inbound.instruction-phrase' | 'inbound.secret-shape';

/** strong: hidden from a reader (invisible characters, an HTML comment, an encoded payload). weak: a visible phrase. */
export type InboundStrength = 'strong' | 'weak';

export interface InboundFinding {
  readonly rule: InboundRule;
  readonly strength: InboundStrength;
  /** 1-based line in the scanned text; null for a finding in the tail of a truncated text. */
  readonly line: number | null;
  /** A fixed description from a closed list; never text taken from the content. */
  readonly what: string;
}

export interface InboundScan {
  readonly findings: readonly InboundFinding[];
  readonly strong: boolean;
  readonly bytesTotal: number;
  readonly bytesScanned: number;
  readonly truncated: boolean;
}

export interface InboundScanOptions {
  /** Most bytes scanned: the first and the last half. Default 262144. */
  readonly maxBytes?: number;
  /** Also look for secret-shaped values (vendor tokens, private key blocks): used for prompts, which leave the machine. */
  readonly secrets?: boolean;
}

export const INBOUND_SCAN_DEFAULT_MAX_BYTES = 262144;
const MAX_FINDINGS = 50;
const MAX_ENCODED_CANDIDATES = 64;
const MAX_ENCODED_CHARS = 8192;
const MAX_COMMENT_CHARS = 4000;

const RTL_LETTER = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/;
const BIDI_OVERRIDE = new Set<number>([0x202d, 0x202e]);
const BIDI_OPEN_EMBED = new Set<number>([0x202a, 0x202b, 0x202d, 0x202e]);
const BIDI_OPEN_ISOLATE = new Set<number>([0x2066, 0x2067, 0x2068]);
const NON_ASCII_LETTER = /[\p{L}\p{M}]/u;
const ZW_RUN = 3;

function isInvisible(cp: number): boolean {
  return ZW_SET.has(cp) || BIDI_SET.has(cp) || isTag(cp) || isVariationSelector(cp) || cp === 0x00ad;
}

/** The text with every invisible character removed, so a phrase split by them is still seen. */
export function stripInvisible(text: string): string {
  let out = '';
  for (const ch of text) if (!isInvisible(ch.codePointAt(0) ?? 0)) out += ch;
  return out;
}

/** True when the bidirectional controls on a line are what right-to-left writing uses: RTL letters, every embedding or isolate closed, no override. */
function benignBidi(line: string): boolean {
  if (!RTL_LETTER.test(line)) return false;
  let embeds = 0;
  let isolates = 0;
  for (const ch of line) {
    const cp = ch.codePointAt(0) ?? 0;
    if (BIDI_OVERRIDE.has(cp)) return false;
    if (BIDI_OPEN_EMBED.has(cp)) embeds++;
    else if (cp === 0x202c) embeds--;
    else if (BIDI_OPEN_ISOLATE.has(cp)) isolates++;
    else if (cp === 0x2069) isolates--;
    if (embeds < 0 || isolates < 0) return false;
  }
  return embeds === 0 && isolates === 0;
}

/** The hidden-character kinds on one line, by the install scanner's sets, with the exemptions everyday text needs. */
function hiddenKinds(line: string, firstLine: boolean): string[] {
  const chars = Array.from(line);
  const kinds = new Set<string>();
  let vsRun = 0;
  let zwRun = 0;
  let bidi = false;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] ?? '';
    const cp = ch.codePointAt(0) ?? 0;
    const prev = chars[i - 1];
    const next = chars[i + 1];
    if (isVariationSelector(cp)) {
      vsRun++;
      const prevCp = prev?.codePointAt(0) ?? 0;
      if (vsRun >= 2 || (cp >= 0xe0100 && !(prevCp >= 0x3400 && prevCp <= 0x2ffff))) kinds.add('stacked variation selectors');
      continue;
    }
    vsRun = 0;
    if (isTag(cp)) {
      if (cp === 0xe007f) continue;
      let j = i;
      while (j > 0 && isTag((chars[j - 1] ?? '').codePointAt(0) ?? 0)) j--;
      if (((chars[j - 1] ?? '').codePointAt(0) ?? 0) === 0x1f3f4) continue;
      kinds.add('Unicode tag characters (text a reader cannot see)');
      continue;
    }
    if (BIDI_SET.has(cp)) {
      bidi = true;
      continue;
    }
    if (ZW_SET.has(cp)) {
      const benign =
        (cp === 0xfeff && firstLine && i === 0) ||
        (cp === 0x200d && isEmojiContext(prev) && isEmojiContext(next)) ||
        ((cp === 0x200c || cp === 0x200d) && prev !== undefined && NON_ASCII_LETTER.test(prev) && (prev.codePointAt(0) ?? 0) > 0x2ff);
      if (benign) {
        zwRun = 0;
        continue;
      }
      zwRun++;
      if (zwRun >= ZW_RUN) kinds.add('a run of zero-width characters');
      continue;
    }
    zwRun = 0;
  }
  if (bidi && !benignBidi(line)) kinds.add('bidirectional control characters');
  return [...kinds];
}

const TIER_A: readonly RegExp[] = OVERRIDE_PHRASES.slice(0, 6);
const TIER_B: readonly RegExp[] = OVERRIDE_PHRASES.slice(6);
const ADDRESSEE = /\b(?:you|your|assistant|ai|agent|model|llm|claude|codex|gemini|copilot|chatgpt)\b/i;
const INTRODUCED = /(?:such\s+as|like|e\.g\.|for\s+example|for\s+instance|phrases?|strings?|payloads?|known\s+as|called|says?|reads?|containing|contains|text)\s*[:,]?\s*$/i;
const META = /\b(?:prompt[\s-]+injections?|jailbreaks?|injection\s+attacks?)\b/i;
const QUOTES: readonly [string, string][] = [['"', '"'], ["'", "'"], ['`', '`'], ['\u201c', '\u201d'], ['\u2018', '\u2019'], ['\u00ab', '\u00bb'], ['/', '/']];

/** Most extra characters a quotation may hold around the phrase and still count as quoting it (a JSON value or a long quoted message is not). */
const QUOTE_SLACK = 30;

/** True when the match at [start, end) is quoted on its line: a pair of quotes wrapped closely around it. */
function quoted(line: string, start: number, end: number): boolean {
  for (const [open, close] of QUOTES) {
    const o = line.lastIndexOf(open, start - 1);
    if (o === -1) continue;
    const c = line.indexOf(close, end);
    if (c === -1 || c - o - 1 > end - start + QUOTE_SLACK) continue;
    if (open !== close || countOf(line.slice(0, o), open) % 2 === 0) return true;
  }
  return false;
}

function countOf(s: string, ch: string): number {
  return s.split(ch).length - 1;
}

/** A visible phrase match that is discussion, not instruction: quoted, introduced as an example, or on a line about prompt injection. */
function discussed(line: string, m: RegExpExecArray): boolean {
  const start = m.index;
  const end = start + m[0].length;
  if (quoted(line, start, end)) return true;
  if (INTRODUCED.test(line.slice(Math.max(0, start - 50), start))) return true;
  return META.test(line);
}

function phraseMatch(line: string, strict: boolean): RegExpExecArray | null {
  for (const p of TIER_A) {
    const m = p.exec(line);
    if (m !== null && (strict || !discussed(line, m))) return m;
  }
  if (!ADDRESSEE.test(line)) return null;
  for (const p of TIER_B) {
    const m = p.exec(line);
    if (m !== null && (strict || !discussed(line, m))) return m;
  }
  return null;
}

/** Patterns for text a reader does not see (an HTML comment body, a decoded payload): addressed to the agent. */
const DIRECTED: readonly RegExp[] = [
  ...OVERRIDE_PHRASES,
  /\b(?:ignore|disregard|forget)\b[^.\n]{0,60}\b(?:instructions?|prompts?|system\s+prompt|your\s+rules)\b/i,
  /\b(?:ai|assistant|llm|language\s+model|claude|codex|gemini|copilot|chatgpt|coding\s+agent|ai\s+agent)s?\b[\s,:]{0,3}(?:[^.\n]{0,20}\s)?(?:must|should|shall|will|need\s+to|have\s+to|are\s+to|is\s+to|please)\b/i,
  /^\s*(?:ai|assistant|llm|claude|codex|gemini|agent)\s*[:,]/im,
  /\b(?:do\s+not|don't|never)\s+(?:tell|mention|reveal|show|inform|notify)\s+(?:this\s+to\s+)?(?:the\s+)?(?:user|human|developer|anyone)\b/i,
  /\b(?:system\s+prompt|hidden\s+instructions?|secret\s+instructions?)\b/i,
];

const PAYLOAD: readonly RegExp[] = [
  ...DIRECTED,
  /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/i,
  /\b(?:curl|wget|nc|ncat)\b[^\n]*(?:~\/\.ssh|\.aws\/credentials|\bid_rsa\b|\.env\b)/i,
  /(?:~\/\.ssh|\.aws\/credentials|\bid_rsa\b|\.env\b)[^\n]*\|\s*(?:curl|wget|nc|ncat)\b/i,
];

function lineAt(starts: readonly number[], index: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  const re = /\r\n|\r|\n|\u2028|\u2029/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) starts.push(m.index + m[0].length);
  return starts;
}

const BASE64 = /[A-Za-z0-9+/_-]{32,}={0,2}/g;

const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/;

/** A token-shaped value that is a placeholder, not a key: the word EXAMPLE, or one character repeated eight times. */
function placeholder(token: string): boolean {
  return /example/i.test(token) || /(.)\1{7,}/.test(token);
}

/** Lines holding a vendor token shape (the install scanner's redaction list) or a private key block. */
function secretLines(lines: readonly string[]): number[] {
  const out: number[] = [];
  lines.forEach((line, i) => {
    if (PRIVATE_KEY.test(line)) {
      out.push(i + 1);
      return;
    }
    for (const p of TOKEN_PATTERNS) {
      const re = new RegExp(p.source, p.flags.replace('g', ''));
      const m = re.exec(line);
      if (m !== null && !placeholder(m[0])) {
        out.push(i + 1);
        return;
      }
    }
  });
  return out;
}

function decodedText(candidate: string): string | null {
  let body = candidate.slice(0, MAX_ENCODED_CHARS).replace(/=+$/, '');
  if (body.length % 4 === 1) body = body.slice(0, -1);
  if (body.length < 24) return null;
  const padded = body + '='.repeat((4 - (body.length % 4)) % 4);
  const buf = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (buf.length < 16) return null;
  let printable = 0;
  for (const b of buf) if ((b >= 0x20 && b < 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d) printable++;
  return printable / buf.length >= 0.9 ? buf.toString('latin1') : null;
}

interface Part {
  text: string;
  /** Line numbers are reported for the head only. */
  numbered: boolean;
}

function partsOf(text: string, maxBytes: number): { parts: Part[]; total: number; scanned: number; truncated: boolean } {
  const total = Buffer.byteLength(text, 'utf8');
  if (total <= maxBytes) return { parts: [{ text, numbered: true }], total, scanned: total, truncated: false };
  const buf = Buffer.from(text, 'utf8');
  const half = Math.floor(maxBytes / 2);
  const head = buf.subarray(0, half).toString('utf8');
  const tail = buf.subarray(buf.length - half).toString('utf8');
  return { parts: [{ text: head, numbered: true }, { text: tail, numbered: false }], total, scanned: half * 2, truncated: true };
}

/**
 * Scans text for instructions hidden from a human reader. Pure: no I/O, no clock. At most `maxBytes` bytes are read
 * (the first and the last half of a longer text). The result never contains the scanned text.
 */
export function scanInbound(text: string, opts: InboundScanOptions = {}): InboundScan {
  const maxBytes = Math.max(1024, Math.floor(opts.maxBytes ?? INBOUND_SCAN_DEFAULT_MAX_BYTES));
  const { parts, total, scanned, truncated } = partsOf(text, maxBytes);
  const findings: InboundFinding[] = [];
  const seen = new Set<string>();
  const add = (rule: InboundRule, strength: InboundStrength, line: number | null, what: string): void => {
    const key = `${rule}|${line ?? '-'}|${what}`;
    if (seen.has(key) || findings.length >= MAX_FINDINGS) return;
    seen.add(key);
    findings.push({ rule, strength, line, what });
  };
  for (const part of parts) {
    const num = (n: number): number | null => (part.numbered ? n : null);
    const lines = part.text.split(/\r\n|\r|\n|\u2028|\u2029/);
    let inFence = false;
    lines.forEach((raw, i) => {
      for (const kind of hiddenKinds(raw, i === 0 && part.numbered)) add('inbound.hidden-characters', 'strong', num(i + 1), kind);
      if (/^\s*(```|~~~)/.test(raw)) {
        inFence = !inFence;
        return;
      }
      const visible = stripInvisible(raw);
      if (visible !== raw && phraseMatch(raw, true) === null && phraseMatch(visible, true) !== null) {
        add('inbound.split-phrase', 'strong', num(i + 1), 'an instruction phrase broken up by hidden characters');
        return;
      }
      if (!inFence && phraseMatch(visible, false) !== null) add('inbound.instruction-phrase', 'weak', num(i + 1), 'an instruction-override phrase');
    });
    if (opts.secrets === true) for (const n of secretLines(lines)) add('inbound.secret-shape', 'strong', num(n), 'a secret-shaped value (an access token or a private key)');
    const starts = lineStarts(part.text);
    const comment = /<!--([\s\S]*?)-->/g;
    let m: RegExpExecArray | null;
    while ((m = comment.exec(part.text)) !== null) {
      const body = stripInvisible((m[1] ?? '').slice(0, MAX_COMMENT_CHARS));
      if (DIRECTED.some((p) => p.test(body))) add('inbound.html-comment', 'strong', num(lineAt(starts, m.index)), 'an HTML comment (invisible when rendered) addressed to the agent');
    }
    let candidates = 0;
    BASE64.lastIndex = 0;
    while ((m = BASE64.exec(part.text)) !== null && candidates < MAX_ENCODED_CANDIDATES) {
      if (/data:[\w.+-]+\/[\w.+-]+;base64,$/i.test(part.text.slice(Math.max(0, m.index - 64), m.index))) continue;
      if (!/[0-9+/=_-]/.test(m[0]) || !/[a-z]/.test(m[0]) || !/[A-Z]/.test(m[0])) continue;
      candidates++;
      const decoded = decodedText(m[0]);
      if (decoded !== null && PAYLOAD.some((p) => p.test(decoded))) add('inbound.encoded-instruction', 'strong', num(lineAt(starts, m.index)), 'base64 text that decodes to instructions or a command');
    }
  }
  return { findings, strong: findings.some((f) => f.strength === 'strong'), bytesTotal: total, bytesScanned: scanned, truncated };
}

/** Collects the string values of a tool result (any JSON shape), depth-first, up to `maxChars` characters in all. */
export function textOfResult(value: unknown, maxChars: number = 4 * INBOUND_SCAN_DEFAULT_MAX_BYTES): string {
  const out: string[] = [];
  let size = 0;
  const walk = (v: unknown, depth: number): void => {
    if (size >= maxChars || depth > 8) return;
    if (typeof v === 'string') {
      if (v === '') return;
      const piece = v.slice(0, maxChars - size);
      out.push(piece);
      size += piece.length + 1;
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v.slice(0, 1000)) walk(x, depth + 1);
      return;
    }
    if (typeof v === 'object' && v !== null) for (const x of Object.values(v as Record<string, unknown>).slice(0, 1000)) walk(x, depth + 1);
  };
  walk(value, 0);
  return out.join('\n');
}
