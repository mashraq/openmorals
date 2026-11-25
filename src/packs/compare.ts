import { matchesAllowTarget } from '../guards/destructive.js';
import { defaultDocumentBylaws } from '../guards/document.js';
import { defaultDataClass, defaultOutboundBylaws } from '../outbound/guard.js';
import type { Bylaws, Decision, Limit, Loosening } from '../types.js';
import { DATA_CLASSES, decisionRank } from '../types.js';

export type { Loosening } from '../types.js';

/**
 * The `candidate` of an `ignored` entry for a project rule that shares an id with a user rule.
 * Nothing was loosened: the project's rule is kept beside the user's, which is unchanged.
 */
export const RULE_KEPT_BESIDE = '(changed copy, added beside the user rule)';

/** True for an `ignored` entry that records a project rule kept beside a user rule of the same id. */
export function isRuleKeptBeside(l: Loosening): boolean {
  return l.field.startsWith('rules.') && l.candidate === RULE_KEPT_BESIDE;
}

function limitAtLeastAsStrict(c: number, b: number): boolean {
  if (b === 0) return true;
  if (c === 0) return false;
  return c <= b;
}

/**
 * One walk over every setting that can loosen a policy. With `fix` off it only reports; with `fix`
 * on it also writes the baseline value back into `c` wherever `c` is looser, so the result is at
 * least as strict as `b` field by field. `loosenings` (packs) and `tighten` (the user floor) both
 * call this, so the two can never disagree about what counts as looser.
 */
