// Host names for the outbound guard (0.20.0): registrable domains from the bundled Public Suffix List, IP literals and
// what kind of address they are, UTS #39 skeletons over the bundled confusables subset, mixed-script labels, and the
// look-alike test against the user's own list of sites. Plain code over the name: no DNS lookup, no network call.
import { isIP } from 'node:net';
import { domainToASCII, domainToUnicode } from 'node:url';
import { CONFUSABLES_DATA } from './data/confusables.js';
import { PUBLIC_SUFFIX_DATA } from './data/public-suffix.js';

const NORMAL = 1;
const WILD = 2;
const EXCEPTION = 4;

let RULES: Map<string, number> | null = null;

function rules(): Map<string, number> {
  if (RULES !== null) return RULES;
  const m = new Map<string, number>();
  for (const line of PUBLIC_SUFFIX_DATA.split('\n')) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const tld = line.slice(0, colon);
    for (const rest of line.slice(colon + 1).split(',')) {
      let key: string;
      let flag: number;
      if (rest === '') {
        key = tld;
        flag = NORMAL;
      } else if (rest === '*.') {
        key = tld;
        flag = WILD;
      } else if (rest.startsWith('*.')) {
        key = `${rest.slice(2)}.${tld}`;
        flag = WILD;
      } else if (rest.startsWith('!')) {
        key = `${rest.slice(1)}.${tld}`;
        flag = EXCEPTION;
      } else {
        key = `${rest}.${tld}`;
        flag = NORMAL;
      }
      m.set(key, (m.get(key) ?? 0) | flag);
    }
  }
  RULES = m;
  return m;
}

/**
 * A host name in the form the guard compares: lower case, no trailing dot, internationalised labels in their ASCII
 * (punycode) form. Null when the name is empty or not a valid host name. IP literals are returned as given (IPv6 without
 * brackets).
 */
export function normalHost(host: string): string | null {
  let h = host.trim().toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === '') return null;
  if (isIP(h) !== 0) return h;
  if (h.length > 253) return null;
  const ascii = domainToASCII(h);
  if (ascii === '' || !/^[a-z0-9.-]+$/.test(ascii) || ascii.split('.').some((l) => l === '' || l.length > 63)) return null;
  return ascii;
}

/** The public suffix of an ASCII host (the PSL algorithm, with the default rule "*"). */
export function publicSuffix(host: string): string {
  const labels = host.split('.');
  const r = rules();
  for (let i = 0; i < labels.length; i++) {
    const cand = labels.slice(i).join('.');
    const flags = r.get(cand) ?? 0;
    if ((flags & EXCEPTION) !== 0) return labels.slice(i + 1).join('.');
    const parent = labels.slice(i + 1).join('.');
    if ((flags & NORMAL) !== 0 || (parent !== '' && ((r.get(parent) ?? 0) & WILD) !== 0)) return cand;
  }
  return labels[labels.length - 1] ?? host;
}

/**
 * The registrable domain of a host (its public suffix and one more label), in ASCII form; null for an IP literal, a
 * single-label name or a name that is itself a public suffix.
 */
export function registrableDomain(hostIn: string): string | null {
  const host = normalHost(hostIn);
  if (host === null || isIP(host) !== 0) return null;
  const suffix = publicSuffix(host);
  if (suffix === host) return null;
  const rest = host.slice(0, host.length - suffix.length - 1);
  const label = rest.split('.').pop();
  return label === undefined || label === '' ? null : `${label}.${suffix}`;
}

/** The registrable domain, or the host itself when there is none (an IP literal, `localhost`, a name under no rule). */
export function siteOf(host: string): string {
  const h = normalHost(host) ?? host.toLowerCase();
  return registrableDomain(h) ?? h;
}

export type AddressKind = 'loopback' | 'link-local' | 'private' | 'public';

function v4Kind(a: number, b: number): AddressKind {
  if (a === 127 || a === 0) return 'loopback';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return 'private';
  return 'public';
}

