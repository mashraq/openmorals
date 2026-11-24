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
}

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
}

export type AuditRecord = AuditRecordV1 | AuditRecordV2;

/** The `prev` of the first record of a session. */
export const AUDIT_GENESIS = '0'.repeat(64);

/** Where a session's chain stands: the `seq` of its last record and that record line's hash. Kept in the session file. */
export interface ChainHead {
  seq: number;
  head: string;
}

/** The optional v2 fields, as one call knows them. */
export interface AuditMeta {
  bylaws?: string;
  event?: string;
  run?: string;
  agent?: string;
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
  { re: /([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi, to: '$1$2:[REDACTED]@' },
  { re: /\b([A-Za-z_][A-Za-z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|PWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL)[A-Za-z0-9_]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s"';&|]+)/gi, to: '$1$3[REDACTED]' },
  { re: /(--?(password|passwd|pass|token|secret|api-key|apikey|access-key|secret-key|client-secret)(=|\s+))("[^"]*"|'[^']*'|[^\s"']+)/gi, to: '$1[REDACTED]' },
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
  };
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

/** The v2 fields of one call: the bylaws digest, the host event, the host's agent id, and `OPENMORALS_RUN` from the hook's own environment. */
export function auditMeta(input: { bylaws: Bylaws | null; event: string | null | undefined; agent: string | null | undefined; env: NodeJS.ProcessEnv }): AuditMeta {
  const meta: AuditMeta = {};
  if (input.bylaws !== null) meta.bylaws = bylawsDigest(input.bylaws);
  const event = cleanAuditId(input.event);
  if (event !== undefined) meta.event = event;
  const run = cleanAuditId(input.env['OPENMORALS_RUN']);
  if (run !== undefined) meta.run = run;
  const agent = cleanAuditId(input.agent);
  if (agent !== undefined) meta.agent = agent;
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
export function chainAudit(records: readonly AuditFields[], meta: AuditMeta, from: ChainHead | undefined): ChainedAudit {
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
    };
    const line = JSON.stringify(rec);
    head = { seq: rec.seq, head: auditLineHash(line) };
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
  for (const k of ['bylaws', 'event', 'run', 'agent'] as const) {
    if (o[k] === undefined) continue;
    const s = str(o, k);
    if (s === null || (k === 'bylaws' && !HEX64.test(s))) return { error: `mistyped field ${k}` };
    rec[k] = s;
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
