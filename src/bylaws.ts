import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, parse as parsePath, resolve as resolvePath } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { atLeastAsStrict, isRuleKeptBeside, tighten } from './packs/compare.js';
import { readPrinciples } from './packs/schema.js';
import { configDir } from './paths.js';
import { validateSandboxSection } from './sandbox/section.js';
import { baseUrlProblem, keyEnvNameProblem } from './reviewer/http.js';
import { globProblem } from './diffclass/glob.js';
import { compileContentPattern } from './rules/pattern.js';
import { defaultDeleteBylaws } from './guards/delete.js';
import { defaultDocumentBylaws } from './guards/document.js';
import { DEFAULT_CODE_MINUTES, defaultOutboundBylaws } from './outbound/guard.js';
import { normalHost, publicSuffix } from './outbound/domain.js';
import { DETECTOR_NAMES, isDetectorName } from './rules/detectors.js';
import type { Bylaws, BylawsLoad, DataClass, Decision, LearnBylaws, Limit, MergeBylaws, MergeClass, ModelPrice, ReviewerCompat, ReviewerProviderName, Rule, RuleMatch } from './types.js';
import { DATA_CLASSES, MERGE_CLASSES, isDecision } from './types.js';
import { defaultLearnBylaws } from './guards/learn.js';
import { defaultSpawns } from './tokens/agents.js';

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
    # Tokens are counted where the host reports them: Codex (PostModelRequest) and
    # OpenClaw (llm_output), and for Claude Code from its own session logs (the
    # numbers only; see transcript below). Gemini CLI and opencode report none, so
    # there only tool calls are counted (see docs/adapters.md). Input, output and
    # cache-write tokens count; cache reads are shown apart, not counted.
    tokens: { soft: 2000000, hard: 5000000, step: 500000 }
    # Spend, in hundredths of your price table's currency (cents for dollars).
    # Off (0) by default; it only counts models listed under prices.
    cost: { soft: 0, hard: 0, step: 100 }
    # Your own prices per million tokens, by the model id the host reports. Empty by
    # default: openmorals ships no prices. User-level file only. For example:
    #   prices:
    #     example-model-small: { input: 0.25, output: 1.25 }
    prices: {}
    # Claude Code only: read token counts from the session's logs and its
    # sub-agents' logs. Only the numbers are read; no text is kept. Unset means on.
    # transcript: true
    # Tool calls per sub-agent. Unset means off. For example:
    # agent_tool_calls: { soft: 200, hard: 600, step: 100 }
    # Runs of sub-agents per session. Sub-agents started together (one batch of
    # parallel calls) count as one run. Unset means ask at 25 and every 25 after.
    # spawns: { soft: 25, hard: 0, step: 25 }
    # The most sub-agents one batch may start before it asks. 0 is off. Unset means 10.
    # fanout: 10

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
    # Files that hold private data, as globs from the project root (clinical/**,
    # *.hl7). Reading one never asks by itself; it marks the session, so a later
    # step that also reaches the network after untrusted content gets the decision
    # above. A project file can add entries, never remove yours. None by default.
    # private_paths: []

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

  document:
    # Before a write or command deletes a document, leaves a file empty, removes
    # more than shrink_percent of a document (and at least min_removed_bytes), or
    # removes one of its headings. Also when it cannot tell: the file cannot be
    # read, the text was cut at 256 KB, or the tool gives no new content (a shell
    # redirect over a document, a patch that only names the file). Appends and
    # new files are never asked about. "allow" switches it off.
    decision: ask
    shrink_percent: 25
    # A smaller removal is never counted as sharp (a small file rewritten).
    min_removed_bytes: 512
    # What counts as a document, by file name extension (lower case, no dot).
    extensions: [md, markdown, mdx, txt, text, rst, adoc, asciidoc, org, tex, rtf, doc, docx, odt, pages, pdf, xls, xlsx, ods, numbers, ppt, pptx, odp, key]
    # Files left alone, as globs from the project folder; a name with no / matches
    # at any depth. A project file can remove entries, never add one.
    exclude: [node_modules, vendor, dist, build, target, coverage, .git, .venv]

  delete:
    # Before a plain delete of any existing file: rm, unlink, del, erase,
    # Remove-Item, git rm (not --cached), a patch that deletes a file, an MCP tool
    # that deletes a path. rm -r, rm -f and wildcards stay with destructive above;
    # documents stay with document. No file, folder or kind of file is exempt.
    # steer: trash refuses a delete the project trash can take and names the
    # command that can: openmorals trash <path> (you can restore it; only you can
    # purge it). steer: ask asks about each delete instead. A file the trash cannot
    # take (outside the project, another volume, a secret file, openmorals' own
    # folders) gets decision. A path built at run time ($VAR, $(...)) is refused.
    # "allow" switches the guard off.
    decision: ask
    steer: trash

  # packages:
  #   On by default with decision ask, so it is not written out here. Before a
  #   command installs a package by name (npm install, pnpm/yarn/bun add, pip
  #   install, uv/poetry add, cargo add, go get, gem install, bundle add,
  #   composer require) that the project's manifest and lockfile do not list.
  #   An agent can invent a package name, and someone may have published code
  #   under it. A project with no manifest of that kind is not judged. "allow"
  #   switches it off; a project file can only make it stricter.
  #   decision: ask

  # learn:
  #   On by default, so it is not written out here. Guards what an agent writes
  #   into files that teach later sessions: instructions files every session
  #   loads (AGENTS.md, CLAUDE.md, GEMINI.md, rule folders, MEMORY.md), notes in
  #   a .claude memory folder, and skills, sub-agents and commands. It scans what
  #   a write adds (hidden instructions; for a skill, every scanner rule: a
  #   critical finding is refused), flags an instructions file that grows past
  #   tokens (about four bytes each; 0 turns that check off), asks about a write
  #   from the shell it cannot see, and asks before such a write in a session
  #   that has read untrusted content. "allow" switches it off; a project file
  #   can only make it stricter.
  #   decision: ask
  #   tokens: 10000

  # unknown-tools:
  #   On by default with decision ask, so it is not written out here. On Claude
  #   Code, Codex CLI and Gemini CLI, a tool name that is not one of the host's
  #   built-in tools openmorals knows, and not an MCP tool, asks before it runs:
  #   openmorals cannot tell what such a call does. It asks once per name in a
  #   session; after you approve a call, that name is not asked about again in
  #   the session. Codex has no ask, so there it is blocked until you allow it.
  #   allow lists names that never ask. "allow" switches it off. A project file
  #   can only make it stricter, so put names you trust in your user-level file.
  #   decision: ask
  #   allow: []
  #     - my_tool

  # replace:
  #   Off unless you switch it on (it costs one refused call and one extra command
  #   for each file replaced whole in a folder without git). steer: keep refuses a
  #   call that would replace the whole content of an existing file with no .git
  #   folder above it (the Write tool, > file, tee, sed -i, perl -i), naming
  #   openmorals trash --copy <path>: a copy goes to the project trash, the file
  #   stays, and the same call then passes. A project file can switch it on, never
  #   off. See docs/delete.md.
  #   steer: keep

  outbound:
    # Where a form, a message or a link sends data, judged from the action alone:
    # no network call, no model. Each ask comes once per site and field in a
    # session: after you approve it in your agent's own dialog, the same entry on
    # the same site is not asked about again. Text in the conversation never
    # counts as your approval. "allow" switches one off.
    # A password, passcode or one-time code typed into a site not in "sites", into
    # a page whose address is unknown, or on a page opened from a link in a mail or
    # other untrusted output; a password or token inside a URL.
    credential: ask
    # A site that looks like one of yours without being it (same letters once
    # look-alikes are swapped, one or two characters off, your site's name in
    # front of another site), a name mixing scripts or posing as plain letters,
    # or user@host in a link.
    lookalike: ask
    # A raw public IP address instead of a site name (localhost never asks).
    ip_host: ask
    # javascript:, data:, vbscript: and file: links; executable and macro
    # downloads; the link-local address cloud machines keep credentials on; a
    # private-network address that came from untrusted output.
    dangerous_target: ask
    # A link whose shown text names another site than the one it opens.
    link_mismatch: ask
    # A blind copy, a new outside recipient on a reply, or an address that
    # appeared only inside untrusted output.
    recipient: ask
    # The two denies. openmorals stops the agent only; you can still type it
    # yourself. Only the user-level file can make either one ask.
    # A password or code typed into a look-alike of one of your sites:
    lookalike_credential: deny
    # A one-time code from a message typed into a site that message did not name:
    code_relay: deny
    # How long a code seen in a message is remembered (1 to 60 minutes).
    code_minutes: 10

