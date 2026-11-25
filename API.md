# openmorals public API (v0.16.0)

The package entry point is `openmorals` (ESM, `dist/src/index.js`, types in `dist/src/index.d.ts`).
Everything below is exported from it. Run `npm run build` to produce `dist/`.

## Changes

- 0.16.0: added (nothing removed or renamed): `RuleMatch.detector` (a detector name or a list) and `RuleMatch.network` (`true`); on the `other` member of `Action`, the optional `raw` (an `ActionText`: every key, string and number of the input, one per line, capped, NOT redacted, read only by detectors); `Bylaws.guards.taint.private_paths` (optional globs); `ruleCheck`, the types `RuleCheck`, `DetectorHit`, `RuleMeter` and `StepMeter`, `newRuleMeter`, `detectorTexts`, `hitNote`, `maskAction`, `MAX_CALL_CONTENT_STEPS`; `DETECTOR_NAMES`, `DETECTORS`, the types `DetectorName` and `DetectorInfo`, `detectCount`, `isDetectorName`, `luhnValid`, `ibanValid`, `ssnValid`, `nhsValid`, `reservedDomain`, `fictionalPhone`, `TEST_CARD_NUMBERS`, `IBAN_LENGTHS`, `LABEL_WINDOW`, `MAX_DETECTOR_HITS` (and in `src/rules/detectors.ts` `detectSpans`, `maskDetected`, `namedDetectors` for the adapters); in the `taint` namespace `actionReachesNetwork` and `privatePathGlob`; in the `inbound` namespace `rawText`. Optional new parameters: `ruleOutcome(..., meter?)`, `ContentPattern.search(text, maxSteps?, meter?)`, `describeAction(action, mask?)`, `recordAction`, `findCallEntry` and `recordOutcome` (`mask?`, the detectors whose hits are masked in what is stored). Behaviour: with no rule that names a detector every decision and every stored or audited text is unchanged; `validateBylaws` refuses an unknown detector, an empty list, `network: false` and a bad `private_paths` glob, with the reason; the floor walk compares `match.detector` and `match.network` per user rule id and keeps the user's `private_paths`; a decision's content rules share one step budget (`MAX_CALL_CONTENT_STEPS`). Code that compares an `other` action with `deepEqual` must allow the new field (or compare `withoutContent(a)`).
- 0.15.0: added (nothing removed or renamed): on the `write` member of `Action`, the optional `content` (an `ActionText`, capped like `args`, not redacted); `RuleMatch.content`; `ruleOutcome`, the type `RuleOutcome` (`'match' | 'cut' | 'steps'`), `actionTexts`, `compileContentPattern`, the types `ContentPattern` and `ContentPatternResult`, and the constants `MAX_CONTENT_PATTERN_CHARS`, `MAX_CONTENT_REPEAT`, `MAX_CONTENT_PROGRAM`, `MAX_CONTENT_STEPS`; in the `inbound` namespace nothing new is exported (`contentText` and `writeContent` live in `src/inbound/outbound.ts` for the adapters). Behaviour: every adapter's write mapping fills `content` from the host's documented field (docs/adapters.md, "Content rules"); `validateBylaws` accepts `match.content` and refuses a pattern the linear-time matcher cannot run, with the reason, under `rules[i].match.content`; `decide` reads `match.content` over a write's content and an `other` action's `args` and `message`, and when the text was cut or the search ran out of steps a deny rule fires as matched and an ask rule asks (same rule id, a reason that says so); `ruleMatches` is true in those cases too; `loosenings` and the project floor compare `match.content` per user rule id; `storedAction` and `withoutContent` drop write content. With no content rule every decision is unchanged. Code that compares a `write` action with `deepEqual` must allow the new field (or compare `withoutContent(a)`).
- 0.14.0: added (nothing removed or renamed): the type `ActionText` (`text`, `bytes`, `cut`) and, on the `other` member of `Action`, the optional `args` and `message`; in the `inbound` namespace `judgeAgentMessage`, `scanOutbound`, `contentAction`, `argsText`, `messageText`, `capText`, `withoutContent`, the constants `ACTION_TEXT_MAX_BYTES`, `ACTION_TEXT_MAX_DEPTH`, `ACTION_TEXT_MAX_VALUES`, `MESSAGE_TOOLS`, `SECRET_KEY` and the types `ContentHost`, `OutboundScan`, `OutboundOrigin`; `InboundOrigin` also takes `agent-message`; in the `diffClass` namespace `diffClassVerdictWith`, `formatDiffClass` and the type `DiffClassOutcome`. Behaviour: `toAction` and `toActions` (Claude Code) and `codexActions`, `geminiActions`, `opencodeToolActions` and `openclawToolActions` put `args` (and, for the tools in `MESSAGE_TOOLS`, `message`) on the `other` action; `openclawToolActions` also returns that `other` action after any lifted path or URL actions (before, it was dropped when one was lifted). Every hook scans `message` text with the inbound rules before the call: a finding writes an audit line after the call's own line and marks the session (`injected` or `untrusted`); the call's verdict is unchanged. `storedAction` drops `args` and `message`, so the session history and the audit line never hold them; no guard reads them. `redact()` gives the same output with a URL-credential pattern that no longer slows down on long runs of letters. Code that compares an `other` action with `deepEqual` must allow the new fields (or compare `withoutContent(a)`).
- 0.13.0: added (nothing removed or renamed): in the `diffClass` namespace, `diffClassCommandWith` (the command with merge settings supplied by the caller), `INTEGRITY_RULES`, `integrityReasons`, `notChecked`, `versions`, `literalShape`, the patterns `ASSERT_RE`, `SKIP_RE`, `EXIT_RE`, `EQUALITY_RE`, `SUPPRESSION_RE`, the lists `TEST_GLOBS`, `RUNNER_GLOBS`, `SNAPSHOT_GLOBS`, `ADR_GLOBS`, `MANIFESTS`, `CODE_EXTENSIONS` and the types `IntegrityRule`, `IntegrityContext`, `DiffClassSettings`; `ClassifyInput` gains the optional `declaredPaths`, `boundaryPaths`, `maxLines`, `maxFiles` and `settingsSource`; `DiffVerdict` gains `notChecked`; `ReasonSource` takes a second argument (an `IntegrityContext`; a one-argument source still fits); `MergeBylaws` gains the optional `boundary_paths` (validated by `validateBylaws`; `loosenings` and the user floor treat it as a protected list); `REASON_SOURCES` now holds the test-integrity source; diff-class case rows accept `paths`, `boundary_paths`, `max_lines`, `max_files` and `not_rule`. CLI: `diff-class --paths GLOB` (repeatable), `--max-lines N`, `--max-files N`; `--json` gains `notChecked`. Behaviour: test-integrity reasons (`integrity.*`) can only add review; a diff that met a switched-on class can now need review because of one; the `class.off` reason names the settings source the caller gave (default unchanged: "the user-level file").
- 0.12.0: added (nothing removed or renamed): the `diffClass` namespace (`diffClassCommand`, `classifyDiff`, `parseDiff`, `decodeDiff`, `pathDoubt`, `applyHunks`, `gitBlobHash`, `hashNames`, `folderReader`, `memoryReader`, `rebuild`, `checkCaseRows`, `checkBylaws`, `isCaseFile`, `scanAdded`, `exclusionsFor`, `isRootBylaws`, `compileGlob`, `firstMatch`, `globProblem`, `factsOf`, `parseSummary`, `recordReasons`, `reasonLines`, `formatVerdictText`, `formatVerdictJson`, the constants `DIFF_CLASS_EXIT`, `DIFF_CLASS_USAGE`, `EXCLUSIONS`, `REASON_SOURCES`, `CANNOT_SEE`, `CANNOT_SEE_REPRODUCED`, `ROOT_BYLAWS`, `SCAN_RULE_PREFIXES`, `MAX_DIFF_BYTES`, `MAX_DIFF_FILES`, `MAX_BASE_FILE_BYTES` and the types); `MergeBylaws`, `MergeClass`, `MERGE_CLASSES` and the optional `Bylaws.merge` (validated by `validateBylaws`; `loosenings` and the user floor treat `merge.review_free` as an exemption list and `merge.always_review` as a protected list); `evals.EvalCases.diffClass` and `evals.EvalReport.diffClass` (rows in a `*.cases.yaml` file headed `classifier: diff-class`). CLI: `openmorals diff-class`; `openmorals eval` prints a diff-class line and `--json` gains `diffClass`; `--guard diff-class` scores only those rows.
- 0.11.0: added (nothing removed or renamed): the `auditSample` namespace (`sampleCommand`, `planDraw`, `drawPicks`, `pickNumber`, `scanLog`, `rateState`, `tallySamples`, `findPick`, `readSampleEvent`, `drawData`, `parseSampleSettings`, the constants `DEFAULT_SAMPLE_SETTINGS`, `SAMPLE_BYS`, `SAMPLE_VERDICTS`, `SAMPLE_LIMITS`, `SAMPLE_METHOD`, `SAMPLE_RULES`, `SAMPLE_SESSION`, `SAMPLE_RATE_MAX`, `SAMPLE_READ_ALL_MAX`, `SAMPLE_SETTLE_MAX`, `SAMPLE_SETTINGS_FILE`, `SAMPLE_USAGE`, `SAMPLE_EMPTY_EXIT`, `SAMPLE_UNREADABLE_EXIT`, `SAMPLE_USAGE_EXIT` and the types); the type `AuditSampleData` and the optional `AuditFields.sample`, written by `chainAudit` and kept by `parseAuditLine` (a `sample` that is not an object makes the line an error). CLI: `openmorals audit sample`. Behaviour: self-protect asks for every `audit sample` form that writes, and applies its `openmorals` list to `npx`, `bunx`, `pnpx`, `npm`/`pnpm`/`yarn`/`bun` `exec`/`x`/`dlx` and `python -m openmorals` (more asks only).
- 0.10.0: added (nothing removed or renamed): the `tests` namespace (`parseTestReport`, `detectFormat`, `compareTests`, `parseApprovals`, `testsCommand`, `parseXml`, `relativeTo`, `isReportFormat`, `isLossKind`, the constants `REPORT_FORMATS`, `LOSS_KINDS`, `ID_SEPARATOR`, `APPROVAL_FILE`, `LIMITS`, `MAX_REPORT_BYTES`, `TESTS_USAGE`, `UNREADABLE_EXIT` and the types). CLI: `openmorals tests compare`. No engine or hook behaviour changed.
- 0.9.0: added (nothing removed or renamed): `packs.PACK_NAMES` gains `test-lock` (an add-on pack of ask rules); `evals.CASE_KEYS` gains `pack` (a case row judged under a shipped pack's file; `Case.bylaws` then holds that file's parsed YAML). CLI: `openmorals packs NAME` prints one pack's file. No engine or hook behaviour changed.
- 0.8.1: added (nothing removed or renamed): `toActions`, `decideCall`, `adapterVerdicts` and `isMcpTool` from the Claude Code adapter; `evals.Case` gains `actions` and `tool`. Behaviour: `runClaudeCodeHook` and `runClaudeCodeHookReviewed` judge a tool without its own mapping (every `mcp__` tool) as `other` plus the actions `argActions` lifts from its top-level path and URL arguments, and an `mcp__` tool named like a delete takes the `online-delete` decision as `adapter.mcp-delete`; the audit line names every action, joined by ` ; `. A mapped built-in tool is judged exactly as before. `scoreCases` and the case tests judge a row with `decideCall`.
- 0.8.0: added (nothing removed or renamed): `AuditRecord` is now `AuditRecordV1 | AuditRecordV2` (common fields `AuditFields`; v2 adds `seq`, `prev`, `ov` and the optional `bylaws`, `event`, `run`, `agent`); `AUDIT_GENESIS`, `ChainHead`, `AuditMeta`, `ChainedAudit`, `chainAudit`, `appendAuditText`, `auditLineHash`, `bylawsDigest`, `auditMeta`; `appendAuditForSession`; `verifyAudit`, `verifyAuditText`, `readSessionHeads`, `summarizeRun`, `summarizeRunText`, `formatVerify`, `formatRunSummary` and their types; `SessionMemory.chain` and `StoredHistoryEntry.asked` (optional), `findCallEntry`, `parseChain`; `ClaudeCodeHookInput.agent_id`; `PostToolEvent` and `PromptEvent` take optional `event` and `agent`. Behaviour: every hook writes version 2 lines chained per session file and keeps the chain head in the session file; a post-tool event for a call that was asked about writes an `ask.approved` line; `openmorals check` and an unreadable hook input chain under the session `unknown` (and so write its session file); `parseAuditLine` reads version 1 and 2 and rejects a version 2 line with a bad `seq` or `prev`. Code that switches on `record.v === 1` must also accept 2. `makeAuditRecord` and `appendAudit` are unchanged and still write unchained version 1 records, which `verify` reports as `unchained` after the chain began; use `appendAuditForSession` instead.
- 0.7.0: added (nothing removed or renamed): the `evals` namespace (`loadCases`, `loadCasesFrom`, `folderSource`, `embeddedCaseSource`, `defaultCasesDir`, `scoreCases`, `runEval`, `formatEvalText`, `formatEvalJson`, the constants `CASE_KEYS`, `CASE_HOME`, `CASE_CONFIG_DIR`, `CASE_CWD`, `MAX_CASE_FILE_BYTES`, `EVAL_REPETITIONS`, `EVAL_EXIT`, `EVAL_JSON_SCHEMA` and the types). Behaviour: none of the existing functions changed.
- 0.6.2: added (nothing removed or renamed): `decide` takes an optional fifth argument `where` (type `Where`), `GuardContext.where` (optional), `makeWhere`, `resolveLinks`, `pathExists`; `AuditReadResult.status` (type `AuditStatus`); `SessionMemory.unreadable` (optional) and `unreadableFindings`. Behaviour: `decide` reads the file system to resolve symbolic links (no writes); the self-protect guard covers the real config directory, the folders above it, paths inside arguments and paths reached through links; `loadSession` gives an unreadable or unparsable session file a tainted memory with `unreadable` set instead of a clean one; `readAudit` reports a missing file as `missing`, not as an empty log; `recordOutcome` keeps memory fields other than history and taint.
- 0.6.1: added (nothing removed or renamed): `keyEnvNameProblem` (next to `baseUrlProblem`), and `RULE_KEPT_BESIDE` and `isRuleKeptBeside` in `packs/compare` (not re-exported at the top level). Behaviour: `reviewer.api_key_env` must be 1-64 letters, digits and underscores, not starting with a digit, all upper case or all lower case, with no run of more than 24 characters between underscores, and left unchanged by the redactors; anything else is refused (the error names the setting, never the value), and `readKey` refuses it without reading the environment. `looseningNote` reports a project rule that shares an id with a user rule as `note bylaws.rule-kept-beside: ...` instead of `tried to loosen`; the `ignored` list is unchanged.
- 0.6.0: added (nothing removed or renamed): `ReviewerProviderName` also takes `anthropic-messages` (the new default), `openai-chat` and `gemini`; `ReviewerBylaws` gained optional `base_url`, `auth` and `compat` (type `ReviewerCompat`); `createOpenAIChatProvider`, `chatRequestBody`, `readChatResponse`, `createGeminiProvider`, `generateContentBody`, `readGenerateContentResponse`, `baseUrlProblem`, their option types and default constants; `reviewerProvider` takes an optional `fetch`, and `ReviewVerdictOptions` a `fetch`; `REVIEWER_DEFAULT_KEY_ENV`; `validateBylaws`, `parseBylaws` and `loadBylaws` take an optional `project` flag; the Anthropic client's `name` is `anthropic-messages`. `InboundBylaws.judge` (optional) and, in the `inbound` namespace, `handlePostToolJudged`, `JudgedRunOptions`, `flaggedSpan`, `judgeFrame`, `judgeKey`, `judgeSpan`, `JudgeOptions`, `JudgeResult` and the `JUDGE_*` constants; `callWithTimeout` is exported from the reviewer module; `runClaudeCodeHookReviewed` runs the judge on post-tool events when `guards.inbound.judge` is on. `guards.budget.cost` and `guards.budget.prices` (optional; types `ModelPrice`), `SessionState.cost` and `prevCost` (optional); `addCost`, `settleBudget`, `usageCounts`, `costOf`, `recordUsage` and their types; `codexAdapter.CODEX_EVENTS` and the install snippet include `PostModelRequest`. The `openclawAdapter` namespace (`runOpenclawHook`, `openclawToolActions`, `toOpenclawAnswer`, `installSnippet`, the plugin source functions and types); `AgentName` and `AGENT_NAMES` include `openclaw`; `installAgentHook(dir, 'openclaw')`. Behaviour: `countToolCall` and `addTokens` no longer move `prevTokens`; a judged call saves `settleBudget(state)`, so tokens reported between two calls are seen by the next (before, a soft token step reported between calls never asked). `effectiveBylaws`, `looseningNote`, `packs.tighten`, the type `Loosening` at the top level; optional `base` parameters on `validateBylaws`, `parseBylaws` and `loadBylaws`; `floorSource` and `ignored` on a valid `BylawsLoad`, `floor` on an invalid one. Behaviour: `resolveBylaws` treats the user-level file (else the defaults) as a floor that a project file can only tighten; looser project settings are dropped, listed in `ignored`, noted in every verdict's reason (`note bylaws.loosening-ignored: ...`) and printed by `check` and `validate` on stderr. The reviewer's provider, model, key variable, timeout and switch, and `guards.inbound.notify`, are read from the user-level file only. An invalid project file fails closed on the user floor instead of the defaults.
- 0.5.0: added (nothing removed or renamed): `guards.inbound` in `Bylaws` (type `InboundBylaws`: `enabled`, `decision`, `notify`, `max_bytes`; constants `INBOUND_MAX_BYTES_DEFAULT`, `INBOUND_MAX_BYTES_MIN`, `INBOUND_MAX_BYTES_MAX`) and the schema; the `inbound` namespace (`scanInbound`, `stripInvisible`, `textOfResult`, `judgeToolResult`, `judgePrompt`, `handlePostTool`, `handlePrompt`, `safeToolName`, `auditReason`, `INBOUND_SCAN_DEFAULT_MAX_BYTES` and the types); `toClaudeInboundOutput` and `InboundHookEvent`; `HookEvent` and `ALL_HOOK_EVENTS` include `UserPromptSubmit`; `ClaudeCodeHookInput` gained `tool_response` and `prompt`; the taint state gained an optional `injectedCount`, the event `{ type: 'injected', detail }` and the source `inbound-content`; `codexAdapter.installSnippet()` and `geminiCliAdapter.installSnippet()` carry three events (`CODEX_EVENTS`, `GEMINI_EVENTS`); `opencodeAdapter.toOpencodeInboundAnswer` and `OpencodeAnswer.notice`. Behaviour: the taint judge asks with `taint.injected-content` before a network or private-data step once hidden instructions were found in the session; `runClaudeCodeHook` answers `UserPromptSubmit` and scans `PostToolUse` results; `runCodexHook`, `runGeminiHook` and `runOpencodeHook` handle their post-tool and prompt events; `packs.loosenings` compares `allow_targets` with the engine's matcher and reports `budget.*.step` and `guards.inbound`; `initProject` installs `UserPromptSubmit`. Code that builds a `Bylaws` object by hand must now add `guards.inbound` (copy it from `DEFAULT_BYLAWS`).
- 0.4.0: added (nothing removed or renamed): `packs.embeddedPacks()` and the type `EmbeddedPacks` (the packs built into a single executable, or `null` outside one). Behaviour: inside the single-file binary, `packs.listPacks()`, `packs.readPackText()` and `packs.loadPack()` called without `dir` read the packs embedded in the binary; their `file` is `(built in)/packs/<name>.yaml`.
- 0.3.1: no signature changed. Behaviour: on `platform: 'win32'` (the default on Windows), `runCodexHook`, `runGeminiHook` and `runOpencodeHook` read a shell command as PowerShell, POSIX shell and cmd.exe and keep the strictest verdict; the destructive guard reads a PowerShell `rm` as the POSIX `rm` too.
- 0.3.0: added (nothing removed or renamed): `normalizeAllowTarget`, `matchesAllowTarget` and `isSafeAllowTarget` (the destructive guard's own allow-target functions) and `hasOpenMoralsHook`; the `codexAdapter`, `geminiCliAdapter` and `opencodeAdapter` namespaces, `installAgentHook`, `AGENT_NAMES`, `isAgentName`, `opencodeCommand`, `AGENT_FOLLOW_UP`; `AuditRecord.source` may also be `codex`, `gemini-cli` or `opencode`. Behaviour: the self-protect guard also covers the Codex, Gemini CLI and opencode hook and plugin files. `sandbox` in `Bylaws` (type `SandboxBylaws`) and the schema; the sandbox exports (`planSandbox`, `runSandboxed`, `sandboxCommand`, `planForProject`, `formatPlanText`, `hostPlanInputs`, `detectSandboxTool`, `validateSandboxSection`, `SANDBOX_REFUSED_EXIT` and the types); `packs.loosenings` reports extra sandbox hosts, extra writable paths and dropped read-denied paths. `reviewer` in `Bylaws` (types `ReviewerBylaws`, `ReviewerProviderName`; constants `REVIEWER_TIMEOUT_MIN_MS`, `REVIEWER_TIMEOUT_MAX_MS`) and the schema; `runClaudeCodeHookReviewed` and `ReviewedHookOptions`; the reviewer exports (`reviewAction`, `reviewVerdict`, `reviewerProvider`, `applyReview`, `createAnthropicProvider`, `createFakeProvider`, `parseReviewReply`, `buildReviewPrompt`, `DEFAULT_REVIEW_MODEL`, `DRY_RUN_REPLY`, `REVIEW_VERDICTS` and the types). `packs.loosenings` also reports `reviewer.enabled` switched off and a softer `reviewer.on_escalate`. Behaviour: `openmorals hook claude-code` now goes through `runClaudeCodeHookReviewed` (identical output while `reviewer.enabled` is false). Code that builds a `Bylaws` object by hand must now add `reviewer` and `sandbox` (copy them from `DEFAULT_BYLAWS`); a loaded `Bylaws` always has them.
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
  | { kind: 'write'; path: string; tool: string; content?: ActionText }   // content: 0.15.0
  | { kind: 'fetch'; url: string; tool: string }
  | { kind: 'other'; tool: string; args?: ActionText; message?: ActionText; raw?: ActionText };   // raw: 0.16.0

interface ActionText { text: string; bytes: number; cut: boolean }
//   0.14.0. `args`: the call's arguments as compact JSON, every string value through redact() and a value under a
//   secret-named key replaced by [REDACTED], nested objects walked to depth 8, at most 2,000 values. `message`: the text
//   the call hands to another agent (see MESSAGE_TOOLS). Both capped at ACTION_TEXT_MAX_BYTES (262144 UTF-8 bytes); over
//   it the first and last halves are kept, `cut` is true and `bytes` is the size before redaction and the cut. Neither is
//   written to the audit log or the session history, and no guard reads them; content rules do (0.15.0), after redaction.
//   0.15.0. `content` on a write: what the write puts in the file, from the host's documented field, capped the same way
//   but NOT redacted (a content rule must see a key being written). Never written to the audit log or the session history.
//   0.16.0. `raw` on `other`: every key, string and number of the input, one per line, capped the same way, NOT redacted,
//   cut when the walk stopped early. Read only by detectors; never stored, never put in a reason.

interface Verdict { decision: Decision; rule: string; reason: string }

interface SessionState { toolCalls: number; tokens: number; prevTokens: number }
const EMPTY_STATE: SessionState;                      // all zeros, frozen

interface Limit { soft: number; hard: number; step: number }   // 0 switches a check off

type RuleDecision = 'ask' | 'deny';
interface RuleMatch { tool?: string; command?: string; path?: string; content?: string; detector?: string | string[]; network?: true }
//   tool, command, path, content: case-insensitive regex sources (content: 0.15.0, flags im, linear-time matcher).
//   detector (0.16.0): one of DETECTOR_NAMES or a list; network (0.16.0): only actions that reach the network.
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
    taint: { decision: Decision; trusted_hosts: string[]; private_paths?: string[] };   // private_paths: 0.16.0
  };
  rules: Rule[];
  audit: { enabled: boolean };
  reviewer: ReviewerBylaws;
  sandbox: SandboxBylaws;
}

