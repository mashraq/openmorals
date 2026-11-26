import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { auditLogPath } from './paths.js';
import type { Bylaws, Decision } from './types.js';
import { isDecision } from './types.js';
import { VERSION } from './version.js';

/** The fields every record version carries. */
export interface AuditFields {
  ts: string;
  source: string;
  session: string | null;
  tool: string;
  action: string;
  decision: Decision;
  rule: string;
  reason: string;
  cwd: string | null;
  budget: { tool_calls: number; tokens: number } | null;
  /** `openmorals audit sample`'s own draws, verdicts and declared changes (from 0.11.0); absent on every other record. */
  sample?: AuditSampleData;
  /** `openmorals order check`'s result and `order approve`'s approval (from 0.27.0); absent on every other record. */
  order_check?: AuditSampleData;
  /** The test files this call writes, relative to the project (0.32.0): what `openmorals tests provenance` reads. Absent when none. */
  tests?: string[];
  /** What this call handed to another agent (0.37.0): kind, hash and size of the text, the sending session's taint, authority claims. Never the text. Absent when the call hands nothing on. */
  handoff?: AuditHandoff;
}

/** The kinds of handoff a call can carry: starting an agent, a message to a running one, a child's report back. */
export const HANDOFF_KINDS = ['spawn', 'message', 'handback'] as const;
export type HandoffKind = (typeof HANDOFF_KINDS)[number];
/** The sending session's taint when the call was judged: none, untrusted content read, or hidden instructions found. */
export const SENDER_TAINTS = ['clean', 'untrusted', 'injected'] as const;
export type SenderTaint = (typeof SENDER_TAINTS)[number];

/** The `handoff` field of a call's audit record (0.37.0). `sha256` is of the redacted, capped text the scan saw; `bytes` is the size before redaction and the cut. */
export interface AuditHandoff {
  kind: HandoffKind;
  sha256: string;
  bytes: number;
  /** True when the text was over the cap and only its first and last halves were kept and hashed. */
  cut?: true;
  sender_taint: SenderTaint;
  /** Labels of authority or consent claims found in the text (`user-approved`, `no-need-to-ask`, ...). Labels only: no decision reads them. */
  claims?: string[];
}

/** A JSON object carried by an `audit sample` record; `sample/draw.ts` reads its shape. */
export type AuditSampleData = Readonly<Record<string, unknown>>;

/** A record as written before 0.8.0, and as `makeAuditRecord` builds it: not chained. */
export interface AuditRecordV1 extends AuditFields {
  v: 1;
}

/**
 * A record from 0.8.0 on. `seq` counts the records of one session file from 1; `prev` is the SHA-256 (hex) of the
 * previous record line of the same session as written, without its newline (`AUDIT_GENESIS` for the first). `ov` is the
 * openmorals version that wrote it. `bylaws` (digest of the bylaws in force), `event` (the host event), `run` (from
 * `OPENMORALS_RUN`) and `agent` (the host's agent id) are left out when unknown, never guessed.
 */
export interface AuditRecordV2 extends AuditFields {
  v: 2;
  seq: number;
  prev: string;
  ov: string;
  bylaws?: string;
  event?: string;
  run?: string;
  agent?: string;
  /** The work order named by `OPENMORALS_ORDER` in the hook's own environment (0.27.0), as given; absent when unset. */
  order?: string;
  /** The `disclaimer:` texts of the bylaws in force (0.25.0), on the first record of a session that runs under them. */
  disclaimers?: string[];
}

export type AuditRecord = AuditRecordV1 | AuditRecordV2;

/** The `prev` of the first record of a session. */
export const AUDIT_GENESIS = '0'.repeat(64);

/** Where a session's chain stands: the `seq` of its last record and that record line's hash. Kept in the session file. */
export interface ChainHead {
  seq: number;
  head: string;
  /** SHA-256 (hex) of the disclaimer texts this session last wrote (0.25.0), so each set is written once per session. */
  disclaimers?: string;
}

/** The optional v2 fields, as one call knows them. */
export interface AuditMeta {
  bylaws?: string;
  event?: string;
  run?: string;
  agent?: string;
  /** `OPENMORALS_ORDER` from the hook's own environment (0.27.0). */
  order?: string;
  /** The bylaws' disclaimer texts (0.25.0): written on one record per session, not on every record. */
  disclaimers?: string[];
}

/** `missing`: no log file; `empty`: a file with no lines; `unreadable`: the file exists but could not be read (see `errors`). */
export type AuditStatus = 'missing' | 'empty' | 'ok' | 'unreadable';

export interface AuditReadResult {
  status: AuditStatus;
  records: AuditRecord[];
  errors: { line: number; error: string }[];
}