# Your own rules. Each adds an ask or a deny; a rule cannot loosen a guard.
# match fields are case-insensitive regular expressions; every field given must match.
#   tool:    the tool name (Bash, PowerShell, Read, Write, Edit, ...)
#   command: the full command line (Bash and PowerShell tools)
#   path:    a file path the action touches (or any argument of a command)
#   content: what a write puts in a file, and a tool's arguments or agent message
#            (^ and $ match at line ends; no backreferences or lookaround). Content
#            over 256 KB is cut: a deny rule then denies, an ask rule asks.
#   detector: a named detector, or a list of them, over the same text plus the
#            command line, the URL and a tool's arguments before redaction:
#            secret-token, card-number, iban, us-ssn, nhs-number, email, phone-e164,
#            hl7-msh, fhir-patient. They find likely patterns (shape and checksum),
#            not proof of personal data; nothing they find is logged.
#   network: true matches only an action that reaches the network.
rules: []
#  - id: no-production
#    match: { command: "\\\\bprod(uction)?\\\\b" }
#    decision: deny
#    reason: Production is off limits to agents.
#    hard: true
#  - id: no-private-keys-in-files
#    match: { content: "-----BEGIN [A-Z ]*PRIVATE KEY-----" }
#    decision: deny
#    reason: A private key must not be written into a file.
#  - id: no-card-numbers-out
#    match: { detector: card-number, network: true }
#    decision: deny
#    reason: A card number must not leave this machine.

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

