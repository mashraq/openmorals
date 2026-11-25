// What the outbound guard reads out of text (0.20.0): URLs and their hosts, e-mail addresses, the addresses on a mail's
// From, To, Cc and Sender lines, one-time codes next to the words that name them, links whose shown text names another
// site than their target, a browser tool's "Page URL" line and the snapshot references of password and code fields.
// Every pattern has bounded repeats; every list is capped. Nothing read here is kept as text: the caller hashes it.
import { normalHost, siteOf } from './domain.js';

/** The most of one text these readers look at (the first and the last half when it is longer). */
export const READ_MAX_CHARS = 262144;
/** The most items one reader returns from one text. */
export const READ_MAX_ITEMS = 200;

export function bounded(text: string): string {
  if (text.length <= READ_MAX_CHARS) return text;
  const half = READ_MAX_CHARS / 2;
  return `${text.slice(0, half)}\n${text.slice(text.length - half)}`;
}

const URL_RE = /\b(?:https?|ftp|wss?):\/\/[^\s"'<>()[\]{}`\\]{1,2048}/gi;
const ADDRESS_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,63}\b/g;
const BARE_HOST_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,8}[a-z]{2,63}\b/gi;

/** The hosts (ASCII form) of the http, https, ftp and websocket URLs in a text, each once. */
export function urlHosts(text: string): string[] {
  const out = new Set<string>();
  for (const m of bounded(text).matchAll(URL_RE)) {
    const h = hostOfUrl(m[0]);
    if (h !== null) out.add(h);
    if (out.size >= READ_MAX_ITEMS) break;
  }
  return [...out];
}

/** The host of a URL, in ASCII form, or null when it has none. */
export function hostOfUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.hostname === '' ? null : normalHost(u.hostname);
  } catch {
    return null;
  }
}

/** The e-mail addresses in a text, lower case, each once. */
export function addressesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of bounded(text).matchAll(ADDRESS_RE)) {
    out.add(m[0].toLowerCase());
    if (out.size >= READ_MAX_ITEMS) break;
  }
  return [...out];
}

/** The domain of an address, ASCII form, or null. */
export function addressDomain(addr: string): string | null {
  const at = addr.lastIndexOf('@');
  return at < 0 ? null : normalHost(addr.slice(at + 1));
}

const HEADER_RE = /(?<![\w-])["']?(from|to|cc|sender)\b["']?[ \t]*[:=][ \t]*(\[[^\]]{0,4000}\]|"[^"\n]{0,1000}"|[^\n]{0,1000})/gi;
const RECIPIENT_LINE_RE = /(?<![\w-])["']?(?:to|cc|bcc)\b["']?[ \t]*[:=][ \t]*(?:\[[^\]]{0,4000}\]|"[^"\n]{0,1000}"|[^\n]{0,1000})/gi;

/**
 * The addresses on a message's From, To, Cc and Sender lines (a mail header, or the same names as keys in a tool's JSON
 * result). Reply-To is left out on purpose: an address only there is not a participant of the thread.
 */
export function headerAddresses(text: string): string[] {
  const out = new Set<string>();
  for (const m of bounded(text).matchAll(HEADER_RE)) {
    for (const a of addressesIn(m[2] ?? '')) out.add(a);
    if (out.size >= READ_MAX_ITEMS) break;
  }
  return [...out];
}

const CODE_WORDS = /\b(?:verification|security|login|log-in|sign[- ]?in|authenti[a-z]*|confirm[a-z]*|one[- ]?time|otp|2fa|mfa|two[- ]?factor|passcode|access)\b|\bcode is\b|\byour code\b|\bpin\b/i;
const DIGIT_RUN = /(?<![\d.,+\w-])(\d{3,4}[ -]\d{3,4}|\d{4,8})(?![\d\w]|[.,]\d)/g;

/** The digits of a value typed into a field when it reads as a code (4 to 8 digits, one space or dash allowed), else null. */
export function codeDigits(value: string): string | null {
  const v = value.trim();
  if (!/^(\d{3,4}[ -]\d{3,4}|\d{4,8})$/.test(v)) return null;
  const d = v.replace(/[ -]/g, '');
  return d.length >= 4 && d.length <= 8 ? d : null;
}

/** One-time codes in a text: 4 to 8 digits with a word that names a code (verification, sign-in, one-time, OTP ...) within 60 characters before or 30 after. */
export function codesIn(text: string): string[] {
  const t = bounded(text);
  const out = new Set<string>();
  for (const m of t.matchAll(DIGIT_RUN)) {
    const i = m.index ?? 0;
    const near = t.slice(Math.max(0, i - 60), Math.min(t.length, i + m[0].length + 30));
    if (!CODE_WORDS.test(near)) continue;
    const d = codeDigits(m[0]);
    if (d !== null) out.add(d);
    if (out.size >= 16) break;
  }
  return [...out];
}

/**
 * The registrable domains a message names: of its URLs, its addresses and its bare host names, leaving out its To, Cc and
 * Bcc lines (the reader's own address does not name the site a code is for).
 */
export function namedSites(textIn: string): string[] {
  const text = bounded(textIn).replace(RECIPIENT_LINE_RE, ' ');
  const out = new Set<string>();
  for (const h of urlHosts(text)) out.add(siteOf(h));
  for (const a of addressesIn(text)) {
    const d = addressDomain(a);
    if (d !== null) out.add(siteOf(d));
  }
  for (const m of bounded(text).matchAll(BARE_HOST_RE)) {
    const h = normalHost(m[0]);
    if (h !== null) out.add(siteOf(h));
    if (out.size >= READ_MAX_ITEMS) break;
  }
  return [...out];
}

/** The hosts a person typed: of URLs, of addresses, and bare host names (`example.org`), ASCII form. */
export function typedHosts(text: string): string[] {
  const out = new Set<string>(urlHosts(text));
  for (const a of addressesIn(text)) {
    const d = addressDomain(a);
    if (d !== null) out.add(d);
  }
  for (const m of bounded(text).matchAll(BARE_HOST_RE)) {
    const h = normalHost(m[0]);
    if (h !== null) out.add(h);
    if (out.size >= READ_MAX_ITEMS) break;
  }
  return [...out];
}

/** Digit runs of 4 to 8 a person typed (so a code the user gives the agent is never taken for one relayed from a message). */
export function typedCodes(text: string): string[] {
  const out = new Set<string>();
  for (const m of bounded(text).matchAll(DIGIT_RUN)) {
    const d = codeDigits(m[0]);
    if (d !== null) out.add(d);
    if (out.size >= 32) break;
  }
  return [...out];
}

const ANCHOR_RE = /<a\b[^>]{0,500}?\bhref[ \t]*=[ \t]*["']([^"'<>]{1,2048})["'][^>]{0,500}>([^<]{1,300})<\/a>/gi;
const MD_LINK_RE = /\[([^\]\n]{1,300})\]\(([^)\s]{1,2048})\)/g;