function expandV6(h: string): number[] | null {
  let s = h.split('%')[0] ?? h;
  const m = /^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (m !== null) {
    const o = m.slice(2, 6).map(Number);
    s = `${m[1] ?? ''}${(((o[0] ?? 0) << 8) | (o[1] ?? 0)).toString(16)}:${(((o[2] ?? 0) << 8) | (o[3] ?? 0)).toString(16)}`;
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const head = (parts[0] ?? '') === '' ? [] : (parts[0] ?? '').split(':').map((g) => parseInt(g, 16));
  const rest = parts.length === 2 && (parts[1] ?? '') !== '' ? (parts[1] ?? '').split(':').map((g) => parseInt(g, 16)) : [];
  if ([...head, ...rest].some((g) => Number.isNaN(g))) return null;
  const fill = 8 - head.length - rest.length;
  if (fill < 0 || (parts.length === 1 && fill !== 0)) return null;
  return [...head, ...new Array<number>(parts.length === 2 ? fill : 0).fill(0), ...rest];
}

/** What kind of address an IP literal is, or null for a name. Loopback includes 0.0.0.0/8 and ::; private includes 100.64/10 and fc00::/7. */
export function addressKind(hostIn: string): AddressKind | null {
  let h = hostIn.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  const fam = isIP(h);
  if (fam === 4) {
    const o = h.split('.').map(Number);
    return v4Kind(o[0] ?? 0, o[1] ?? 0);
  }
  if (fam !== 6) return null;
  const g = expandV6(h);
  if (g === null) return 'public';
  if (g.every((x) => x === 0) || (g.slice(0, 7).every((x) => x === 0) && g[7] === 1)) return 'loopback';
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4Kind((g[6] ?? 0) >> 8, (g[6] ?? 0) & 0xff);
  const first = g[0] ?? 0;
  if ((first & 0xffc0) === 0xfe80) return 'link-local';
  if (first === 0xfd00 && g[1] === 0x0ec2) return 'link-local';
  if ((first & 0xfe00) === 0xfc00) return 'private';
  return 'public';
}

/** True for `localhost` and names under it. */
export function isLocalhostName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost');
}

let CONFUSABLE: Map<string, string> | null = null;

function confusables(): Map<string, string> {
  if (CONFUSABLE !== null) return CONFUSABLE;
  const m = new Map<string, string>();
  for (const entry of CONFUSABLES_DATA.split('\u001f')) {
    const cp = entry.codePointAt(0);
    if (cp === undefined) continue;
    const ch = String.fromCodePoint(cp);
    m.set(ch, entry.slice(ch.length));
  }
  CONFUSABLE = m;
  return m;
}

/**
 * The UTS #39 skeleton of a string over the bundled subset (characters that look like ASCII letters and digits): NFD,
 * each character replaced by its prototype, NFD again; then lower case, so `0` and `O` meet `o` and `1` meets `l`.
 */
export function skeleton(s: string): string {
  const m = confusables();
  let out = '';
  for (const ch of s.normalize('NFD')) out += m.get(ch) ?? ch;
  out = out.normalize('NFD').toLowerCase();
  let again = '';
  for (const ch of out) again += m.get(ch) ?? ch;
  return again.normalize('NFD');
}

const SCRIPTS: readonly [string, RegExp][] = [
  ['Latin', /\p{Script=Latin}/u],
  ['Cyrillic', /\p{Script=Cyrillic}/u],
  ['Greek', /\p{Script=Greek}/u],
  ['Armenian', /\p{Script=Armenian}/u],
  ['Hebrew', /\p{Script=Hebrew}/u],
  ['Arabic', /\p{Script=Arabic}/u],
  ['Georgian', /\p{Script=Georgian}/u],
  ['Han', /\p{Script=Han}/u],
  ['Hiragana', /\p{Script=Hiragana}/u],
  ['Katakana', /\p{Script=Katakana}/u],
  ['Hangul', /\p{Script=Hangul}/u],
  ['Bopomofo', /\p{Script=Bopomofo}/u],
  ['Thai', /\p{Script=Thai}/u],
  ['Devanagari', /\p{Script=Devanagari}/u],
  ['Cherokee', /\p{Script=Cherokee}/u],
];
const NEUTRAL = /[\p{Script=Common}\p{Script=Inherited}]/u;
const ALLOWED_MIXES: readonly (readonly string[])[] = [
  ['Latin', 'Han', 'Hiragana', 'Katakana'],
  ['Latin', 'Han', 'Bopomofo'],
  ['Latin', 'Han', 'Hangul'],
];

/** The scripts the letters of a label are written in (Common and Inherited characters, such as digits and marks, left out). */
export function scriptsOf(label: string): Set<string> {
  const out = new Set<string>();
  for (const ch of label) {
    if (NEUTRAL.test(ch)) continue;
    const s = SCRIPTS.find(([, re]) => re.test(ch));
    out.add(s !== undefined ? s[0] : `other-${ch.codePointAt(0)?.toString(16) ?? '?'}`);
  }
  return out;
}

