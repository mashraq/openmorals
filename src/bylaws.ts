import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse as parsePath, resolve as resolvePath } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { tighten } from './packs/compare.js';
import { configDir } from './paths.js';
import { validateSandboxSection } from './sandbox/section.js';
import { baseUrlProblem, keyEnvNameProblem } from './reviewer/http.js';
import type { Bylaws, BylawsLoad, Decision, Limit, ModelPrice, ReviewerCompat, ReviewerProviderName, Rule, RuleMatch } from './types.js';
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
    # Tokens are only counted where the host reports them: Codex (PostModelRequest)
    # and OpenClaw (llm_output). Claude Code, Gemini CLI and opencode do not, so
    # there only tool calls are counted (see docs/adapters.md).
    tokens: { soft: 2000000, hard: 5000000, step: 500000 }
    # Spend, in hundredths of your price table's currency (cents for dollars).
    # Off (0) by default; it only counts models listed under prices.
    cost: { soft: 0, hard: 0, step: 100 }
    # Your own prices per million tokens, by the model id the host reports. Empty by
    # default: openmorals ships no prices. User-level file only. For example:
    #   prices:
    #     example-model-small: { input: 0.25, output: 1.25 }
    prices: {}

  loop:
    # The same command again and again with nothing written in between, a polling
    # loop (sleep / tail / ps), or the same failure repeated. "allow" switches it off.
    decision: ask

  taint:
    # Rule of Two: once untrusted content has entered the session (a web page, MCP
    # tool output, a file from outside the project), a step that touches private
    # data AND reaches the network gets this decision. "allow" switches it off.
    decision: ask
    # Hosts whose pages do not count as untrusted. "docs.example.com" is exact;
    # ".example.com" covers its subdomains.
    trusted_hosts: []

  inbound:
    # Scan tool results, fetched pages and the prompts you submit for hidden
    # instructions: invisible characters, HTML comments addressed to the agent,
    # base64 that decodes to instructions, and instruction-override phrases.
    # A finding in a tool result marks the session as tainted and is written to
    # the audit log, silently: no tokens are spent until a later step that reaches
    # the network or private data is stopped (taint above). Reading is never blocked.
    # In a prompt, hidden characters get this decision (ask warns you, deny blocks
    # the message); a secret-shaped value gets secrets.send; phrases and comments
    # in your own words only mark the session.
    enabled: true
    decision: ask
    # Also tell the agent about each finding in a tool result (a short notice that
    # stays in its context and is re-sent with every later call, so it costs tokens).
    notify: false
    # The most bytes of one result or prompt that are scanned (the first and the
    # last half). From 4096 to 8388608.
    max_bytes: 262144
    # Opt-in, user-level file only: send the lines a weak finding in a tool result
    # flagged (text that reads like an instruction; at most 1,000 characters,
    # redacted, cached by hash) to the reviewer's provider. Its only possible effect
    # is to confirm an injection, so later network or private-data steps ask. Costs
    # tokens per new flagged span; off by default.
    judge: false

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

reviewer:
  # A second model looks at each "ask" before you are asked, and adds its note to
  # the reason. It can never allow anything: "no-objection" still asks you, and
  # "escalate" keeps the ask (or denies, with on_escalate: deny). Off by default,
  # because it sends the redacted action text to a model API.
  # Only the user-level file (in the openmorals config directory) can set where the
  # reviewer sends text, with which key and model: a project file cannot.
  enabled: false
  provider: anthropic-messages   # anthropic-messages | openai-chat | gemini | fake (a dry run that sends nothing)
  model: claude-haiku-5-5
  api_key_env: ANTHROPIC_API_KEY   # the NAME of the variable holding the key
  timeout_ms: 8000         # at most 25000, below the hook's 30-second timeout
  on_escalate: ask
  # base_url: https://api.openai.com/v1   # optional; https, or http to this machine only
  # auth: none                            # for a local server that needs no key (e.g. Ollama)
  # compat: { token_param: max_completion_tokens, system_role: developer }   # openai-chat only