function shownSite(text: string): string | null {
  const t = text.trim();
  const u = /^(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,8}[a-z]{2,63})(?:[/:?#]\S*)?$/i.exec(t);
  if (u === null || u[1] === undefined) return null;
  const h = normalHost(u[1]);
  return h === null ? null : siteOf(h);
}

/** A link whose shown text is a host name or URL on another registrable domain than its target. */
export interface MismatchedLink {
  shown: string;
  target: string;
}

/** HTML anchors and Markdown links whose shown text names one site and whose target is on another. */
export function mismatchedLinks(text: string): MismatchedLink[] {
  const t = bounded(text);
  const out: MismatchedLink[] = [];
  const add = (href: string, label: string): void => {
    const shown = shownSite(label);
    if (shown === null) return;
    const host = hostOfUrl(href.trim());
    if (host === null) return;
    if (siteOf(host) === shown) return;
    if (!out.some((x) => x.target === host && x.shown === shown)) out.push({ shown, target: host });
  };
  for (const m of t.matchAll(ANCHOR_RE)) {
    add(m[1] ?? '', m[2] ?? '');
    if (out.length >= 64) return out;
  }
  for (const m of t.matchAll(MD_LINK_RE)) {
    add(m[2] ?? '', m[1] ?? '');
    if (out.length >= 64) return out;
  }
  return out;
}

const PAGE_URL_RE = /(?:^|\n)[ \t]*(?:[-*][ \t]*)?Page URL:[ \t]*(\S{1,2048})/i;

/** The page a browser tool reports it is on ("Page URL: ..." in its result), or null. */
export function pageUrlIn(text: string): string | null {
  const m = PAGE_URL_RE.exec(bounded(text));
  return m === null || m[1] === undefined ? null : m[1];
}

/** Words that make a field a password or code field, in a field's label, name, description or key. */
export const CREDENTIAL_FIELD = /pass(?:word|code|phrase)?\b|passwd|\bpwd\b|\bpin\b|one[- ]?time|\botp\b|\b2fa\b|\bmfa\b|verification|security[ _-]?(?:code|answer|question)|auth(?:entication)?[ _-]?code|log[- ]?in[ _-]?code|sign[- ]?in[ _-]?code|\bcvv\b|\bcvc\b|\bcsc\b|\bsecret\b/i;

const SNAPSHOT_FIELD_RE = /\b(textbox|searchbox|combobox|spinbutton)[ \t]+"([^"\n]{0,160})"[^\n[]{0,80}\[ref=([A-Za-z0-9_-]{1,24})\]/g;

/** The references of the password and code fields in a browser snapshot (`textbox "Password" [ref=e12]`). */
export function credentialRefs(text: string): string[] {
  const out = new Set<string>();
  for (const m of bounded(text).matchAll(SNAPSHOT_FIELD_RE)) {
    if (CREDENTIAL_FIELD.test(m[2] ?? '')) out.add(m[3] ?? '');
    if (out.size >= 64) break;
  }
  out.delete('');
  return [...out];
}
