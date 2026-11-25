import type { Bylaws } from '../types.js';

/**
 * A pack's principles (0.25.0). Each one is either checked, naming the rules or guards of the same file that check it
 * (`checked_by`), or advice only (`advisory`), which nothing checks. A principle changes no decision and is never put in
 * an agent's context: it tells the person which part of a pack's promise the engine enforces and which part it does not.
 */
export interface Principle {
  id: string;
  /** Where the principle is stated (an http or https address); optional. */
  source?: string;
  /** Rule ids and guard names of the same file that check it. */
  checked_by?: string[];
  /** Advice for the person, which nothing checks. */
  advisory?: string;
}

export const MAX_PRINCIPLES = 100;
export const MAX_CHECKED_BY = 32;
export const MAX_ADVISORY_CHARS = 1000;
export const MAX_DISCLAIMER_CHARS = 2000;
export const MAX_SOURCE_CHARS = 500;

/** The guard names a `checked_by` entry may use (the keys of `guards:`). */
export const GUARD_NAMES: readonly string[] = ['destructive', 'online-delete', 'secrets', 'self-protect', 'budget', 'loop', 'taint', 'inbound', 'document', 'outbound', 'delete', 'replace'];

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
/** Control characters other than tab and newline. */
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f\u2028\u2029]/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Why a text field is malformed, or null: a non-empty string within `max` characters, without control characters. */
function textProblem(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return 'must be a text (a string)';
  if (v.trim() === '') return 'must not be empty';
  if (v.length > max) return `must be at most ${max} characters (it has ${v.length})`;
  if (CONTROL_RE.test(v)) return 'must not hold control characters';
  return null;
}

/**
 * Whether the file's own settings switch a guard off, so that it checks nothing (a principle cannot name it then).
 * Read on the validated policy of the same file.
 */
export function guardSwitchedOff(name: string, b: Bylaws): boolean {
  const g = b.guards;
  switch (name) {
    case 'destructive':
      return g.destructive.decision === 'allow';
    case 'online-delete':
      return g['online-delete'].decision === 'allow';
    case 'secrets':
      return g.secrets.read === 'allow' && g.secrets.write === 'allow' && g.secrets.send === 'allow';
    case 'self-protect':
      return g['self-protect'].decision === 'allow';
    case 'budget': {
      const off = (l: { soft: number; hard: number } | undefined): boolean => l === undefined || (l.soft === 0 && l.hard === 0);
      return off(g.budget.tool_calls) && off(g.budget.tokens) && off(g.budget.cost);
    }
    case 'loop':
      return g.loop.decision === 'allow';
    case 'taint':
      return g.taint.decision === 'allow';
    case 'inbound':
      return !g.inbound.enabled;
    case 'document':
      return g.document?.decision === 'allow';
    case 'outbound': {
      const o = g.outbound;
      return o !== undefined && [o.credential, o.lookalike, o.ip_host, o.dangerous_target, o.link_mismatch, o.recipient, o.lookalike_credential, o.code_relay].every((d) => d === 'allow');
    }
    case 'delete':
      return g.delete?.decision === 'allow';
    case 'replace':
      return g.replace?.steer !== 'keep';
    default:
      return true;
  }
}

export interface PrinciplesRead {
  principles: Principle[];
  /** The file's `disclaimer:`, or null when it has none or it is malformed. */
  disclaimer: string | null;
  /** One entry per problem, as `path: message` (the bylaws validator's form). */
  errors: string[];
}

/**
 * Reads and checks `principles:` and `disclaimer:` of one file (a pack, or a bylaws file made from one). `raw` is the
 * parsed file; `b` its validated policy (for which guards it switches off). A principle must name what checks it
 * (`checked_by`, each id a rule of this file or a guard listed under this file's `guards:` and not switched off there)
 * or say it is advice only (`advisory`); never both, never neither.
 */