/** True when a label mixes scripts outside the combinations UTS #39 "highly restrictive" allows (Latin with Han and Japanese kana, Bopomofo or Hangul). */
export function mixedScript(label: string): boolean {
  const s = scriptsOf(label);
  if (s.size <= 1) return false;
  return !ALLOWED_MIXES.some((mix) => [...s].every((x) => mix.includes(x)));
}

export type IntrinsicLookalike = { how: 'mixed-script'; label: string } | { how: 'ascii-lookalike'; label: string; as: string };

/**
 * A look-alike that needs no list: a label that mixes scripts, or a label written in other letters whose skeleton is
 * plain ASCII (it reads as an ASCII name). An internationalised name in one script that does not pose as ASCII is not
 * one. Null when neither.
 */
export function intrinsicLookalike(asciiHost: string): IntrinsicLookalike | null {
  const uni = domainToUnicode(asciiHost);
  for (const label of uni.split('.')) {
    if (/^[\x00-\x7f]*$/.test(label)) continue;
    if (mixedScript(label)) return { how: 'mixed-script', label };
    const sk = skeleton(label);
    if (/^[a-z0-9-]+$/.test(sk)) return { how: 'ascii-lookalike', label, as: sk };
  }
  return null;
}

/** Optimal string alignment distance (insert, delete, substitute, swap two neighbours), stopping above `max`. */
export function editDistance(a: string, b: string, max: number): number {
  const x = [...a];
  const y = [...b];
  if (Math.abs(x.length - y.length) > max) return max + 1;
  const rows: number[][] = [];
  for (let i = 0; i <= x.length; i++) {
    const row: number[] = new Array<number>(y.length + 1).fill(0);
    row[0] = i;
    rows.push(row);
  }
  const r0 = rows[0];
  if (r0 !== undefined) for (let j = 0; j <= y.length; j++) r0[j] = j;
  for (let i = 1; i <= x.length; i++) {
    const row = rows[i] as number[];
    const prev = rows[i - 1] as number[];
    let best = Infinity;
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      let v = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) v = Math.min(v, ((rows[i - 2] as number[])[j - 2] ?? 0) + 1);
      row[j] = v;
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
  }
  return (rows[x.length] as number[])[y.length] ?? max + 1;
}

/** The edit distance a name of this many characters (its registrable label) may be from a listed site and count as a look-alike. */
export function distanceAllowed(labelLength: number): number {
  if (labelLength >= 9) return 2;
  if (labelLength >= 4) return 1;
  return 0;
}

export type ListedLookalike = { site: string; how: 'skeleton' } | { site: string; how: 'distance'; distance: number } | { site: string; how: 'subdomain' };

/** True when the host is a listed site or a name under it. */
export function hostListed(asciiHost: string, sites: readonly string[]): boolean {
  return sites.some((s) => asciiHost === s || asciiHost.endsWith(`.${s}`));
}

/**
 * Whether a host looks like one of the user's sites without being it or a name under it: the same UTS #39 skeleton
 * (`exarnple.test` and `example.test`), an edit distance of 1 or 2 by the name's length (`examp1e.test`, `exmaple.test`),
 * or a listed site used as a subdomain of another registrable domain (`example.test.login.invalid`). The first found
 * wins, in the order of the list.
 */
export function listedLookalike(asciiHost: string, sites: readonly string[]): ListedLookalike | null {
  if (sites.length === 0 || isIP(asciiHost) !== 0 || isLocalhostName(asciiHost)) return null;
  if (hostListed(asciiHost, sites)) return null;
  const reg = registrableDomain(asciiHost) ?? asciiHost;
  const regU = domainToUnicode(reg);
  const regSk = skeleton(regU);
  for (const site of sites) {
    const sReg = registrableDomain(site) ?? site;
    if (sReg === reg) continue;
    const sU = domainToUnicode(sReg);
    if (skeleton(sU) === regSk) return { site, how: 'skeleton' };
    const label = sU.split('.')[0] ?? sU;
    const max = distanceAllowed([...label].length);
    if (max > 0) {
      const d = editDistance(regU, sU, max);
      if (d <= max) return { site, how: 'distance', distance: d };
    }
    const sub = asciiHost.slice(0, Math.max(0, asciiHost.length - reg.length - 1));
    if (sub !== '' && (sub === sReg || sub.endsWith(`.${sReg}`) || sub.startsWith(`${sReg}.`) || sub.includes(`.${sReg}.`))) return { site, how: 'subdomain' };
  }
  return null;
}

/** The Unicode form of an ASCII host, for a reason a person reads. */
export function shownHost(asciiHost: string): string {
  const u = domainToUnicode(asciiHost);
  return u === '' ? asciiHost : u;
}