sandbox:
  # Used only by "openmorals sandbox plan" and "openmorals sandbox run -- <cmd>",
  # which run a command under an OS sandbox (macOS sandbox-exec, Linux bubblewrap;
  # Windows gets a written plan only). Writes are allowed only in the project and
  # the temp folders, credential files cannot be read, and the network is off.
  network:
    allow_hosts: []        # host names or *.example.com; only srt can filter by host
  write:
    allow: []              # extra writable folders (~/ and project-relative accepted)
  read:
    deny: []               # extra folders the command may not read
`;

function limit(soft: number, hard: number, step: number): Limit {
  return { soft, hard, step };
}

export const INBOUND_MAX_BYTES_DEFAULT = 262144;

export const DEFAULT_BYLAWS: Bylaws = {
  version: 1,
  guards: {
    destructive: { decision: 'ask', allow_targets: [] },
    'online-delete': { decision: 'ask' },
    secrets: { read: 'ask', write: 'ask', send: 'deny', hard: true },
    'self-protect': { decision: 'ask' },
    budget: { tool_calls: limit(400, 1500, 100), tokens: limit(2000000, 5000000, 500000), cost: limit(0, 0, 100), prices: {} },
    loop: { decision: 'ask' },
    taint: { decision: 'ask', trusted_hosts: [] },
    inbound: { enabled: true, decision: 'ask', notify: false, max_bytes: INBOUND_MAX_BYTES_DEFAULT, judge: false },
  },
  rules: [],
  audit: { enabled: true },
  reviewer: { enabled: false, provider: 'anthropic-messages', model: 'claude-haiku-5-5', api_key_env: 'ANTHROPIC_API_KEY', timeout_ms: 8000, on_escalate: 'ask' },
  sandbox: { network: { allow_hosts: [] }, write: { allow: [] }, read: { deny: [] } },
};

export const INBOUND_MAX_BYTES_MIN = 4096;
export const INBOUND_MAX_BYTES_MAX = 8 * 1024 * 1024;

/** The reviewer must answer inside the host's hook timeout (30 s as `openmorals init` installs it). */
export const REVIEWER_TIMEOUT_MAX_MS = 25000;
export const REVIEWER_TIMEOUT_MIN_MS = 100;

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

export const MAX_PRICE_ENTRIES = 200;

function readPrices(v: unknown, e: Errors): Record<string, ModelPrice> {
  const p = 'guards.budget.prices';
  if (v === null) return {};
  if (!isObj(v)) {
    e.add(p, 'must be a mapping of model id to { input, output }');
    return {};
  }
  const out: Record<string, ModelPrice> = {};
  const ids = Object.keys(v);
  if (ids.length > MAX_PRICE_ENTRIES) e.add(p, `at most ${MAX_PRICE_ENTRIES} models`);
  for (const id of ids.slice(0, MAX_PRICE_ENTRIES)) {
    const entry = v[id];
    if (!/^[A-Za-z0-9._:@/-]{1,128}$/.test(id)) {
      e.add(`${p}.${id}`, 'model id must be 1-128 letters, digits and . _ : @ / -');
      continue;
    }
    if (!isObj(entry)) {
      e.add(`${p}.${id}`, 'must be { input: <price>, output: <price> } per million tokens');
      continue;
    }
    checkKeys(entry, ['input', 'output'], `.${p}.${id}`, e);
    const input = entry['input'];
    const output = entry['output'];
    if (typeof input !== 'number' || !Number.isFinite(input) || input < 0 || typeof output !== 'number' || !Number.isFinite(output) || output < 0) {
      e.add(`${p}.${id}`, 'input and output must be prices of 0 or more per million tokens');
      continue;
    }
    out[id] = { input, output };
  }
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

const REVIEWER_PROVIDERS: readonly ReviewerProviderName[] = ['anthropic-messages', 'anthropic', 'openai-chat', 'gemini', 'fake'];

/** The key variable a protocol reads when the file names none, so a key is never sent to another vendor's endpoint. */
export const REVIEWER_DEFAULT_KEY_ENV: Readonly<Record<ReviewerProviderName, string>> = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
  'anthropic-messages': 'ANTHROPIC_API_KEY',
  'openai-chat': 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  fake: 'ANTHROPIC_API_KEY',
});

function readReviewer(rv: Obj, b: Bylaws, e: Errors, project: boolean): void {
  const p = '.reviewer';
  const r = b.reviewer;
  checkKeys(rv, ['enabled', 'provider', 'model', 'api_key_env', 'timeout_ms', 'on_escalate', 'base_url', 'auth', 'compat'], p, e);
  r.enabled = readBool(rv, 'enabled', p, r.enabled, e);
  const provider = rv['provider'];
  if (provider !== undefined) {
    const found = REVIEWER_PROVIDERS.find((x) => x === provider);
    if (found !== undefined) r.provider = found;
    else e.add(`${p}.provider`, `must be one of ${REVIEWER_PROVIDERS.join(', ')} (got ${JSON.stringify(provider)})`);
  }
  const model = rv['model'];
  if (model !== undefined) {
    if (typeof model === 'string' && /^[A-Za-z0-9._:@/-]{1,128}$/.test(model)) r.model = model;
    else e.add(`${p}.model`, 'must be a model id (1-128 letters, digits and . _ : @ / -)');
  }
  const keyEnv = rv['api_key_env'];
  if (keyEnv !== undefined) {
    const why = typeof keyEnv === 'string' ? keyEnvNameProblem(keyEnv) : 'must be a string';
    if (why === null && typeof keyEnv === 'string') r.api_key_env = keyEnv;
    else e.add(`${p}.api_key_env`, `${why ?? 'is invalid'}: give the NAME of an environment variable (such as ANTHROPIC_API_KEY), never the key itself`);
  } else if (provider !== undefined && !project) r.api_key_env = REVIEWER_DEFAULT_KEY_ENV[r.provider];
  const t = rv['timeout_ms'];
  if (t !== undefined) {
    if (typeof t === 'number' && Number.isInteger(t) && t >= REVIEWER_TIMEOUT_MIN_MS && t <= REVIEWER_TIMEOUT_MAX_MS) r.timeout_ms = t;
    else e.add(`${p}.timeout_ms`, `must be a whole number of milliseconds from ${REVIEWER_TIMEOUT_MIN_MS} to ${REVIEWER_TIMEOUT_MAX_MS} (below the hook's 30-second timeout)`);
  }
  const oe = rv['on_escalate'];
  if (oe !== undefined) {
    if (oe === 'ask' || oe === 'deny') r.on_escalate = oe;
    else e.add(`${p}.on_escalate`, 'must be ask or deny (a reviewer can never allow)');
  }
  const bu = rv['base_url'];
  if (bu !== undefined) {
    const why = typeof bu === 'string' ? baseUrlProblem(bu) : 'must be a string';
    if (why === null && typeof bu === 'string') r.base_url = bu;
    else e.add(`${p}.base_url`, why ?? 'is invalid');
  }
  const au = rv['auth'];
  if (au !== undefined) {
    if (au === 'key' || au === 'none') r.auth = au;
    else e.add(`${p}.auth`, 'must be key or none');
  }
  const cp = section(rv, 'compat', p, e);
  if (cp !== null) {
    checkKeys(cp, ['token_param', 'system_role'], `${p}.compat`, e);
    const c: ReviewerCompat = {};
    const tp = cp['token_param'];
    if (tp === 'max_tokens' || tp === 'max_completion_tokens') c.token_param = tp;
    else if (tp !== undefined) e.add(`${p}.compat.token_param`, 'must be max_tokens or max_completion_tokens');
    const sr = cp['system_role'];
    if (sr === 'system' || sr === 'developer') c.system_role = sr;
    else if (sr !== undefined) e.add(`${p}.compat.system_role`, 'must be system or developer');
    r.compat = c;
  }
  if (project) return;
  if (r.compat !== undefined && r.provider !== 'openai-chat') e.add(`${p}.compat`, 'applies only to provider openai-chat');
  if ((r.provider === 'openai-chat' || r.provider === 'gemini') && model === undefined) e.add(`${p}.model`, `is required with provider ${r.provider} (the default model is an Anthropic one)`);
}

