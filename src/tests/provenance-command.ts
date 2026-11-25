import { readAudit } from '../audit.js';
import { auditLogPath, configDir } from '../paths.js';
import { testProvenance } from './provenance.js';
import type { ProvenanceResult } from './provenance.js';

export interface SubResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export const PROVENANCE_USAGE = `  openmorals tests provenance [PATH...] [--session ID] [--since ISO-TIME] [--log FILE] [--json]
      Says which test files the agent wrote, from the audit log: each path, the calls that wrote it (time, session,
      agent, host, tool) and how many tries were stopped. With PATHs, only those, and a path with no record is
      listed as such. No record proves nothing: the audit may have been off, the write may have come from a script,
      or it may predate 0.32.0. Exit 0 when nothing listed was written by the agent, 1 when something was, 2 when
      the log cannot be read, 64 usage error.`;

export const PROVENANCE_LIMITS: readonly string[] = [
  'Only writes the hooks saw are recorded: a test written by a script, a code generator or an interpreter one-liner is not.',
  'Records start at 0.32.0; earlier writes are not listed.',
  'A path with no record was not shown to be written by the agent; that is not proof it was not.',
];

function format(r: ProvenanceResult, log: string): string {
  const out: string[] = [];
  if (r.entries.length === 0) out.push(`No test file writes recorded in ${log} (${r.recordsRead} records read).`);
  else out.push(`${r.entries.length} test file${r.entries.length === 1 ? '' : 's'} written by the agent, from ${log}:`);
  for (const e of r.entries) {
    const sessions = [...new Set(e.writes.map((w) => w.session ?? 'unknown'))];
    const last = e.writes[e.writes.length - 1];
    out.push(`  ${e.path}: ${e.writes.length} write${e.writes.length === 1 ? '' : 's'}${e.stopped > 0 ? `, ${e.stopped} stopped` : ''}; session${sessions.length === 1 ? '' : 's'} ${sessions.join(', ')}${last !== undefined ? `; last ${last.ts} by ${last.source} ${last.tool}${last.agent !== null ? ` (agent ${last.agent})` : ''}` : ''}`);
  }
  if (r.noRecord.length > 0) out.push(`No record for: ${r.noRecord.join(', ')}`);
  out.push('', ...PROVENANCE_LIMITS.map((l) => `Not checked: ${l}`));
  return `${out.join('\n')}\n`;
}

export function provenanceCommand(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): SubResult {
  const paths: string[] = [];
  let session: string | undefined;
  let since: string | undefined;
  let log: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const val = (): string | null => {
      const v = argv[i + 1];
      i++;
      return v === undefined || v.startsWith('--') ? null : v;
    };
    if (a === '--json') json = true;
    else if (a === '--session' || a === '--since' || a === '--log') {
      const v = val();
      if (v === null) return { exitCode: 64, stdout: '', stderr: `openmorals tests provenance: ${a} needs a value; nothing was done\n\nUsage:\n${PROVENANCE_USAGE}\n` };
      if (a === '--session') session = v;
      else if (a === '--since') {
        if (Number.isNaN(Date.parse(v))) return { exitCode: 64, stdout: '', stderr: `openmorals tests provenance: --since ${JSON.stringify(v)} is not a time; nothing was done\n` };
        since = new Date(v).toISOString();
      } else log = v;
    } else if (a.startsWith('--')) return { exitCode: 64, stdout: '', stderr: `openmorals tests provenance: unknown option ${a}; nothing was done\n\nUsage:\n${PROVENANCE_USAGE}\n` };
    else paths.push(a);
  }
  const file = log ?? auditLogPath(configDir(env));
  const read = readAudit(file);
  if (read.status === 'unreadable') return { exitCode: 2, stdout: '', stderr: `openmorals tests provenance: ${read.errors[0]?.error ?? 'cannot read the audit log'}\n` };
  const r = testProvenance(read.records, { paths, ...(session !== undefined ? { session } : {}), ...(since !== undefined ? { since } : {}) });
  const exitCode = r.entries.some((e) => e.writes.length > 0) ? 1 : 0;
  if (json) return { exitCode, stdout: `${JSON.stringify({ exitCode, log: file, logStatus: read.status, badLines: read.errors.length, ...r, limits: PROVENANCE_LIMITS }, null, 2)}\n`, stderr: '' };
  return { exitCode, stdout: format(r, file) + (read.errors.length > 0 ? `${read.errors.length} audit line(s) could not be read and were skipped.\n` : ''), stderr: '' };
}