# defer: true
#   Hold a deletion or document ask for you instead of asking at once: the agent is
#   told the action did not run and was queued, and carries on with other work; you
#   approve that exact action later (type "approve <code>" in the chat, or run
#   "openmorals pending" and "openmorals approve" in a terminal) and it may run once.
#   Off by default; under --unattended these asks are held whatever this says.
#   A project file can switch it on, never off. See docs/deferred-asks.md.

# sites: [example.com, mail.example.org]
#   User-level file only. Your own sites: a password or code may go to them (and
#   to names under them) without asking, and a name that looks like one of them is
#   a look-alike. A project file cannot set it. See docs/outbound.md.

# protect: [mybank.example]
#   Sites whose look-alikes are refused, without letting anything go to the site
#   itself unasked (that is what "sites" does). A password or code typed into a
#   name that looks like one of these is refused; a password typed into the site
#   itself still asks. Your file and a project file may both add names; a project
#   cannot remove one, and a site in your own "sites" or "protect" is never
#   treated as a look-alike of a name a project added. See docs/outbound.md.

# data_classes:
#   User-level file only. What to do when a kind of private data is typed into a
#   form, put in a URL or sent in a message, and where it may go without asking.
#   Classes left out keep these defaults:
#   card:        { decision: ask, sites: [] }     # card numbers (Luhn)
#   bank:        { decision: ask, sites: [] }     # IBANs (mod-97)
#   national_id: { decision: ask, sites: [] }     # US SSN, NHS number
#   health:      { decision: ask, sites: [] }     # HL7 v2 messages, FHIR Patient
#   email:       { decision: allow, sites: [] }   # e-mail addresses
#   phone:       { decision: allow, sites: [] }   # phone numbers in +E.164

# merge:
#   Used only by "openmorals diff-class", which reads a diff and says whether it may
#   merge without a person reading it. Nothing is review-free unless the user-level
#   file (in the openmorals config directory) switches a class on; a project file
#   can only switch one off again and add paths to always_review.
#   review_free: []        # tighten-only | reproduced (see docs/merge-verdict.md)
#   always_review: []      # globs, e.g. clinical/** or src/billing/**
#   boundary_paths: []     # globs; a change there with no docs/adr/ change gets a
#                          # test-integrity reason line (see docs/test-integrity.md)
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
    document: defaultDocumentBylaws(),
    outbound: defaultOutboundBylaws(),
    delete: defaultDeleteBylaws(),
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

export const MATCH_KEYS: readonly string[] = ['tool', 'command', 'path', 'content', 'detector', 'network'];

export const MAX_PRIVATE_PATHS = 200;

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
      e.add(`${p}.match`, `must be a mapping with at least one of ${MATCH_KEYS.join(', ')}`);
      return;
    }
    checkKeys(m, MATCH_KEYS, `${p}.match`, e);
    const match: RuleMatch = {};
    const det = m['detector'];
    if (det !== undefined) {
      const names = typeof det === 'string' ? [det] : Array.isArray(det) ? det : null;
      if (names === null || names.length === 0 || names.length > DETECTOR_NAMES.length) e.add(`${p}.match.detector`, `must be a detector name or a list of them (${DETECTOR_NAMES.join(', ')})`);
      else {
        const unknown = names.filter((x: unknown) => !isDetectorName(x));
        if (unknown.length > 0) e.add(`${p}.match.detector`, `unknown detector ${unknown.map((x: unknown) => JSON.stringify(x)).join(', ')} (known: ${DETECTOR_NAMES.join(', ')})`);
        else match.detector = typeof det === 'string' ? det : (names as string[]).slice();
      }
    }
    const net = m['network'];
    if (net !== undefined) {
      if (net === true) match.network = true;
      else e.add(`${p}.match.network`, 'must be true (leave it out to match whether or not the action reaches the network)');
    }
    const content = m['content'];
    if (content !== undefined) {
      if (typeof content !== 'string' || content === '') e.add(`${p}.match.content`, 'must be a non-empty string (a regular expression)');
      else {
        const c = compileContentPattern(content);
        if (c.ok) match.content = content;
        else e.add(`${p}.match.content`, c.error);
      }
    }
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
      e.add(`${p}.match`, `needs at least one of ${MATCH_KEYS.join(', ')}`);
      return;
    }
    const reason = item['reason'];
    if (reason !== undefined && typeof reason !== 'string') e.add(`${p}.reason`, 'must be a string');
    const hard = readBool(item, 'hard', p, false, e);
    out.push({ id, match, decision, reason: typeof reason === 'string' ? reason : `matched your rule ${id}`, hard });
  });
  return out;
}