function walk(c: Bylaws, b: Bylaws, fix: boolean): Loosening[] {
  const out: Loosening[] = [];
  const dec = (field: string, cv: Decision, bv: Decision, set: (d: Decision) => void): void => {
    if (decisionRank(cv) < decisionRank(bv)) {
      out.push({ field, candidate: cv, baseline: bv });
      if (fix) set(bv);
    }
  };
  const flag = (field: string, cv: boolean, bv: boolean, set: () => void): void => {
    if (bv && !cv) {
      out.push({ field, candidate: 'false', baseline: 'true' });
      if (fix) set();
    }
  };
  const lim = (field: string, cl: Limit, bl: Limit): void => {
    for (const f of ['soft', 'hard', 'step'] as const) {
      if (f === 'step' && cl.soft === 0) continue;
      if (!limitAtLeastAsStrict(cl[f], bl[f])) {
        out.push({ field: `${field}.${f}`, candidate: String(cl[f]), baseline: String(bl[f]) });
        if (fix) cl[f] = bl[f];
      }
    }
    if (fix && cl.hard > 0 && cl.soft > cl.hard) cl.soft = cl.hard;
  };
  /** An exemption list: every candidate entry must already be exempt in the baseline. */
  const exempt = (field: string, list: string[], ok: (x: string) => boolean, none: string, set: (l: string[]) => void): void => {
    const bad = list.filter((x) => !ok(x));
    for (const x of bad) out.push({ field, candidate: x, baseline: none });
    if (fix && bad.length > 0) set(list.filter(ok));
  };
  /** A protected list: every baseline entry must still be in the candidate. */
  const kept = (field: string, list: string[], base: readonly string[], set: (l: string[]) => void): void => {
    const missing = base.filter((x) => !list.includes(x));
    for (const x of missing) out.push({ field, candidate: '(missing)', baseline: x });
    if (fix && missing.length > 0) set([...list, ...missing]);
  };
  const cg = c.guards;
  const bg = b.guards;
  dec('guards.destructive.decision', cg.destructive.decision, bg.destructive.decision, (d) => (cg.destructive.decision = d));
  exempt('guards.destructive.allow_targets', cg.destructive.allow_targets, (t) => matchesAllowTarget(t, bg.destructive.allow_targets), '(not allowed)', (l) => (cg.destructive.allow_targets = l));
  dec('guards.online-delete.decision', cg['online-delete'].decision, bg['online-delete'].decision, (d) => (cg['online-delete'].decision = d));
  dec('guards.secrets.read', cg.secrets.read, bg.secrets.read, (d) => (cg.secrets.read = d));
  dec('guards.secrets.write', cg.secrets.write, bg.secrets.write, (d) => (cg.secrets.write = d));
  dec('guards.secrets.send', cg.secrets.send, bg.secrets.send, (d) => (cg.secrets.send = d));
  flag('guards.secrets.hard', cg.secrets.hard, bg.secrets.hard, () => (cg.secrets.hard = true));
  dec('guards.self-protect.decision', cg['self-protect'].decision, bg['self-protect'].decision, (d) => (cg['self-protect'].decision = d));
  lim('guards.budget.tool_calls', cg.budget.tool_calls, bg.budget.tool_calls);
  lim('guards.budget.tokens', cg.budget.tokens, bg.budget.tokens);
  if (bg.budget.cost !== undefined) {
    if (cg.budget.cost === undefined) {
      if (bg.budget.cost.soft > 0 || bg.budget.cost.hard > 0) out.push({ field: 'guards.budget.cost', candidate: '(missing)', baseline: `${bg.budget.cost.soft}/${bg.budget.cost.hard}` });
      if (fix) cg.budget.cost = { ...bg.budget.cost };
    } else lim('guards.budget.cost', cg.budget.cost, bg.budget.cost);
  }
  dec('guards.loop.decision', cg.loop.decision, bg.loop.decision, (d) => (cg.loop.decision = d));
  dec('guards.taint.decision', cg.taint.decision, bg.taint.decision, (d) => (cg.taint.decision = d));
  const trusted = new Set(bg.taint.trusted_hosts.map((h) => h.toLowerCase()));
  exempt('guards.taint.trusted_hosts', cg.taint.trusted_hosts, (h) => trusted.has(h.toLowerCase()), '(not trusted)', (l) => (cg.taint.trusted_hosts = l));
  kept('guards.taint.private_paths', cg.taint.private_paths ?? [], bg.taint.private_paths ?? [], (l) => (cg.taint.private_paths = l));
  flag('guards.inbound.enabled', cg.inbound.enabled, bg.inbound.enabled, () => (cg.inbound.enabled = true));
  dec('guards.inbound.decision', cg.inbound.decision, bg.inbound.decision, (d) => (cg.inbound.decision = d));
  if (cg.inbound.max_bytes < bg.inbound.max_bytes) {
    out.push({ field: 'guards.inbound.max_bytes', candidate: String(cg.inbound.max_bytes), baseline: String(bg.inbound.max_bytes) });
    if (fix) cg.inbound.max_bytes = bg.inbound.max_bytes;
  }
  const cd = cg.document ?? (cg.document = defaultDocumentBylaws());
  const bd = bg.document ?? defaultDocumentBylaws();
  dec('guards.document.decision', cd.decision, bd.decision, (d) => (cd.decision = d));
  if (cd.shrink_percent > bd.shrink_percent) {
    out.push({ field: 'guards.document.shrink_percent', candidate: String(cd.shrink_percent), baseline: String(bd.shrink_percent) });
    if (fix) cd.shrink_percent = bd.shrink_percent;
  }
  if (cd.min_removed_bytes > bd.min_removed_bytes) {
    out.push({ field: 'guards.document.min_removed_bytes', candidate: String(cd.min_removed_bytes), baseline: String(bd.min_removed_bytes) });
    if (fix) cd.min_removed_bytes = bd.min_removed_bytes;
  }
  kept('guards.document.extensions', cd.extensions, bd.extensions, (l) => (cd.extensions = l));
  const excluded = new Set(bd.exclude);
  exempt('guards.document.exclude', cd.exclude, (x) => excluded.has(x), '(not excluded)', (l) => (cd.exclude = l));
  const co = cg.outbound ?? (cg.outbound = defaultOutboundBylaws());
  const bo = bg.outbound ?? defaultOutboundBylaws();
  for (const k of ['credential', 'lookalike', 'ip_host', 'dangerous_target', 'link_mismatch', 'recipient'] as const) dec(`guards.outbound.${k}`, co[k], bo[k], (d) => (co[k] = d));
  for (const k of ['lookalike_credential', 'code_relay'] as const) dec(`guards.outbound.${k}`, co[k], bo[k], (d) => (co[k] = d === 'deny' ? 'deny' : 'ask'));
  if (co.code_minutes < bo.code_minutes) {
    out.push({ field: 'guards.outbound.code_minutes', candidate: String(co.code_minutes), baseline: String(bo.code_minutes) });
    if (fix) co.code_minutes = bo.code_minutes;
  }
  const baseSites = new Set(b.sites ?? []);
  exempt('sites', c.sites ?? [], (x) => baseSites.has(x), '(not listed)', (l) => (c.sites = l));
  for (const k of DATA_CLASSES) {
    const cc = c.data_classes?.[k] ?? defaultDataClass(k);
    const bc = b.data_classes?.[k] ?? defaultDataClass(k);
    const put = (v: { decision: Decision; sites: string[] }): void => {
      c.data_classes = { ...(c.data_classes ?? {}), [k]: v };
    };
    dec(`data_classes.${k}.decision`, cc.decision, bc.decision, (d) => put({ ...cc, decision: d }));
    const classSites = new Set(bc.sites);
    exempt(`data_classes.${k}.sites`, cc.sites, (x) => classSites.has(x), '(not listed)', (l) => put({ ...(c.data_classes?.[k] ?? cc), sites: l }));
  }
  for (const r of b.rules) {
    const m = c.rules.find((x) => x.id === r.id);
    if (m === undefined) {
      out.push({ field: `rules.${r.id}`, candidate: '(missing)', baseline: r.decision });
      if (fix) c.rules.push({ ...r, match: { ...r.match } });
      continue;
    }
    dec(`rules.${r.id}.decision`, m.decision, r.decision, (d) => (m.decision = d === 'deny' ? 'deny' : 'ask'));
    flag(`rules.${r.id}.hard`, m.hard, r.hard, () => (m.hard = true));
    for (const f of ['tool', 'command', 'path', 'content', 'detector', 'network'] as const) {
      const cv = m.match[f] === undefined ? '(none)' : typeof m.match[f] === 'string' ? (m.match[f] as string) : JSON.stringify(m.match[f]);
      const bv = r.match[f] === undefined ? '(none)' : typeof r.match[f] === 'string' ? (r.match[f] as string) : JSON.stringify(r.match[f]);
      if (cv !== bv) {
        out.push({ field: `rules.${r.id}.match.${f}`, candidate: cv, baseline: bv });
        if (fix) m.match = { ...r.match };
      }
    }
  }
  flag('audit.enabled', c.audit.enabled, b.audit.enabled, () => (c.audit.enabled = true));
  flag('defer', c.defer ?? false, b.defer ?? false, () => (c.defer = true));
  flag('reviewer.enabled', c.reviewer.enabled, b.reviewer.enabled, () => (c.reviewer.enabled = true));
  dec('reviewer.on_escalate', c.reviewer.on_escalate, b.reviewer.on_escalate, (d) => (c.reviewer.on_escalate = d === 'deny' ? 'deny' : 'ask'));
  const hosts = new Set(b.sandbox.network.allow_hosts);
  exempt('sandbox.network.allow_hosts', c.sandbox.network.allow_hosts, (h) => hosts.has(h), '(not allowed)', (l) => (c.sandbox.network.allow_hosts = l));
  const writes = new Set(b.sandbox.write.allow);
  exempt('sandbox.write.allow', c.sandbox.write.allow, (w) => writes.has(w), '(not writable)', (l) => (c.sandbox.write.allow = l));
  kept('sandbox.read.deny', c.sandbox.read.deny, b.sandbox.read.deny, (l) => (c.sandbox.read.deny = l));
  kept('sandbox.write.protected_paths', c.sandbox.write.protected_paths ?? [], b.sandbox.write.protected_paths ?? [], (l) => (c.sandbox.write.protected_paths = l));
  const baseFree = b.merge?.review_free ?? [];
  exempt('merge.review_free', c.merge?.review_free ?? [], (x) => baseFree.some((y) => y === x), '(not switched on)', (l) => (c.merge = { ...c.merge, review_free: baseFree.filter((y) => l.includes(y)), always_review: c.merge?.always_review ?? [] }));
  kept('merge.always_review', c.merge?.always_review ?? [], b.merge?.always_review ?? [], (l) => (c.merge = { ...c.merge, review_free: c.merge?.review_free ?? [], always_review: l }));
  kept('merge.boundary_paths', c.merge?.boundary_paths ?? [], b.merge?.boundary_paths ?? [], (l) => (c.merge = { ...c.merge, review_free: c.merge?.review_free ?? [], always_review: c.merge?.always_review ?? [], boundary_paths: l }));
  return out;
}

