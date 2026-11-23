# openmorals public API (v0.2.0)

The package entry point is `openmorals` (ESM, `dist/src/index.js`, types in `dist/src/index.d.ts`).
Everything below is exported from it. Run `npm run build` to produce `dist/`.

## Changes

- 0.3.0: added (nothing removed or renamed): the `codexAdapter`, `geminiCliAdapter` and `opencodeAdapter` namespaces, `installAgentHook`, `AGENT_NAMES`, `isAgentName`, `opencodeCommand`, `AGENT_FOLLOW_UP`; `AuditRecord.source` may also be `codex`, `gemini-cli` or `opencode`. Behaviour: the self-protect guard also covers the Codex, Gemini CLI and opencode hook and plugin files. `sandbox` in `Bylaws` (type `SandboxBylaws`) and the schema; the sandbox exports (`planSandbox`, `runSandboxed`, `sandboxCommand`, `planForProject`, `formatPlanText`, `hostPlanInputs`, `detectSandboxTool`, `validateSandboxSection`, `SANDBOX_REFUSED_EXIT` and the types); `packs.loosenings` reports extra sandbox hosts, extra writable paths and dropped read-denied paths. `reviewer` in `Bylaws` (types `ReviewerBylaws`, `ReviewerProviderName`; constants `REVIEWER_TIMEOUT_MIN_MS`, `REVIEWER_TIMEOUT_MAX_MS`) and the schema; `runClaudeCodeHookReviewed` and `ReviewedHookOptions`; the reviewer exports (`reviewAction`, `reviewVerdict`, `reviewerProvider`, `applyReview`, `createAnthropicProvider`, `createFakeProvider`, `parseReviewReply`, `buildReviewPrompt`, `DEFAULT_REVIEW_MODEL`, `DRY_RUN_REPLY`, `REVIEW_VERDICTS` and the types). `packs.loosenings` also reports `reviewer.enabled` switched off and a softer `reviewer.on_escalate`. Behaviour: `openmorals hook claude-code` now goes through `runClaudeCodeHookReviewed` (identical output while `reviewer.enabled` is false).
- 0.2.0: added (nothing removed or renamed): `guards.loop` and `guards.taint` in `Bylaws` and the schema; session memory (`loadSession`, `saveSession`, `SessionMemory`, `sessionFindings`, `combineVerdict`, `recordAction`, `recordOutcome`, `taintContext`, `parseMemory`, `parseTaint`, `EMPTY_MEMORY`, `HISTORY_KEEP`); `unattendedVerdict`, `isUnattended`; `NETWORK_COMMANDS`, `reachesNetwork`; `ClaudeCodeHookInput` gained `tool_use_id`, `error`, `is_interrupt`; `runClaudeCodeHook` takes `unattended`; `POST_EVENTS`; `mergeClaudeSettings` takes an optional `events` list (default `['PreToolUse']`, unchanged); `initProject` takes `bylawsText` and `hookEvents` and installs all three hook events by default; the install scanner exports; the `undo`, `guidance`, `loop`, `taint` and `packs` namespaces. Behaviour: in cmd and PowerShell, `timeout` is a command, not a wrapper; the secrets guard uses the shared network list (so `git push`, `npm publish` and cloud CLIs count as network); destructive delete reasons name `openmorals trash`.
- 0.1.0 (initial): first published shape. Any later change to a signature below is listed here, newest first.
- 0.1.0, same day: the parser also unwraps ssh, docker/kubectl exec, wsl, same-line aliases and interpreter one-liners (behaviour only; no signature changed).

## Types

