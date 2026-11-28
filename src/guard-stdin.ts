import { readSync } from 'node:fs';
import { EMBED_BAD_REQUEST, EMBED_ERROR, guardCall } from './embed.js';
import type { GuardCallRequest } from './embed.js';
import { unattendedVerdict } from './session.js';
import type { Decision, Verdict } from './types.js';

/** The most bytes `openmorals guard --json` reads from stdin. A longer input is not read to the end: the call asks. */
export const GUARD_STDIN_MAX_BYTES = 16 * 1024 * 1024;

/** What reading stdin gave: the bytes, or why they could not be read. */
export type StdinRead = { ok: true; bytes: Uint8Array } | { ok: false; why: string };

/** The printed line and the exit code of one `openmorals guard --json` run. */
export interface GuardStdinResult {
  stdout: string;
  exitCode: number;
  verdict: Verdict;
}

/** The exit code of a decision, the same as `openmorals check`: 0 allow, 1 ask, 2 deny. */
export function guardExitCode(d: Decision): number {
  return d === 'allow' ? 0 : d === 'ask' ? 1 : 2;
}

/** Reads fd 0 to its end, stopping past `limit` bytes. Never throws. */
export function readStdinLimited(limit: number = GUARD_STDIN_MAX_BYTES, fd = 0): StdinRead {
  const chunks: Buffer[] = [];
  let total = 0;
  const buf = Buffer.alloc(64 * 1024);
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      total += n;
      if (total > limit) return { ok: false, why: `stdin holds more than ${limit} bytes` };
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    if (code === 'EOF') return { ok: true, bytes: Buffer.concat(chunks) };
    return { ok: false, why: `stdin could not be read (${typeof code === 'string' ? code : 'error'})` };
  }
  return { ok: true, bytes: Buffer.concat(chunks) };
}

function answer(v: Verdict): GuardStdinResult {
  const verdict: Verdict = { decision: v.decision, rule: v.rule, reason: v.reason };
  return { stdout: JSON.stringify(verdict), exitCode: guardExitCode(verdict.decision), verdict };
}

function refuse(rule: string, reason: string, unattended: boolean): GuardStdinResult {
  const v: Verdict = { decision: 'ask', rule, reason: `${reason}; openmorals asks instead of guessing` };
  return answer(unattended ? unattendedVerdict(v) : v);
}

/**
 * One run of `openmorals guard --json` (Preview, 0.43.1): one request in `guardCall`'s shape, read from stdin, judged
 * by `guardCall`, printed as one JSON line. It adds no rule of its own: input it cannot read as one JSON object asks
 * (deny when unattended) with `embed.bad-request`, the rule `guardCall` gives a request it cannot read. Never throws.
 */
export function guardStdin(read: StdinRead, opts: { unattended: boolean; env?: NodeJS.ProcessEnv }): GuardStdinResult {
  try {
    if (!read.ok) return refuse(EMBED_BAD_REQUEST, read.why, opts.unattended);
    if (read.bytes.length > GUARD_STDIN_MAX_BYTES) return refuse(EMBED_BAD_REQUEST, `stdin holds more than ${GUARD_STDIN_MAX_BYTES} bytes`, opts.unattended);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(read.bytes);
    } catch {
      return refuse(EMBED_BAD_REQUEST, 'stdin is not UTF-8 text', opts.unattended);
    }
    if (text.trim() === '') return refuse(EMBED_BAD_REQUEST, 'stdin is empty: give one JSON request', opts.unattended);
    let request: unknown;
    try {
      request = JSON.parse(text);
    } catch {
      return refuse(EMBED_BAD_REQUEST, 'stdin is not one JSON document', opts.unattended);
    }
    // A value that is not an object is refused by guardCall itself, with the same rule.
    return answer(guardCall(request as GuardCallRequest, { unattended: opts.unattended, ...(opts.env !== undefined ? { env: opts.env as Record<string, string | undefined> } : {}) }));
  } catch (e: unknown) {
    return refuse(EMBED_ERROR, `openmorals hit an internal error (${e instanceof Error ? e.message : 'unknown'})`, opts.unattended);
  }
}

/**
 * True when a hook command runs `openmorals guard` (0.43.1): a word naming openmorals (or its cli.js) followed by
 * `guard`. Quotes, brackets and commas count as spaces (so a JSON word list is read too), which is enough to see the two
 * words side by side.
 */
export function namesGuardCommand(command: string): boolean {
  const words = command.replace(/["'\[\],]/g, ' ').split(/\s+/).filter((w) => w !== '');
  const ours = (w: string): boolean => /^(openmorals(\.cmd|\.exe|\.(c|m)?js)?|cli\.(c|m)?js)$/i.test(w.split(/[\\/]/).pop() ?? w);
  return words.some((w, i) => ours(w) && words[i + 1] === 'guard');
}