interface SandboxBylaws { network: { allow_hosts: string[] }; write: { allow: string[] }; read: { deny: string[] } }

type ReviewerProviderName = 'anthropic' | 'anthropic-messages' | 'openai-chat' | 'gemini' | 'fake';
interface ReviewerCompat { token_param?: 'max_tokens' | 'max_completion_tokens'; system_role?: 'system' | 'developer' }
interface ReviewerBylaws { enabled: boolean; provider: ReviewerProviderName; model: string; api_key_env: string; timeout_ms: number; on_escalate: 'ask' | 'deny'; base_url?: string; auth?: 'key' | 'none'; compat?: ReviewerCompat }

interface Loosening { field: string; candidate: string; baseline: string }

type BylawsLoad =
  | { ok: true; bylaws: Bylaws; source: string; floorSource?: string; ignored?: Loosening[] }
  | { ok: false; error: string; source: string; floor?: Bylaws };
```

A loaded `Bylaws` is always complete: every field the file leaves out is filled from `DEFAULT_BYLAWS`.

## Engine

```ts
function decide(action: Action, bylaws: Bylaws | BylawsLoad, state: SessionState, guards?: readonly Guard[], where?: Partial<Where>): Verdict;
const BUILTIN_GUARDS: readonly Guard[];               // destructive, online-delete, secrets, self-protect, budget
function ruleMatches(rule: Rule, action: Action, parsed: ParsedCommand | null): boolean;   // true when ruleOutcome is not null
type RuleOutcome = 'match' | 'cut' | 'steps';         // 0.15.0
function ruleOutcome(rule: Rule, action: Action, parsed: ParsedCommand | null): RuleOutcome | null;
//   'cut': every other field matched, the content pattern did not match the kept text, and the text was cut at the cap;
//   'steps': the same, but the search ran out of MAX_CONTENT_STEPS. decide() fails closed on both: a deny rule denies,
//   an ask rule asks, and the reason says the content could not be checked whole.
function actionTexts(action: Action): ActionText[];  // 0.15.0: what a content rule reads (write content; other args, message)
function ruleCheck(rule: Rule, action: Action, parsed: ParsedCommand | null, meter?: RuleMeter): RuleCheck;   // 0.16.0
interface RuleCheck { outcome: RuleOutcome | null; hits: DetectorHit[] }   // hits: detectors that found something, with counts
interface DetectorHit { detector: DetectorName; count: number }
interface RuleMeter { steps: number; found: Map<ActionText, Map<DetectorName, number>> }   // shared by one decision's rules
function newRuleMeter(): RuleMeter;
const MAX_CALL_CONTENT_STEPS: number;                 // 40,000,000: content-pattern steps of one decision, all rules together
function detectorTexts(action: Action): ActionText[]; // 0.16.0: write content, command, URL, other raw (else args, message)
function hitNote(hits: readonly DetectorHit[]): string;   // " (found by card-number: 2)": names and counts only
function maskAction(action: Action, mask: readonly DetectorName[]): Action;   // command, path or URL with hits masked

