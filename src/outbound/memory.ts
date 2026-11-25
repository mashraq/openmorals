// What one session remembers for the outbound guard (0.20.0), kept in the session file beside the taint marks. Hosts,
// addresses, codes and approval keys are kept only as salted SHA-256 hashes cut to 16 hex characters; the one name kept
// in clear is the host of the page a browser tool is on (the same host the session history already records for the
// navigation), so a reason can name it. Page text, form values and secrets are never kept.
//
// A one-time code has 10^4 to 10^8 values, so its hash can be reversed by trying them all: what protects it is that it
// is dropped after `code_minutes` (10 by default) and that the session file is the user's own (mode 0600).
import { createHash, randomBytes } from 'node:crypto';
import { normalHost, siteOf } from './domain.js';
import { addressesIn, codesIn, credentialRefs, headerAddresses, hostOfUrl, mismatchedLinks, namedSites, pageUrlIn, typedCodes, typedHosts, urlHosts } from './read.js';

/** How the page the browser is on was reached: a host the person typed, a link that first appeared in untrusted output, or neither. */
export type PageVia = 'typed' | 'untrusted' | 'other';

export interface OutboundPage {
  /** The page's host, ASCII form. */
  host: string;
  via: PageVia;
  /** For `untrusted`: the tool whose output the link first appeared in. */
  source?: string;
  at: string;
}

export interface OutboundCode {
  /** Hash of the code's digits. */
  h: string;
  /** Hashes of the registrable domains the message holding it named. */
  named: string[];
  /** The tool whose output held it. */
  tool: string;
  at: string;
}

export interface OutboundPending {
  /** The host's id for the call, when it sent one. */
  id: string | null;
  tool: string;
  /** Hashes of the approval keys the call asked about. */
  keys: string[];
}

export interface OutboundMemory {
  /** Random per session; every hash below is salted with it. */
  salt: string;
  page?: OutboundPage;
  /** Snapshot references of the password and code fields on `page`. */
  credRefs: string[];
  /** Hosts (and their registrable domains) first seen in untrusted output, by hash, with the tool they were seen in. */
  seen: Record<string, string>;
  /** Hosts, registrable domains and addresses the person typed in a prompt, and the codes they typed, by hash. */
  typed: string[];
  /** Addresses that appeared anywhere in untrusted output. */
  mentioned: string[];
  /** Addresses on From, To, Cc and Sender lines of messages read in this session. */
  headers: string[];
  /** Hosts that a link's shown text disguised (the text named another site). */
  deceptive: string[];
  codes: OutboundCode[];
  /** Calls that were asked about and have not been seen to run. */
  pending: OutboundPending[];
  /** Hashes of approval keys the person approved in the host's own dialog (the call ran after the ask). */
  approved: string[];
  /** True when the saved memory could not be read: the guard then knows no page, no approval and no code. */
  unreadable?: boolean;
}

export const OUTBOUND_CAPS = Object.freeze({ seen: 512, typed: 256, mentioned: 256, headers: 256, deceptive: 64, codes: 16, credRefs: 64, pending: 8, approved: 128, keysPerCall: 32 });

/** The memory and the time it is judged at, as the guard receives them on `Where.outbound`. */
export interface OutboundView {
  memory: OutboundMemory;
  now: number;
}

export function newOutboundMemory(salt: string = randomBytes(8).toString('hex')): OutboundMemory {
  return { salt, credRefs: [], seen: {}, typed: [], mentioned: [], headers: [], deceptive: [], codes: [], pending: [], approved: [] };
}

export type HashKind = 'host' | 'addr' | 'code' | 'key';

export function hashOf(salt: string, kind: HashKind, value: string): string {
  return createHash('sha256').update(`${salt}\u0000${kind}\u0000${value}`).digest('hex').slice(0, 16);
}

function pushCapped(list: readonly string[], items: readonly string[], cap: number): string[] {
  const next = list.filter((x) => !items.includes(x));
  next.push(...items.filter((x, i) => items.indexOf(x) === i));
  return next.slice(-cap);
}

function hostHashes(salt: string, host: string): string[] {
  const out = [hashOf(salt, 'host', host)];
  const site = siteOf(host);
  if (site !== host) out.push(hashOf(salt, 'host', site));
  return out;
}

/** True when the person typed this host, or its registrable domain, in a prompt of this session. */
export function wasTyped(m: OutboundMemory, host: string): boolean {
  return hostHashes(m.salt, host).some((h) => m.typed.includes(h));
}