/** Every setting in which `candidate` is looser than `baseline` (a pack against the defaults, a team file against a personal one). */
export function loosenings(candidate: Bylaws, baseline: Bylaws): Loosening[] {
  return walk(JSON.parse(JSON.stringify(candidate)) as Bylaws, baseline, false);
}

/**
 * Settings that only the user-level file may set: where the reviewer sends text, under which key
 * and model, and how long it may take; (0.17.0) the sandbox's protected paths; and (0.20.0) `sites`
 * and `data_classes`. A project file naming them is ignored (and reported).
 */
function userOnly(c: Bylaws, floor: Bylaws, out: Loosening[]): void {
  const r = c.reviewer;
  const f = floor.reviewer;
  for (const k of ['provider', 'model', 'api_key_env', 'timeout_ms', 'base_url', 'auth'] as const) {
    if (r[k] !== f[k]) out.push({ field: `reviewer.${k}`, candidate: String(r[k] ?? '(unset)'), baseline: `${String(f[k] ?? '(unset)')} (user-level only)` });
  }
  if (JSON.stringify(r.compat ?? null) !== JSON.stringify(f.compat ?? null)) out.push({ field: 'reviewer.compat', candidate: JSON.stringify(r.compat ?? null), baseline: `${JSON.stringify(f.compat ?? null)} (user-level only)` });
  if (r.enabled !== f.enabled) out.push({ field: 'reviewer.enabled', candidate: String(r.enabled), baseline: `${String(f.enabled)} (user-level only)` });
  if (c.guards.inbound.notify !== floor.guards.inbound.notify) out.push({ field: 'guards.inbound.notify', candidate: String(c.guards.inbound.notify), baseline: `${String(floor.guards.inbound.notify)} (user-level only)` });
  if ((c.guards.inbound.judge ?? false) !== (floor.guards.inbound.judge ?? false)) out.push({ field: 'guards.inbound.judge', candidate: String(c.guards.inbound.judge ?? false), baseline: `${String(floor.guards.inbound.judge ?? false)} (user-level only)` });
  c.reviewer = { ...f, on_escalate: r.on_escalate };
  c.guards.inbound.notify = floor.guards.inbound.notify;
  if (JSON.stringify(c.guards.budget.prices ?? {}) !== JSON.stringify(floor.guards.budget.prices ?? {})) out.push({ field: 'guards.budget.prices', candidate: `${Object.keys(c.guards.budget.prices ?? {}).length} models`, baseline: `${Object.keys(floor.guards.budget.prices ?? {}).length} models (user-level only)` });
  if (JSON.stringify(c.sites ?? []) !== JSON.stringify(floor.sites ?? [])) out.push({ field: 'sites', candidate: `${(c.sites ?? []).length} sites`, baseline: `${(floor.sites ?? []).length} sites (user-level only)` });
  if (floor.sites === undefined) delete c.sites;
  else c.sites = [...floor.sites];
  if (JSON.stringify(c.data_classes ?? {}) !== JSON.stringify(floor.data_classes ?? {})) out.push({ field: 'data_classes', candidate: JSON.stringify(c.data_classes ?? {}).slice(0, 120), baseline: `${JSON.stringify(floor.data_classes ?? {}).slice(0, 120)} (user-level only)` });
  if (floor.data_classes === undefined) delete c.data_classes;
  else c.data_classes = JSON.parse(JSON.stringify(floor.data_classes)) as NonNullable<Bylaws['data_classes']>;
  const cp = c.sandbox.write.protected_paths;
  const fp = floor.sandbox.write.protected_paths;
  if (JSON.stringify(cp ?? []) !== JSON.stringify(fp ?? [])) out.push({ field: 'sandbox.write.protected_paths', candidate: JSON.stringify(cp ?? []), baseline: `${JSON.stringify(fp ?? [])} (user-level only)` });
  if (fp === undefined) delete c.sandbox.write.protected_paths;
  else c.sandbox.write.protected_paths = [...fp];
  if (floor.guards.budget.prices === undefined) delete c.guards.budget.prices;
  else c.guards.budget.prices = { ...floor.guards.budget.prices };
  if (floor.guards.inbound.judge === undefined) delete c.guards.inbound.judge;
  else c.guards.inbound.judge = floor.guards.inbound.judge;
}