```ts
type Decision = 'allow' | 'ask' | 'deny';
const DECISIONS: readonly Decision[];                 // ['allow', 'ask', 'deny']
function decisionRank(d: Decision): number;           // allow 0, ask 1, deny 2
function strictest(a: Decision, b: Decision): Decision;
function isDecision(v: unknown): v is Decision;

type ShellKind = 'posix' | 'powershell' | 'cmd';

type Action =
  | { kind: 'exec'; command: string; shell: ShellKind; tool: string }
  | { kind: 'read'; path: string; tool: string }
  | { kind: 'write'; path: string; tool: string }
  | { kind: 'fetch'; url: string; tool: string }
  | { kind: 'other'; tool: string };

interface Verdict { decision: Decision; rule: string; reason: string }

interface SessionState { toolCalls: number; tokens: number; prevTokens: number }
const EMPTY_STATE: SessionState;                      // all zeros, frozen

interface Limit { soft: number; hard: number; step: number }   // 0 switches a check off

type RuleDecision = 'ask' | 'deny';
interface RuleMatch { tool?: string; command?: string; path?: string }   // case-insensitive regex sources
interface Rule { id: string; match: RuleMatch; decision: RuleDecision; reason: string; hard: boolean }

interface Bylaws {
  version: 1;
  guards: {
    destructive: { decision: Decision; allow_targets: string[] };
    'online-delete': { decision: Decision };
    secrets: { read: Decision; write: Decision; send: Decision; hard: boolean };
    'self-protect': { decision: Decision };
    budget: { tool_calls: Limit; tokens: Limit };
    loop: { decision: Decision };
    taint: { decision: Decision; trusted_hosts: string[] };
  };
  rules: Rule[];
  audit: { enabled: boolean };
  reviewer: ReviewerBylaws;
  sandbox: SandboxBylaws;
}

interface SandboxBylaws { network: { allow_hosts: string[] }; write: { allow: string[] }; read: { deny: string[] } }

type ReviewerProviderName = 'anthropic' | 'fake';
interface ReviewerBylaws { enabled: boolean; provider: ReviewerProviderName; model: string; api_key_env: string; timeout_ms: number; on_escalate: 'ask' | 'deny' }

type BylawsLoad =
  | { ok: true; bylaws: Bylaws; source: string }
  | { ok: false; error: string; source: string };
```

A loaded `Bylaws` is always complete: every field the file leaves out is filled from `DEFAULT_BYLAWS`.

## Engine

```ts
function decide(action: Action, bylaws: Bylaws | BylawsLoad, state: SessionState, guards?: readonly Guard[]): Verdict;
const BUILTIN_GUARDS: readonly Guard[];               // destructive, online-delete, secrets, self-protect, budget
function ruleMatches(rule: Rule, action: Action, parsed: ParsedCommand | null): boolean;
function describeAction(action: Action): string;      // command text, or "<tool> <path|url>"

interface Finding { decision: Decision; rule: string; reason: string }
interface GuardContext { action: Action; parsed: ParsedCommand | null; bylaws: Bylaws; state: SessionState }
interface Guard { id: string; isHard(bylaws: Bylaws): boolean; evaluate(ctx: GuardContext): Finding[] }
```

`decide` is pure (no I/O) and never throws. The strictest finding wins (deny > ask > allow; the first one wins a tie).
It fails closed:
- `bylaws` with `ok: false`: the defaults are used and the result is at least `ask` (rule `bylaws.invalid` when nothing else fired).
- A guard that throws gives `ask` (rule `<guard>.error`), or `deny` when `guard.isHard(bylaws)` is true (the secrets guard when `guards.secrets.hard`).
- A custom rule that throws gives `ask`, or `deny` when the rule has `hard: true` (rule `rules.<id>.error`).
- A command the parser cannot see through (computed command name, a shell fed from a pipe it cannot read, undecodable `-EncodedCommand`, nesting deeper than 8) gives `ask` (rule `parser.opaque`).
- Any other internal error gives `ask` (rule `engine.error`).

`allow` comes back with rule `none`. Rule ids are `<guard>.<check>` (for example `destructive.recursive-delete`, `destructive.git-force-push`, `destructive.sql-drop`, `online-delete.cloud-delete`, `secrets.send`, `budget.tool_calls.hard`) or `rules.<id>` for custom rules.

`state` is the session's count INCLUDING the call being judged. The budget guard asks when a count first passes `soft` (and again each `step` above it), and denies at or above `hard`.

## Bylaws

