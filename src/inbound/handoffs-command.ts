// `openmorals audit handoffs` (0.38.0): what agents handed to each other, read back from the `handoff` field of the
// audit log. A report only: it reads the log and changes nothing.
import type { AuditHandoff, AuditRecord } from '../audit.js';
import { readAudit } from '../audit.js';
import { auditLogPath, configDir } from '../paths.js';

export interface HandoffsResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const HANDOFFS_USAGE = `  openmorals audit handoffs [--session ID] [--since ISO-TIME] [--log FILE] [--json]
      Says what agents handed to each other, from the audit log: how many prompts, messages and reports by host and
      tool, and lists those sent from a session that had read untrusted or hidden content, those carrying a claim of
      approval or authority, those over the size cap, and the same text sent more than once. Never shows the text.
      Exit 1 when a handoff from such a session, with a claim or over the cap is listed; 0 otherwise, also when only
      repeats are listed (the same brief sent twice is often normal); 2 when the log cannot be read; 64 usage error.`;

export const HANDOFFS_LIMITS: readonly string[] = [
  'Only text passed through a message tool the hooks see is recorded; a note file, a shared folder, a mailbox file or a message board is not.',
  'Records start at 0.38.0; earlier handoffs are not listed.',
  'A claim label is a phrase match: it misses a claim worded another way and can label a harmless sentence. It changes no decision.',
  'The fingerprint is an HMAC-SHA256 of the redacted text up to the cap, so two texts that differ only in a redacted secret or past the cap share it.',
  'Fingerprints are keyed per install (the key file in the config folder), so they cannot be compared across machines or installs, and anyone who can read the key file can still confirm a guessed text. With no usable key file no fingerprint is recorded and the call is not counted as a repeat.',
  'The sending taint is the session the hook ran in when the call was judged; where a child agent runs in its own session, its own taint is not in the parent\'s record.',
];

/** One recorded handoff, without its text. */
export interface HandoffEntry {
  ts: string;
  session: string | null;
  source: string;
  tool: string;
  agent: string | null;
  decision: string;
  handoff: AuditHandoff;
}

export interface HandoffRepeat {
  fingerprint: string;
  count: number;
  sessions: string[];
}

export interface HandoffReport {
  recordsRead: number;
  total: number;
  byKind: Record<string, number>;
  byTool: Record<string, number>;
  fromTainted: HandoffEntry[];
  withClaims: HandoffEntry[];
  cut: HandoffEntry[];
  repeated: HandoffRepeat[];
}

export interface HandoffFilter {
  session?: string;
  since?: string;
}

/** The handoff report over audit records, oldest first as the log holds them. */
export function handoffReport(records: readonly AuditRecord[], filter: HandoffFilter = {}): HandoffReport {
  const entries: HandoffEntry[] = [];
  for (const r of records) {
    if (r.v !== 2 || r.handoff === undefined) continue;
    if (filter.session !== undefined && r.session !== filter.session) continue;
    if (filter.since !== undefined && r.ts < filter.since) continue;
    entries.push({ ts: r.ts, session: r.session, source: r.source, tool: r.tool, agent: r.agent ?? null, decision: r.decision, handoff: r.handoff });
  }
  const byKind: Record<string, number> = {};
  const byTool: Record<string, number> = {};
  const hashes = new Map<string, { count: number; sessions: Set<string> }>();
  for (const e of entries) {
    byKind[e.handoff.kind] = (byKind[e.handoff.kind] ?? 0) + 1;
    const key = `${e.source} ${e.tool}`;
    byTool[key] = (byTool[key] ?? 0) + 1;
    const fp = e.handoff.fingerprint;
    if (fp === undefined) continue;
    const h = hashes.get(fp) ?? { count: 0, sessions: new Set<string>() };
    h.count++;
    h.sessions.add(e.session ?? 'unknown');
    hashes.set(fp, h);
  }
  const repeated = [...hashes]
    .filter(([, h]) => h.count > 1)
    .map(([fingerprint, h]) => ({ fingerprint, count: h.count, sessions: [...h.sessions].sort() }))
    .sort((a, b) => b.count - a.count || a.fingerprint.localeCompare(b.fingerprint));
  return {
    recordsRead: records.length,
    total: entries.length,
    byKind,
    byTool,
    fromTainted: entries.filter((e) => e.handoff.sender_taint !== 'clean'),
    withClaims: entries.filter((e) => (e.handoff.claims?.length ?? 0) > 0),
    cut: entries.filter((e) => e.handoff.cut === true),
    repeated,
  };
}