/**
 * Validates a parsed file. Settings it does not mention are taken from `base` (the defaults, or
 * the user floor for a project file). With `project` set, the reviewer's cross-field checks are
 * skipped: a project's reviewer settings are only syntax-checked, then ignored by the floor.
 */
export function validateBylaws(raw: unknown, source = '<memory>', base: Bylaws = DEFAULT_BYLAWS, project = false): BylawsLoad {
  const e = new Errors();
  if (raw === null || raw === undefined) return { ok: true, bylaws: cloneBylaws(base), source };
  if (!isObj(raw)) return { ok: false, error: 'the file must be a YAML mapping', source };
  checkKeys(raw, ['version', 'guards', 'rules', 'audit', 'reviewer', 'sandbox'], '', e);
  if (raw['version'] !== 1) e.add('version', 'must be 1');
  const d = base.guards;
  const b = cloneBylaws(base);
  const g = section(raw, 'guards', '', e);
  if (g !== null) {
    checkKeys(g, ['destructive', 'online-delete', 'secrets', 'self-protect', 'budget', 'loop', 'taint', 'inbound'], '.guards', e);
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
      checkKeys(bu, ['tool_calls', 'tokens', 'cost', 'prices'], '.guards.budget', e);
      b.guards.budget.tool_calls = readLimit(bu, 'tool_calls', '.guards.budget', d.budget.tool_calls, e);
      b.guards.budget.tokens = readLimit(bu, 'tokens', '.guards.budget', d.budget.tokens, e);
      if (bu['cost'] !== undefined) b.guards.budget.cost = readLimit(bu, 'cost', '.guards.budget', d.budget.cost ?? limit(0, 0, 100), e);
      if (bu['prices'] !== undefined) b.guards.budget.prices = readPrices(bu['prices'], e);
    }
    const lo = section(g, 'loop', '.guards', e);
    if (lo !== null) {
      checkKeys(lo, ['decision'], '.guards.loop', e);
      b.guards.loop.decision = readDecision(lo, 'decision', '.guards.loop', d.loop.decision, e);
    }
    const ta = section(g, 'taint', '.guards', e);
    if (ta !== null) {
      checkKeys(ta, ['decision', 'trusted_hosts'], '.guards.taint', e);
      b.guards.taint.decision = readDecision(ta, 'decision', '.guards.taint', d.taint.decision, e);
      const th = ta['trusted_hosts'];
      if (th !== undefined && th !== null) {
        if (!Array.isArray(th) || !th.every((x: unknown) => typeof x === 'string' && /^\.?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(x))) e.add('.guards.taint.trusted_hosts', 'must be a list of host names (a leading dot covers subdomains; no schemes, paths or wildcards)');
        else b.guards.taint.trusted_hosts = th.map((x: unknown) => String(x).toLowerCase());
      }
    }
    const ib = section(g, 'inbound', '.guards', e);
    if (ib !== null) {
      checkKeys(ib, ['enabled', 'decision', 'notify', 'max_bytes', 'judge'], '.guards.inbound', e);
      if (ib['judge'] !== undefined) b.guards.inbound.judge = readBool(ib, 'judge', '.guards.inbound', d.inbound.judge ?? false, e);
      b.guards.inbound.enabled = readBool(ib, 'enabled', '.guards.inbound', d.inbound.enabled, e);
      b.guards.inbound.notify = readBool(ib, 'notify', '.guards.inbound', d.inbound.notify, e);
      b.guards.inbound.decision = readDecision(ib, 'decision', '.guards.inbound', d.inbound.decision, e);
      const mb = ib['max_bytes'];
      if (mb !== undefined) {
        if (typeof mb === 'number' && Number.isInteger(mb) && mb >= INBOUND_MAX_BYTES_MIN && mb <= INBOUND_MAX_BYTES_MAX) b.guards.inbound.max_bytes = mb;
        else e.add('.guards.inbound.max_bytes', `must be a whole number of bytes from ${INBOUND_MAX_BYTES_MIN} to ${INBOUND_MAX_BYTES_MAX}`);
      }
    }
  }
  b.rules = readRules(raw['rules'], e);
  const au = section(raw, 'audit', '', e);
  if (au !== null) {
    checkKeys(au, ['enabled'], '.audit', e);
    b.audit.enabled = readBool(au, 'enabled', '.audit', base.audit.enabled, e);
  }
  const rv = section(raw, 'reviewer', '', e);
  if (rv !== null) readReviewer(rv, b, e, project);
  const sb = section(raw, 'sandbox', '', e);
  if (sb !== null) {
    const v = validateSandboxSection(sb);
    if (!v.ok) for (const msg of v.error.split('; ')) e.list.push(msg.startsWith('sandbox') ? `.${msg}` : msg);
    else b.sandbox = { network: { allow_hosts: v.section.hosts }, write: { allow: v.section.write }, read: { deny: v.section.denyRead } };
  }
  if (e.list.length > 0) return { ok: false, error: e.list.map((x) => x.replace(/^\./, '')).join('; '), source };
  return { ok: true, bylaws: b, source };
}