/** The tool in whose untrusted output this host (or its registrable domain) first appeared, when the person did not type it. */
export function seenIn(m: OutboundMemory, host: string): string | null {
  if (wasTyped(m, host)) return null;
  for (const h of hostHashes(m.salt, host)) {
    const tool = m.seen[h];
    if (tool !== undefined) return tool;
  }
  return null;
}

export function addressTyped(m: OutboundMemory, addr: string): boolean {
  return m.typed.includes(hashOf(m.salt, 'addr', addr.toLowerCase()));
}

export function addressMentioned(m: OutboundMemory, addr: string): boolean {
  return m.mentioned.includes(hashOf(m.salt, 'addr', addr.toLowerCase()));
}

export function addressInHeaders(m: OutboundMemory, addr: string): boolean {
  return m.headers.includes(hashOf(m.salt, 'addr', addr.toLowerCase()));
}

export function isDeceptive(m: OutboundMemory, host: string): boolean {
  return m.deceptive.includes(hashOf(m.salt, 'host', host));
}

export function codeTyped(m: OutboundMemory, digits: string): boolean {
  return m.typed.includes(hashOf(m.salt, 'code', digits));
}

/** The code seen in a message within `minutes` before `now` whose digits these are, or null. */
export function recentCode(m: OutboundMemory, digits: string, now: number, minutes: number): OutboundCode | null {
  const h = hashOf(m.salt, 'code', digits);
  for (const c of [...m.codes].reverse()) {
    const at = Date.parse(c.at);
    if (c.h === h && Number.isFinite(at) && now - at <= minutes * 60000 && now >= at - 60000) return c;
  }
  return null;
}

export function codeNamed(m: OutboundMemory, c: OutboundCode, host: string): boolean {
  return c.named.includes(hashOf(m.salt, 'host', siteOf(host)));
}

export function approvedKey(m: OutboundMemory, key: string): boolean {
  return m.approved.includes(hashOf(m.salt, 'key', key));
}

/** After a prompt: the hosts, addresses and codes the person typed. */
export function notePrompt(m: OutboundMemory, text: string): OutboundMemory {
  const items: string[] = [];
  for (const h of typedHosts(text)) items.push(...hostHashes(m.salt, h));
  for (const a of addressesIn(text)) items.push(hashOf(m.salt, 'addr', a));
  for (const c of typedCodes(text)) items.push(hashOf(m.salt, 'code', c));
  if (items.length === 0) return m;
  return { ...m, typed: pushCapped(m.typed, items, OUTBOUND_CAPS.typed) };
}

/** What a tool's result tells the guard. */
export interface ResultNote {
  tool: string;
  /** The tool's result (or error) text, or null. */
  text: string | null;
  /** True when the call reads untrusted content (a fetch, an MCP tool, a web search, a network command, a file outside the project). */
  untrusted: boolean;
  /** True when the tool drives a browser (its name says so). */
  browser: boolean;
  /** For a browser navigation that ran: the URL it was asked to open. */
  navigatedTo: string | null;
  /** True when the call ran (the host reported its outcome). */
  ran: boolean;
  /** The host's id for the call. */
  id: string | null;
  now: Date;
  codeMinutes: number;
}

function setPage(m: OutboundMemory, host: string, now: Date, inherit: OutboundPage | undefined): OutboundMemory {
  let via: PageVia = 'other';
  let source: string | undefined;
  if (wasTyped(m, host)) via = 'typed';
  else {
    const s = seenIn(m, host);
    if (s !== null) {
      via = 'untrusted';
      source = s;
    } else if (inherit !== undefined && inherit.via === 'untrusted') {
      via = 'untrusted';
      source = inherit.source;
    }
  }
  const page: OutboundPage = { host, via, at: now.toISOString() };
  if (source !== undefined) page.source = source;
  const keepRefs = m.page !== undefined && m.page.host === host;
  return { ...m, page, credRefs: keepRefs ? m.credRefs : [] };
}