```ts
const BYLAWS_FILENAMES: readonly ['openmorals.yaml', 'openmorals.yml'];
const DEFAULT_BYLAWS: Bylaws;
const DEFAULT_BYLAWS_YAML: string;                    // the commented file `openmorals init` writes
function cloneBylaws(b: Bylaws): Bylaws;
function validateBylaws(raw: unknown, source?: string): BylawsLoad;   // raw = parsed YAML/JSON value; null/undefined = defaults
function parseBylaws(text: string, source?: string): BylawsLoad;      // YAML text
function loadBylaws(file: string): BylawsLoad;
function findBylaws(startDir: string): string | null;                 // walks up from startDir to the root
function resolveBylaws(cwd: string, env?: NodeJS.ProcessEnv): BylawsLoad;  // project file, else <configDir>/openmorals.yaml, else defaults (source '<defaults>')
function stringifyBylaws(b: Bylaws): string;          // YAML
function compileRuleRegex(source: string): RegExp;    // new RegExp(source, 'i')
```

There is no `mergeBylaws` in the public package. A merge only needs `validateBylaws`, `strictest`/`decisionRank` and the `Bylaws` type. Every field orders from loose to strict: a decision by `decisionRank`, a `Limit` by lower `soft`/`hard`, `hard: true` over `false`, `audit.enabled: true` over `false`, and `rules` as a union.

### `openmorals.yaml` schema (version 1)

Validation is strict: an unknown key, a wrong type or a bad regular expression makes the whole file invalid, with every error listed as `path: message` joined by `; `.