export function parseBylaws(text: string, source = '<memory>', base: Bylaws = DEFAULT_BYLAWS, project = false): BylawsLoad {
  let raw: unknown;
  try {
    raw = parseYaml(text, { strict: true, uniqueKeys: true, maxAliasCount: 50 });
  } catch (err: unknown) {
    return { ok: false, error: `YAML parse error: ${err instanceof Error ? err.message.split('\n')[0] ?? '' : String(err)}`, source };
  }
  return validateBylaws(raw, source, base, project);
}

export function loadBylaws(file: string, base: Bylaws = DEFAULT_BYLAWS, project = false): BylawsLoad {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err: unknown) {
    return { ok: false, error: `cannot read: ${err instanceof Error ? err.message : String(err)}`, source: file };
  }
  return parseBylaws(text, file, base, project);
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

function userBylawsFile(env: NodeJS.ProcessEnv): string | null {
  for (const name of BYLAWS_FILENAMES) {
    const user = join(configDir(env), name);
    if (existsSync(user)) return user;
  }
  return null;
}

/**
 * The policy for a folder. The user-level file (or, without one, the built-in defaults) is the
 * floor; the nearest project `openmorals.yaml` above `cwd` may only tighten it. A project setting
 * that would loosen the floor is dropped and listed in `ignored`; the reviewer's provider, model,
 * key variable and timeout come from the user-level file only. An invalid file fails closed
 * (`ok: false`) with the strictest policy that could still be read as its `floor`.
 */
