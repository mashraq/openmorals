import type { Bylaws, Decision, Limit } from '../types.js';
import { decisionRank } from '../types.js';

export interface Loosening {
  field: string;
  candidate: string;
  baseline: string;
}

function limitAtLeastAsStrict(c: number, b: number): boolean {
  if (b === 0) return true;
  if (c === 0) return false;
  return c <= b;
}

function cmpDecision(out: Loosening[], field: string, c: Decision, b: Decision): void {
  if (decisionRank(c) < decisionRank(b)) out.push({ field, candidate: c, baseline: b });
}

function cmpLimit(out: Loosening[], field: string, c: Limit, b: Limit): void {
  if (!limitAtLeastAsStrict(c.soft, b.soft)) out.push({ field: `${field}.soft`, candidate: String(c.soft), baseline: String(b.soft) });
  if (!limitAtLeastAsStrict(c.hard, b.hard)) out.push({ field: `${field}.hard`, candidate: String(c.hard), baseline: String(b.hard) });
}

export function loosenings(candidate: Bylaws, baseline: Bylaws): Loosening[] {
  const out: Loosening[] = [];
  const c = candidate.guards;
  const b = baseline.guards;
  cmpDecision(out, 'guards.destructive.decision', c.destructive.decision, b.destructive.decision);
  const allowed = new Set(b.destructive.allow_targets.map((t) => t.toLowerCase()));
  for (const t of c.destructive.allow_targets) {
    if (!allowed.has(t.toLowerCase())) out.push({ field: 'guards.destructive.allow_targets', candidate: t, baseline: '(not allowed)' });
  }
  cmpDecision(out, 'guards.online-delete.decision', c['online-delete'].decision, b['online-delete'].decision);
  cmpDecision(out, 'guards.secrets.read', c.secrets.read, b.secrets.read);
  cmpDecision(out, 'guards.secrets.write', c.secrets.write, b.secrets.write);
  cmpDecision(out, 'guards.secrets.send', c.secrets.send, b.secrets.send);
  if (b.secrets.hard && !c.secrets.hard) out.push({ field: 'guards.secrets.hard', candidate: 'false', baseline: 'true' });
  cmpDecision(out, 'guards.self-protect.decision', c['self-protect'].decision, b['self-protect'].decision);
  cmpLimit(out, 'guards.budget.tool_calls', c.budget.tool_calls, b.budget.tool_calls);
  cmpLimit(out, 'guards.budget.tokens', c.budget.tokens, b.budget.tokens);
  cmpDecision(out, 'guards.loop.decision', c.loop.decision, b.loop.decision);
  cmpDecision(out, 'guards.taint.decision', c.taint.decision, b.taint.decision);
  const trusted = new Set(b.taint.trusted_hosts.map((h) => h.toLowerCase()));
  for (const h of c.taint.trusted_hosts) {
    if (!trusted.has(h.toLowerCase())) out.push({ field: 'guards.taint.trusted_hosts', candidate: h, baseline: '(not trusted)' });
  }
  for (const r of baseline.rules) {
    const m = candidate.rules.find((x) => x.id === r.id);
    if (m === undefined) {
      out.push({ field: `rules.${r.id}`, candidate: '(missing)', baseline: r.decision });
      continue;
    }
    cmpDecision(out, `rules.${r.id}.decision`, m.decision, r.decision);
    if (r.hard && !m.hard) out.push({ field: `rules.${r.id}.hard`, candidate: 'false', baseline: 'true' });
    for (const f of ['tool', 'command', 'path'] as const) {
      if (m.match[f] !== r.match[f]) out.push({ field: `rules.${r.id}.match.${f}`, candidate: m.match[f] ?? '(none)', baseline: r.match[f] ?? '(none)' });
    }
  }
  if (baseline.audit.enabled && !candidate.audit.enabled) out.push({ field: 'audit.enabled', candidate: 'false', baseline: 'true' });
  if (baseline.reviewer.enabled && !candidate.reviewer.enabled) out.push({ field: 'reviewer.enabled', candidate: 'false', baseline: 'true' });
  cmpDecision(out, 'reviewer.on_escalate', candidate.reviewer.on_escalate, baseline.reviewer.on_escalate);
  const hosts = new Set(baseline.sandbox.network.allow_hosts);
  for (const h of candidate.sandbox.network.allow_hosts) if (!hosts.has(h)) out.push({ field: 'sandbox.network.allow_hosts', candidate: h, baseline: '(not allowed)' });
  const writes = new Set(baseline.sandbox.write.allow);
  for (const w of candidate.sandbox.write.allow) if (!writes.has(w)) out.push({ field: 'sandbox.write.allow', candidate: w, baseline: '(not writable)' });
  const denied = new Set(candidate.sandbox.read.deny);
  for (const d of baseline.sandbox.read.deny) if (!denied.has(d)) out.push({ field: 'sandbox.read.deny', candidate: '(readable)', baseline: d });
  return out;
}