/**
 * True when the report lists a handoff that sets exit 1: one sent from a session that had read untrusted or hidden
 * content, one carrying a claim, or one over the cap. Repeats are listed but do not count: one brief sent to several
 * agents, or sent again after a retry, is common.
 */
export function handoffsListed(r: HandoffReport): boolean {
  return r.fromTainted.length > 0 || r.withClaims.length > 0 || r.cut.length > 0;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function line(e: HandoffEntry, extra: string): string {
  return `  ${e.ts} ${e.source} ${e.tool} (${e.handoff.kind}, ${e.handoff.bytes} bytes) session ${e.session ?? 'unknown'}${e.agent !== null ? ` agent ${e.agent}` : ''}: ${extra}`;
}

function format(r: HandoffReport, log: string): string {
  const out: string[] = [];
  if (r.total === 0) out.push(`No handoffs recorded in ${log} (${r.recordsRead} records read).`);
  else {
    const kinds = Object.entries(r.byKind).sort().map(([k, n]) => `${n} ${k}`).join(', ');
    out.push(`${plural(r.total, 'handoff')} recorded in ${log}: ${kinds}.`);
    for (const [k, n] of Object.entries(r.byTool).sort()) out.push(`  ${k}: ${n}`);
  }
  if (r.fromTainted.length > 0) {
    out.push('', `Sent from a session that had read untrusted or hidden content (${r.fromTainted.length}):`);
    for (const e of r.fromTainted) out.push(line(e, e.handoff.sender_taint));
  }
  if (r.withClaims.length > 0) {
    out.push('', `Carrying a claim of approval or authority (${r.withClaims.length}):`);
    for (const e of r.withClaims) out.push(line(e, (e.handoff.claims ?? []).join(', ')));
  }
  if (r.cut.length > 0) {
    out.push('', `Over the size cap, only the first and last parts scanned (${r.cut.length}):`);
    for (const e of r.cut) out.push(line(e, 'cut'));
  }
  if (r.repeated.length > 0) {
    out.push('', `The same text sent more than once (${r.repeated.length}; listed only, not counted in the exit code):`);
    for (const h of r.repeated) out.push(`  ${h.fingerprint.slice(0, 12)}: ${h.count} times, session${h.sessions.length === 1 ? '' : 's'} ${h.sessions.join(', ')}`);
  }
  out.push('', ...HANDOFFS_LIMITS.map((l) => `Not checked: ${l}`));
  return `${out.join('\n')}\n`;
}

export function handoffsCommand(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): HandoffsResult {
  let session: string | undefined;
  let since: string | undefined;
  let log: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--json') json = true;
    else if (a === '--session' || a === '--since' || a === '--log') {
      const v = argv[i + 1];
      i++;
      if (v === undefined || v.startsWith('--')) return { exitCode: 64, stdout: '', stderr: `openmorals audit handoffs: ${a} needs a value; nothing was done\n\nUsage:\n${HANDOFFS_USAGE}\n` };
      if (a === '--session') session = v;
      else if (a === '--since') {
        if (Number.isNaN(Date.parse(v))) return { exitCode: 64, stdout: '', stderr: `openmorals audit handoffs: --since ${JSON.stringify(v)} is not a time; nothing was done\n` };
        since = new Date(v).toISOString();
      } else log = v;
    } else return { exitCode: 64, stdout: '', stderr: `openmorals audit handoffs: unknown argument ${a}; nothing was done\n\nUsage:\n${HANDOFFS_USAGE}\n` };
  }
  const file = log ?? auditLogPath(configDir(env));
  const read = readAudit(file);
  if (read.status === 'unreadable') return { exitCode: 2, stdout: '', stderr: `openmorals audit handoffs: ${read.errors[0]?.error ?? 'cannot read the audit log'}\n` };
  const r = handoffReport(read.records, { ...(session !== undefined ? { session } : {}), ...(since !== undefined ? { since } : {}) });
  const exitCode = handoffsListed(r) ? 1 : 0;
  if (json) return { exitCode, stdout: `${JSON.stringify({ exitCode, log: file, logStatus: read.status, badLines: read.errors.length, ...r, limits: HANDOFFS_LIMITS }, null, 2)}\n`, stderr: '' };
  return { exitCode, stdout: format(r, file) + (read.errors.length > 0 ? `${read.errors.length} audit line(s) could not be read and were skipped.\n` : ''), stderr: '' };
}
