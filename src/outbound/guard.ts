// The outbound guard (0.20.0): where a form, a message or a link sends data, judged from the action alone (and, inside a
// hook, from what this session has seen). No network call, no DNS lookup, no model: the reason line is the only text.
//
// Signals:
// - S1: a password, passcode or one-time code typed into a field (its label, its snapshot reference or the value's shape);
// - S2: the site a form is on is not one the user listed for that credential or data class;
// - S3: a look-alike host (UTS #39 skeleton, edit distance, a listed site as a subdomain, mixed script, an ASCII look-alike,
//   user@host) or a raw IP host;
// - S4: the host first appeared in untrusted output and was not typed by the person;
// - S5: a link whose shown text names another site, a blind copy, a new outside recipient on a reply, or a recipient seen
//   only inside untrusted output;
// - S6: a code seen in a message, typed into a site the message did not name;
// - S7: a javascript:, data:, vbscript: or file: URL, an executable or macro-document download, a link-local or (from
//   untrusted output) private address.
// Two combinations deny (user-level file may make them ask): S1 into a look-alike of a listed site, and S6. Everything else
// asks, once per destination and field in a session once the person has approved it in the host's own dialog.
import type { Finding, Guard, GuardContext } from '../guard.js';
import type { DetectorName } from '../rules/detectors.js';
import { detectCount } from '../rules/detectors.js';
import { reachesNetwork } from '../network.js';
import type { Action, ArgLeaf, Bylaws, DataClass, DataClassBylaws, Decision, OutboundBylaws } from '../types.js';
import { DATA_CLASSES, decisionRank } from '../types.js';
import type { OutboundMemory } from './memory.js';
import { addressInHeaders, addressMentioned, addressTyped, approvedKey, codeNamed, codeTyped, isDeceptive, recentCode, seenIn, wasTyped } from './memory.js';
import type { ListedLookalike } from './domain.js';
import { addressKind, hostListed, intrinsicLookalike, isLocalhostName, listedLookalike, normalHost, shownHost, siteOf } from './domain.js';
import { CREDENTIAL_FIELD, addressDomain, addressesIn, codeDigits, mismatchedLinks } from './read.js';

export const DEFAULT_CODE_MINUTES = 10;

export function defaultOutboundBylaws(): OutboundBylaws {
  return { credential: 'ask', lookalike: 'ask', ip_host: 'ask', dangerous_target: 'ask', link_mismatch: 'ask', recipient: 'ask', lookalike_credential: 'deny', code_relay: 'deny', code_minutes: DEFAULT_CODE_MINUTES };
}

/** The detectors each data class is found by. */
export const DATA_CLASS_DETECTORS: Readonly<Record<DataClass, readonly DetectorName[]>> = Object.freeze({
  card: ['card-number'],
  bank: ['iban'],
  national_id: ['us-ssn', 'nhs-number'],
  health: ['hl7-msh', 'fhir-patient'],
  email: ['email'],
  phone: ['phone-e164'],
});

/** A class left out of `data_classes`: card, bank, national-id and health data ask; e-mail addresses and phone numbers do not (typing your own into a form is everyday). */
export function defaultDataClass(c: DataClass): DataClassBylaws {
  return { decision: c === 'email' || c === 'phone' ? 'allow' : 'ask', sites: [] };
}

export function outboundSettings(b: Bylaws): OutboundBylaws {
  return b.guards.outbound ?? defaultOutboundBylaws();
}

export function dataClassSettings(b: Bylaws, c: DataClass): DataClassBylaws {
  return b.data_classes?.[c] ?? defaultDataClass(c);
}

/** The rule ids this guard reports. */
export type OutboundRule = 'outbound.credential-lookalike' | 'outbound.code-relay' | 'outbound.credential' | 'outbound.private-data' | 'outbound.lookalike' | 'outbound.ip-host' | 'outbound.dangerous-target' | 'outbound.link-mismatch' | 'outbound.recipient';

/** A finding and the key that, once the person approves it, keeps it from asking again in this session (null: never kept). */
export interface Signal {
  finding: Finding;
  key: string | null;
}

