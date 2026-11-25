# Architecture overview

> This page describes 0.5.0 and is kept for history. For the code as it is now, see [as-built.md](as-built.md); for install and setup, [deployment.md](deployment.md) and [prerequisites.md](prerequisites.md); for direction, [target.md](target.md).

Status labels: **Built (version)**, **Planned**, **Rejected**. This page describes 0.5.0.

## In one sentence

openmorals is a local program that a coding agent's host calls before each tool call; it judges the call against a YAML file of bylaws with deterministic code and answers allow, ask or deny. The model proposes; openmorals answers; the host enforces the answer.

## What runs where

```
 your machine
 ┌───────────────────────────────────────────────────────────────────────────────┐
 │ host agent: Claude Code │ Codex CLI │ Gemini CLI │ opencode                    │
 │    │ hook config written by `openmorals init --agent <host>`                  │
 │    ▼ one process per tool call (stdin: the call as JSON; stdout: the answer)  │
 │ openmorals hook <host>                                                        │
 │    ├─ adapter: host event  ->  action {exec | read | write | fetch | other}   │
 │    ├─ engine.decide(action, bylaws, state)                                    │
 │    │     command parser -> 5 guards -> your rules -> strictest wins           │
 │    ├─ session checks: loop detector, taint judge (Rule of Two)                │
 │    ├─ reviewer (optional, Claude Code only, asks only)  ──► model API          │
 │    ├─ session file (counter, last 20 actions, taint)   config dir/sessions/   │
 │    └─ audit log (one JSON line per decision, redacted) config dir/audit.jsonl │
 │                                                                               │
 │ commands a person runs: check, scan, trash/restore/purge, guidance, packs,    │
 │ init, validate, audit, sandbox plan, sandbox run                              │
 └───────────────────────────────────────────────────────────────────────────────┘
```

The reviewer arrow is the only network connection openmorals can make, and only when the user turns the reviewer on. Everything else stays on the machine. Built (0.3.0).

## Components

| Component | What it does | Source | Status |
|---|---|---|---|
| Policy engine | `decide(action, bylaws, state)`: a pure function returning `{decision, rule, reason}`; strictest finding wins; any error gives ask | [`src/engine.ts`](../../src/engine.ts) | Built (0.1.0) |
| Command parser | reads a command line as the shell would: quotes, escapes, wrappers (`sudo`, `env`, `timeout`...), `bash -c`, `eval`, `$(...)`, backticks, `cmd /c`, `powershell -Command`/`-EncodedCommand`, `find -exec`, variables set earlier on the same line, multi-line commands; POSIX, PowerShell and cmd dialects | [`src/shell.ts`](../../src/shell.ts) | Built (0.1.0; Windows dialect fixes 0.2.0 and 0.3.1) |
| Guards | destructive, online-delete, secrets, self-protect, budget | [`src/guards/`](../../src/guards/) | Built (0.1.0) |
| Bylaws | loads, validates (strictly) and writes `openmorals.yaml`; the config directory file (else defaults) as a floor, tightened by the nearest project file walking up | [`src/bylaws.ts`](../../src/bylaws.ts), [`src/packs/compare.ts`](../../src/packs/compare.ts) | Built (0.1.0); floor 0.6.0 |
| Session memory | per-session counter, the last 20 actions (redacted) and the taint state, in one JSON file | [`src/state.ts`](../../src/state.ts), [`src/session.ts`](../../src/session.ts) | Built (0.2.0) |
| Loop detector | repeats, polling, near-repeats, repeated failures | [`src/loop/`](../../src/loop/) | Built (0.2.0) |
| Taint judge | Rule of Two over the session; since 0.5.0 also asks before network or private-data steps once hidden instructions were found in content | [`src/taint/`](../../src/taint/) | Built (0.2.0; content 0.5.0) |
| Inbound scanner | hidden-instruction rules over tool results, fetched pages and prompts, run from each host's post-tool and prompt hooks; taints and audits silently by default | [`src/inbound/`](../../src/inbound/), [docs/scanner.md](../scanner.md#inbound-scanning-050) | Built (0.5.0); not run against live Codex, Gemini CLI or opencode |
| Audit log | one redacted JSON line per decision, chained per session; `openmorals audit` prints it, `audit verify` checks the chain, `audit --run` summarises a run | [`src/audit.ts`](../../src/audit.ts), [`src/audit-verify.ts`](../../src/audit-verify.ts) | Built (0.1.0); chain, verify and run summary 0.8.0 ([docs/audit.md](../audit.md)) |
| Claude Code adapter | `PreToolUse` judge; `PostToolUse` and `PostToolUseFailure` record outcomes and scan results; `UserPromptSubmit` scans the prompt (0.5.0); settings merge for `init` | [`src/adapters/claude-code.ts`](../../src/adapters/claude-code.ts), [`src/init.ts`](../../src/init.ts) | Built (0.1.0; post events 0.2.0) |
| Codex, Gemini CLI, opencode adapters | the same judgement in each host's format; ask sent as a block where the host cannot ask | [`src/adapters/`](../../src/adapters/) | Built (0.3.0); not run against the live tools |
| Reviewer | second model on asks; escalate-only | [`src/reviewer/`](../../src/reviewer/) | Built (0.3.0); never called a real API |
| Sandbox | plan a Seatbelt profile, bubblewrap arguments or a written Windows plan from the bylaws; run one command under it | [`src/sandbox/`](../../src/sandbox/) | Built (0.3.0): macOS run once, Linux in CI only, Windows plan only |
| Install scanner | static scan of skills, plugins, MCP configs and npm packages before install | [`src/scanner/`](../../src/scanner/) | Built (0.2.0) |
| Trash and undo | move into `.openmorals/trash` with an undo log; restore; purge with `--yes` | [`src/undo/`](../../src/undo/) | Built (0.2.0) |
| Guidance writer | the bylaws as plain instructions in a marked block of `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` | [`src/guidance/`](../../src/guidance/) | Built (0.2.0) |
| Packs | five ready-made bylaws files | [`packs/`](../../packs/), [`src/packs/`](../../src/packs/) | Built (0.2.0) |
| CLI | every command above | [`src/cli.ts`](../../src/cli.ts) | Built |
| Library entry | everything exported for programmatic use | [`src/index.ts`](../../src/index.ts), [API.md](../../API.md) | Built |
| Single-file binary build | bundles the CLI with esbuild and builds it with Node's `node --build-sea`; packs embedded as assets | [`scripts/build-binary.mjs`](../../scripts/build-binary.mjs), [docs/distribution.md](../distribution.md) | Built (0.4.0); no release made yet |
| Binary comparison | runs every guard case and the main commands through the Node CLI and a binary and fails on any difference | [`scripts/compare-binary.mjs`](../../scripts/compare-binary.mjs) | Built (0.4.0) |
| Python package | a launcher for the binary with no decision code; checks the binary's SHA-256 first and fails closed | [`python/`](../../python/), [docs/distribution.md](../distribution.md) | Built (0.4.0); not on PyPI yet |