export function resolveBylaws(cwd: string, env: NodeJS.ProcessEnv = process.env): BylawsLoad {
  const userFile = userBylawsFile(env);
  const user: BylawsLoad = userFile !== null ? loadBylaws(userFile) : { ok: true, bylaws: cloneBylaws(DEFAULT_BYLAWS), source: '<defaults>' };
  const floor = user.ok ? user.bylaws : cloneBylaws(DEFAULT_BYLAWS);
  const projectFile = findBylaws(cwd);
  if (projectFile === null || (userFile !== null && resolvePath(projectFile) === resolvePath(userFile))) return user.ok ? user : { ...user, floor };
  const project = loadBylaws(projectFile, floor, true);
  if (!project.ok) return { ...project, floor };
  const merged = tighten(project.bylaws, floor);
  if (!user.ok) return { ...user, floor: merged.bylaws };
  return { ok: true, bylaws: merged.bylaws, source: projectFile, floorSource: user.source, ignored: merged.ignored };
}

/** The policy to enforce for a load: the bylaws when valid, else the floor an invalid load carries, else the defaults. */
export function effectiveBylaws(load: BylawsLoad): Bylaws {
  return load.ok ? load.bylaws : (load.floor ?? DEFAULT_BYLAWS);
}

/** One line naming the settings a project file tried to loosen, or null when it tried none. */
export function looseningNote(load: BylawsLoad): string | null {
  if (!load.ok || load.ignored === undefined || load.ignored.length === 0) return null;
  const fields = [...new Set(load.ignored.map((l) => l.field))];
  const shown = fields.slice(0, 4).join(', ');
  return `note bylaws.loosening-ignored: ${load.source} tried to loosen ${shown}${fields.length > 4 ? ` (+${fields.length - 4} more)` : ''}; the floor from ${load.floorSource ?? '<defaults>'} was kept`;
}

export function stringifyBylaws(b: Bylaws): string {
  return stringifyYaml(b, { lineWidth: 0 });
}