interface Ctx {
  cfg: OutboundBylaws;
  bylaws: Bylaws;
  /** The person's `sites`: where a password, code or recipient goes without an ask. Read by the exemptions only. */
  sites: string[];
  /** The person's own names, `sites` then `protect` (0.23.0): their look-alikes are judged, and a host under one is never a look-alike. */
  own: string[];
  /** Names a project file added to `protect` (0.23.0): their look-alikes are judged, nothing is exempted by them. */
  added: string[];
  mem: OutboundMemory | null;
  now: number;
}

const STOP_ONLY = 'openmorals stops only the agent: you can type it yourself if it is right';

function toolWords(tool: string): string[] {
  return tool
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '');
}

const ENTRY_WORDS = new Set(['type', 'fill', 'input', 'enter', 'submit', 'form', 'autofill']);
const SEND_WORDS = new Set(['send', 'reply', 'respond', 'forward', 'fwd', 'share', 'invite']);
const REPLY_WORDS = new Set(['reply', 'respond', 'forward', 'fwd']);
const BROWSER_WORDS = new Set(['browser', 'playwright', 'puppeteer', 'chrome', 'devtools', 'selenium', 'webdriver', 'page', 'tab', 'navigate']);
const NAVIGATE_WORDS = new Set(['navigate', 'goto', 'open', 'visit', 'browse', 'load']);

/** True when a tool's name says it drives a browser. */
export function isBrowserTool(tool: string): boolean {
  return toolWords(tool).some((w) => BROWSER_WORDS.has(w));
}

/** True when a browser tool's name says it opens a page. */
export function isNavigateTool(tool: string): boolean {
  const w = toolWords(tool);
  return w.some((x) => BROWSER_WORDS.has(x)) && w.some((x) => NAVIGATE_WORDS.has(x));
}

function keyOf(leaf: ArgLeaf): string {
  for (let i = leaf.path.length - 1; i >= 0; i--) {
    const k = leaf.path[i] ?? '';
    if (!/^\d+$/.test(k)) return k.toLowerCase().replace(/[_-]/g, '');
  }
  return '';
}

const URL_KEYS = new Set(['url', 'uri', 'href', 'link', 'links', 'endpoint', 'targeturl', 'pageurl', 'location', 'website']);
const DESCRIPTOR_KEYS = new Set(['element', 'target', 'ref', 'name', 'label', 'selector', 'placeholder', 'id', 'field', 'fieldname', 'aria', 'arialabel', 'description', 'title', 'type', 'kind', 'role', 'inputtype']);
const VALUE_KEYS = new Set(['text', 'value', 'values', 'input', 'content', 'data', 'answer', 'keys']);
const META_KEYS = new Set(['submit', 'slowly', 'action', 'button', 'modifiers', 'doubleclick', 'timeout', 'delay', 'clear', 'tab', 'index', 'x', 'y', 'coordinate', 'width', 'height']);
const RECIPIENT_KEYS = new Set(['to', 'cc', 'bcc', 'recipient', 'recipients', 'email', 'emails', 'emailaddress', 'attendees', 'invitees', 'sharewith', 'with', 'replyto', 'toaddress', 'toaddresses']);
const ID_KEYS = ['ref', 'target', 'id', 'selector', 'name', 'element', 'label'];