type DetectorName = 'secret-token' | 'card-number' | 'iban' | 'us-ssn' | 'nhs-number' | 'email' | 'phone-e164' | 'hl7-msh' | 'fhir-patient';
const DETECTOR_NAMES: readonly DetectorName[];
const DETECTORS: readonly DetectorInfo[];             // { name, fires, doesNotFire, misses }
function detectCount(name: DetectorName, text: string): number;   // at most MAX_DETECTOR_HITS (1000); linear in the text
function isDetectorName(v: unknown): v is DetectorName;
function luhnValid(digits: string): boolean;
function ibanValid(compact: string): boolean;         // country length from IBAN_LENGTHS, then mod-97 == 1
function ssnValid(nineDigits: string): boolean;       // area not 000/666/900-999, group not 00, serial not 0000
function nhsValid(tenDigits: string): boolean;        // modulus 11, weights 10..2
function reservedDomain(domain: string): boolean;     // RFC 2606 / 6761 names
function fictionalPhone(digits: string): boolean;     // NANP 555-01xx, UK drama ranges
const TEST_CARD_NUMBERS: ReadonlySet<string>;         // published test card numbers that never fire
const IBAN_LENGTHS: Readonly<Record<string, number>>;
const LABEL_WINDOW: number;                           // 40: characters before a bare SSN or NHS number searched for its label
const MAX_DETECTOR_HITS: number;                      // 1000
function compileContentPattern(source: string): ContentPatternResult;   // 0.15.0
type ContentPatternResult = { ok: true; pattern: ContentPattern } | { ok: false; error: string };
interface ContentPattern { readonly source: string; search(text: string, maxSteps?: number, meter?: StepMeter): boolean | null }   // null: out of steps; meter (0.16.0) adds the steps taken
interface StepMeter { steps: number }
const MAX_CONTENT_PATTERN_CHARS: number;              // 1024
const MAX_CONTENT_REPEAT: number;                     // 1000, the largest {n,m}
const MAX_CONTENT_PROGRAM: number;                    // 8192 steps once repeats are expanded
const MAX_CONTENT_STEPS: number;                      // 10,000,000 per search
function describeAction(action: Action, mask?: readonly DetectorName[]): string;   // command text, or "<tool> <path|url>"; mask (0.16.0): hits replaced by [<detector>]