export const MAX_DOCUMENT_LIST = 200;

function readDocument(o: Obj, b: Bylaws, base: Bylaws['guards']['document'] | undefined, e: Errors): void {
  const p = '.guards.document';
  checkKeys(o, ['decision', 'shrink_percent', 'min_removed_bytes', 'extensions', 'exclude'], p, e);
  const out = b.guards.document ?? (b.guards.document = defaultDocumentBylaws());
  out.decision = readDecision(o, 'decision', p, (base ?? defaultDocumentBylaws()).decision, e);
  const sp = o['shrink_percent'];
  if (sp !== undefined) {
    if (typeof sp === 'number' && Number.isInteger(sp) && sp >= 1 && sp <= 100) out.shrink_percent = sp;
    else e.add(`${p}.shrink_percent`, 'must be a whole number from 1 to 100');
  }
  const mb = o['min_removed_bytes'];
  if (mb !== undefined) {
    if (typeof mb === 'number' && Number.isInteger(mb) && mb >= 0 && mb <= 1048576) out.min_removed_bytes = mb;
    else e.add(`${p}.min_removed_bytes`, 'must be a whole number of bytes from 0 to 1048576');
  }
  const ex = o['extensions'];
  if (ex !== undefined && ex !== null) {
    if (!Array.isArray(ex) || !ex.every((x: unknown) => typeof x === 'string' && /^[a-z0-9]{1,16}$/.test(x))) e.add(`${p}.extensions`, 'must be a list of file name extensions in lower case, without the dot (md, txt, docx)');
    else if (ex.length > MAX_DOCUMENT_LIST) e.add(`${p}.extensions`, `may hold at most ${MAX_DOCUMENT_LIST} extensions`);
    else out.extensions = [...new Set(ex as string[])];
  } else if (ex === null) out.extensions = [];
  const xs = o['exclude'];
  if (xs !== undefined && xs !== null) {
    if (!Array.isArray(xs) || !xs.every((x: unknown) => typeof x === 'string')) e.add(`${p}.exclude`, 'must be a list of globs (e.g. docs/generated/** or node_modules)');
    else if (xs.length > MAX_DOCUMENT_LIST) e.add(`${p}.exclude`, `may hold at most ${MAX_DOCUMENT_LIST} globs`);
    else {
      const bad = (xs as string[]).map((x) => [x, globProblem(x)] as const).filter(([, why]) => why !== null);
      for (const [x, why] of bad) e.add(`${p}.exclude`, `${JSON.stringify(x)} ${why ?? ''}`);
      if (bad.length === 0) out.exclude = [...new Set(xs as string[])];
    }
  } else if (xs === null) out.exclude = [];
}

function readDelete(o: Obj, b: Bylaws, base: Bylaws['guards']['delete'] | undefined, e: Errors): void {
  const p = '.guards.delete';
  checkKeys(o, ['decision', 'steer'], p, e);
  const out = b.guards.delete ?? (b.guards.delete = defaultDeleteBylaws());
  out.decision = readDecision(o, 'decision', p, (base ?? defaultDeleteBylaws()).decision, e);
  const st = o['steer'];
  if (st !== undefined) {
    if (st === 'trash' || st === 'ask') out.steer = st;
    else e.add(`${p}.steer`, `must be trash or ask (got ${JSON.stringify(st)})`);
  }
}

function readPackages(o: Obj, b: Bylaws, base: Bylaws['guards']['packages'] | undefined, e: Errors): void {
  const p = '.guards.packages';
  checkKeys(o, ['decision'], p, e);
  if (o['decision'] === undefined) return;
  b.guards.packages = { decision: readDecision(o, 'decision', p, (base ?? { decision: 'ask' }).decision, e) };
}

function readUnknownTools(o: Obj, b: Bylaws, base: Bylaws['guards']['unknown-tools'] | undefined, e: Errors): void {
  const p = '.guards.unknown-tools';
  checkKeys(o, ['decision', 'allow'], p, e);
  const out: { decision: Decision; allow?: string[] } = { decision: base?.decision ?? 'ask', ...(base?.allow !== undefined ? { allow: [...base.allow] } : {}) };
  if (o['decision'] !== undefined) out.decision = readDecision(o, 'decision', p, out.decision, e);
  const al = o['allow'];
  if (al !== undefined) {
    if (!Array.isArray(al) || !al.every((x: unknown) => typeof x === 'string' && x !== '' && x.length <= 128)) e.add(`${p}.allow`, 'must be a list of tool names (non-empty, at most 128 characters each)');
    else out.allow = al.map((x: unknown) => String(x));
  }
  if (o['decision'] !== undefined || al !== undefined) b.guards['unknown-tools'] = out;
}