/**
 * The user floor: merges a project file over the user-level bylaws so the result is never looser
 * than `floor` in any setting. A project may add rules, raise a decision, lower a limit, drop an
 * exemption and add a protected path; anything looser is replaced by the floor's value and listed.
 * The user's rules are always kept as written; the project's rules are added beside them.
 */
export function tighten(candidate: Bylaws, floor: Bylaws): { bylaws: Bylaws; ignored: Loosening[] } {
  const c = JSON.parse(JSON.stringify(candidate)) as Bylaws;
  const ignored: Loosening[] = [];
  userOnly(c, floor, ignored);
  const sameRule = (a: Bylaws['rules'][number], b: Bylaws['rules'][number]): boolean => JSON.stringify(a) === JSON.stringify(b);
  const projectRules = c.rules.filter((r) => !floor.rules.some((u) => sameRule(u, r)));
  for (const r of projectRules) {
    if (floor.rules.some((u) => u.id === r.id)) ignored.push({ field: `rules.${r.id}`, candidate: RULE_KEPT_BESIDE, baseline: '(user rule kept as written)' });
  }
  c.rules = [...floor.rules.map((r) => ({ ...r, match: { ...r.match } })), ...projectRules];
  ignored.push(...walk(c, floor, true));
  return { bylaws: c, ignored };
}
