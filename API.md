# openmorals public API (v0.1.0)

The package entry point is `openmorals` (ESM, `dist/src/index.js`, types in `dist/src/index.d.ts`).
Everything below is exported from it. Run `npm run build` to produce `dist/`.

## Changes

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
  };
  rules: Rule[];
  audit: { enabled: boolean };
}

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
| `rules[]` | `{id, match: {tool?, command?, path?}, decision: ask\|deny, reason?, hard?}` | [] |
| `audit.enabled` | boolean | true |

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
  source: string;             // 'claude-code' | 'check' (more adapters later)
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
```

## Claude Code adapter and init

```ts
interface ClaudeCodeHookInput { session_id: string | null; cwd: string | null; hook_event_name: string | null; tool_name: string; tool_input: Record<string, unknown> }
function parseHookInput(text: string): { ok: true; input: ClaudeCodeHookInput } | { ok: false; error: string };
function toAction(toolName: string, toolInput: Record<string, unknown>): Action;
function toHookOutput(v: Verdict): string | null;     // null for allow (print nothing); else the PreToolUse hookSpecificOutput JSON
interface HookRun { stdout: string; exitCode: 0; verdict: Verdict }
function runClaudeCodeHook(stdinText: string, opts?: { env?: NodeJS.ProcessEnv; cwd?: string; now?: Date }): HookRun;

const DEFAULT_HOOK_COMMAND: 'openmorals hook claude-code';
function mergeClaudeSettings(existing: unknown, command?: string): { ok: true; settings: Record<string, unknown>; changed: boolean } | { ok: false; error: string };
function initProject(dir: string, opts?: { hookCommand?: string; installHook?: boolean; now?: Date }): InitResult;

function sensitiveLabel(path: string): string | null;  // why a path counts as a secret, or null
const VERSION: string;
```
