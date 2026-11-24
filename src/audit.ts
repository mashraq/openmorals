import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { auditLogPath } from './paths.js';
import type { Decision } from './types.js';
import { isDecision } from './types.js';

export interface AuditRecord {
  v: 1;
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

export function makeAuditRecord(input: Omit<AuditRecord, 'v' | 'ts' | 'action' | 'reason'> & { action: string; reason: string }, now: Date = new Date()): AuditRecord {
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

export function appendAudit(record: AuditRecord, file: string = auditLogPath()): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const safe: AuditRecord = { ...record, action: summarize(record.action), reason: summarize(record.reason) };
  appendFileSync(file, `${JSON.stringify(safe)}\n`, { mode: 0o600 });
}

function str(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === 'string' ? v : null;
}

export function parseAuditLine(line: string): AuditRecord | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { error: 'not valid JSON' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { error: 'not a JSON object' };
  const o = raw as Record<string, unknown>;
  if (o['v'] !== 1) return { error: 'unknown record version' };
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
  return { v: 1, ts, source, session: str(o, 'session'), tool, action, decision, rule, reason, cwd: str(o, 'cwd'), budget };
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
