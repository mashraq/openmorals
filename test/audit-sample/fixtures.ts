import type { AuditFields, AuditSampleData, ChainHead } from '../../src/audit.js';
import { chainAudit } from '../../src/audit.js';
import { chainKey } from '../../src/audit-verify.js';
import type { Decision } from '../../src/types.js';

export interface Rec {
  session: string;
  run?: string;
  ts: string;
  tool?: string;
  action?: string;
  decision?: Decision;
  rule?: string;
  reason?: string;
  cwd?: string | null;
  agent?: string;
  sample?: AuditSampleData;
}

/** A chained log in the order given, one chain per session, as the hooks would write it. */
export function buildLog(recs: readonly Rec[]): string {
  const heads = new Map<string, ChainHead | undefined>();
  let text = '';
  for (const r of recs) {
    const fields: AuditFields = {
      ts: r.ts,
      source: 'claude-code',
      session: r.session,
      tool: r.tool ?? 'Bash',
      action: r.action ?? 'ls',
      decision: r.decision ?? 'allow',
      rule: r.rule ?? 'default',
      reason: r.reason ?? 'no guard objected',
      cwd: r.cwd === undefined ? '/srv/example' : r.cwd,
      budget: null,
      ...(r.sample !== undefined ? { sample: r.sample } : {}),
    };
    const key = chainKey(fields as AuditFields & { v: 1 });
    const meta = { ...(r.run !== undefined ? { run: r.run } : {}), ...(r.agent !== undefined ? { agent: r.agent } : {}) };
    const c = chainAudit([fields], meta, heads.get(key));
    heads.set(key, c.head);
    text += c.text;
  }
  return text;
}

/** Records of `n` runs (run-01 ...), two sessions of two records each, all at least a day before `NOW`. */
export function runs(n: number, opts: { prefix?: string; tool?: string; action?: (i: number) => string; agent?: string; cwd?: string } = {}): Rec[] {
  const out: Rec[] = [];
  for (let i = 1; i <= n; i++) {
    const id = `${opts.prefix ?? 'run'}-${String(i).padStart(2, '0')}`;
    for (const s of ['a', 'b']) {
      for (const k of [0, 1]) {
        out.push({ session: `${id}-${s}`, run: id, ts: `2026-01-0${(i % 9) + 1}T10:0${k}:0${s === 'a' ? 0 : 1}.000Z`, tool: opts.tool ?? 'Bash', action: opts.action?.(i) ?? `npm test --workspace w${i}`, ...(opts.agent !== undefined ? { agent: opts.agent } : {}), ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}) });
      }
    }
  }
  return out;
}

export const NOW = new Date('2026-02-01T12:00:00.000Z');

/** A deterministic 32-byte seed for tests, as hex. */
export function seedHex(i: number): string {
  return i.toString(16).padStart(2, '0').repeat(32);
}

/** A random source that returns the given bytes, standing in for the operating system's. */
export function fixedRandom(hex: string): (n: number) => Buffer {
  return (n: number) => Buffer.from(hex, 'hex').subarray(0, n);
}