/** After a tool ran: approvals of what it was asked about, the page a browser is on, and what untrusted output held. */
export function noteResult(mIn: OutboundMemory, n: ResultNote): OutboundMemory {
  let m = mIn;
  if (n.ran && m.pending.length > 0) {
    const idx = n.id !== null ? m.pending.findIndex((p) => p.id === n.id) : -1;
    const at = idx >= 0 ? idx : m.pending.map((p) => p.tool).lastIndexOf(n.tool);
    const p = at >= 0 ? m.pending[at] : undefined;
    if (p !== undefined) m = { ...m, pending: m.pending.filter((_, i) => i !== at), approved: pushCapped(m.approved, p.keys, OUTBOUND_CAPS.approved) };
  }
  const minutes = Math.max(1, n.codeMinutes);
  const fresh = m.codes.filter((c) => {
    const at = Date.parse(c.at);
    return Number.isFinite(at) && n.now.getTime() - at <= minutes * 60000;
  });
  if (fresh.length !== m.codes.length) m = { ...m, codes: fresh };
  const before = m.page;
  if (n.ran && n.browser && n.navigatedTo !== null) {
    const h = hostOfUrl(n.navigatedTo) ?? hostOfUrl(`https://${n.navigatedTo}`);
    if (h !== null) m = setPage(m, h, n.now, undefined);
  }
  const text = n.text;
  if (text === null || text === '') return m;
  if (n.browser) {
    const page = pageUrlIn(text);
    const h = page !== null ? hostOfUrl(page) : null;
    if (h !== null && (m.page === undefined || m.page.host !== h)) m = setPage(m, h, n.now, m.page ?? before);
    const refs = credentialRefs(text);
    if (refs.length > 0) m = { ...m, credRefs: pushCapped(m.credRefs, refs, OUTBOUND_CAPS.credRefs) };
  }
  const deceptive = mismatchedLinks(text).map((l) => hashOf(m.salt, 'host', l.target));
  if (deceptive.length > 0) m = { ...m, deceptive: pushCapped(m.deceptive, deceptive, OUTBOUND_CAPS.deceptive) };
  if (!n.untrusted || n.browser) return m;
  const seen: Record<string, string> = { ...m.seen };
  let added = 0;
  for (const host of urlHosts(text)) {
    for (const h of hostHashes(m.salt, host)) {
      if (seen[h] === undefined) {
        seen[h] = n.tool.slice(0, 80);
        added++;
      }
    }
  }
  if (added > 0) {
    const entries = Object.entries(seen);
    m = { ...m, seen: Object.fromEntries(entries.slice(-OUTBOUND_CAPS.seen)) };
  }
  const addrs = addressesIn(text).map((a) => hashOf(m.salt, 'addr', a));
  if (addrs.length > 0) m = { ...m, mentioned: pushCapped(m.mentioned, addrs, OUTBOUND_CAPS.mentioned) };
  const heads = headerAddresses(text).map((a) => hashOf(m.salt, 'addr', a));
  if (heads.length > 0) m = { ...m, headers: pushCapped(m.headers, heads, OUTBOUND_CAPS.headers) };
  const codes = codesIn(text);
  if (codes.length > 0) {
    const named = namedSites(text).map((s) => hashOf(m.salt, 'host', s));
    const at = n.now.toISOString();
    const add = codes.map((c): OutboundCode => ({ h: hashOf(m.salt, 'code', c), named: named.slice(0, 32), tool: n.tool.slice(0, 80), at }));
    m = { ...m, codes: [...m.codes.filter((c) => !add.some((a) => a.h === c.h)), ...add].slice(-OUTBOUND_CAPS.codes) };
  }
  return m;
}

/** Before a call the hook asked about: the approval keys it asked about, so that running it records them as approved. */
export function notePending(m: OutboundMemory, id: string | null, tool: string, keys: readonly string[]): OutboundMemory {
  if (keys.length === 0) return m;
  const hashed = [...new Set(keys)].slice(0, OUTBOUND_CAPS.keysPerCall).map((k) => hashOf(m.salt, 'key', k));
  const pending = [...m.pending.filter((p) => id === null || p.id !== id), { id, tool: tool.slice(0, 80), keys: hashed }].slice(-OUTBOUND_CAPS.pending);
  return { ...m, pending };
}

const HEX16 = /^[0-9a-f]{16}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function hashList(v: unknown, cap: number): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && HEX16.test(x))) return null;
  return (v as string[]).slice(-cap);
}