export function readPrinciples(raw: Record<string, unknown>, b: Bylaws): PrinciplesRead {
  const errors: string[] = [];
  const add = (path: string, msg: string): void => {
    errors.push(`${path}: ${msg}`);
  };
  let disclaimer: string | null = null;
  if (raw['disclaimer'] !== undefined) {
    const why = textProblem(raw['disclaimer'], MAX_DISCLAIMER_CHARS);
    if (why !== null) add('disclaimer', why);
    else disclaimer = (raw['disclaimer'] as string).trim();
  }
  const principles: Principle[] = [];
  const v = raw['principles'];
  if (v === undefined) return { principles, disclaimer, errors };
  if (!Array.isArray(v)) {
    add('principles', 'must be a list');
    return { principles, disclaimer, errors };
  }
  if (v.length > MAX_PRINCIPLES) {
    add('principles', `may hold at most ${MAX_PRINCIPLES} principles`);
    return { principles, disclaimer, errors };
  }
  const ruleIds = new Set(b.rules.map((r) => r.id));
  const listed = new Set(isObj(raw['guards']) ? Object.keys(raw['guards']).filter((k) => GUARD_NAMES.includes(k)) : []);
  const seen = new Set<string>();
  v.forEach((item: unknown, idx: number) => {
    const p = `principles[${idx}]`;
    if (!isObj(item)) {
      add(p, 'must be a mapping with id and either checked_by or advisory');
      return;
    }
    for (const k of Object.keys(item)) if (!['id', 'source', 'checked_by', 'advisory'].includes(k)) add(`${p}.${k}`, 'unknown key (allowed: id, source, checked_by, advisory)');
    const id = item['id'];
    if (typeof id !== 'string' || !ID_RE.test(id)) {
      add(`${p}.id`, 'must be 1-64 letters, digits, dots, dashes or underscores');
      return;
    }
    if (seen.has(id)) add(`${p}.id`, `duplicate id ${id}`);
    seen.add(id);
    const out: Principle = { id };
    if (item['source'] !== undefined) {
      const s = item['source'];
      const why = textProblem(s, MAX_SOURCE_CHARS);
      if (why !== null) add(`${p}.source`, why);
      else if (!/^https?:\/\/[^\s/]+\S*$/i.test(s as string)) add(`${p}.source`, 'must be an http or https address');
      else out.source = s as string;
    }
    const hasChecked = item['checked_by'] !== undefined && item['checked_by'] !== null;
    const hasAdvisory = item['advisory'] !== undefined && item['advisory'] !== null;
    if (!hasChecked && !hasAdvisory) {
      add(p, `principle ${id} says neither what checks it (checked_by: rule ids or guard names of this file) nor that it is advice only (advisory: "..."), and a pack may not claim a principle nothing checks`);
      return;
    }
    if (hasChecked && hasAdvisory) {
      add(p, `principle ${id} has both checked_by and advisory: split it into a checked principle and an advice-only one, so the person can tell which part is enforced`);
      return;
    }
    if (hasAdvisory) {
      const why = textProblem(item['advisory'], MAX_ADVISORY_CHARS);
      if (why !== null) add(`${p}.advisory`, why);
      else out.advisory = (item['advisory'] as string).trim();
      principles.push(out);
      return;
    }
    const cb = item['checked_by'];
    if (!Array.isArray(cb) || cb.length === 0 || !cb.every((x: unknown) => typeof x === 'string' && x !== '')) {
      add(`${p}.checked_by`, 'must be a non-empty list of rule ids or guard names');
      return;
    }
    if (cb.length > MAX_CHECKED_BY) {
      add(`${p}.checked_by`, `may name at most ${MAX_CHECKED_BY} rules or guards`);
      return;
    }
    let bad = false;
    for (const ref of cb as string[]) {
      if (ruleIds.has(ref)) continue;
      if (listed.has(ref)) {
        if (guardSwitchedOff(ref, b)) {
          add(`${p}.checked_by`, `${ref} is a guard this file switches off, so it checks nothing`);
          bad = true;
        }
        continue;
      }
      const hint = GUARD_NAMES.includes(ref) ? `the guard ${ref} is not listed under this file's guards: (list it, e.g. ${ref}: {}, so the claim and the setting sit in one file)` : 'no rule or guard of this file has that id';
      add(`${p}.checked_by`, `${JSON.stringify(ref).slice(0, 80)} is not a rule or guard in this file: ${hint}`);
      bad = true;
    }
    if (!bad) principles.push({ ...out, checked_by: [...(cb as string[])] });
  });
  return { principles, disclaimer, errors };
}
