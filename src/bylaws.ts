import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse as parsePath } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { configDir } from './paths.js';
import type { Bylaws, BylawsLoad, Decision, Limit, Rule, RuleMatch } from './types.js';
import { isDecision } from './types.js';

export const BYLAWS_FILENAMES = ['openmorals.yaml', 'openmorals.yml'] as const;

export const DEFAULT_BYLAWS_YAML = `# openmorals.yaml: the bylaws your coding agent works under.
# Every decision is one of: allow | ask | deny.
#   allow = openmorals does not object (the agent's own permission prompts still apply)
#   ask   = the agent's host asks you before the action runs
#   deny  = the action is refused and the agent is told why
# If this file cannot be read or is invalid, openmorals fails closed: it uses the
# defaults below and asks before anything it would otherwise allow.
version: 1

guards:
  destructive:
    # Recursive, forced or wildcard deletes, git push --force, git reset --hard,
    # git clean -f, DROP TABLE / TRUNCATE, disk formatting.
    decision: ask
    # Relative paths that may be deleted without asking, e.g. build output.
    # Only plain relative names count: no "..", no "~", no absolute paths, no wildcards.
    allow_targets: []
    #   - node_modules
    #   - dist

  online-delete:
    # gh repo delete, aws s3 rm, gcloud ... delete, kubectl delete,
    # terraform destroy, npm unpublish, HTTP DELETE requests.
    decision: ask

  secrets:
    # Reading .env files, ~/.ssh, cloud credentials and key files.
    read: ask
    # Writing to those files.
    write: ask
    # A command line that reads a secret AND talks to the network.
    send: deny
    # hard: if this guard ever fails internally, deny instead of ask.
    hard: true

  self-protect:
    # Changes to this file, to .claude/settings.json and to the audit log.
    decision: ask

  budget:
    # Per session. "ask" when the count passes soft (and again every "step"
    # after that), "deny" at hard. Set a value to 0 to switch that check off.
    tool_calls: { soft: 400, hard: 1500, step: 100 }
    # Tokens are only counted when the adapter supplies them
    # (the Claude Code adapter does not yet: see ROADMAP.md).
    tokens: { soft: 2000000, hard: 5000000, step: 500000 }

# Your own rules. Each adds an ask or a deny; a rule cannot loosen a guard.
# match fields are case-insensitive regular expressions; every field given must match.
#   tool:    the tool name (Bash, PowerShell, Read, Write, Edit, ...)
#   command: the full command line (Bash and PowerShell tools)
#   path:    a file path the action touches (or any argument of a command)
rules: []
#  - id: no-production
#    match: { command: "\\\\bprod(uction)?\\\\b" }
#    decision: deny
#    reason: Production is off limits to agents.
#    hard: true

audit:
  # Append every decision to audit.jsonl in the openmorals config directory.
  enabled: true
`;

function limit(soft: number, hard: number, step: number): Limit {
  return { soft, hard, step };
}

export const DEFAULT_BYLAWS: Bylaws = {
  version: 1,
  guards: {
    destructive: { decision: 'ask', allow_targets: [] },
    'online-delete': { decision: 'ask' },
    secrets: { read: 'ask', write: 'ask', send: 'deny', hard: true },
    'self-protect': { decision: 'ask' },
    budget: { tool_calls: limit(400, 1500, 100), tokens: limit(2000000, 5000000, 500000) },
  },
  rules: [],
  audit: { enabled: true },
};

export function cloneBylaws(b: Bylaws): Bylaws {
  return JSON.parse(JSON.stringify(b)) as Bylaws;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

class Errors {
  list: string[] = [];
  add(path: string, msg: string): void {
    this.list.push(`${path}: ${msg}`);
  }
}

function checkKeys(o: Obj, allowed: readonly string[], path: string, e: Errors): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) e.add(`${path}.${k}`, `unknown key (allowed: ${allowed.join(', ')})`);
}

function section(o: Obj, key: string, path: string, e: Errors): Obj | null {
  const v = o[key];
  if (v === undefined || v === null) return null;
  if (!isObj(v)) {
    e.add(`${path}.${key}`, 'must be a mapping');
    return null;
  }
  return v;
}