/** The saved memory, or a fresh one marked `unreadable` when it is malformed; absent stays absent. */
export function parseOutboundMemory(v: unknown): OutboundMemory | undefined {
  if (v === undefined) return undefined;
  const lost = (): OutboundMemory => ({ ...newOutboundMemory(), unreadable: true });
  if (!isObj(v) || typeof v['salt'] !== 'string' || !/^[0-9a-f]{8,64}$/.test(v['salt'])) return lost();
  const m = newOutboundMemory(v['salt']);
  for (const k of ['typed', 'mentioned', 'headers', 'deceptive', 'approved'] as const) {
    const l = hashList(v[k], OUTBOUND_CAPS[k]);
    if (l === null) return lost();
    m[k] = l;
  }
  const refs = v['credRefs'];
  if (refs !== undefined) {
    if (!Array.isArray(refs) || !refs.every((x) => typeof x === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(x))) return lost();
    m.credRefs = (refs as string[]).slice(-OUTBOUND_CAPS.credRefs);
  }
  const seen = v['seen'];
  if (seen !== undefined) {
    if (!isObj(seen) || !Object.entries(seen).every(([k, t]) => HEX16.test(k) && typeof t === 'string' && t.length <= 80)) return lost();
    m.seen = Object.fromEntries(Object.entries(seen as Record<string, string>).slice(-OUTBOUND_CAPS.seen));
  }
  const page = v['page'];
  if (page !== undefined) {
    if (!isObj(page) || typeof page['host'] !== 'string' || normalHost(page['host']) !== page['host'] || (page['via'] !== 'typed' && page['via'] !== 'untrusted' && page['via'] !== 'other') || typeof page['at'] !== 'string') return lost();
    m.page = { host: page['host'], via: page['via'], at: page['at'] };
    if (typeof page['source'] === 'string') m.page.source = page['source'].slice(0, 80);
  }
  const codes = v['codes'];
  if (codes !== undefined) {
    if (!Array.isArray(codes)) return lost();
    for (const c of codes as unknown[]) {
      if (!isObj(c) || typeof c['h'] !== 'string' || !HEX16.test(c['h']) || typeof c['tool'] !== 'string' || typeof c['at'] !== 'string') return lost();
      const named = hashList(c['named'], 32);
      if (named === null) return lost();
      m.codes.push({ h: c['h'], named, tool: c['tool'].slice(0, 80), at: c['at'] });
    }
    m.codes = m.codes.slice(-OUTBOUND_CAPS.codes);
  }
  const pending = v['pending'];
  if (pending !== undefined) {
    if (!Array.isArray(pending)) return lost();
    for (const p of pending as unknown[]) {
      if (!isObj(p) || (p['id'] !== null && typeof p['id'] !== 'string') || typeof p['tool'] !== 'string') return lost();
      const keys = hashList(p['keys'], OUTBOUND_CAPS.keysPerCall);
      if (keys === null) return lost();
      m.pending.push({ id: p['id'] === null ? null : String(p['id']).slice(0, 128), tool: p['tool'].slice(0, 80), keys });
    }
    m.pending = m.pending.slice(-OUTBOUND_CAPS.pending);
  }
  return m;
}

/** A session memory for a case row or a test, from plain words; hashes are taken with a fixed salt. */
export interface OutboundSketch {
  page?: string;
  via?: PageVia;
  source?: string;
  typed?: string[];
  seen?: Record<string, string>;
  mentioned?: string[];
  headers?: string[];
  deceptive?: string[];
  cred_refs?: string[];
  codes?: { code: string; named?: string[]; tool?: string; minutes_ago?: number }[];
  approved?: string[];
}

export function sketchMemory(s: OutboundSketch, now: Date, salt = '00000000'): OutboundMemory {
  let m = newOutboundMemory(salt);
  for (const t of s.typed ?? []) {
    if (t.includes('@')) m = { ...m, typed: [...m.typed, hashOf(salt, 'addr', t.toLowerCase())] };
    else if (/^\d+$/.test(t)) m = { ...m, typed: [...m.typed, hashOf(salt, 'code', t)] };
    else {
      const h = normalHost(t);
      if (h !== null) m = { ...m, typed: [...m.typed, ...hostHashes(salt, h)] };
    }
  }
  for (const [host, tool] of Object.entries(s.seen ?? {})) {
    const h = normalHost(host);
    if (h !== null) for (const x of hostHashes(salt, h)) m.seen[x] = tool;
  }
  m.mentioned = (s.mentioned ?? []).map((a) => hashOf(salt, 'addr', a.toLowerCase()));
  m.headers = (s.headers ?? []).map((a) => hashOf(salt, 'addr', a.toLowerCase()));
  m.deceptive = (s.deceptive ?? []).map((h) => hashOf(salt, 'host', normalHost(h) ?? h));
  m.credRefs = [...(s.cred_refs ?? [])];
  m.approved = (s.approved ?? []).map((k) => hashOf(salt, 'key', k));
  for (const c of s.codes ?? []) {
    m.codes.push({ h: hashOf(salt, 'code', c.code), named: (c.named ?? []).map((n) => hashOf(salt, 'host', siteOf(normalHost(n) ?? n))), tool: c.tool ?? 'mcp__mail__read', at: new Date(now.getTime() - (c.minutes_ago ?? 1) * 60000).toISOString() });
  }
  if (s.page !== undefined) {
    const h = hostOfUrl(s.page) ?? normalHost(s.page);
    if (h !== null) {
      m.page = { host: h, via: s.via ?? 'other', at: now.toISOString() };
      if (s.source !== undefined) m.page.source = s.source;
    }
  }
  return m;
}