function readLearn(o: Obj, b: Bylaws, base: Bylaws['guards']['learn'] | undefined, e: Errors): void {
  const p = '.guards.learn';
  checkKeys(o, ['decision', 'tokens'], p, e);
  const d = base ?? defaultLearnBylaws();
  const out: LearnBylaws = { decision: d.decision, tokens: d.tokens };
  if (o['decision'] !== undefined) out.decision = readDecision(o, 'decision', p, d.decision, e);
  const t = o['tokens'];
  if (t !== undefined) {
    if (typeof t === 'number' && Number.isInteger(t) && t >= 0 && t <= 1000000) out.tokens = t;
    else e.add(`${p}.tokens`, 'must be a whole number of tokens from 0 (no size check) to 1000000');
  }
  if (o['decision'] !== undefined || t !== undefined) b.guards.learn = out;
}

function readReplace(o: Obj, b: Bylaws, e: Errors): void {
  const p = '.guards.replace';
  checkKeys(o, ['steer'], p, e);
  const st = o['steer'];
  if (st === undefined) return;
  if (st === 'off' || st === 'keep') b.guards.replace = { steer: st };
  else e.add(`${p}.steer`, `must be off or keep (got ${JSON.stringify(st)})`);
}

/** Most host names in `sites` or in one data class's `sites` (0.20.0). */
export const MAX_SITES = 200;