interface Finding { decision: Decision; rule: string; reason: string }
interface GuardContext { action: Action; parsed: ParsedCommand | null; bylaws: Bylaws; state: SessionState; where?: Where }
interface Guard { id: string; isHard(bylaws: Bylaws): boolean; evaluate(ctx: GuardContext): Finding[] }
interface Where {                                     // 0.6.2
  configDir: string;                                  // the real config directory; default configDir() (so OPENMORALS_HOME counts)
  cwd: string;                                        // relative paths start here; default process.cwd()
  home: string;                                       // for ~ and $HOME; default os.homedir()
  vars: Readonly<Record<string, string>>;             // lower-case folder variables: home, userprofile, appdata, xdg_config_home, openmorals_home
  realpath: (p: string) => string;                    // default resolveLinks
  exists: (p: string) => boolean;                     // default pathExists
}
function makeWhere(over?: Partial<Where>, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): Where;
function resolveLinks(p: string): string;             // resolves symbolic links; a missing tail is appended to its deepest existing folder
function pathExists(p: string): boolean;
```

`where` (0.6.2) tells the self-protect guard which config directory is the real one and where relative paths start; a host adapter passes the config directory and working directory it was given. Anything left out comes from the process.

`decide` writes nothing and never throws. Since 0.6.2 it reads the file system to resolve symbolic links in the paths an action names (lstat, realpath, readlink); pass `realpath` and `exists` in `where` to keep it from touching the disk. The strictest finding wins (deny > ask > allow; the first one wins a tie).
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
function validateBylaws(raw: unknown, source?: string, base?: Bylaws): BylawsLoad;   // raw = parsed YAML/JSON value; null/undefined = base; omitted settings come from base (default DEFAULT_BYLAWS)
function parseBylaws(text: string, source?: string, base?: Bylaws): BylawsLoad;      // YAML text
function loadBylaws(file: string, base?: Bylaws): BylawsLoad;
function findBylaws(startDir: string): string | null;                 // walks up from startDir to the root
function resolveBylaws(cwd: string, env?: NodeJS.ProcessEnv): BylawsLoad;  // the user floor (<configDir>/openmorals.yaml, else defaults) tightened by the nearest project file; see below
function effectiveBylaws(load: BylawsLoad): Bylaws;   // the bylaws, else the floor an invalid load carries, else DEFAULT_BYLAWS
function looseningNote(load: BylawsLoad): string | null;  // the 'note bylaws.loosening-ignored: ...' text decide() appends, or null
function stringifyBylaws(b: Bylaws): string;          // YAML
function compileRuleRegex(source: string): RegExp;    // new RegExp(source, 'i')
```

**The user floor (0.6.0).** `resolveBylaws` loads the user-level file first (or the defaults when there is none) and reads the nearest project file on top of it, with settings the project file does not mention taken from the user file. Then `packs.tighten(project, floor)` keeps every project setting that is at least as strict and replaces every looser one with the floor's value: a decision by `decisionRank`; a `Limit` by lower `soft`/`hard`/`step`, with `0` (off) the loosest; `hard: true`, `audit.enabled`, `guards.inbound.enabled` and `reviewer.enabled` over `false`; `guards.inbound.max_bytes` higher; exemption lists (`destructive.allow_targets`, `taint.trusted_hosts`, `sandbox.network.allow_hosts`, `sandbox.write.allow`) may only lose entries; protected lists (`sandbox.read.deny`) may only gain them; the user's rules are kept as written and the project's are added beside them. `reviewer.provider`, `model`, `api_key_env`, `timeout_ms` and `enabled`, `guards.inbound.notify` and `guards.inbound.judge`, come from the user file only. The dropped settings are on the load as `ignored`, with `floorSource` naming the user file. `packs.loosenings` uses the same walk, so the two cannot disagree. An invalid file gives `ok: false` with `floor`: the strictest policy that could still be read.

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
| `guards.taint.private_paths` | string[] (0.16.0), at most 200 globs in the `merge.always_review` grammar: files that hold private data; reading one or naming it in a command marks the session as having touched private data (Rule of Two). A project file can add entries, never drop the user's | absent |
| `guards.inbound.enabled` | boolean: scan tool results, fetched pages and prompts for hidden instructions | true |
| `guards.inbound.decision` | allow/ask/deny: what hidden characters in a submitted prompt get (ask warns the user, deny blocks the message). A tool result is never blocked | ask |
| `guards.inbound.notify` | boolean: also send a short fixed notice to the model (and the user) for each finding in a tool result. Off: findings taint the session and are audited silently | false |
| `guards.inbound.max_bytes` | whole number, 4096 to 8388608: most bytes of one result or prompt scanned (the first and last halves) | 262144 |
| `guards.budget.cost` | `{ soft, hard, step }` in hundredths of the price table's currency; counts only models in `prices`; 0 = off | 0 / 0 / 100 |
| `guards.budget.prices` | user-level file only: model id (as the host reports it) to `{ input, output }` per million tokens, at most 200 models | {} |
| `guards.inbound.judge` | boolean, user-level file only: send the lines a weak finding in a tool result flagged (at most 1,000 characters, redacted, cached by hash) to the reviewer's provider; its escalate (or a failure) marks the session as injected, its no-objection changes nothing (Claude Code hook only) | false |
| `rules[]` | `{id, match: {tool?, command?, path?, content?, detector?, network?}, decision: ask\|deny, reason?, hard?}` (`content`: 0.15.0; `detector`, `network: true`: 0.16.0) | [] |
| `audit.enabled` | boolean | true |
| `reviewer.enabled` | boolean: ask a second model about every `ask` in the Claude Code hook (sends redacted action text to the provider) | false |
| `reviewer.provider` | `anthropic-messages` (`anthropic` is the 0.3 name), `openai-chat`, `gemini`, or `fake` (a dry run: sends nothing, always "no objection"). User-level file only | anthropic-messages |
| `reviewer.model` | model id, 1-128 of `A-Za-z0-9._:@/-`; required with `openai-chat` and `gemini`. User-level file only | claude-haiku-5-5 |
| `reviewer.api_key_env` | the NAME of the environment variable holding the key (never the key): 1-64 letters, digits and underscores, all upper case or all lower case, no run over 24 characters between underscores, nothing the redactors take for a key; when a file names a provider but not this, the provider's own variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`). User-level file only | ANTHROPIC_API_KEY |
| `reviewer.base_url` | where requests go: https, or http only to localhost, 127.0.0.0/8 or [::1]; no user name, password, query or fragment. User-level file only | the protocol's public endpoint |
| `reviewer.auth` | `key` or `none` (send no key, for a local server; not valid for anthropic-messages at call time). User-level file only | key |
| `reviewer.compat` | openai-chat only: `token_param` (`max_tokens` or `max_completion_tokens`), `system_role` (`system` or `developer`). User-level file only | max_tokens, system |
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
interface AuditFields {
  ts: string;                 // ISO 8601 UTC
  source: string;             // 'claude-code' | 'codex' | 'gemini-cli' | 'opencode' | 'openclaw' | 'check'
  session: string | null;     // the host's session id
  tool: string;               // e.g. 'Bash', 'Read', 'check'
  action: string;             // command text or '<tool> <path>', redacted, at most 2000 chars (+ truncation note)
  decision: Decision;
  rule: string;               // 'ask.approved' on the line a post-tool event writes for a call that was asked about (0.8.0)
  reason: string;             // redacted
  cwd: string | null;
  budget: { tool_calls: number; tokens: number } | null;   // session counts after this call; null for `check` and inbound lines
}
interface AuditRecordV1 extends AuditFields { v: 1 }       // before 0.8.0, and what makeAuditRecord builds
interface AuditRecordV2 extends AuditFields {              // 0.8.0
  v: 2;
  seq: number;                // 1, 2, ... within the session file
  prev: string;               // SHA-256 hex of the previous line of the same session as written (no newline); AUDIT_GENESIS for the first
  ov: string;                 // openmorals version
  bylaws?: string;            // SHA-256 hex of the effective bylaws as sorted-key JSON; absent when none were read
  event?: string;             // host event name
  run?: string;               // OPENMORALS_RUN from the hook's own environment
  agent?: string;             // the host's agent id, when it sends one
}
type AuditRecord = AuditRecordV1 | AuditRecordV2;
const AUDIT_GENESIS: string;                                   // 64 zeros
interface ChainHead { seq: number; head: string }              // kept in the session file as `chain`
interface AuditMeta { bylaws?: string; event?: string; run?: string; agent?: string }
type AuditStatus = 'missing' | 'empty' | 'ok' | 'unreadable';   // 0.6.2
interface AuditReadResult { status: AuditStatus; records: AuditRecord[]; errors: { line: number; error: string }[] }