/** The value a URL key holds as a URL: with a scheme as given; a bare host name gets https:// (a navigate tool accepts one). */
function urlValue(v: string): string | null {
  const t = v.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return t;
  if (/^(?:[a-z0-9-]{1,63}\.){1,8}[a-z]{2,63}(?:[:/?#]|$)/i.test(t)) return `https://${t}`;
  return null;
}

const EXECUTABLE = new Set(['exe', 'msi', 'msix', 'appx', 'dmg', 'pkg', 'scr', 'bat', 'cmd', 'com', 'ps1', 'vbs', 'vbe', 'wsf', 'hta', 'jar', 'apk', 'lnk', 'iso', 'docm', 'dotm', 'xlsm', 'xltm', 'xlam', 'pptm', 'potm', 'ppam']);

function q(host: string): string {
  return shownHost(host);
}

/** The list a look-alike's name came from, as the reason names it. */
function listName(site: string, x: Ctx): string {
  if (x.sites.includes(site)) return 'your sites list';
  if (x.own.includes(site)) return 'your protect list';
  return "the project file's protect list";
}

function lookalikeOf(host: string, x: Ctx): ListedLookalike | null {
  return listedLookalike(host, x.own, x.added);
}

function find(decision: Decision, rule: OutboundRule, reason: string, key: string | null): Signal[] {
  return decision === 'allow' ? [] : [{ finding: { decision, rule, reason }, key }];
}

/** The data classes found in a text whose setting is not allow, with the detectors' counts summed. */
function classesIn(text: string, x: Ctx): DataClass[] {
  const out: DataClass[] = [];
  for (const c of DATA_CLASSES) {
    if (dataClassSettings(x.bylaws, c).decision === 'allow') continue;
    if (DATA_CLASS_DETECTORS[c].some((d) => detectCount(d, text) > 0)) out.push(c);
  }
  return out;
}

const CLASS_NAMES: Readonly<Record<DataClass, string>> = Object.freeze({ card: 'a card number', bank: 'a bank account number (IBAN)', national_id: 'a national ID number', health: 'a health record', email: 'an e-mail address', phone: 'a phone number' });

function decodeLoose(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

/** Signals on one URL the agent opens, fetches or sends a request to. */
function judgeUrl(url: string, tool: string, x: Ctx, browser: boolean): Signal[] {
  const out: Signal[] = [];
  const raw = url.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1]?.toLowerCase() ?? null;
  if (scheme === 'javascript' || scheme === 'data' || scheme === 'vbscript' || (scheme === 'file' && browser)) {
    const what = scheme === 'file' ? 'reads a file on this machine instead of opening a page' : scheme === 'data' ? 'carries its own content instead of opening a site' : 'runs code instead of opening a page';
    out.push(...find(x.cfg.dangerous_target, 'outbound.dangerous-target', `${tool} opens a ${scheme}: URL, which ${what}`, `outbound.dangerous-target|${scheme}:`));
    return out;
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return out;
  }
  if (!['http:', 'https:', 'ftp:', 'ws:', 'wss:'].includes(u.protocol) || u.hostname === '') return out;
  const host = normalHost(u.hostname);
  if (host === null) return out;
  const kind = addressKind(host);
  const from = x.mem !== null ? seenIn(x.mem, host) : null;
  if (kind !== null) {
    if (kind === 'link-local') out.push(...find(x.cfg.dangerous_target, 'outbound.dangerous-target', `${tool} reaches ${host}, a link-local address (where cloud machines serve their own credentials)`, `outbound.dangerous-target|${host}`));
    else if (kind === 'private' && from !== null) out.push(...find(x.cfg.dangerous_target, 'outbound.dangerous-target', `${tool} reaches ${host}, an address on a private network, and the address first appeared in ${from} output, not from you`, `outbound.dangerous-target|${host}`));
    else if (kind === 'public') out.push(...find(x.cfg.ip_host, 'outbound.ip-host', `${tool} reaches ${host}, a raw IP address instead of a site name, so openmorals cannot say whose it is`, `outbound.ip-host|${host}`));
  } else if (!isLocalhostName(host)) {
    const la = lookalikeOf(host, x);
    if (la !== null) {
      const how = la.how === 'skeleton' ? 'it reads the same once look-alike letters are swapped' : la.how === 'distance' ? `${la.distance === 1 ? 'one character differs' : 'two characters differ'}` : `it puts ${la.site} in front of another site's name`;
      out.push(...find(x.cfg.lookalike, 'outbound.lookalike', `${tool} opens ${q(host)}, which looks like ${la.site} from ${listName(la.site, x)} but is not it (${how})`, `outbound.lookalike|${host}`));
    } else {
      const il = intrinsicLookalike(host);
      if (il !== null) {
        const how = il.how === 'mixed-script' ? `its name mixes letters of different scripts ("${il.label}")` : `its name "${il.label}" is written in other letters that read as "${il.as}"`;
        out.push(...find(x.cfg.lookalike, 'outbound.lookalike', `${tool} opens ${q(host)} (${host}): ${how}`, `outbound.lookalike|${host}`));
      }
    }
    if (x.mem !== null && isDeceptive(x.mem, host)) out.push(...find(x.cfg.link_mismatch, 'outbound.link-mismatch', `${tool} opens ${q(host)}, the target of a link whose shown text named another site`, `outbound.link-mismatch|${host}`));
  }
  if (u.username !== '' && u.password === '' && kind === null) out.push(...find(x.cfg.lookalike, 'outbound.lookalike', `${tool} opens a URL that puts "${decodeLoose(u.username).slice(0, 40)}@" before the site, so it opens ${q(host)}`, `outbound.lookalike|userinfo|${host}`));
  if (u.password !== '') out.push(...find(x.cfg.credential, 'outbound.credential', `${tool} sends a password inside the URL to ${q(host)}`, `outbound.credential|${siteOf(host)}|url-password`));
  const text = decodeLoose(`${u.pathname}${u.search}${u.hash}`);
  if (detectCount('secret-token', `${u.search}${u.hash}\n${text}`) > 0) out.push(...find(x.cfg.credential, 'outbound.credential', `${tool} sends a token-shaped value inside the URL to ${q(host)}`, `outbound.credential|${siteOf(host)}|url-token`));
  for (const c of classesIn(text, x)) {
    const cs = dataClassSettings(x.bylaws, c);
    if (hostListed(host, cs.sites)) continue;
    out.push(...find(cs.decision, 'outbound.private-data', `${tool} puts ${CLASS_NAMES[c]} in a URL to ${q(host)}, which is not a site you listed for it`, `outbound.private-data|${c}|${siteOf(host)}|url`));
  }
  const ext = /\.([a-z0-9]{2,5})$/i.exec(u.pathname)?.[1]?.toLowerCase();
  if (ext !== undefined && EXECUTABLE.has(ext)) out.push(...find(x.cfg.dangerous_target, 'outbound.dangerous-target', `${tool} downloads ${u.pathname.split('/').pop() ?? ''} from ${q(host)}: an executable or a document with macros (.${ext})`, `outbound.dangerous-target|${host}|${ext}`));
  return out;
}

interface Entry {
  value: string;
  descriptor: string;
  field: string;
  ref: string | null;
}

/** The values a form-entry tool types, each with the words that describe its field and an id for the field. */
function entriesOf(leaves: readonly ArgLeaf[]): Entry[] {
  const byParent = new Map<string, ArgLeaf[]>();
  for (const l of leaves) {
    const p = l.path.slice(0, -1).join('\u0000');
    const list = byParent.get(p);
    if (list === undefined) byParent.set(p, [l]);
    else list.push(l);
  }
  const out: Entry[] = [];
  for (const l of leaves) {
    const key = keyOf(l);
    if (DESCRIPTOR_KEYS.has(key) || META_KEYS.has(key) || URL_KEYS.has(key)) continue;
    const siblings = byParent.get(l.path.slice(0, -1).join('\u0000')) ?? [];
    const desc = siblings.filter((s) => DESCRIPTOR_KEYS.has(keyOf(s)) && s !== l).map((s) => s.value.slice(0, 200));
    if (!VALUE_KEYS.has(key)) desc.push(key);
    let field = '';
    let ref: string | null = null;
    for (const k of ID_KEYS) {
      const s = siblings.find((x) => keyOf(x) === k);
      if (s !== undefined) {
        field = s.value.slice(0, 60);
        if (k === 'ref' || k === 'target') ref = s.value;
        break;
      }
    }
    if (field === '') field = l.path.join('.').slice(0, 60);
    out.push({ value: l.value, descriptor: desc.join(' '), field, ref });
    if (out.length >= 200) break;
  }
  return out;
}

/** True when a call types into a form or submits one: its tool's name says so, or its `action` is `type` (also read by the release hold, 0.28.0). */
export function entryTool(tool: string, leaves: readonly ArgLeaf[]): boolean {
  if (toolWords(tool).some((w) => ENTRY_WORDS.has(w))) return true;
  return leaves.some((l) => keyOf(l) === 'action' && /^type$/i.test(l.value));
}

/** True when a tool's name says it sends, replies, forwards or shares a message (also read by the release hold, 0.28.0). */
export function isSendTool(tool: string): boolean {
  return toolWords(tool).some((w) => SEND_WORDS.has(w));
}

function firstUrl(leaves: readonly ArgLeaf[]): string | null {
  for (const l of leaves) {
    if (!URL_KEYS.has(keyOf(l))) continue;
    const u = urlValue(l.value);
    if (u !== null && /^https?:/i.test(u)) return u;
  }
  return null;
}

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.hostname === '' ? null : normalHost(u.hostname);
  } catch {
    return null;
  }
}

/** Signals on what a form-entry tool types: credentials (S1, S2, S3, S4, S6) and private data (data classes). */
function judgeEntry(tool: string, leaves: readonly ArgLeaf[], x: Ctx): Signal[] {
  const out: Signal[] = [];
  const inCall = firstUrl(leaves);
  const page = x.mem?.page;
  const dest = inCall !== null ? hostOf(inCall) : (page?.host ?? null);
  const via = dest !== null && page !== undefined && page.host === dest ? page : undefined;
  const destName = dest !== null ? q(dest) : '';
  for (const e of entriesOf(leaves)) {
    const digits = codeDigits(e.value);
    const code = digits !== null && x.mem !== null && !codeTyped(x.mem, digits) ? recentCode(x.mem, digits, x.now, x.cfg.code_minutes) : null;
    const credential = CREDENTIAL_FIELD.test(e.descriptor) || (e.ref !== null && x.mem !== null && x.mem.credRefs.includes(e.ref)) || detectCount('secret-token', e.value) > 0 || code !== null;
    const what = code !== null ? 'a one-time code' : 'a password or code';
    if (credential) {
      const key = `outbound.credential|${dest !== null ? siteOf(dest) : '(unknown page)'}|${e.field}`;
      if (dest === null) {
        out.push(...find(x.cfg.credential, 'outbound.credential', `${tool} types ${what} into a page whose address openmorals does not know (no page was opened through a browser tool in this session)`, key));
        continue;
      }
      const la = lookalikeOf(dest, x);
      // The look-alike and code-relay findings replace the sites check below, except where that check is stricter: a
      // name added to protect, or a code remembered for longer, must never turn the sites check's deny into an ask.
      let special: Decision | null = null;
      if (la !== null && la.how !== 'subdomain') {
        const how = la.how === 'skeleton' ? 'it reads the same once look-alike letters are swapped' : la.distance === 1 ? 'one character differs' : 'two characters differ';
        out.push({ finding: { decision: x.cfg.lookalike_credential, rule: 'outbound.credential-lookalike', reason: `${tool} types ${what} into ${destName}, which looks like ${la.site} from ${listName(la.site, x)} but is not it (${how}); ${STOP_ONLY}` }, key: x.cfg.lookalike_credential === 'ask' ? key : null });
        special = x.cfg.lookalike_credential;
      } else if (code !== null && code.named.length > 0 && x.mem !== null && !codeNamed(x.mem, code, dest)) {
        const mins = Math.max(0, Math.round((x.now - Date.parse(code.at)) / 60000));
        out.push({ finding: { decision: x.cfg.code_relay, rule: 'outbound.code-relay', reason: `${tool} types a one-time code seen in ${code.tool} output ${mins} minute${mins === 1 ? '' : 's'} ago into ${destName}, a site that message did not name; ${STOP_ONLY}` }, key: x.cfg.code_relay === 'ask' ? key : null });
        special = x.cfg.code_relay;
      }
      if (special !== null) {
        if (decisionRank(x.cfg.credential) > decisionRank(special)) {
          if (!hostListed(dest, x.sites)) out.push(...find(x.cfg.credential, 'outbound.credential', `${tool} types ${what} into ${destName}, which is not a site in your sites list`, key));
          else if (via?.via === 'untrusted') out.push(...find(x.cfg.credential, 'outbound.credential', `${tool} types ${what} into ${destName} (in your sites list), on a page opened from a link in ${via.source ?? 'untrusted'} output, not one you typed`, key));
        }
        continue;
      }
      if (!hostListed(dest, x.sites)) {
        const extra = la !== null ? `; it puts ${la.site} in front of another site's name` : '';
        const opened = via?.via === 'untrusted' ? `; the page was opened from a link in ${via.source ?? 'untrusted'} output` : '';
        out.push(...find(x.cfg.credential, 'outbound.credential', `${tool} types ${what} into ${destName}, which is not a site in your sites list${extra}${opened}`, key));
      } else if (via?.via === 'untrusted') {
        out.push(...find(x.cfg.credential, 'outbound.credential', `${tool} types ${what} into ${destName} (in your sites list), on a page opened from a link in ${via.source ?? 'untrusted'} output, not one you typed`, key));
      }
    }
    for (const c of classesIn(`${e.descriptor}: ${e.value}`, x)) {
      if (!DATA_CLASS_DETECTORS[c].some((d) => detectCount(d, e.value) > 0) && !/\d/.test(e.value)) continue;
      const cs = dataClassSettings(x.bylaws, c);
      const key = `outbound.private-data|${c}|${dest !== null ? siteOf(dest) : '(unknown page)'}|${e.field}`;
      if (dest === null) out.push(...find(cs.decision, 'outbound.private-data', `${tool} types ${CLASS_NAMES[c]} into a page whose address openmorals does not know`, key));
      else if (!hostListed(dest, cs.sites)) out.push(...find(cs.decision, 'outbound.private-data', `${tool} types ${CLASS_NAMES[c]} into ${destName}, which is not a site you listed for it${via?.via === 'untrusted' ? `; the page was opened from a link in ${via.source ?? 'untrusted'} output` : ''}`, key));
      else if (via?.via === 'untrusted') out.push(...find(cs.decision, 'outbound.private-data', `${tool} types ${CLASS_NAMES[c]} into ${destName} (a site you listed for it), on a page opened from a link in ${via.source ?? 'untrusted'} output`, key));
    }
  }
  return out;
}

interface Recipient {
  addr: string;
  bcc: boolean;
}

function recipientsOf(leaves: readonly ArgLeaf[]): Recipient[] {
  const out: Recipient[] = [];
  for (const l of leaves) {
    const key = keyOf(l);
    if (!RECIPIENT_KEYS.has(key)) continue;
    for (const a of addressesIn(l.value)) if (!out.some((r) => r.addr === a)) out.push({ addr: a, bcc: key === 'bcc' });
    if (out.length >= 100) break;
  }
  return out;
}

/** Signals on a message a send, reply, forward or share tool sends: recipients (S5), private data in it, links in it. */
function judgeSend(tool: string, leaves: readonly ArgLeaf[], x: Ctx): Signal[] {
  const recipients = recipientsOf(leaves);
  if (recipients.length === 0) return [];
  const out: Signal[] = [];
  const reply = toolWords(tool).some((w) => REPLY_WORDS.has(w));
  const domains = [...new Set(recipients.map((r) => addressDomain(r.addr)).filter((d): d is string => d !== null))];
  for (const r of recipients) {
    const d = addressDomain(r.addr);
    if (d === null) continue;
    if (hostListed(d, x.sites)) continue;
    if (x.mem !== null && (addressTyped(x.mem, r.addr) || wasTyped(x.mem, d))) continue;
    const key = `outbound.recipient|${r.addr}`;
    if (r.bcc) out.push(...find(x.cfg.recipient, 'outbound.recipient', `${tool} adds a blind copy to an address at ${q(d)}, which you did not type and is not one of your sites`, key));
    else if (x.mem !== null && addressMentioned(x.mem, r.addr) && !addressInHeaders(x.mem, r.addr)) out.push(...find(x.cfg.recipient, 'outbound.recipient', `${tool} sends to an address at ${q(d)} that appeared only inside the text of untrusted output in this session, not typed by you`, key));
    else if (reply && (x.mem === null || !addressInHeaders(x.mem, r.addr))) out.push(...find(x.cfg.recipient, 'outbound.recipient', `${tool} adds a new outside recipient at ${q(d)}: not on the messages read in this session, not typed by you, not one of your sites`, key));
  }
  const body = leaves.filter((l) => !RECIPIENT_KEYS.has(keyOf(l)));
  for (const c of classesIn(body.map((l) => l.value).join('\n'), x)) {
    const cs = dataClassSettings(x.bylaws, c);
    const outside = domains.filter((d) => !hostListed(d, cs.sites));
    if (outside.length === 0) continue;
    out.push(...find(cs.decision, 'outbound.private-data', `${tool} sends ${CLASS_NAMES[c]} to ${outside.slice(0, 3).map(q).join(', ')}${outside.length > 3 ? ` (+${outside.length - 3} more)` : ''}, not a site you listed for it`, `outbound.private-data|${c}|${outside.map(siteOf).sort().join(',')}|message`));
  }
  for (const l of body) {
    for (const m of mismatchedLinks(l.value)) out.push(...find(x.cfg.link_mismatch, 'outbound.link-mismatch', `${tool} sends a link that shows ${q(m.shown)} but opens ${q(m.target)}`, `outbound.link-mismatch|${m.target}`));
  }
  return out;
}

/** Every signal on one action, before approvals in this session are taken into account. */
export function outboundSignals(ctx: GuardContext): Signal[] {
  const view = ctx.where?.outbound;
  const norm = (l: readonly string[] | undefined): string[] => (l ?? []).map((s) => normalHost(s) ?? s);
  const sites = norm(ctx.bylaws.sites);
  const own = [...new Set([...sites, ...norm(ctx.bylaws.protect)])];
  const added = norm(ctx.bylaws.project_protect).filter((s) => !own.includes(s));
  const x: Ctx = { cfg: outboundSettings(ctx.bylaws), bylaws: ctx.bylaws, sites, own, added, mem: view !== undefined && view.memory.unreadable !== true ? view.memory : null, now: view?.now ?? Date.now() };
  const a: Action = ctx.action;
  const out: Signal[] = [];
  switch (a.kind) {
    case 'fetch':
      out.push(...judgeUrl(a.url, a.tool, x, isBrowserTool(a.tool)));
      break;
    case 'exec':
      if (ctx.parsed === null) break;
      for (const c of ctx.parsed.commands) {
        if (!reachesNetwork(c)) continue;
        for (const w of c.args) if (/^(?:https?|ftp|wss?):\/\//i.test(w)) out.push(...judgeUrl(w, c.name, x, false));
      }
      break;
    case 'other': {
      const leaves = a.leaves ?? [];
      if (leaves.length === 0) break;
      const browser = isBrowserTool(a.tool);
      for (const l of leaves) {
        if (!URL_KEYS.has(keyOf(l))) continue;
        const u = browser ? urlValue(l.value) : /^(?:https?|ftp|wss?):\/\//i.test(l.value.trim()) ? l.value.trim() : null;
        if (u !== null) out.push(...judgeUrl(u, a.tool, x, browser));
      }
      if (entryTool(a.tool, leaves)) out.push(...judgeEntry(a.tool, leaves, x));
      if (isSendTool(a.tool)) out.push(...judgeSend(a.tool, leaves, x));
      break;
    }
    default:
      break;
  }
  const seen = new Set<string>();
  return out.filter((s) => {
    const k = `${s.finding.rule}\u0000${s.key ?? s.finding.reason}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The approval keys of the asks on one action that the person has not approved yet (for the hook to record). */
export function outboundAskKeys(ctx: GuardContext): string[] {
  const mem = ctx.where?.outbound?.memory;
  return outboundSignals(ctx)
    .filter((s) => s.finding.decision === 'ask' && s.key !== null && (mem === undefined || !approvedKey(mem, s.key)))
    .map((s) => s.key as string);
}

export const outboundGuard: Guard = {
  id: 'outbound',
  isHard: () => false,
  evaluate(ctx: GuardContext): Finding[] {
    const mem = ctx.where?.outbound?.memory;
    return outboundSignals(ctx)
      .filter((s) => !(s.finding.decision === 'ask' && s.key !== null && mem !== undefined && mem.unreadable !== true && approvedKey(mem, s.key)))
      .map((s) => s.finding);
  },
};