function readSites(v: unknown, path: string, e: Errors): string[] | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || !v.every((x: unknown) => typeof x === 'string')) {
    e.add(path, 'must be a list of host names (example.com; a name covers the names under it; no schemes, paths or wildcards)');
    return null;
  }
  if (v.length > MAX_SITES) {
    e.add(path, `may hold at most ${MAX_SITES} host names`);
    return null;
  }
  const out: string[] = [];
  for (const x of v as string[]) {
    const h = /^[^\s/:@*?#[\]]+$/.test(x) ? normalHost(x) : null;
    if (h === null || !h.includes('.') || /^[0-9.]+$/.test(h)) {
      e.add(path, `${JSON.stringify(x)} is not a host name with a dot (example.com)`);
      continue;
    }
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

/**
 * A `protect` list (0.23.0): the same host names as `sites`, and not a public suffix (`co.uk`), which would make every
 * name under it protected and so every other name under it a candidate look-alike.
 */
function readProtect(v: unknown, path: string, e: Errors): string[] | null {
  const list = readSites(v, path, e);
  if (list === null) return null;
  const out: string[] = [];
  for (const h of list) {
    if (publicSuffix(h) === h) e.add(path, `${JSON.stringify(h)} is a public suffix, under which anyone can register a name: name a site under it, such as example.${h}`);
    else out.push(h);
  }
  return out;
}

/**
 * `protect` from one file (0.23.0). The user-level file (or a file loaded on its own) sets the person's list; a project
 * file can only add, into `project_protect`, and an entry already in the person's `sites` or `protect` is not added again.
 */
function readProtectTop(raw: Obj, b: Bylaws, base: Bylaws, project: boolean, e: Errors): void {
  const v = raw['protect'];
  if (v === undefined) return;
  const list = readProtect(v, '.protect', e);
  if (!project) {
    if (list !== null) b.protect = list;
    else if (v === null) b.protect = [];
    return;
  }
  if (list === null || list.length === 0) return;
  const own = new Set([...(base.sites ?? []), ...(base.protect ?? [])]);
  const added = [...(base.project_protect ?? [])];
  for (const h of list) if (!own.has(h) && !added.includes(h)) added.push(h);
  b.project_protect = added;
}

function readOutbound(o: Obj, b: Bylaws, base: Bylaws['guards']['outbound'] | undefined, e: Errors): void {
  const p = '.guards.outbound';
  const keys = ['credential', 'lookalike', 'ip_host', 'dangerous_target', 'link_mismatch', 'recipient'] as const;
  checkKeys(o, [...keys, 'lookalike_credential', 'code_relay', 'code_minutes'], p, e);
  const d = base ?? defaultOutboundBylaws();
  const out = b.guards.outbound ?? (b.guards.outbound = defaultOutboundBylaws());
  for (const k of keys) out[k] = readDecision(o, k, p, d[k], e);
  for (const k of ['lookalike_credential', 'code_relay'] as const) {
    const v = o[k];
    if (v === undefined) out[k] = d[k];
    else if (v === 'ask' || v === 'deny') out[k] = v;
    else e.add(`${p}.${k}`, `must be ask or deny (got ${JSON.stringify(v)}): this deny can become an ask, never be switched off`);
  }
  const cm = o['code_minutes'];
  if (cm !== undefined) {
    if (typeof cm === 'number' && Number.isInteger(cm) && cm >= 1 && cm <= 60) out.code_minutes = cm;
    else e.add(`${p}.code_minutes`, 'must be a whole number of minutes from 1 to 60');
  } else out.code_minutes = d.code_minutes ?? DEFAULT_CODE_MINUTES;
}

function readDataClasses(v: unknown, b: Bylaws, e: Errors): void {
  const p = '.data_classes';
  if (v === undefined || v === null) return;
  if (!isObj(v)) {
    e.add(p, 'must be a mapping of data class to { decision, sites }');
    return;
  }
  checkKeys(v, DATA_CLASSES, p, e);
  const out: Partial<Record<DataClass, { decision: Decision; sites: string[] }>> = { ...(b.data_classes ?? {}) };
  for (const c of DATA_CLASSES) {
    const entry = section(v, c, p, e);
    if (entry === null) continue;
    checkKeys(entry, ['decision', 'sites'], `${p}.${c}`, e);
    const prev = out[c] ?? { decision: c === 'email' || c === 'phone' ? 'allow' : 'ask', sites: [] };
    const decision = readDecision(entry, 'decision', `${p}.${c}`, prev.decision, e);
    const sites = readSites(entry['sites'], `${p}.${c}.sites`, e) ?? (entry['sites'] === null ? [] : prev.sites);
    out[c] = { decision, sites };
  }
  b.data_classes = out;
}

export const MAX_ALWAYS_REVIEW = 200;

function readMerge(m: Obj, base: MergeBylaws | undefined, e: Errors): MergeBylaws {
  const p = '.merge';
  checkKeys(m, ['review_free', 'always_review', 'boundary_paths'], p, e);
  const out: MergeBylaws = { review_free: [...(base?.review_free ?? [])], always_review: [...(base?.always_review ?? [])] };
  if (base?.boundary_paths !== undefined) out.boundary_paths = [...base.boundary_paths];
  const rf = m['review_free'];
  if (rf !== undefined && rf !== null) {
    if (!Array.isArray(rf)) e.add(`${p}.review_free`, `must be a list of ${MERGE_CLASSES.join(', ')}`);
    else {
      const list: MergeClass[] = [];
      for (const x of rf as unknown[]) {
        const found = MERGE_CLASSES.find((c) => c === x);
        if (found === undefined) e.add(`${p}.review_free`, `unknown class ${JSON.stringify(x)} (classes: ${MERGE_CLASSES.join(', ')})`);
        else if (!list.includes(found)) list.push(found);
      }
      out.review_free = list;
    }
  } else if (rf === null) out.review_free = [];
  const ar = m['always_review'];
  if (ar !== undefined && ar !== null) {
    if (!Array.isArray(ar)) e.add(`${p}.always_review`, 'must be a list of path globs');
    else if (ar.length > MAX_ALWAYS_REVIEW) e.add(`${p}.always_review`, `at most ${MAX_ALWAYS_REVIEW} globs`);
    else {
      const list: string[] = [];
      for (const x of ar as unknown[]) {
        const why = typeof x === 'string' ? globProblem(x) : 'must be a string';
        if (why !== null || typeof x !== 'string') e.add(`${p}.always_review`, `${JSON.stringify(x)} ${why ?? 'is invalid'}`);
        else if (!list.includes(x)) list.push(x);
      }
      out.always_review = list;
    }
  } else if (ar === null) out.always_review = [];
  const bp = m['boundary_paths'];
  if (bp !== undefined && bp !== null) {
    if (!Array.isArray(bp)) e.add(`${p}.boundary_paths`, 'must be a list of path globs');
    else if (bp.length > MAX_ALWAYS_REVIEW) e.add(`${p}.boundary_paths`, `at most ${MAX_ALWAYS_REVIEW} globs`);
    else {
      const list: string[] = [];
      for (const x of bp as unknown[]) {
        const why = typeof x === 'string' ? globProblem(x) : 'must be a string';
        if (why !== null || typeof x !== 'string') e.add(`${p}.boundary_paths`, `${JSON.stringify(x)} ${why ?? 'is invalid'}`);
        else if (!list.includes(x)) list.push(x);
      }
      out.boundary_paths = list;
    }
  } else if (bp === null) out.boundary_paths = [];
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
  checkKeys(raw, ['version', 'guards', 'rules', 'audit', 'reviewer', 'sandbox', 'merge', 'defer', 'sites', 'data_classes', 'protect', 'principles', 'disclaimer', 'guidance'], '', e);
  if (raw['version'] !== 1) e.add('version', 'must be 1');
  const d = base.guards;
  const b = cloneBylaws(base);
  const g = section(raw, 'guards', '', e);
  if (g !== null) {
    checkKeys(g, ['destructive', 'online-delete', 'secrets', 'self-protect', 'budget', 'loop', 'taint', 'inbound', 'document', 'outbound', 'delete', 'replace', 'packages', 'learn', 'unknown-tools'], '.guards', e);
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
      checkKeys(bu, ['tool_calls', 'tokens', 'cost', 'prices', 'transcript', 'agent_tool_calls', 'spawns', 'fanout'], '.guards.budget', e);
      b.guards.budget.tool_calls = readLimit(bu, 'tool_calls', '.guards.budget', d.budget.tool_calls, e);
      b.guards.budget.tokens = readLimit(bu, 'tokens', '.guards.budget', d.budget.tokens, e);
      if (bu['cost'] !== undefined) b.guards.budget.cost = readLimit(bu, 'cost', '.guards.budget', d.budget.cost ?? limit(0, 0, 100), e);
      if (bu['prices'] !== undefined) b.guards.budget.prices = readPrices(bu['prices'], e);
      if (bu['transcript'] !== undefined) b.guards.budget.transcript = readBool(bu, 'transcript', '.guards.budget', true, e);
      if (bu['agent_tool_calls'] !== undefined) b.guards.budget.agent_tool_calls = readLimit(bu, 'agent_tool_calls', '.guards.budget', limit(0, 0, 100), e);
      if (bu['spawns'] !== undefined) b.guards.budget.spawns = readLimit(bu, 'spawns', '.guards.budget', defaultSpawns(), e);
      if (bu['fanout'] !== undefined) {
        const f = bu['fanout'];
        if (typeof f !== 'number' || !Number.isInteger(f) || f < 0 || f > 1000) e.add('.guards.budget.fanout', 'must be a whole number from 0 to 1000');
        else b.guards.budget.fanout = f;
      }
    }
    const lo = section(g, 'loop', '.guards', e);
    if (lo !== null) {
      checkKeys(lo, ['decision'], '.guards.loop', e);
      b.guards.loop.decision = readDecision(lo, 'decision', '.guards.loop', d.loop.decision, e);
    }
    const ta = section(g, 'taint', '.guards', e);
    if (ta !== null) {
      checkKeys(ta, ['decision', 'trusted_hosts', 'private_paths'], '.guards.taint', e);
      b.guards.taint.decision = readDecision(ta, 'decision', '.guards.taint', d.taint.decision, e);
      const th = ta['trusted_hosts'];
      if (th !== undefined && th !== null) {
        if (!Array.isArray(th) || !th.every((x: unknown) => typeof x === 'string' && /^\.?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(x))) e.add('.guards.taint.trusted_hosts', 'must be a list of host names (a leading dot covers subdomains; no schemes, paths or wildcards)');
        else b.guards.taint.trusted_hosts = th.map((x: unknown) => String(x).toLowerCase());
      }
      const pp = ta['private_paths'];
      if (pp !== undefined && pp !== null) {
        if (!Array.isArray(pp) || !pp.every((x: unknown) => typeof x === 'string')) e.add('.guards.taint.private_paths', 'must be a list of globs (e.g. clinical/** or *.hl7)');
        else if (pp.length > MAX_PRIVATE_PATHS) e.add('.guards.taint.private_paths', `may hold at most ${MAX_PRIVATE_PATHS} globs`);
        else {
          const bad = (pp as string[]).map((g) => [g, globProblem(g)] as const).filter(([, why]) => why !== null);
          for (const [g, why] of bad) e.add('.guards.taint.private_paths', `${JSON.stringify(g)} ${why ?? ''}`);
          if (bad.length === 0) b.guards.taint.private_paths = [...new Set(pp as string[])];
        }
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
  const doc = g !== null ? section(g, 'document', '.guards', e) : null;
  if (doc !== null) readDocument(doc, b, d.document, e);
  const ob = g !== null ? section(g, 'outbound', '.guards', e) : null;
  if (ob !== null) readOutbound(ob, b, d.outbound, e);
  const dl = g !== null ? section(g, 'delete', '.guards', e) : null;
  if (dl !== null) readDelete(dl, b, d.delete, e);
  const rp = g !== null ? section(g, 'replace', '.guards', e) : null;
  if (rp !== null) readReplace(rp, b, e);
  const pk = g !== null ? section(g, 'packages', '.guards', e) : null;
  if (pk !== null) readPackages(pk, b, d.packages, e);
  const ln = g !== null ? section(g, 'learn', '.guards', e) : null;
  if (ln !== null) readLearn(ln, b, d.learn, e);
  const ut = g !== null ? section(g, 'unknown-tools', '.guards', e) : null;
  if (ut !== null) readUnknownTools(ut, b, d['unknown-tools'], e);
  if (raw['sites'] !== undefined) {
    const sites = readSites(raw['sites'], '.sites', e);
    if (sites !== null) b.sites = sites;
    else if (raw['sites'] === null) b.sites = [];
  }
  readProtectTop(raw, b, base, project, e);
  readDataClasses(raw['data_classes'], b, e);
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
    else {
      const pp = v.section.protectedPaths ?? base.sandbox.write.protected_paths;
      b.sandbox = { network: { allow_hosts: v.section.hosts }, write: { allow: v.section.write, ...(pp !== undefined ? { protected_paths: [...pp] } : {}) }, read: { deny: v.section.denyRead } };
    }
  }
  const mg = section(raw, 'merge', '', e);
  if (mg !== null) b.merge = readMerge(mg, base.merge, e);
  if (raw['defer'] !== undefined) b.defer = readBool(raw, 'defer', '', base.defer ?? false, e);
  const gd = section(raw, 'guidance', '', e);
  if (gd !== null) {
    checkKeys(gd, ['first_activity'], '.guidance', e);
    b.guidance = { first_activity: readBool(gd, 'first_activity', '.guidance', base.guidance?.first_activity ?? false, e) };
  }
  // Principles and the disclaimer (0.25.0) change no decision. A fault in them alone still makes the file invalid (loud at
  // every load), but its other settings stay in force, held at least as strict as what the file was read over.
  const pr = readPrinciples(raw, b);
  if (pr.disclaimer !== null && !(b.disclaimers ?? []).includes(pr.disclaimer)) b.disclaimers = [...(b.disclaimers ?? []), pr.disclaimer];
  if (e.list.length > 0) return { ok: false, error: [...e.list.map((x) => x.replace(/^\./, '')), ...pr.errors].join('; '), source };
  if (pr.errors.length > 0) return { ok: false, error: pr.errors.join('; '), source, floor: project ? tighten(b, base).bylaws : atLeastAsStrict(b, base), keptRest: true };
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
  const floor = user.ok ? user.bylaws : (user.floor ?? cloneBylaws(DEFAULT_BYLAWS));
  const projectFile = findBylaws(cwd);
  if (projectFile === null || (userFile !== null && resolvePath(projectFile) === resolvePath(userFile))) return user.ok ? user : { ...user, floor };
  const project = overFloor(loadBylaws(projectFile, floor, true), floor, user.source);
  if (!project.ok) return project;
  if (!user.ok) return { ...user, floor: project.bylaws };
  return project;
}

/**
 * A project file's load (read with `floor` as its base and `project` set) merged onto the floor the way `resolveBylaws`
 * does: looser settings replaced by the floor's and listed in `ignored`; an invalid project load keeps the floor as its
 * `floor`. Exported (0.23.0) so `eval` rows with a `project` block are merged by the same code as a real folder.
 */
export function overFloor(project: BylawsLoad, floor: Bylaws, floorSource: string): BylawsLoad {
  if (!project.ok) return { ...project, floor: project.floor ?? floor };
  const merged = tighten(project.bylaws, floor);
  return { ok: true, bylaws: merged.bylaws, source: project.source, floorSource, ignored: merged.ignored };
}

/** The policy to enforce for a load: the bylaws when valid, else the floor an invalid load carries, else the defaults. */
export function effectiveBylaws(load: BylawsLoad): Bylaws {
  return load.ok ? load.bylaws : (load.floor ?? DEFAULT_BYLAWS);
}

/**
 * One line naming the settings a project file tried to loosen, and the project rules kept beside
 * a user rule of the same id (nothing loosened: the user's rule is unchanged), or null when neither.
 */
export function looseningNote(load: BylawsLoad): string | null {
  if (!load.ok || load.ignored === undefined || load.ignored.length === 0) return null;
  const floorSource = load.floorSource ?? '<defaults>';
  const list = (fields: string[]): string => `${fields.slice(0, 4).join(', ')}${fields.length > 4 ? ` (+${fields.length - 4} more)` : ''}`;
  const loosened = [...new Set(load.ignored.filter((l) => !isRuleKeptBeside(l)).map((l) => l.field))];
  const beside = [...new Set(load.ignored.filter(isRuleKeptBeside).map((l) => l.field))];
  const parts: string[] = [];
  if (loosened.length > 0) parts.push(`note bylaws.loosening-ignored: ${load.source} tried to loosen ${list(loosened)}; the floor from ${floorSource} was kept`);
  if (beside.length > 0) parts.push(`note bylaws.rule-kept-beside: ${load.source} has its own ${list(beside)}, kept beside the user's rule of the same id; the user's rule in ${floorSource} is unchanged`);
  return parts.join('; ');
}

/**
 * A policy as a bylaws file. The resolved `disclaimers` list (0.25.0) is written as the file key `disclaimer` (several
 * texts joined by a blank line), so the text reads back as a valid file.
 */
export function stringifyBylaws(b: Bylaws): string {
  const { disclaimers, ...rest } = b;
  return stringifyYaml(disclaimers !== undefined && disclaimers.length > 0 ? { ...rest, disclaimer: disclaimers.join('\n\n') } : rest, { lineWidth: 0 });
}