function makeAuditRecord(input: Omit<AuditFields, 'ts'>, now?: Date): AuditRecordV1;   // unchained; redacts and truncates
function chainAudit(records: readonly AuditFields[], meta: AuditMeta, from: ChainHead | undefined): ChainedAudit;   // pure: numbers and links after `from`
//   ChainedAudit { records: AuditRecordV2[]; text: string /* lines, each with its newline */; head: ChainHead | undefined }
function auditMeta(i: { bylaws: Bylaws | null; event: string | null | undefined; agent: string | null | undefined; env: NodeJS.ProcessEnv }): AuditMeta;   // ids: control characters removed, redacted, at most 128 chars
function auditLineHash(line: string): string;                 // SHA-256 hex of one line as written
function bylawsDigest(bylaws: Bylaws): string;
function appendAuditText(text: string, file?: string): void;  // appends whole lines in one write, mode 0600
function appendAuditForSession(sessionId: string | null, records: readonly AuditFields[], meta: AuditMeta, dir?: string, now?: Date): void;   // chain after the session file's head ('unknown' for null), save the head, append
function appendAudit(record: AuditRecord, file?: string): void;     // writes one record as given (no chain); default auditLogPath(); redacts again before writing
function parseAuditLine(line: string): AuditRecord | { error: string };   // versions 1 and 2
function parseAuditText(text: string): AuditReadResult;            // skips blank lines, reports bad ones by 1-based line number; status 'empty' when no line is left, else 'ok'
function readAudit(file?: string): AuditReadResult;                 // status 'missing' when there is no file (0.6.2; before, a missing log read as an empty one); 'unreadable' with the error in errors when it cannot be read
function redact(text: string): string;

// Verification and run summaries (0.8.0). They read; they never write. See docs/audit.md for what they prove and what they do not.
function verifyAudit(file: string, opts?: { sessionsDir?: string; run?: string | null }): VerifyResult;   // sessionsDir defaults to `sessions` beside the log
function verifyAuditText(text: string, opts?: VerifyOptions, status?: AuditStatus): VerifyResult;      // pure; opts.heads: ChainHead by session file name
function readSessionHeads(dir: string): { heads: Map<string, ChainHead>; unreadable: string[] };
//   VerifyResult { ok; status; lines; v1; v2; sessions; run: string | null; runRecords: number | null; problems: VerifyFinding<VerifyProblemKind>[]; notes: VerifyFinding<VerifyNoteKind>[] }
//   VerifyFinding { kind; line: number | null; session: string | null; detail: string }
//   VerifyProblemKind = 'unreadable-log' | 'unreadable-line' | 'truncated' | 'edited' | 'gap' | 'restart' | 'tail-missing' | 'unchained' | 'missing-log' | 'run-missing'
//   VerifyNoteKind = 'legacy' | 'fork' | 'behind' | 'session-unreadable' | 'no-log'
function summarizeRun(file: string, run: string, opts?: { sessionsDir?: string }): RunSummary;
function summarizeRunText(text: string, run: string, verified: VerifyResult): RunSummary;
//   RunSummary { run; status; records; sessions: string[]; denies; asks; approved_asks; taint_marks; loosening_notes: RunItem[]; record: { ok; problems } }
//   RunItem { line; ts; session; tool; decision; rule; action /* first 200 chars */ }
function formatVerify(file: string, v: VerifyResult): string;
function formatRunSummary(s: RunSummary): string;
```

JSONL line format: one `AuditRecord` per line, `JSON.stringify` with the version 2 keys in the order `v`, `seq`, `prev`, then the common fields as above, then `ov`, `bylaws`, `event`, `run`, `agent`. The hash in the next line's `prev` is over the line exactly as written, so a reader must hash the raw line, never a re-serialised object. A version 1 line, as written before 0.8.0:

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
function loadSessionState(sessionId: string, dir?: string): SessionState;   // missing, unreadable or corrupt file gives zeros (see loadSession for the taint)
function saveSessionState(sessionId: string, state: SessionState, dir?: string, now?: Date): void;   // atomic write, mode 0600
function countToolCall(state: SessionState): SessionState;   // toolCalls + 1
function addTokens(state: SessionState, tokens: number): SessionState;

// Session memory for the loop detector and the taint judge, stored in the same session file.
interface StoredHistoryEntry { action: Action; outcome?: { ok: boolean; error?: string }; id?: string; asked?: string }   // id = the host's tool-use id; asked = the rule of an ask verdict (0.8.0)
interface SessionMemory { history: readonly StoredHistoryEntry[]; taint: TaintState; unreadable?: string; chain?: ChainHead }   // unreadable: why the saved state could not be read (0.6.2); chain: the audit chain head (0.8.0)
const EMPTY_MEMORY: SessionMemory;
const HISTORY_KEEP: 20;
function loadSession(sessionId: string, dir?: string): { state: SessionState; memory: SessionMemory };   // only a missing file is a clean new session; see below
function saveSession(sessionId: string, state: SessionState, memory: SessionMemory, dir?: string, now?: Date): void;
function sessionFindings(action: Action, memory: SessionMemory, bylaws: Bylaws, ctx: TaintContext): Finding[];   // loop + taint, per the bylaws switches
function unreadableFindings(memory: SessionMemory): Finding[];   // 0.6.2: one ask, rule budget.unmeasured, while memory.unreadable is set
function combineVerdict(verdict: Verdict, findings: readonly Finding[]): Verdict;   // strictest wins; a tie keeps the engine's verdict
function recordAction(memory: SessionMemory, action: Action, verdict: Verdict, ctx: TaintContext, id: string | null): SessionMemory;   // redacted, last 20; a denied action does not taint
function recordOutcome(memory: SessionMemory, action: Action, outcome: { ok: boolean; error?: string }, id: string | null): SessionMemory;
function findCallEntry(history: readonly StoredHistoryEntry[], action: Action, id: string | null): number;   // 0.8.0: by call id, else the newest same action with no outcome; -1 when none
function parseChain(v: unknown): ChainHead | undefined;   // 0.8.0: a malformed head reads as none (the next record then starts a new chain, which verify reports)
function taintContext(projectRoot: string, bylaws: Bylaws, platform?: NodeJS.Platform): TaintContext;
function parseMemory(raw: unknown): SessionMemory;    // a damaged taint state reads as tainted, a missing one as clean
function unattendedVerdict(v: Verdict): Verdict;      // ask becomes deny; allow and deny unchanged
function isUnattended(env: NodeJS.ProcessEnv): boolean;   // OPENMORALS_UNATTENDED set and not 0/false
```

