// Handoff records (0.38.0): what one agent hands to another, recorded on the call's own audit line so a report can
// count it. The record holds the kind of handoff, a keyed fingerprint and the size of the text the scan saw, the
// sending session's taint when the call was judged, and labels for authority or consent claims in the text. Never the
// text itself. Nothing here changes a decision, adds an ask or marks the session: a claim is a label in the log, not a signal.
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuditHandoff, HandoffKind, SenderTaint } from '../audit.js';
import type { TaintState } from '../taint/index.js';
import type { Action } from '../types.js';
import { stripInvisible } from './scan.js';

/**
 * The kind of handoff each message tool makes (every tool in `MESSAGE_TOOLS`; a test checks the two lists agree).
 * `spawn`: starts an agent with a prompt. `message`: text to an agent or session already running. `handback`: a child's report to its parent.
 */
export const HANDOFF_KIND_OF: Readonly<Record<string, HandoffKind>> = Object.freeze({
  Agent: 'spawn',
  Task: 'spawn',
  SubagentHandback: 'handback',
  SendMessage: 'message',
  spawn_agent: 'spawn',
  send_input: 'message',
  send_message: 'message',
  followup_task: 'message',
  codebase_investigator: 'spawn',
  cli_help: 'spawn',
  generalist: 'spawn',
  browser_agent: 'spawn',
  task: 'spawn',
  subagent: 'spawn',
  sessions_spawn: 'spawn',
  sessions_create: 'spawn',
  sessions_send: 'message',
  conversations_send: 'message',
});

/** The sending session's taint as one word: `injected` if hidden instructions were found, else `untrusted` if untrusted content was read, else `clean`. */
export function senderTaint(t: TaintState | null | undefined): SenderTaint {
  if (t === null || t === undefined) return 'clean';
  if ((t.injectedCount ?? 0) > 0) return 'injected';
  if (t.untrustedCount > 0) return 'untrusted';
  return 'clean';
}

/**
 * Phrases that claim approval or authority on someone's behalf. A handed-on message cannot carry the person's consent,
 * so these are worth counting; they are matched after invisible characters are removed, and only label the record.
 */
export const AUTHORITY_CLAIMS: ReadonlyArray<{ label: string; pattern: RegExp }> = Object.freeze([
  { label: 'user-approved', pattern: /\b(?:the\s+)?(?:user|owner|human|person)\s+(?:has\s+|have\s+)?(?:already\s+)?(?:approved|confirmed|consented|agreed|signed\s+off)\b/i },
  { label: 'already-authorised', pattern: /\b(?:already|pre-?)\s*(?:approved|authori[sz]ed)\b/i },
  { label: 'no-need-to-ask', pattern: /\b(?:no\s+need\s+to|without|skip(?:ping)?)\s+(?:ask(?:ing)?|confirm(?:ing)?|(?:asking\s+for\s+|requesting\s+)?(?:permission|approval|confirmation))\b/i },
  { label: 'on-behalf', pattern: /\bon\s+behalf\s+of\s+(?:the\s+)?(?:user|owner|admin(?:istrator)?|operator)\b/i },
  { label: 'role-authority', pattern: /\b(?:(?:as|i\s+am|i['’]m)\s+(?:the|your)|this\s+is\s+(?:your|(?:me|us|i|we)\s*,?\s+(?:the|your)))\s+(?:admin(?:istrator)?|owner|operator|system\s+administrator)\b/i },
  { label: 'grants-permission', pattern: /\b(?:you\s+are|you['’]re)\s+(?:now\s+|hereby\s+)?(?:authori[sz]ed|permitted|cleared)\s+to\b|\bi\s+(?:hereby\s+)?(?:authori[sz]e|permit)\s+you\s+to\b/i },
]);

/** The labels of the authority claims in `text`, in the order of `AUTHORITY_CLAIMS`, each once. */
export function authorityClaims(text: string): string[] {
  const plain = stripInvisible(text);
  return AUTHORITY_CLAIMS.filter((c) => c.pattern.test(plain)).map((c) => c.label);
}

/** The file in the config folder that holds this install's fingerprint key: 32 random bytes as hex, mode 0600. */
export const HANDOFF_KEY_FILE = 'handoff.key';

const KEY_HEX = /^[0-9a-f]{64}$/;

function readKey(file: string): Buffer | null {
  const text = readFileSync(file, 'utf8').trim();
  return KEY_HEX.test(text) ? Buffer.from(text, 'hex') : null;
}

/**
 * This install's fingerprint key, created on first use with an exclusive create (mode 0600), or null when the file
 * cannot be read or written or does not hold a key. With no key no fingerprint is recorded: never an unkeyed hash.
 */
export function handoffKey(dir: string): Buffer | null {
  const file = join(dir, HANDOFF_KEY_FILE);
  try {
    return readKey(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return null;
  }
  try {
    return readKey(file);
  } catch {
    return null;
  }
}

/** HMAC-SHA256 (hex) of `text` under `key`: the same text gives the same fingerprint within one install only. */
export function handoffFingerprint(text: string, key: Buffer): string {
  return createHmac('sha256', key).update(text, 'utf8').digest('hex');
}

/**
 * The handoff a call makes: the first of its actions that carries a message from a known message tool, or `undefined`.
 * `taint` is the session's taint when the call was judged, before this message's own scan (which writes its own line).
 * `dir` is the config folder that holds the fingerprint key; without it, or without a usable key, the record has no fingerprint.
 */
export function handoffOf(actions: readonly Action[], taint: TaintState | null | undefined, dir?: string): AuditHandoff | undefined {
  for (const a of actions) {
    if (a.kind !== 'other' || a.message === undefined) continue;
    if (!Object.prototype.hasOwnProperty.call(HANDOFF_KIND_OF, a.tool)) continue;
    const kind = HANDOFF_KIND_OF[a.tool] as HandoffKind;
    const claims = authorityClaims(a.message.text);
    const key = dir === undefined ? null : handoffKey(dir);
    return {
      kind,
      ...(key !== null ? { fingerprint: handoffFingerprint(a.message.text, key) } : {}),
      bytes: a.message.redactedBytes ?? a.message.bytes,
      ...(a.message.cut ? { cut: true as const } : {}),
      sender_taint: senderTaint(taint),
      ...(claims.length > 0 ? { claims } : {}),
    };
  }
  return undefined;
}
