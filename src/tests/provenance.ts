import { isAbsolute, relative } from 'node:path';
import type { AuditRecord } from '../audit.js';
import { TEST_GLOBS } from '../diffclass/integrity.js';
import { compileGlob } from '../diffclass/glob.js';
import { parseCommand } from '../shell.js';
import type { Action } from '../types.js';

/** At most this many test paths go on one audit record. */
export const MAX_TEST_WRITES = 20;

const isTest = ((tests) => (p: string): boolean => tests.some((t) => t(p)))(TEST_GLOBS.map(compileGlob));

/** Commands whose operands (after the options) are files they write: `tee` writes each, `cp`/`mv`/`install`/`ln` write the last. */
const WRITES_EACH = new Set(['tee']);
const WRITES_LAST = new Set(['cp', 'mv', 'install', 'ln', 'rsync']);
const REDIRECT_WRITE = /^(\d*>{1,2}\|?|&>>?|>&)$/;

function toRel(path: string, cwd: string | null): string {
  const p = path.replace(/\\/g, '/');
  if (cwd === null || !isAbsolute(p)) return p.replace(/^\.\//, '');
  const r = relative(cwd, p).replace(/\\/g, '/');
  return r.startsWith('..') ? p : r;
}

function execTargets(command: string, shell: Extract<Action, { kind: 'exec' }>['shell']): string[] {
  const out: string[] = [];
  let parsed;
  try {
    parsed = parseCommand(command, shell);
  } catch {
    return out;
  }
  for (const c of parsed.commands) {
    for (const r of c.redirects) if (REDIRECT_WRITE.test(r.op) && r.target !== '' && !/^&?\d$/.test(r.target) && r.target !== '/dev/null') out.push(r.target);
    const operands = c.args.filter((a) => !a.startsWith('-'));
    if (WRITES_EACH.has(c.name)) out.push(...operands);
    else if (WRITES_LAST.has(c.name) && operands.length >= 2) out.push(operands[operands.length - 1] as string);
    else if (c.name === 'sed' && c.args.some((a) => a === '-i' || a.startsWith('-i') || a === '--in-place' || a.startsWith('--in-place='))) out.push(...operands.slice(1));
  }
  return out;
}

/**
 * The test files one tool call writes, as paths relative to the project (0.32.0): write actions, and in a shell
 * command the redirect targets and the files tee, cp, mv, install, ln, rsync and sed -i write. Matched against the
 * diff-class `exclude.test-file` globs. Best effort: a test written by a script, a code generator or an interpreter
 * one-liner is not seen.
 */
export function testWritesOf(actions: readonly Action[], cwd: string | null): string[] {
  const found = new Set<string>();
  for (const a of actions) {
    const paths = a.kind === 'write' ? [a.path] : a.kind === 'exec' ? execTargets(a.command, a.shell) : [];
    for (const p of paths) {
      const rel = toRel(p, cwd);
      if (isTest(rel)) found.add(rel);
      if (found.size >= MAX_TEST_WRITES) return [...found];
    }
  }
  return [...found];
}

export interface ProvenanceWrite {
  ts: string;
  session: string | null;
  agent: string | null;
  source: string;
  tool: string;
  decision: string;
}

export interface ProvenanceEntry {
  path: string;
  /** Calls that wrote it and went ahead (allow) or were put to the person (ask, which may have gone ahead). */
  writes: ProvenanceWrite[];
  /** Calls that tried to write it and were stopped (deny). */
  stopped: number;
}

export interface ProvenanceResult {
  entries: ProvenanceEntry[];
  /** The paths asked about that no audit record names. No record proves nothing: the audit may have been off. */
  noRecord: string[];
  recordsRead: number;
}

/** Folds audit records into who wrote which test file. Pure. */
export function testProvenance(records: readonly AuditRecord[], opts: { paths?: readonly string[]; session?: string; since?: string } = {}): ProvenanceResult {
  const wanted = opts.paths !== undefined && opts.paths.length > 0 ? new Set(opts.paths.map((p) => p.replace(/\\/g, '/').replace(/^\.\//, ''))) : null;
  const by = new Map<string, ProvenanceEntry>();
  let read = 0;
  for (const r of records) {
    if (opts.session !== undefined && r.session !== opts.session) continue;
    if (opts.since !== undefined && r.ts < opts.since) continue;
    read++;
    const tests = r.tests ?? [];
    for (const path of tests) {
      if (wanted !== null && !wanted.has(path)) continue;
      const e = by.get(path) ?? { path, writes: [], stopped: 0 };
      if (r.decision === 'deny') e.stopped++;
      else e.writes.push({ ts: r.ts, session: r.session, agent: 'agent' in r && typeof r.agent === 'string' ? r.agent : null, source: r.source, tool: r.tool, decision: r.decision });
      by.set(path, e);
    }
  }
  const entries = [...by.values()].sort((a, b) => a.path.localeCompare(b.path));
  const noRecord = wanted === null ? [] : [...wanted].filter((p) => !by.has(p)).sort();
  return { entries, noRecord, recordsRead: read };
}