| key | type | default |
|---|---|---|
| `version` | `1` (required) | |
| `guards.destructive.decision` | allow/ask/deny | ask |
| `guards.destructive.allow_targets` | string[]: plain relative names deletable without asking (no `..`, `~`, absolute paths or wildcards; checked per target) | [] |
| `guards.online-delete.decision` | allow/ask/deny | ask |
| `guards.secrets.read` / `.write` / `.send` | allow/ask/deny | ask / ask / deny |
| `guards.secrets.hard` | boolean | true |
| `guards.self-protect.decision` | allow/ask/deny | ask |
| `guards.budget.tool_calls` | `{soft, hard, step}` whole numbers ≥ 0, soft ≤ hard | 400 / 1500 / 100 |
| `guards.budget.tokens` | same | 2000000 / 5000000 / 500000 |
| `guards.loop.decision` | allow/ask/deny: what a detected loop gets (the same command 4 times, 6 polling steps or 5 near-identical steps with no file written in between, or a command that already failed 3 times with the same error). `allow` switches the detector off | ask |
| `guards.taint.decision` | allow/ask/deny: what a step gets when untrusted content has entered the session, private data is involved and the step reaches the network (Rule of Two). `allow` switches it off | ask |
| `guards.taint.trusted_hosts` | string[]: host names whose pages do not count as untrusted; `docs.example.com` is exact, `.example.com` covers subdomains | [] |
| `rules[]` | `{id, match: {tool?, command?, path?}, decision: ask\|deny, reason?, hard?}` | [] |
| `audit.enabled` | boolean | true |
| `reviewer.enabled` | boolean: ask a second model about every `ask` in the Claude Code hook (sends redacted action text to the provider) | false |
| `reviewer.provider` | `anthropic` (Messages API) or `fake` (a dry run: sends nothing, always "no objection") | anthropic |
| `reviewer.model` | model id, 1-128 of `A-Za-z0-9._:@/-` | claude-haiku-5-5 |
| `reviewer.api_key_env` | the NAME of the environment variable holding the key (never the key) | ANTHROPIC_API_KEY |
| `reviewer.timeout_ms` | whole number, 100 to 25000 (below the hook's 30-second timeout) | 8000 |
| `reviewer.on_escalate` | ask/deny: what a model's `escalate` does; `allow` is rejected | ask |
| `sandbox.network.allow_hosts` | string[]: host names or `*.example.com` (no IP addresses, URLs or bare `*`); empty = network off. Carried only in the srt settings: sandbox-exec and bubblewrap keep the network off whatever it says | [] |
| `sandbox.write.allow` | string[]: extra writable paths, absolute, `~/` or project-relative | [] |
| `sandbox.read.deny` | string[]: extra paths the command may not read | [] |

Custom rule ids match `^[a-z0-9][a-z0-9._-]{0,63}$` (case-insensitive) and must be unique. `decision: allow` is rejected, because a rule can only add a check. Every match field given must match. `path` is tested against the path of a read or write, or against any argument or redirect target of a command.

## Command parser

```ts
function parseCommand(text: string, shell?: ShellKind): ParsedCommand;
interface ParsedCommand { text: string; shell: ShellKind; commands: SimpleCommand[]; opaque: string[] }
interface SimpleCommand { name: string; args: string[]; redirects: Redirect[]; shell: ShellKind; pipeIn: boolean; bulk: boolean; via: string[] }
interface Redirect { op: string; target: string }
```

`commands` is flat. It includes commands nested in `$(...)`, backticks, `bash -c`, `sh -c`, `eval`, `powershell -Command` and `-EncodedCommand`, `cmd /c`, `find -exec`, `xargs`, `echo ... | sh`, `git -c alias.x=!...`, `ssh host '<cmd>'`, `docker exec`/`run`, `kubectl exec -- <cmd>`, `wsl`, aliases defined earlier on the same line, and quoted strings inside `python -c`/`node -e`/`perl -e` code. `${IFS}` and `{a,b}` brace words are split as the shell would. Wrappers (`sudo`, `env`, `nohup`, `timeout`, `nice`, `command`, `exec` and others) are stripped and recorded in `via`. `name` is the lower-cased basename without `.exe`.

## Audit log

```ts
interface AuditRecord {
  v: 1;
  ts: string;                 // ISO 8601 UTC
  source: string;             // 'claude-code' | 'codex' | 'gemini-cli' | 'opencode' | 'check'
  session: string | null;     // the host's session id
  tool: string;               // e.g. 'Bash', 'Read', 'check'
  action: string;             // command text or '<tool> <path>', redacted, at most 2000 chars (+ truncation note)
  decision: Decision;
  rule: string;
  reason: string;             // redacted
  cwd: string | null;
  budget: { tool_calls: number; tokens: number } | null;   // session counts after this call; null for `check`
}
interface AuditReadResult { records: AuditRecord[]; errors: { line: number; error: string }[] }

function appendAudit(record: AuditRecord, file?: string): void;     // default auditLogPath(); redacts again before writing
function makeAuditRecord(input: Omit<AuditRecord, 'v' | 'ts'>, now?: Date): AuditRecord;
function parseAuditLine(line: string): AuditRecord | { error: string };
function parseAuditText(text: string): AuditReadResult;            // skips blank lines, reports bad ones by 1-based line number
function readAudit(file?: string): AuditReadResult;                 // a missing file gives an empty result, not an error
function redact(text: string): string;
```

JSONL line format: one `AuditRecord` per line, `JSON.stringify` with keys in the order above, for example:

```json
{"v":1,"ts":"2026-01-01T00:00:00.000Z","source":"claude-code","session":"abc","tool":"Bash","action":"rm -rf build","decision":"ask","rule":"destructive.recursive-delete","reason":"recursive, forced delete of 'build'","cwd":"/work/app","budget":{"tool_calls":12,"tokens":0}}
```

Secret values are never written. Known token shapes, `Authorization` headers, `user:password@` in URLs, `*_TOKEN=`/`*_SECRET=`-style assignments, `--password` values and PEM private keys are replaced with `[REDACTED]`, and the contents of a file Write are never logged (only its path).

## Directories and session state

```ts
function configDir(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, home?: string): string;
//   $OPENMORALS_HOME, else win32: %APPDATA%\openmorals, else $XDG_CONFIG_HOME/openmorals, else ~/.config/openmorals
function auditLogPath(dir?: string): string;          // <dir>/audit.jsonl
function sessionStatePath(sessionId: string, dir?: string): string;   // <dir>/sessions/<safe id>.json
function safeSessionId(id: string): string;           // [A-Za-z0-9_-] only, at most 128 chars, 'unknown' if empty
function loadSessionState(sessionId: string, dir?: string): SessionState;   // missing or corrupt file gives zeros
function saveSessionState(sessionId: string, state: SessionState, dir?: string, now?: Date): void;   // atomic write, mode 0600
function countToolCall(state: SessionState): SessionState;   // toolCalls + 1
function addTokens(state: SessionState, tokens: number): SessionState;

// Session memory for the loop detector and the taint judge, stored in the same session file.
interface StoredHistoryEntry { action: Action; outcome?: { ok: boolean; error?: string }; id?: string }   // id = the host's tool-use id
interface SessionMemory { history: readonly StoredHistoryEntry[]; taint: TaintState }
const EMPTY_MEMORY: SessionMemory;
const HISTORY_KEEP: 20;
function loadSession(sessionId: string, dir?: string): { state: SessionState; memory: SessionMemory };
function saveSession(sessionId: string, state: SessionState, memory: SessionMemory, dir?: string, now?: Date): void;
function sessionFindings(action: Action, memory: SessionMemory, bylaws: Bylaws, ctx: TaintContext): Finding[];   // loop + taint, per the bylaws switches
function combineVerdict(verdict: Verdict, findings: readonly Finding[]): Verdict;   // strictest wins; a tie keeps the engine's verdict
function recordAction(memory: SessionMemory, action: Action, verdict: Verdict, ctx: TaintContext, id: string | null): SessionMemory;   // redacted, last 20; a denied action does not taint
function recordOutcome(memory: SessionMemory, action: Action, outcome: { ok: boolean; error?: string }, id: string | null): SessionMemory;
function taintContext(projectRoot: string, bylaws: Bylaws, platform?: NodeJS.Platform): TaintContext;
function parseMemory(raw: unknown): SessionMemory;    // a damaged taint state reads as tainted, a missing one as clean
function unattendedVerdict(v: Verdict): Verdict;      // ask becomes deny; allow and deny unchanged
function isUnattended(env: NodeJS.ProcessEnv): boolean;   // OPENMORALS_UNATTENDED set and not 0/false
```

`saveSessionState` keeps the stored memory; `saveSession` replaces it. Command text, paths, URLs and failure text are passed through `redact()` before they are stored, and failure text is cut to 400 characters.

## Claude Code adapter and init

```ts
interface ClaudeCodeHookInput { session_id: string | null; cwd: string | null; hook_event_name: string | null; tool_name: string; tool_input: Record<string, unknown>; tool_use_id: string | null; error: string | null; is_interrupt: boolean }
function parseHookInput(text: string): { ok: true; input: ClaudeCodeHookInput } | { ok: false; error: string };
function toAction(toolName: string, toolInput: Record<string, unknown>): Action;
function toHookOutput(v: Verdict): string | null;     // null for allow (print nothing); else the PreToolUse hookSpecificOutput JSON
interface HookRun { stdout: string; exitCode: 0; verdict: Verdict }
function runClaudeCodeHook(stdinText: string, opts?: { env?: NodeJS.ProcessEnv; cwd?: string; now?: Date; unattended?: boolean }): HookRun;
const POST_EVENTS: readonly string[];                 // ['PostToolUse', 'PostToolUseFailure']

type HookEvent = 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure';
const ALL_HOOK_EVENTS: readonly HookEvent[];
const DEFAULT_HOOK_COMMAND: 'openmorals hook claude-code';
function mergeClaudeSettings(existing: unknown, command?: string, events?: readonly HookEvent[]): { ok: true; settings: Record<string, unknown>; changed: boolean } | { ok: false; error: string };   // events defaults to ['PreToolUse']
function initProject(dir: string, opts?: { hookCommand?: string; installHook?: boolean; now?: Date; bylawsText?: string; hookEvents?: readonly HookEvent[] }): InitResult;   // hookEvents defaults to ALL_HOOK_EVENTS

function sensitiveLabel(path: string): string | null;  // why a path counts as a secret, or null
const NETWORK_COMMANDS: ReadonlySet<string>;           // the one list of network command names
function reachesNetwork(command: SimpleCommand): boolean;   // used by the secrets guard and the taint tracker
const VERSION: string;
```

`runClaudeCodeHookReviewed(stdinText, opts?: HookOptions & { reviewProvider?: ReviewProvider }): Promise<HookRun>` is what `openmorals hook claude-code` runs: the same as `runClaudeCodeHook`, and then, only when the bylaws are valid, `reviewer.enabled` is true, the answer is `ask` and the run is not unattended, the reviewer (see below). `reviewProvider` replaces the provider named in the bylaws (tests use a fake one).

The hook answers three events. `PreToolUse` runs the engine, then the loop detector and the taint judge over the session memory, and prints the strictest answer. `PostToolUse` (the tool succeeded) and `PostToolUseFailure` (the tool failed; `error` holds the failure text) only record the outcome on the matching history entry, by `tool_use_id`, and print nothing; an interrupted call (`is_interrupt: true`) is not recorded as a failure. Any other event prints nothing. Input shapes are taken from the Claude Code hooks reference, https://code.claude.com/docs/en/hooks (read 23 Nov 2026).

## Other hosts (Codex CLI, Gemini CLI, opencode)

```ts
import { codexAdapter, geminiCliAdapter, opencodeAdapter, installAgentHook } from 'openmorals';

codexAdapter.runCodexHook(stdinText: string, opts?: { env?; cwd?; now?; unattended?: boolean; platform? }): { stdout: string; exitCode: 0; verdict: Verdict };
geminiCliAdapter.runGeminiHook(stdinText: string, opts?): { stdout: string; exitCode: 0; verdict: Verdict };
opencodeAdapter.runOpencodeHook(stdinText: string, opts?): { stdout: string; exitCode: 0; verdict: Verdict; answer: OpencodeAnswer };
// each namespace also has installSnippet(), mergeConfig(), SOURCE, DEFAULT_COMMAND and its own input parser and output writer
function installAgentHook(dir: string, agent: 'codex' | 'gemini-cli' | 'opencode', opts?: { hookCommand?: string; now?: Date }): AgentInstallResult;
type AgentInstallResult =
  | { ok: true; agent; file: string; changed: boolean; backupPath: string | null; followUp: string }
  | { ok: false; agent; file: string; error: string; snippet: string };   // nothing was written
```

They run the same engine, the loop detector, the taint judge and unattended mode, count the budget and write the audit log. What each host can express (Codex and opencode V1 have no ask, so an ask is sent as a block), the input and output shapes with their sources, and what was not run: [docs/adapters.md](docs/adapters.md).

## Reviewer

```ts
function reviewVerdict(action: Action, verdict: Verdict, cfg: ReviewerBylaws, opts?: { env?; provider?: ReviewProvider; context?: string; nonce?: string }): Promise<{ verdict: Verdict; outcome: ReviewOutcome | null }>;
function reviewerProvider(cfg: ReviewerBylaws, env?): ReviewProvider;     // anthropic or the dry-run fake; reads the key only when a review is sent
function reviewAction(req: { action: Action; verdict: Verdict; context?: string }, provider: ReviewProvider, opts?: ReviewOptions): Promise<ReviewOutcome>;
function applyReview(v: Verdict, review: Review, onEscalate?: 'ask' | 'deny'): Verdict;   // strictest(v.decision, ...): never looser
type ReviewVerdict = 'escalate' | 'no-objection';                          // there is no 'allow'
```

Only an `ask` is sent; `allow` and `deny` come back unchanged and the provider is not called. A model's `no-objection` keeps the `ask` and adds its note to the reason; a model's `escalate` keeps the `ask`, or denies when `on_escalate: deny`. Every failure (timeout, HTTP or network error, missing key, refusal, an unparseable reply, a crash) keeps the `ask` and names the cause in the reason, whatever `on_escalate` says. The audit log records the final verdict. Full design, framing, limits and the provider's request shape: [docs/reviewer.md](docs/reviewer.md).

## Sandbox

```ts
function planSandbox(bylaws: Bylaws | BylawsLoad, platform: string, projectRoot: string, opts: PlanOptions): SandboxPlan;   // pure
function hostPlanInputs(projectRoot: string): { projectRoot: string; opts: PlanOptions };   // real paths of this machine
function runSandboxed(cmd: string, args: readonly string[], plan: SandboxPlan, deps?: RunDeps): Promise<RunResult>;   // 125 and nothing started on refusal
function sandboxCommand(rest: readonly string[], bylaws: BylawsLoad, projectRoot: string, deps?: SandboxCommandDeps): Promise<{ exitCode: number; stdout: string; stderr: string; plan: SandboxPlan | null }>;
const SANDBOX_REFUSED_EXIT: 125;
```

`openmorals sandbox plan [--json] [--platform darwin|linux|win32]` prints the plan (exit 0, or 1 when no plan can be made). `openmorals sandbox run -- <cmd> [args...]` runs the command as an argument vector, never through a shell, under `/usr/bin/sandbox-exec` (macOS) or `bwrap` from a fixed path (Linux), and exits with its exit code; it refuses with 125 and starts nothing when the tool is missing, on Windows, when the plan is invalid, or when the command is not written after `--`. Credential-named environment variables are dropped from the child. `RunDeps` and `SandboxCommandDeps` inject the platform, tool detection, spawn and plan inputs for tests. Design and limits: [docs/sandbox.md](docs/sandbox.md).

## Install scanner

```ts
function scanPath(target: string, options?: ScanOptions): ScanReport;            // a folder or one file; never runs anything
function scanFiles(files: readonly ScanFile[], options?: ScanOptions, root?: string): ScanReport;
function formatScanText(report: ScanReport): string;
function formatScanJson(report: ScanReport): string;
function verdictFor(worst: Severity | null): ScanVerdict;                         // ScanVerdict is the Decision union
const SCAN_RULES: readonly ScanRule[];
const DEFAULT_SCAN_LIMITS: ScanLimits;
const UNDISABLEABLE_RULES: readonly string[];
function ruleById(id: string, rules?: readonly ScanRule[]): ScanRule | undefined;
function classifyFile(path: string, text: string): FileKind;
function redactSecrets(text: string): string;
interface ScanReport { readonly root: string; readonly verdict: ScanVerdict; readonly counts: SeverityCounts; readonly findings: readonly ScanFinding[]; readonly stats: ScanStats; readonly limits: ScanLimits }
```

Types: `ScanFinding`, `ScanRule`, `ScanFile`, `ScanOptions`, `ScanLimits`, `ScanStats`, `ScanVerdict`, `Severity`, `SeverityCounts`, `FileKind`, `RuleHit`, `RuleMatcher`. Full description, rules and limits: [docs/scanner.md](docs/scanner.md).

## Extras (namespaced exports)

```ts
import { undo, guidance, loop, taint, packs } from 'openmorals';

undo.trash(target: string, opts: { root: string; cwd?: string; session?: string }): UndoResult<TrashedItem>;
undo.restore(id: string, opts: { root: string }): UndoResult<ListedItem>;
undo.list(opts: { root: string; all?: boolean }): UndoResult<{ items: ListedItem[]; badLines: number[] }>;
undo.purge(opts: { root: string; olderThanDays: number; confirm: boolean }): UndoResult<{ purged: string[]; failed: { id: string; message: string }[] }>;
//   UndoResult<T> = { ok: true; value: T } | { ok: false; code: UndoErrorCode; message: string }; pure planners planTrash/planRestore/planPurge are exported too

guidance.renderGuidance(bylaws: Bylaws, opts?: GuidanceOptions): string;        // the marked block
guidance.writeGuidance(file: string, bylaws: Bylaws, opts?: GuidanceOptions): WriteResult;
guidance.clearGuidance(file: string): WriteResult;
//   GuidanceOptions { trashCommand?, restoreCommand?, loopEnforced?, taintEnforced? }

loop.detectLoop(history: readonly HistoryEntry[], next: Action, options?: Partial<LoopOptions>): LoopVerdict;   // allow or ask, with kind and count

taint.reduceTaint(state: TaintState, event: TaintEvent, ctx: TaintContext): TaintState;
taint.judge(action: Action, state: TaintState, ctx: TaintContext): TaintVerdict;   // allow or ask (rule taint.rule-of-two)
taint.CLEAN_TAINT: TaintState;

packs.listPacks(dir?: string): { name: string; file: string; description: string }[];
packs.loadPack(name: string, dir?: string): BylawsLoad;
packs.readPackText(name: string, dir?: string): { ok: true; name: string; file: string; text: string } | { ok: false; error: string };
packs.loosenings(candidate: Bylaws, baseline: Bylaws): { field: string; candidate: string; baseline: string }[];
packs.PACK_NAMES: readonly ['solo-dev', 'strict', 'ci-unattended', 'production-ops', 'beginner'];
```

Each module's full surface, design and limits: [docs/extras.md](docs/extras.md).