function readDecision(o: Obj, key: string, path: string, fallback: Decision, e: Errors): Decision {
  const v = o[key];
  if (v === undefined) return fallback;
  if (!isDecision(v)) {
    e.add(`${path}.${key}`, `must be allow, ask or deny (got ${JSON.stringify(v)})`);
    return fallback;
  }
  return v;
}

function readBool(o: Obj, key: string, path: string, fallback: boolean, e: Errors): boolean {
  const v = o[key];
  if (v === undefined) return fallback;
  if (typeof v !== 'boolean') {
    e.add(`${path}.${key}`, 'must be true or false');
    return fallback;
  }
  return v;
}

function readLimit(o: Obj, key: string, path: string, fallback: Limit, e: Errors): Limit {
  const v = section(o, key, path, e);
  if (v === null) return { ...fallback };
  checkKeys(v, ['soft', 'hard', 'step'], `${path}.${key}`, e);
  const out = { ...fallback };
  for (const f of ['soft', 'hard', 'step'] as const) {
    const n = v[f];
    if (n === undefined) continue;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || !Number.isInteger(n)) e.add(`${path}.${key}.${f}`, 'must be a whole number, 0 or more');
    else out[f] = n;
  }
  if (out.hard > 0 && out.soft > out.hard) e.add(`${path}.${key}`, 'soft must not be above hard');
  if (out.step < 1) out.step = 1;
  return out;
}

export function compileRuleRegex(source: string): RegExp {
  return new RegExp(source, 'i');
}

