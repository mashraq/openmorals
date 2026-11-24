# Features

Every feature with its status. **Built (version)** means released and tested in that version. **Planned** means not built. **Rejected** means considered and turned down, with the reason in the linked decision.

## Judging actions

| Feature | How to use it | Status | Details |
|---|---|---|---|
| Policy engine: allow, ask or deny with rule and reason | `decide()` in the library | Built (0.1.0) | [API.md](../../API.md#engine) |
| Command parser that sees through quotes, wrappers, `bash -c`, `$(...)`, variables, multi-line commands | automatic | Built (0.1.0) | [overview.md](../architecture/overview.md) |
| Destructive guard | automatic; `guards.destructive` | Built (0.1.0) | [guards.md](../architecture/guards.md#destructive) |
| Online-delete guard | automatic; `guards.online-delete` | Built (0.1.0) | [guards.md](../architecture/guards.md#online-delete) |
| Secrets guard (read, write, send) | automatic; `guards.secrets` | Built (0.1.0) | [guards.md](../architecture/guards.md#secrets) |
| Self-protect guard | automatic; `guards.self-protect` | Built (0.1.0; other hosts' files 0.3.0) | [guards.md](../architecture/guards.md#self-protect) |
| Budget guard: tool calls per session | automatic; `guards.budget.tool_calls` | Built (0.1.0) | [guards.md](../architecture/guards.md#budget) |
| Budget guard: tokens per session | `guards.budget.tokens` | Built (0.1.0) where the host reports tokens; **Planned** for Claude Code (its hook input has no token counts) | |
| Budgets in money (priced per model) | | Planned | [ROADMAP.md](../../ROADMAP.md) |
| Your own rules (`rules[]`), ask or deny only | `openmorals.yaml` | Built (0.1.0) | [API.md](../../API.md#openmoralsyaml-schema-version-1) |
| Loop detector (repeats, polling, near-repeats, repeated failures) | automatic in hooks; `guards.loop` | Built (0.2.0); repeated failures only on Claude Code | [docs/extras.md](../extras.md) |
| Loop thresholds set in the bylaws | | Planned | |
| Taint judge (Rule of Two) | automatic in hooks; `guards.taint` | Built (0.2.0) | [docs/extras.md](../extras.md) |
| Fail closed on every error | automatic | Built (0.1.0) | [ADR 0005](../adr/0005-fail-closed-ask-on-error.md) |
| Unattended mode: ask becomes deny | `--unattended` or `OPENMORALS_UNATTENDED=1` | Built (0.2.0) | |
| Windows: read each command in three dialects | automatic on Codex, Gemini CLI, opencode | Built (0.3.1) | [ADR 0008](../adr/0008-windows-three-dialects-keep-the-strictest.md) |
| MCP tool classification in the bylaws | | Planned (today: a name heuristic in the non-Claude adapters) | |
| Answering "allow" to a host to skip its prompts | | Rejected | [ADR 0009](../adr/0009-never-grant-permission-the-host-would-not.md) |

## Hosts

| Feature | How to use it | Status | Details |
|---|---|---|---|
| Claude Code hook (`PreToolUse`; `PostToolUse` and `PostToolUseFailure` for outcomes) | `openmorals init` | Built (0.1.0; post events 0.2.0) | [README](../../README.md#use-it-with-claude-code) |
| Codex CLI hook (`PreToolUse`; ask sent as a block) | `openmorals init --agent codex` | Built (0.3.0); not run against live Codex | [docs/adapters.md](../adapters.md) |
| Gemini CLI hook (`BeforeTool`) | `openmorals init --agent gemini-cli` | Built (0.3.0); not run against live Gemini CLI | [docs/adapters.md](../adapters.md) |
| opencode plugin | `openmorals init --agent opencode` | Built (0.3.0); not run against live opencode | [docs/adapters.md](../adapters.md) |
| Post-tool events on Codex, Gemini CLI, opencode (outcomes for the loop detector, inbound scanning) | `guards.loop`, `guards.inbound` | Built (0.5.0); opencode V1 reports no failures | [docs/adapters.md](../adapters.md#post-tool-and-prompt-events-050) |
| Antigravity CLI | | Planned: hook format not checked | [docs/adapters.md](../adapters.md#post-tool-and-prompt-events-050) |
| Other hosts (for example Cursor) | | Planned, not started | |

## Commands a person runs

| Feature | Command | Status | Details |
|---|---|---|---|
| Judge a command line | `openmorals check "<command>"` (`--json`, `--shell`, `--bylaws`, `--review`) | Built (0.1.0; `--review` 0.3.0) | [README](../../README.md#60-second-demo) |
| Set up a project | `openmorals init [--agent ...] [--pack ...]` | Built (0.1.0) | |
| Validate the bylaws | `openmorals validate` | Built (0.1.0) | |
| Read the audit log | `openmorals audit` | Built (0.1.0) | |
| Score the guards on the case rows, or on your own rows: catch rate, false alarms, time per decision | `openmorals eval` (`--json`, `--cases`, `--guard`, `--bylaws`) | Built (0.7.0); no model call | [docs/eval.md](../eval.md) |
| Scan a skill, plugin, MCP config or package before install | `openmorals scan <path>` | Built (0.2.0) | [docs/scanner.md](../scanner.md) |
| Scanner limits on the command line (`--max-file-bytes` and others) | | Planned (the library takes them) | |
| Trash, restore, purge | `openmorals trash`, `restore`, `purge --older-than N --yes` | Built (0.2.0) | [docs/extras.md](../extras.md) |
| Write the rules into `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` | `openmorals guidance` | Built (0.2.0); says "blocks" or "asks" from the bylaws and names every host's hook file since 0.5.0 (D-2) | [requirements-log.md](requirements-log.md#known-defects) |
| Ready-made bylaws | `openmorals packs`, `init --pack` | Built (0.2.0) | [docs/extras.md](../extras.md) |
| Plan an OS sandbox from the bylaws | `openmorals sandbox plan` | Built (0.3.0) | [docs/sandbox.md](../sandbox.md) |
| Run one command in the sandbox | `openmorals sandbox run -- <cmd>` | Built (0.3.0): macOS and Linux; Windows refuses | [docs/sandbox.md](../sandbox.md) |
| Allowed hosts in the sandbox (via Anthropic's `srt`) | | Planned | |
| Enforced Windows sandbox | | Planned | |
| Wrap a whole agent in the sandbox | | Planned | |
| Help for each subcommand | `openmorals <command> --help`, `-h`, `openmorals help <command>` | Built (0.5.0): prints usage and does nothing else (D-1 fixed); unknown options are usage errors | [requirements-log.md](requirements-log.md#known-defects) |

## Second opinion

| Feature | How | Status | Details |
|---|---|---|---|
| Reviewer model on asks, escalate-only | `reviewer.enabled: true` | Built (0.3.0), Claude Code and `check --review` only; never called a real API | [ADR 0007](../adr/0007-reviewer-can-only-escalate.md), [docs/reviewer.md](../reviewer.md) |
| Reviewer on the other hosts | | Planned | |
| Reviewer that can approve | | Rejected | [ADR 0007](../adr/0007-reviewer-can-only-escalate.md) |

## Inbound content and prompts

| Feature | Status | Details |
|---|---|---|
| Scan fetched pages and tool results for hidden instructions as they arrive; taint the session silently, never block reading | Built (0.5.0) on Claude Code, Codex, Gemini CLI and opencode; not run against the live tools | [docs/scanner.md](../scanner.md#inbound-scanning-050) |
| Scan the user's prompt on submit: hidden characters warn or block, secret-shaped values are held back, phrases only mark the session | Built (0.5.0); opencode cannot block or warn the user | same |
| A notice to the model for each finding | Built (0.5.0), off by default (`guards.inbound.notify`), because it costs tokens on every later call | [enforcement-model.md](../architecture/enforcement-model.md#what-to-build-next) |
| Optional model screening of prompts or tool results, escalate-only | Planned, only if the deterministic scan proves too weak | same |
| All rules loaded into the agent's context as the main defence | Rejected | [ADR 0004](../adr/0004-enforcement-outside-the-model.md) |

## Records

| Feature | Status | Details |
|---|---|---|
| Audit log, one redacted JSON line per decision | Built (0.1.0) | [API.md](../../API.md#audit-log) |
| Hash-chained audit log | Planned | |
| Session memory: counter, last 20 actions, taint | Built (0.2.0) | |

## Distribution

| Feature | Status | Details |
|---|---|---|
| Build from a clone, `npm link` | Built | [README](../../README.md) |
| `npx openmorals` from npm | Built as a package; not yet published | [docs/distribution.md](../distribution.md) |
| Single-file binary per OS (Linux x64/arm64, macOS arm64/x64, Windows x64), with `SHA256SUMS` | Built (0.4.0) by the release workflow; no release made yet; binaries not signed | [docs/distribution.md](../distribution.md) |
| Binary checked to give the same answers as the Node CLI, case by case | Built (0.4.0) | [docs/distribution.md](../distribution.md) |
| Thin Python package that runs the binary (`pip install openmorals`, `openmorals.check()`) | Built (0.4.0); not on PyPI yet | [docs/distribution.md](../distribution.md) |
| Signed binaries and signed checksums | Planned | [ROADMAP.md](../../ROADMAP.md) |
| More binary targets (Linux musl, Windows on Arm) | Planned | [ROADMAP.md](../../ROADMAP.md) |
| A bash or Python rewrite of the engine | Rejected | [ADR 0002](../adr/0002-typescript-on-node-as-the-one-engine.md) |
| Library API for other tools | Built | [API.md](../../API.md) |
| Decision service over JSON stdin/stdout for any action kind, and as an MCP server | Planned (today: `check --json` for command lines) | [ADR 0001](../adr/0001-a-guard-layer-not-a-factory-platform-or-standard.md) |