`loadSession` (0.6.2) fails toward caution: only a missing file is a new, clean session. A file that cannot be read (permission, a folder in its place), cannot be parsed or is not a JSON object gives zero counts, a taint that reads as untrusted, and `memory.unreadable` saying why. `saveSession` stores that mark and `recordOutcome` keeps it, so a usage report or a post-tool scan cannot erase it; the next judged call (the Claude Code hook, and the pipeline behind the other hosts on a counted call) asks once with `budget.unmeasured`, and `recordAction` clears it.

`saveSessionState` keeps the stored memory; `saveSession` replaces it. Command text, paths, URLs and failure text are passed through `redact()` before they are stored, and failure text is cut to 400 characters.

## Claude Code adapter and init

```ts
interface ClaudeCodeHookInput { session_id: string | null; cwd: string | null; hook_event_name: string | null; tool_name: string; tool_input: Record<string, unknown>; tool_use_id: string | null; error: string | null; is_interrupt: boolean; tool_response: unknown; prompt: string | null; agent_id: string | null }   // tool_name is 'prompt' for UserPromptSubmit; agent_id (0.8.0): the subagent or teammate the hook fires in
function parseHookInput(text: string): { ok: true; input: ClaudeCodeHookInput } | { ok: false; error: string };
function toAction(toolName: string, toolInput: Record<string, unknown>): Action;
function toActions(toolName: string, toolInput: Record<string, unknown>): Action[];   // 0.8.1: [toAction(...)] for a mapped built-in; else `other` plus argActions' lifted reads, writes and fetches (top-level path and URL keys, at most 32)
function isMcpTool(toolName: string): boolean;          // toolName starts with 'mcp__'
function adapterVerdicts(toolName: string, bylaws: Bylaws): Verdict[];   // [adapter.mcp-delete] for an mcp__ tool named like a delete (the online-delete decision), else []
function decideCall(toolName: string, actions: readonly Action[], bylaws: Bylaws | BylawsLoad, state: SessionState, guards?: readonly Guard[], where?: Partial<Where>): Verdict;   // decide on each action plus adapterVerdicts, strictest wins (first on ties); equals decide(action) for a mapped built-in
function toHookOutput(v: Verdict): string | null;     // null for allow (print nothing); else the PreToolUse hookSpecificOutput JSON
interface HookRun { stdout: string; exitCode: 0; verdict: Verdict }
function runClaudeCodeHook(stdinText: string, opts?: { env?: NodeJS.ProcessEnv; cwd?: string; now?: Date; unattended?: boolean }): HookRun;
const POST_EVENTS: readonly string[];                 // ['PostToolUse', 'PostToolUseFailure']

type HookEvent = 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'UserPromptSubmit';   // UserPromptSubmit is installed without a matcher
type InboundHookEvent = 'PostToolUse' | 'PostToolUseFailure' | 'UserPromptSubmit';
function toClaudeInboundOutput(event: InboundHookEvent, o: InboundOutcome): string | null;   // null: print nothing; a blocked prompt: decision "block" + suppressOriginalPrompt; else systemMessage and/or hookSpecificOutput.additionalContext
const ALL_HOOK_EVENTS: readonly HookEvent[];
const DEFAULT_HOOK_COMMAND: 'openmorals hook claude-code';
function mergeClaudeSettings(existing: unknown, command?: string, events?: readonly HookEvent[]): { ok: true; settings: Record<string, unknown>; changed: boolean } | { ok: false; error: string };   // events defaults to ['PreToolUse']
function initProject(dir: string, opts?: { hookCommand?: string; installHook?: boolean; now?: Date; bylawsText?: string; hookEvents?: readonly HookEvent[] }): InitResult;   // hookEvents defaults to ALL_HOOK_EVENTS
function hasOpenMoralsHook(settings: unknown, events?: readonly HookEvent[], command?: string): boolean;   // events default ['PreToolUse']; true when every event already runs the hook, by the same test mergeClaudeSettings uses (the command, or any `openmorals ... hook claude-code`); so it is true exactly when mergeClaudeSettings(settings, command, events).changed is false

function normalizeAllowTarget(t: string): string;       // backslashes to '/', one leading './' and trailing slashes removed; case kept
function matchesAllowTarget(t: string, allow: readonly string[]): boolean;   // normalised target equals an entry or ends with '/<entry>'
function isSafeAllowTarget(t: string): boolean;         // plain relative name: no glob, '..', '~', variable, drive or absolute path

function sensitiveLabel(path: string): string | null;  // why a path counts as a secret, or null
const NETWORK_COMMANDS: ReadonlySet<string>;           // the one list of network command names
function reachesNetwork(command: SimpleCommand): boolean;   // used by the secrets guard and the taint tracker
const VERSION: string;
```

`runClaudeCodeHookReviewed(stdinText, opts?: HookOptions & { reviewProvider?: ReviewProvider }): Promise<HookRun>` is what `openmorals hook claude-code` runs: the same as `runClaudeCodeHook`, and then, only when the bylaws are valid, `reviewer.enabled` is true, the answer is `ask` and the run is not unattended, the reviewer (see below). `reviewProvider` replaces the provider named in the bylaws (tests use a fake one).