const MAX_ACTION = 2000;

const REDACTIONS: { re: RegExp; to: string }[] = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, to: '[REDACTED PRIVATE KEY]' },
  { re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, to: '[REDACTED]' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, to: '[REDACTED]' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, to: '[REDACTED]' },
  { re: /\bglpat-[A-Za-z0-9_-]{16,}\b/g, to: '[REDACTED]' },
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, to: '[REDACTED]' },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, to: '[REDACTED]' },
  { re: /\bAIza[0-9A-Za-z_-]{30,}\b/g, to: '[REDACTED]' },
  { re: /\bnpm_[A-Za-z0-9]{30,}\b/g, to: '[REDACTED]' },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, to: '[REDACTED JWT]' },
  { re: /\b(authorization|proxy-authorization|x-api-key|api-key|x-auth-token)(\s*[:=]\s*)(bearer\s+|basic\s+|token\s+)?[^\s"',;]+/gi, to: '$1$2[REDACTED]' },
  { re: /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, to: '$1 [REDACTED]' },
  // A match may start only where a run of scheme characters starts (the lookbehind), so a long run of letters is read
  // once instead of once per letter; the leading digits or signs are kept in $1. Same output as the 0.13 pattern.
  { re: /(?<![a-z0-9+.-])([0-9+.-]*)([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi, to: '$1$2$3:[REDACTED]@' },
  { re: /\b([A-Za-z_][A-Za-z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL)[A-Za-z0-9_]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"';&|]+)/gi, to: '$1$3[REDACTED]' },
  // A key word standing alone (0.27.0): `password=...` with nothing before it, `token=...` in a query string.
  { re: /(?<![A-Za-z0-9_])(password|passwd|secret|token|api_?key|apikey|access_?key|private_?key|client_?secret)(\s*=\s*)("[^"]*"|'[^']*'|[^\s"';&|]+)/gi, to: '$1$2[REDACTED]' },
  // A flag starts the text or follows whitespace or a shell separator (0.27.0), so "secret-token detector" is not `-token`.
  { re: /(?<![^\s;&|()<>`"'])(--?(password|passwd|pass|token|secret|api-key|apikey|access-key|secret-key|client-secret)(=|\s+))("[^"]*"|'[^']*'|[^\s"']+)/gi, to: '$1[REDACTED]' },
  { re: /(^|\s)(-u|--user)(\s+|=)([^\s:"']+):([^\s"']+)/g, to: '$1$2$3$4:[REDACTED]' },
];

export function redact(text: string): string {
  let out = text;
  for (const r of REDACTIONS) out = out.replace(r.re, r.to);
  return out;
}

export function summarize(text: string): string {
  const r = redact(text);
  return r.length > MAX_ACTION ? `${r.slice(0, MAX_ACTION)}… [truncated ${r.length - MAX_ACTION} chars]` : r;
}

/** Builds an unchained record (version 1). `chainAudit` turns records into chained version 2 lines. */
export function makeAuditRecord(input: Omit<AuditFields, 'ts'>, now: Date = new Date()): AuditRecordV1 {
  return {
    v: 1,
    ts: now.toISOString(),
    source: input.source,
    session: input.session,
    tool: input.tool,
    action: summarize(input.action),
    decision: input.decision,
    rule: input.rule,
    reason: summarize(input.reason),
    cwd: input.cwd,
    budget: input.budget,
    ...(input.tests !== undefined && input.tests.length > 0 ? { tests: [...input.tests] } : {}),
    ...(input.handoff !== undefined ? { handoff: copyHandoff(input.handoff) } : {}),
  };
}

function copyHandoff(h: AuditHandoff): AuditHandoff {
  return { kind: h.kind, sha256: h.sha256, bytes: h.bytes, ...(h.cut === true ? { cut: true as const } : {}), sender_taint: h.sender_taint, ...(h.claims !== undefined && h.claims.length > 0 ? { claims: [...h.claims] } : {}) };
}

function parseHandoff(v: unknown): AuditHandoff | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const kind = o['kind'];
  const sha = o['sha256'];
  const bytes = o['bytes'];
  const cut = o['cut'];
  const st = o['sender_taint'];
  const claims = o['claims'];
  if (typeof kind !== 'string' || !(HANDOFF_KINDS as readonly string[]).includes(kind)) return null;
  if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha)) return null;
  if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) return null;
  if (cut !== undefined && cut !== true) return null;
  if (typeof st !== 'string' || !(SENDER_TAINTS as readonly string[]).includes(st)) return null;
  if (claims !== undefined && (!Array.isArray(claims) || !claims.every((c: unknown) => typeof c === 'string'))) return null;
  return { kind: kind as HandoffKind, sha256: sha, bytes, ...(cut === true ? { cut: true as const } : {}), sender_taint: st as SenderTaint, ...(Array.isArray(claims) && claims.length > 0 ? { claims: claims as string[] } : {}) };
}

/** Writes one record as it is (any version). Hooks write chained lines with `chainAudit` and `appendAuditText`. */
export function appendAudit(record: AuditRecord, file: string = auditLogPath()): void {
  appendAuditText(`${JSON.stringify(safeRecord(record))}\n`, file);
}

/** Appends whole lines (each ending in a newline) in one write. */
export function appendAuditText(text: string, file: string = auditLogPath()): void {
  if (text === '') return;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  appendFileSync(file, text, { mode: 0o600 });
}

function safeRecord<T extends AuditFields>(record: T): T {
  return { ...record, action: summarize(record.action), reason: summarize(record.reason) };
}

/** SHA-256 (hex) of one record line as written, without its newline: what the next record's `prev` holds. */
export function auditLineHash(line: string): string {
  return createHash('sha256').update(line, 'utf8').digest('hex');
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) if (o[k] !== undefined) out[k] = canonical(o[k]);
    return out;
  }
  return v;
}

/** SHA-256 (hex) of the bylaws in force, as JSON with sorted keys: two calls under the same settings carry the same digest. */
export function bylawsDigest(bylaws: Bylaws): string {
  return createHash('sha256').update(JSON.stringify(canonical(bylaws)), 'utf8').digest('hex');
}

const MAX_ID = 128;

/** A host- or user-supplied id for the record: control characters removed, at most 128 characters; undefined when empty. */
export function cleanAuditId(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = redact(v.replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, MAX_ID);
  return s === '' ? undefined : s;
}

const MAX_PATH = 1024;

/** A path for the record (`OPENMORALS_ORDER`): control characters removed, at most 1024 characters; undefined when empty. */
export function cleanAuditPath(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = redact(v.replace(/[\u0000-\u001f\u007f]/g, '').trim()).slice(0, MAX_PATH);
  return s === '' ? undefined : s;
}

/** The v2 fields of one call: the bylaws digest, the host event, the host's agent id, and `OPENMORALS_RUN` from the hook's own environment. */
export function auditMeta(input: { bylaws: Bylaws | null; event: string | null | undefined; agent: string | null | undefined; env: NodeJS.ProcessEnv }): AuditMeta {
  const meta: AuditMeta = {};
  if (input.bylaws !== null) meta.bylaws = bylawsDigest(input.bylaws);
  const ds = input.bylaws?.disclaimers;
  if (ds !== undefined && ds.length > 0) meta.disclaimers = [...ds];
  const event = cleanAuditId(input.event);
  if (event !== undefined) meta.event = event;
  const run = cleanAuditId(input.env['OPENMORALS_RUN']);
  if (run !== undefined) meta.run = run;
  const agent = cleanAuditId(input.agent);
  if (agent !== undefined) meta.agent = agent;
  const order = cleanAuditPath(input.env['OPENMORALS_ORDER']);
  if (order !== undefined) meta.order = order;
  return meta;
}

export interface ChainedAudit {
  records: AuditRecordV2[];
  /** The lines to append, each ending in a newline. */
  text: string;
  /** The session's head after these lines; `from` (or undefined) when there are none. */
  head: ChainHead | undefined;
}

/** Numbers and links records after `from` (a session's head, undefined for a new session). Pure: nothing is written. */
export function chainAudit(records: readonly AuditFields[], metaIn: AuditMeta, from: ChainHead | undefined): ChainedAudit {
  const { disclaimers, ...meta } = metaIn;
  // The disclaimer texts go on the first record of a session that runs under them, and again only when they change.
  const digest = disclaimers !== undefined && disclaimers.length > 0 ? createHash('sha256').update(JSON.stringify(disclaimers), 'utf8').digest('hex') : undefined;
  let owed = digest !== undefined && from?.disclaimers !== digest;
  const carried = digest ?? from?.disclaimers;
  let head = from;
  const out: AuditRecordV2[] = [];
  let text = '';
  for (const r of records) {
    const f = safeRecord(r);
    const rec: AuditRecordV2 = {
      v: 2,
      seq: (head?.seq ?? 0) + 1,
      prev: head?.head ?? AUDIT_GENESIS,
      ts: f.ts,
      source: f.source,
      session: f.session,
      tool: f.tool,
      action: f.action,
      decision: f.decision,
      rule: f.rule,
      reason: f.reason,
      cwd: f.cwd,
      budget: f.budget,
      ov: VERSION,
      ...meta,
      ...(owed && disclaimers !== undefined ? { disclaimers: disclaimers.map((d) => summarize(d)) } : {}),
      ...(f.sample !== undefined ? { sample: f.sample } : {}),
      ...(f.order_check !== undefined ? { order_check: f.order_check } : {}),
      ...(f.tests !== undefined && f.tests.length > 0 ? { tests: f.tests.map((t) => summarize(t)) } : {}),
      ...(f.handoff !== undefined ? { handoff: copyHandoff(f.handoff) } : {}),
    };
    owed = false;
    const line = JSON.stringify(rec);
    head = { seq: rec.seq, head: auditLineHash(line), ...(carried !== undefined ? { disclaimers: carried } : {}) };
    out.push(rec);
    text += `${line}\n`;
  }
  return { records: out, text, head };
}

function str(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === 'string' ? v : null;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function parseAuditLine(line: string): AuditRecord | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { error: 'not valid JSON' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: 'not a JSON object' };
  const o = raw as Record<string, unknown>;
  const v = o['v'];
  if (v !== 1 && v !== 2) return { error: 'unknown record version' };
  const ts = str(o, 'ts');
  const source = str(o, 'source');
  const tool = str(o, 'tool');
  const action = str(o, 'action');
  const rule = str(o, 'rule');
  const reason = str(o, 'reason');
  const decision = o['decision'];
  if (ts === null || source === null || tool === null || action === null || rule === null || reason === null || !isDecision(decision)) {
    return { error: 'missing or mistyped field' };
  }
  const b = o['budget'];
  let budget: AuditRecord['budget'] = null;
  if (typeof b === 'object' && b !== null) {
    const bo = b as Record<string, unknown>;
    const tc = bo['tool_calls'];
    const tk = bo['tokens'];
    if (typeof tc === 'number' && typeof tk === 'number') budget = { tool_calls: tc, tokens: tk };
  }
  const fields: AuditFields = { ts, source, session: str(o, 'session'), tool, action, decision, rule, reason, cwd: str(o, 'cwd'), budget };
  if (v === 1) return { v: 1, ...fields };
  const seq = o['seq'];
  const prev = str(o, 'prev');
  const ov = str(o, 'ov');
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1 || prev === null || !HEX64.test(prev) || ov === null) return { error: 'missing or mistyped chain field' };
  const rec: AuditRecordV2 = { v: 2, seq, prev, ...fields, ov };
  for (const k of ['bylaws', 'event', 'run', 'agent', 'order'] as const) {
    if (o[k] === undefined) continue;
    const s = str(o, k);
    if (s === null || (k === 'bylaws' && !HEX64.test(s))) return { error: `mistyped field ${k}` };
    rec[k] = s;
  }
  const ds = o['disclaimers'];
  if (ds !== undefined) {
    if (!Array.isArray(ds) || !ds.every((x: unknown) => typeof x === 'string')) return { error: 'mistyped field disclaimers' };
    rec.disclaimers = ds as string[];
  }
  const sample = o['sample'];
  if (sample !== undefined) {
    if (typeof sample !== 'object' || sample === null || Array.isArray(sample)) return { error: 'mistyped field sample' };
    rec.sample = sample as AuditSampleData;
  }
  const tw = o['tests'];
  if (tw !== undefined) {
    if (!Array.isArray(tw) || !tw.every((x: unknown) => typeof x === 'string')) return { error: 'mistyped field tests' };
    rec.tests = tw as string[];
  }
  const ho = o['handoff'];
  if (ho !== undefined) {
    const h = parseHandoff(ho);
    if (h === null) return { error: 'mistyped field handoff' };
    rec.handoff = h;
  }
  const oc = o['order_check'];
  if (oc !== undefined) {
    if (typeof oc !== 'object' || oc === null || Array.isArray(oc)) return { error: 'mistyped field order_check' };
    rec.order_check = oc as AuditSampleData;
  }
  return rec;
}

export function parseAuditText(text: string): AuditReadResult {
  const res: AuditReadResult = { status: 'empty', records: [], errors: [] };
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === '') return;
    res.status = 'ok';
    const r = parseAuditLine(line);
    if ('error' in r) res.errors.push({ line: i + 1, error: r.error });
    else res.records.push(r);
  });
  return res;
}

export function readAudit(file: string = auditLogPath()): AuditReadResult {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err: unknown) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? (err as { code: unknown }).code : null;
    if (code === 'ENOENT') return { status: 'missing', records: [], errors: [] };
    return { status: 'unreadable', records: [], errors: [{ line: 0, error: `cannot read ${file}: ${err instanceof Error ? err.message : String(err)}` }] };
  }
  return parseAuditText(text);
}