function readRules(v: unknown, e: Errors): Rule[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    e.add('rules', 'must be a list');
    return [];
  }
  const out: Rule[] = [];
  const seen = new Set<string>();
  v.forEach((item: unknown, idx: number) => {
    const p = `rules[${idx}]`;
    if (!isObj(item)) {
      e.add(p, 'must be a mapping');
      return;
    }
    checkKeys(item, ['id', 'match', 'decision', 'reason', 'hard'], p, e);
    const id = item['id'];
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) {
      e.add(`${p}.id`, 'must be 1-64 letters, digits, dots, dashes or underscores');
      return;
    }
    if (seen.has(id)) e.add(`${p}.id`, `duplicate id ${id}`);
    seen.add(id);
    const decision = item['decision'];
    if (decision !== 'ask' && decision !== 'deny') {
      e.add(`${p}.decision`, 'must be ask or deny (a rule can only add a check, never loosen one)');
      return;
    }
    const m = item['match'];
    if (!isObj(m)) {
      e.add(`${p}.match`, 'must be a mapping with at least one of tool, command, path');
      return;
    }
    checkKeys(m, ['tool', 'command', 'path'], `${p}.match`, e);
    const match: RuleMatch = {};
    for (const f of ['tool', 'command', 'path'] as const) {
      const s = m[f];
      if (s === undefined) continue;
      if (typeof s !== 'string' || s === '') {
        e.add(`${p}.match.${f}`, 'must be a non-empty string (a regular expression)');
        continue;
      }
      try {
        compileRuleRegex(s);
        match[f] = s;
      } catch (err: unknown) {
        e.add(`${p}.match.${f}`, `invalid regular expression: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (Object.keys(match).length === 0) {
      e.add(`${p}.match`, 'needs at least one of tool, command, path');
      return;
    }
    const reason = item['reason'];
    if (reason !== undefined && typeof reason !== 'string') e.add(`${p}.reason`, 'must be a string');
    const hard = readBool(item, 'hard', p, false, e);
    out.push({ id, match, decision, reason: typeof reason === 'string' ? reason : `matched your rule ${id}`, hard });
  });
  return out;
}

export function validateBylaws(raw: unknown, source = '<memory>'): BylawsLoad {
  const e = new Errors();
  if (raw === null || raw === undefined) return { ok: true, bylaws: cloneBylaws(DEFAULT_BYLAWS), source };
  if (!isObj(raw)) return { ok: false, error: 'the file must be a YAML mapping', source };
  checkKeys(raw, ['version', 'guards', 'rules', 'audit'], '', e);
  if (raw['version'] !== 1) e.add('version', 'must be 1');
  const d = DEFAULT_BYLAWS.guards;
  const b = cloneBylaws(DEFAULT_BYLAWS);
  const g = section(raw, 'guards', '', e);
  if (g !== null) {
    checkKeys(g, ['destructive', 'online-delete', 'secrets', 'self-protect', 'budget'], '.guards', e);
    const ds = section(g, 'destructive', '.guards', e);
    if (ds !== null) {
      checkKeys(ds, ['decision', 'allow_targets'], '.guards.destructive', e);
      b.guards.destructive.decision = readDecision(ds, 'decision', '.guards.destructive', d.destructive.decision, e);
      const at = ds['allow_targets'];
      if (at !== undefined && at !== null) {
        if (!Array.isArray(at) || !at.every((x: unknown) => typeof x === 'string' && x !== '')) e.add('.guards.destructive.allow_targets', 'must be a list of non-empty strings');
        else b.guards.destructive.allow_targets = at.map((x: unknown) => String(x));
      }
    }
    const od = section(g, 'online-delete', '.guards', e);
    if (od !== null) {
      checkKeys(od, ['decision'], '.guards.online-delete', e);
      b.guards['online-delete'].decision = readDecision(od, 'decision', '.guards.online-delete', d['online-delete'].decision, e);
    }
    const se = section(g, 'secrets', '.guards', e);
    if (se !== null) {
      checkKeys(se, ['read', 'write', 'send', 'hard'], '.guards.secrets', e);
      b.guards.secrets.read = readDecision(se, 'read', '.guards.secrets', d.secrets.read, e);
      b.guards.secrets.write = readDecision(se, 'write', '.guards.secrets', d.secrets.write, e);
      b.guards.secrets.send = readDecision(se, 'send', '.guards.secrets', d.secrets.send, e);
      b.guards.secrets.hard = readBool(se, 'hard', '.guards.secrets', d.secrets.hard, e);
    }
    const sp = section(g, 'self-protect', '.guards', e);
    if (sp !== null) {
      checkKeys(sp, ['decision'], '.guards.self-protect', e);
      b.guards['self-protect'].decision = readDecision(sp, 'decision', '.guards.self-protect', d['self-protect'].decision, e);
    }
    const bu = section(g, 'budget', '.guards', e);
    if (bu !== null) {
      checkKeys(bu, ['tool_calls', 'tokens'], '.guards.budget', e);
      b.guards.budget.tool_calls = readLimit(bu, 'tool_calls', '.guards.budget', d.budget.tool_calls, e);
      b.guards.budget.tokens = readLimit(bu, 'tokens', '.guards.budget', d.budget.tokens, e);
    }
  }
  b.rules = readRules(raw['rules'], e);
  const au = section(raw, 'audit', '', e);
  if (au !== null) {
    checkKeys(au, ['enabled'], '.audit', e);
    b.audit.enabled = readBool(au, 'enabled', '.audit', true, e);
  }
  if (e.list.length > 0) return { ok: false, error: e.list.map((x) => x.replace(/^\./, '')).join('; '), source };
  return { ok: true, bylaws: b, source };
}

export function parseBylaws(text: string, source = '<memory>'): BylawsLoad {
  let raw: unknown;
  try {
    raw = parseYaml(text, { strict: true, uniqueKeys: true, maxAliasCount: 50 });
  } catch (err: unknown) {
    return { ok: false, error: `YAML parse error: ${err instanceof Error ? err.message.split('\n')[0] ?? '' : String(err)}`, source };
  }
  return validateBylaws(raw, source);
}

export function loadBylaws(file: string): BylawsLoad {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err: unknown) {
    return { ok: false, error: `cannot read: ${err instanceof Error ? err.message : String(err)}`, source: file };
  }
  return parseBylaws(text, file);
}

export function findBylaws(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < 64; i++) {
    for (const name of BYLAWS_FILENAMES) {
      const f = join(dir, name);
      if (existsSync(f)) return f;
    }
    const up = dirname(dir);
    if (up === dir || dir === parsePath(dir).root) break;
    dir = up;
  }
  return null;
}

export function resolveBylaws(cwd: string, env: NodeJS.ProcessEnv = process.env): BylawsLoad {
  const project = findBylaws(cwd);
  if (project !== null) return loadBylaws(project);
  for (const name of BYLAWS_FILENAMES) {
    const user = join(configDir(env), name);
    if (existsSync(user)) return loadBylaws(user);
  }
  return { ok: true, bylaws: cloneBylaws(DEFAULT_BYLAWS), source: '<defaults>' };
}

export function stringifyBylaws(b: Bylaws): string {
  return stringifyYaml(b, { lineWidth: 0 });
}