The hook answers four events. `PreToolUse` runs the engine, then the loop detector and the taint judge over the session memory, and prints the strictest answer; since 0.8.1 it does so for every action `toActions` gives (an `mcp__` tool's top-level path and URL arguments too) and adds `adapterVerdicts`. `PostToolUse` (the tool succeeded) and `PostToolUseFailure` (the tool failed; `error` holds the failure text) record the outcome on the matching history entry, by `tool_use_id`, and scan the result (`tool_response`, every string in it) or the error text for hidden instructions; by default they print nothing, and with `guards.inbound.notify` they print a notice; an interrupted call (`is_interrupt: true`) is not recorded as a failure. `UserPromptSubmit` scans `prompt` (see Inbound scanning below). Any other event prints nothing. Input and output shapes are taken from the Claude Code hooks reference, https://code.claude.com/docs/en/hooks (read 23 Nov 2026; the post-tool and prompt sections again 24 Nov 2026).

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

They run the same engine, the loop detector, the taint judge and unattended mode, count the budget and write the audit log. Since 0.5.0 they also answer the host's post-tool event (Codex `PostToolUse`, Gemini CLI `AfterTool`, opencode `tool.execute.after`: record the outcome for the loop detector and scan the result) and prompt event (Codex `UserPromptSubmit`, Gemini CLI `BeforeAgent`, opencode `prompt`); `installSnippet()` carries all three events (`codexAdapter.CODEX_EVENTS`, `geminiCliAdapter.GEMINI_EVENTS`). What each host can express (Codex and opencode V1 have no ask, so an ask is sent as a block), the input and output shapes with their sources, and what was not run: [docs/adapters.md](docs/adapters.md).

## Inbound scanning

```ts
import { inbound } from 'openmorals';

inbound.scanInbound(text: string, opts?: { maxBytes?: number; secrets?: boolean }): InboundScan;   // pure; never returns the text
//   InboundScan { findings: InboundFinding[]; strong: boolean; bytesTotal; bytesScanned; truncated }
//   InboundFinding { rule: InboundRule; strength: 'strong' | 'weak'; line: number | null; what: string }   // `what` is fixed text
//   InboundRule = 'inbound.hidden-characters' | 'inbound.split-phrase' | 'inbound.html-comment' | 'inbound.encoded-instruction' | 'inbound.instruction-phrase' | 'inbound.secret-shape'
inbound.judgeToolResult(tool: string, text: string, cfg: InboundBylaws, opts?: { taintDecision?: Decision }): InboundOutcome;
inbound.judgePrompt(text: string, cfg: InboundBylaws, opts?: { unattended?: boolean; taintDecision?: Decision; secretsDecision?: Decision }): InboundOutcome;
//   InboundOutcome { origin: 'tool-result' | 'prompt'; verdict: Verdict; notice: string | null; userNotice: string | null; taint: TaintEvent | null; scan: InboundScan | null; record: boolean }
inbound.handlePostTool(ev: PostToolEvent, opts?: InboundRunOptions): InboundOutcome;   // bylaws, outcome for the loop detector, taint, session file, audit line; an `ask.approved` line when the call was asked about (0.8.0)
//   PostToolEvent and PromptEvent take optional `event` and `agent` for the audit line (0.8.0)
inbound.handlePrompt(ev: PromptEvent, opts?: InboundRunOptions): InboundOutcome;
inbound.textOfResult(value: unknown, maxChars?: number): string;   // every string in a tool result, depth-first
inbound.judgeAgentMessage(tool: string, message: ActionText, cfg: InboundBylaws, opts?: { taintDecision?: Decision }): InboundOutcome;   // 0.14.0; origin 'agent-message'; decision always allow, no notice
inbound.scanOutbound(actions: readonly Action[], bylaws: Bylaws, from: { source: string; session: string | null; cwd: string | null }, now?: Date): OutboundScan;
//   OutboundScan { outcomes: InboundOutcome[]; taint: TaintEvent[]; records: AuditFields[] }   // the hooks fold `taint` into the session and write `records` after the call's line
inbound.contentAction(host: ContentHost, tool: string, input: unknown): Action;   // the `other` action with `args` and, for a tool in MESSAGE_TOOLS[host], `message`
inbound.argsText(input: unknown): ActionText | undefined;
inbound.messageText(input: unknown, field: string | null): ActionText | undefined;   // the named field, else every string value, one per line
inbound.capText(raw: string, max?: number, cutAlready?: boolean): ActionText;   // redact(), then the cap
inbound.withoutContent(a: Action): Action;   // the action without `args` and `message`
inbound.MESSAGE_TOOLS: Record<ContentHost, Record<string, string | null>>;   // ContentHost = 'claude-code' | 'codex' | 'gemini-cli' | 'opencode' | 'openclaw'; null: every string value
```

**The outbound leg (0.14.0).** Text one agent hands to another (a child agent's prompt, a subagent's report, a message to another agent or session) is scanned with the same rules before the call runs. A strong finding marks the session `injected`, a weak one `untrusted`; one audit line per finding names the rule, kinds and lines, never the text. The call itself is decided as before, and nothing is said to the model. The mark lands in the session the hook runs in, which is the receiver's only where the receiver shares that session (see docs/adapters.md, "Content-bearing actions").

`strong` findings are hidden from a human reader (invisible characters, an HTML comment, an encoded payload, a phrase split by hidden characters, a secret shape in a prompt); `weak` is a visible override phrase. A tool result is never blocked: its outcome is `allow` (silent, the default) or `ask` with notices (`notify: true`). A prompt gets `deny` only for hidden characters under `decision: deny` (or unattended) or a secret shape under `secrets.send: deny`. The taint judge (`taint.judge`) asks with rule `taint.injected-content` before a network or private-data step once a strong finding is in the session.

## Reviewer

```ts
function reviewVerdict(action: Action, verdict: Verdict, cfg: ReviewerBylaws, opts?: { env?; provider?: ReviewProvider; context?: string; nonce?: string }): Promise<{ verdict: Verdict; outcome: ReviewOutcome | null }>;
function reviewerProvider(cfg: ReviewerBylaws, env?, fetch?: FetchLike): ReviewProvider;     // the client for cfg.provider (anthropic-messages, openai-chat, gemini) or the dry-run fake; reads the key only when a review is sent
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

## Eval

```ts
import { evals } from 'openmorals';

evals.loadCases(dir?: string): CasesResult;            // without dir: the rows built into the single-file binary, else the shipped cases folder
evals.loadCasesFrom(src: CaseSource): CasesResult;     // CaseSource { name: string; list(): string[] | null; read(file: string): string | null }
evals.folderSource(dir: string): CaseSource;           // files over MAX_CASE_FILE_BYTES (4 MiB) or not regular files read as unreadable
evals.scoreCases(cases: EvalCases, opts?: ScoreOptions): ScoreResult;
//   ScoreOptions { guards?: readonly Guard[]; bylaws?: BylawsLoad; guard?: string; repetitions?: number }   // defaults: BUILTIN_GUARDS, the built-in bylaws, every guard, EVAL_REPETITIONS (25)
evals.runEval(opts?: { cases?: string; bylaws?: string; guard?: string; json?: boolean; guards?: readonly Guard[]; repetitions?: number }): EvalCommandResult;
//   EvalCommandResult { exitCode: 0 | 1 | 2; stdout: string; stderr: string; report: EvalReport | null }   // the whole `openmorals eval`, without the process
evals.formatEvalText(r: EvalReport): string;
evals.formatEvalJson(r: EvalReport): string;          // the --json document below
//   CasesResult and ScoreResult are { ok: true; value } | { ok: false; error: string }; none of these throws, calls a model or writes a file
```

`openmorals eval --json` prints one JSON object:

```ts
{
  schema: 1,                       // raised only when a field is renamed or removed; new fields may be added
  source: string,                  // the folder scored, or "(built in)/cases" in the single-file binary
  bylaws: string,                  // "<defaults>" or the --bylaws file (rows with their own bylaws use those)
  repetitions: number,             // timed repetitions of every row
  ok: boolean,                     // true when every row matched (exit 0)
  total: Score,
  guards: (Score & { guard: string; files: string[] })[],   // sorted by guard; the inbound table is guard "inbound"
  diffClass: (Score & { guard: 'diff-class'; files: string[] }) | null,   // merge-verdict rows, not in total: blocking = rows that must need review (or be unreadable), allowing = rows that must be review-free
  wrong: {                         // every wrong row, in file order
    guard: string; file: string; index: number;   // index from 0 in the file's cases list
    line: number | null;           // 1-based line of the row
    label: string;                 // the command, the tool call, or the inbound row's name (up to 200 characters)
    kind: 'missed' | 'false-alarm' | 'stricter' | 'rule';
    expect: string; got: string;   // allow/ask/deny, or none/weak/strong for inbound rows
    expectedRule: string | null; gotRule: string;
  }[]
}
Score = { rows; blocking; caught; catchRate; allowing; falseAlarms; falseAlarmRate; ruleMismatches; wrong; p50Ms; p95Ms }
//   blocking: rows expecting ask or deny (inbound: a finding); caught: of those, rows that got at least that
//   allowing: rows expecting allow (inbound: none); falseAlarms: of those, rows that got more
//   rates are 0 to 1, rounded to 4 places, null when the denominator is 0; times are milliseconds per decision, rounded to 4 places, null when repetitions is 0
```

Exit codes: 0 every row matched, 1 a row is wrong, 2 the rows or bylaws cannot be read (stdout is empty and nothing is scored), 64 a usage error. Row format and the shipped numbers: [docs/eval.md](docs/eval.md).

## Test reports

```ts
import { tests } from 'openmorals';

tests.parseTestReport(text: string, opts?: { format?: ReportFormat; root?: string }): ReportResult;
//   ReportResult = { ok: true; report: TestReport } | { ok: false; error: string }   // a report with no test results is { ok: false }
//   TestReport { format: ReportFormat; tests: TestResult[]; skippedLines: number }
//   TestResult { id: string; file: string | null; status: 'pass' | 'fail' | 'skip' }   // id: file, suites or groups, name, joined by ' > '; a repeated id gets ' #2', ' #3'
//   ReportFormat = 'junit' | 'jest' | 'go-json' | 'dart-json'   // jest also reads Vitest's JSON; dart-json reads flutter test --machine
tests.detectFormat(text: string): ReportFormat | null;
tests.compareTests(before: readonly TestReport[], after: readonly TestReport[], approvals?: readonly Approval[]): Comparison;   // pure; throws RangeError if a side is empty
//   Comparison { failToPass: Gain[]; passToFail: Loss[]; gone: Loss[]; newlySkipped: Loss[]; likelyRenames: RenameGroup[];
//                flaky: string[]; failingGone: string[]; blocking: number; unusedApprovals: Approval[]; totals: { before: Totals; after: Totals } }
//   Gain { id; was: 'failing' | 'skipped' | 'new'; flaky }   Loss { id; kind: 'fails' | 'gone' | 'skipped'; flaky; approvedBy: number | null }
//   blocking counts the losses no approval covers; totals come from the first report of each side and decide nothing
tests.parseApprovals(text: string): { ok: true; approvals: Approval[] } | { ok: false; error: string };   // Approval { kind: LossKind; id: string; line: number }
tests.testsCommand(argv: readonly string[], env?: NodeJS.ProcessEnv): { exitCode: number; stdout: string; stderr: string };   // the whole `openmorals tests`, without the process
tests.parseXml(text: string): { ok: true; root: XmlElement } | { ok: false; error: string };   // elements and attributes only; refuses DOCTYPE and unknown entities
```

Exit codes of `openmorals tests compare`: 0 no unapproved loss, 1 an unapproved loss, 2 a report or the approval file cannot be read, 64 usage error. Guide: [docs/tests-compare.md](docs/tests-compare.md).

## Audit sample

```ts
import { auditSample } from 'openmorals';

auditSample.sampleCommand(argv: readonly string[], deps?: Partial<{ env: NodeJS.ProcessEnv; now: () => Date; random: (bytes: number) => Buffer }>): { exitCode: number; stdout: string; stderr: string };
//   the whole `openmorals audit sample` (argv: the words after `sample`); random defaults to crypto.randomBytes
auditSample.drawPicks(population: readonly string[], rate: number, seedHex: string): string[];   // sorted; the same for any order of population
auditSample.pickNumber(seedHex: string, unit: string): number;   // first 48 bits of HMAC-SHA256(seed, unit) / 2^48; picked when < 1/rate
auditSample.planDraw(text: string, verified: VerifyResult, settings: SampleSettings, by: 'run' | 'session', now: Date, seedHex: string): DrawPlan;   // pure
//   DrawPlan { by; rate; read_all; remaining_before; since; seed; method; population; drawn; forced; picks; active; earlier; outside; unitProblems; summaries; sampleProblems }
auditSample.tallySamples(text: string, settings: SampleSettings): Tally;   // pure; recomputes every draw from its seed
//   Tally { draws; by; considered; picked; forced; verdicts: { total; clean; escape }; verdict_share; escape_rate; open; picks; changes; next: RateState; problems }
auditSample.parseSampleSettings(text: string): { ok: true; settings: SampleSettings } | { ok: false; error: string };
//   SampleSettings { rate: 1..1000 (10); read_all_next: 0..1000 (5); by: 'run' | 'session' ('run'); settle_minutes: 0..10080 (30) }
auditSample.scanLog(text: string, by: 'run' | 'session'): LogScan;   // units with their UnitSummary, and the sample's own events in line order
auditSample.rateState(events: readonly SampleEvent[], settings: SampleSettings): RateState;   // 1 in 1 while fewer than read_all_next units followed the latest escape or change
auditSample.findPick(events: readonly SampleEvent[], name: string): { ok: true; by; unit } | { ok: false; error: string; usage: boolean };
```

Exit codes of `openmorals audit sample`: draw 0 drawn, 1 drawn and the record does not verify, 2 unreadable or not recorded (nothing drawn), 3 nothing to draw from (nothing written), 64 usage error; `--record` 0, 1 not a pick, 2, 64; `--tally` 0, 1 the record does not verify or a draw does not recompute, 2. Guide: [docs/audit.md](docs/audit.md#openmorals-audit-sample).

## Merge verdict

```ts
import { diffClass } from 'openmorals';

diffClass.diffClassCommand(argv: readonly string[], ctx: { env: NodeJS.ProcessEnv; cwd: string; readStdin: () => Uint8Array }): { exitCode: number; stdout: string; stderr: string };
//   the whole `openmorals diff-class` (argv: the words after `diff-class`); reads its inputs, writes nothing
diffClass.diffClassCommandWith(argv, ctx, settings: DiffClassSettings | null): { exitCode: number; stdout: string; stderr: string };
//   the same, with the merge settings from the caller; null reads them as diffClassCommand does
//   DiffClassSettings { merge: MergeBylaws | undefined; source: string; problem?: string | null; notes?: readonly string[] }   // source is named in the class.off reason
diffClass.diffClassVerdictWith(argv, ctx, settings: DiffClassSettings | null): DiffClassOutcome;   // 0.14.0
//   DiffClassOutcome = { ok: true; verdict: DiffVerdict; json: boolean } | { ok: false; result: { exitCode; stdout; stderr } }
//   the same argument and input handling, returning the verdict object so a caller can add its own reasons (they may only add review)
diffClass.formatDiffClass(verdict: DiffVerdict, json: boolean): { exitCode: number; stdout: string; stderr: string };   // what diffClassCommandWith prints for that verdict
diffClass.classifyDiff(input: ClassifyInput): { ok: true; verdict: DiffVerdict } | { ok: false; error: string; line: number | null };
//   ClassifyInput { diff: string; merge: MergeBylaws | undefined; settingsProblem?: string | null; notes?: readonly string[]; base: BaseReader;
//                   reproduced?: string | null; record?: RecordFacts | null; declaredRun?: string | null; exclusions?: readonly Exclusion[]; reasonSources?: readonly ReasonSource[];
//                   declaredPaths?: readonly string[] | null; boundaryPaths?: readonly string[]; maxLines?: number; maxFiles?: number; settingsSource?: string }
//   DiffVerdict { verdict: 'review' | 'review-free'; class: 'A' | 'B'; basis: MergeClass | null; qualifies: MergeClass | null; exitCode: 0 | 1;
//                 reasons: Reason[]; files: FileVerdict[]; switchedOn: MergeClass[]; notes: string[]; cannotSee: string[]; notChecked: string[] }
//   Reason { rule: string; path: string | null; text: string }   // rule ids: doubt.*, exclude.*, tighten.*, record.*, reproduced.*, class.*, settings.*, integrity.*
diffClass.parseDiff(text: string): { ok: true; files: FileDiff[] } | { ok: false; error: string; line: number | null };   // strict; never throws
diffClass.folderReader(dir: string): BaseReader;   // regular files inside dir only, at most MAX_BASE_FILE_BYTES; memoryReader(files) for fixed contents
diffClass.exclusionsFor(path: string, exclusions?: readonly Exclusion[]): { id: string; what: string }[];
diffClass.REASON_SOURCES: readonly ReasonSource[];   // (files, ctx: IntegrityContext) => Reason[]: extra facts over the whole diff; any reason means review
diffClass.INTEGRITY_RULES: readonly IntegrityRule[];   // the test-integrity rules: { id; pattern; misses; needs: 'declared-paths' | 'boundary-paths' | 'size-line' | null; run(files, ctx) }
diffClass.integrityReasons(files: readonly FileDiff[], ctx: IntegrityContext, rules?: readonly IntegrityRule[]): Reason[];
//   IntegrityContext { base: BaseReader; declaredPaths: readonly string[] | null; boundaryPaths: readonly string[]; maxLines: number | null; maxFiles: number | null }
diffClass.notChecked(ctx: IntegrityContext, rules?: readonly IntegrityRule[]): string[];   // the rules that had no input
```

Exit codes of `openmorals diff-class`: 0 review-free, 1 review, 2 an input cannot be read (review), 64 usage error. Guide: [docs/merge-verdict.md](docs/merge-verdict.md); the test-integrity rules: [docs/test-integrity.md](docs/test-integrity.md).

## Extras (namespaced exports)

```ts
import { undo, guidance, loop, taint, packs, inbound } from 'openmorals';

undo.trash(target: string, opts: { root: string; cwd?: string; session?: string }): UndoResult<TrashedItem>;
undo.restore(id: string, opts: { root: string }): UndoResult<ListedItem>;
undo.list(opts: { root: string; all?: boolean }): UndoResult<{ items: ListedItem[]; badLines: number[] }>;
undo.purge(opts: { root: string; olderThanDays: number; confirm: boolean }): UndoResult<{ purged: string[]; failed: { id: string; message: string }[] }>;
//   UndoResult<T> = { ok: true; value: T } | { ok: false; code: UndoErrorCode; message: string }; pure planners planTrash/planRestore/planPurge are exported too

guidance.renderGuidance(bylaws: Bylaws, opts?: GuidanceOptions): string;        // the marked block
guidance.writeGuidance(file: string, bylaws: Bylaws, opts?: GuidanceOptions): WriteResult;
guidance.clearGuidance(file: string): WriteResult;
//   GuidanceOptions { trashCommand?, restoreCommand?, loopEnforced?, taintEnforced? }; the loop and taint lines say "asks" or "blocks" from the bylaws' decision

loop.detectLoop(history: readonly HistoryEntry[], next: Action, options?: Partial<LoopOptions>): LoopVerdict;   // allow or ask, with kind and count

taint.reduceTaint(state: TaintState, event: TaintEvent, ctx: TaintContext): TaintState;
taint.judge(action: Action, state: TaintState, ctx: TaintContext): TaintVerdict;   // allow or ask (rule taint.injected-content or taint.rule-of-two)
taint.CLEAN_TAINT: TaintState;

packs.listPacks(dir?: string): { name: string; file: string; description: string }[];   // without dir: the shipped packs folder, or the packs embedded in the single-file binary
packs.embeddedPacks(): { names: string[]; read(name: string): string | null } | null;   // null unless running as the single-file binary
packs.loadPack(name: string, dir?: string): BylawsLoad;
packs.readPackText(name: string, dir?: string): { ok: true; name: string; file: string; text: string } | { ok: false; error: string };
packs.loosenings(candidate: Bylaws, baseline: Bylaws): { field: string; candidate: string; baseline: string }[];
packs.tighten(candidate: Bylaws, floor: Bylaws): { bylaws: Bylaws; ignored: Loosening[] };   // the user floor merge resolveBylaws uses
packs.PACK_NAMES: readonly ['solo-dev', 'strict', 'ci-unattended', 'production-ops', 'beginner', 'test-lock'];   // test-lock (0.9.0) is an add-on of rules, off unless added
```

Each module's full surface, design and limits: [docs/extras.md](docs/extras.md).