## Where data lives

| What | Where | Status |
|---|---|---|
| Bylaws | `openmorals.yaml` in the config directory (the floor), tightened by the nearest one in the project | Built (0.1.0); floor 0.6.0 |
| Config directory | `$OPENMORALS_HOME`; else `%APPDATA%\openmorals` on Windows; else `$XDG_CONFIG_HOME/openmorals` or `~/.config/openmorals` | Built (0.1.0) |
| Audit log | `<config dir>/audit.jsonl` | Built (0.1.0) |
| Session files | `<config dir>/sessions/` | Built (0.1.0) |
| Trash and undo log | `<project>/.openmorals/trash/`, `<project>/.openmorals/undo.jsonl`, with a `.gitignore` of `*` | Built (0.2.0) |

Secret values are redacted before anything is written. File contents are never logged; a write is recorded by its path only.

## Runtime, dependencies, distribution

- **Language and runtime:** TypeScript, compiled with strict settings, run on Node 20 or later. Built. See [ADR 0002](../adr/0002-typescript-on-node-as-the-one-engine.md).
- **Runtime dependency:** `yaml` only. Development: `typescript`, `@types/node`, and `esbuild` (only to bundle the binary); tests use Node's built-in runner. Built.
- **Platforms:** CI builds and tests on Linux, macOS and Windows (Node 22 and 24). Built (0.3.1). What was run on a real machine is listed per component in [threat-model.md](threat-model.md#what-has-and-has-not-been-run).
- **Three install routes, one engine:** npm, a single-file binary per OS (Linux x64 and arm64, macOS arm64 and x64, Windows x64), and a Python package that only runs that binary. Built (0.4.0). This is distribution of the same engine, not a second implementation. See [ADR 0002](../adr/0002-typescript-on-node-as-the-one-engine.md) and [docs/distribution.md](../distribution.md).
- **Published:** nothing yet. No npm package, GitHub release or PyPI upload. Today, install from a clone (`npm install`, `npm run build`, `npm link`). The binaries come from the release workflow; none was built on the development machine.

## Design rules that hold across components

1. **Enforcement is outside the model.** [ADR 0004](../adr/0004-enforcement-outside-the-model.md)
2. **Fail closed: an error asks, never allows.** [ADR 0005](../adr/0005-fail-closed-ask-on-error.md)
3. **Ask is the default, not forbid.** [ADR 0006](../adr/0006-ask-by-default-not-forbid.md)
4. **openmorals never answers allow to a host.** It stays silent instead, so the host's own permission prompts still apply. [ADR 0009](../adr/0009-never-grant-permission-the-host-would-not.md)
5. **A model can only make an answer stricter.** [ADR 0007](../adr/0007-reviewer-can-only-escalate.md)
6. **Pure core, small shell.** Judging is pure functions over data (engine, guards, loop, taint, trash planning, sandbox planning, guidance rendering); file and process work sits in thin wrappers, so the judging is tested with case tables.
7. **Every guard ships with its own case table,** and a test proves each guard is load-bearing by removing it. [guards.md](guards.md)

## What it is not

Not an agent, not an agent platform, not an orchestrator and not a new standard. It is a guard layer that works with the agents and standards people already use. [ADR 0001](../adr/0001-a-guard-layer-not-a-factory-platform-or-standard.md)
