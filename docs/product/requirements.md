# Requirements

Each requirement has an id, a status and how it is checked. **Built (version)** means released in that version with the named test or case table. **Planned** means not built. **Rejected** means it will not be built, with the reason linked. New requirements get the next free id; ids are never reused. Why each was asked for and when is in [requirements-log.md](requirements-log.md).

## Engine and bylaws (ENG)

| Id | Requirement | Status | Checked by |
|---|---|---|---|
| ENG-01 | `decide(action, bylaws, state)` returns allow, ask or deny with a rule id and a reason, and is a pure function | Built (0.1.0) | `test/engine.test.ts`, every `cases/*.cases.yaml` |
| ENG-02 | The strictest finding wins (deny over ask over allow) | Built (0.1.0) | `test/engine.test.ts` |
| ENG-03 | An invalid bylaws file falls back to the defaults and asks, never allows | Built (0.1.0) | `test/engine.test.ts`, `test/cases.test.ts` |
| ENG-04 | A guard or rule that throws gives ask, or deny if marked hard | Built (0.1.0) | `test/engine.test.ts` |
| ENG-05 | A command whose effect cannot be seen gives ask (`parser.opaque`) | Built (0.1.0) | `cases/destructive.cases.yaml` |
| ENG-06 | Bylaws are validated strictly: an unknown key, wrong type or bad regular expression makes the file invalid | Built (0.1.0) | `test/bylaws-audit.test.ts` |
| ENG-07 | A user rule can only add ask or deny, never allow | Built (0.1.0); dedicated test 0.6.0 | `test/rules-never-allow.test.ts` (the validator, and every case-file case with match-all rules, including an `allow` rule forced past the validator) |
| ENG-08 | Removing any built-in guard makes its ask and deny cases fail (each guard is load-bearing) | Built (0.1.0) | `test/engine.test.ts` |
| ENG-09 | Nearest `openmorals.yaml` walking up, else the config directory, else defaults | Built (0.1.0); changed in 0.6.0 by ENG-10 | `test/bylaws-audit.test.ts` |
| ENG-10 | The user-level file (else the defaults) is a floor: a project file can only tighten it; looser project settings are ignored and reported; reviewer endpoint, key variable, model and timeout come from the user file only | Built (0.6.0) | `test/bylaws-floor.test.ts` |

## Guards (GRD)

| Id | Requirement | Default | Status | Checked by |
|---|---|---|---|---|
| GRD-01 | Ask before recursive, forced or wildcard deletes, including evasions through quoting, wrappers, `bash -c`, `$(...)`, variables, PowerShell and cmd forms | ask | Built (0.1.0) | `cases/destructive.cases.yaml` |
| GRD-02 | Ask before force-push, hard reset, `git clean`, branch delete, discarding work, history rewrite, stash drop | ask | Built (0.1.0) | same |
| GRD-03 | Ask before `DROP`, `TRUNCATE`, `DELETE` without `WHERE`, disk formatting, raw device writes, `shred`, `rsync --delete`, docker prunes | ask | Built (0.1.0) | same |
| GRD-04 | When stopping a delete, name `openmorals trash <path>` as the recoverable alternative | | Built (0.2.0) | `test/trash-hint.test.ts` |
| GRD-05 | Ask before online deletes: repositories, buckets, cloud resources, cluster objects, infrastructure, published packages, HTTP DELETE, remote branch deletes | ask | Built (0.1.0) | `cases/online-delete.cases.yaml` |
| GRD-06 | Ask before reading or writing secret files; deny a command line that reads a secret and reaches the network | read ask, write ask, send deny | Built (0.1.0) | `cases/secrets.cases.yaml` |
| GRD-07 | One shared list of network commands for the secrets guard and the taint judge | | Built (0.2.0) | `test/network.test.ts` |
| GRD-08 | Ask before an agent edits openmorals' own bylaws, any supported host's hook config, the audit log or the trash, or runs `openmorals init`/`purge`; since 0.6.2 also anything in the real config directory (`OPENMORALS_HOME` whatever its name), that directory or a folder above it moved, removed, linked, extracted or copied onto, a protected path inside any argument, and paths reached through a symbolic link | ask | Built (0.1.0; other hosts 0.3.0; config directory, links and arguments 0.6.2) | `cases/self-protect.cases.yaml`, `test/self-protect-links.test.ts` |
| GRD-09 | Count tool calls per session; ask at the soft limit and every step after; deny at the hard limit; 0 switches a limit off | 400 / 1500 / 100 | Built (0.1.0) | `cases/budget.cases.yaml` |
| GRD-10 | Count tokens per session when the host reports them | 2M / 5M / 500k | Built (0.1.0); counted on Codex and OpenClaw (0.6.0); not reported by Claude Code, Gemini CLI or opencode | `cases/budget.cases.yaml`, `test/usage.test.ts` |
| GRD-11 | A cost limit from a per-model price table in the user-level file; no prices shipped | off / empty | Built (0.6.0) | `test/usage.test.ts` |
| GRD-11 | Ask on loops: 4th identical step, 6 polling steps, 5 near-identical steps, 3 identical failures | ask | Built (0.2.0) | `test/extras/loop.test.ts` |
| GRD-12 | Ask on a network step once untrusted content and private data are both in the session (Rule of Two); `trusted_hosts` exempts sites | ask | Built (0.2.0) | `test/extras/taint.test.ts` |
| GRD-13 | On Windows, judge each command in the PowerShell, POSIX and cmd readings and keep the strictest | | Built (0.3.1) | `test/windows-dialects.test.ts` |
| GRD-14 | Classify MCP tools in the bylaws; ask for unknown ones | ask | Planned | |

## Hosts (HST)

| Id | Requirement | Status | Checked by |
|---|---|---|---|
| HST-01 | Claude Code: answer `PreToolUse` in the documented format; print nothing for allow | Built (0.1.0) | `test/adapter-cli.test.ts` |
| HST-02 | Claude Code: record outcomes on `PostToolUse` and `PostToolUseFailure`, print nothing | Built (0.2.0) | `test/session-hook.test.ts` |
| HST-03 | `init` merges the hook into existing settings, backs up first, never replaces, stops on invalid JSON, is idempotent | Built (0.1.0) | `test/adapter-cli.test.ts`, `test/agents-wiring.test.ts` |
| HST-04 | Codex CLI: `PreToolUse`; ask sent as deny with a message to bring the question to the user | Built (0.3.0); live run Planned | `test/adapters/codex/` |
| HST-05 | Gemini CLI: `BeforeTool`; native ask where supported; `OPENMORALS_GEMINI_ASK=deny` for older versions | Built (0.3.0); live run Planned | `test/adapters/gemini-cli/` |
| HST-06 | opencode: plugin for the V1 and V2 plugin APIs; V1 ask sent as a block | Built (0.3.0); live run Planned | `test/adapters/opencode/` |
| HST-07 | Every adapter fails closed in the host's own format when its input cannot be read or anything fails | Built (0.3.0) | `test/agents-wiring.test.ts`, `test/adapter-cli.test.ts` |
| HST-08 | Post-tool outcomes on Codex, Gemini CLI and opencode | Built (0.5.0); opencode V1 reports no failures | `test/inbound.test.ts` |
| HST-09 | Adapters run against each live tool, with a published transcript | Planned | |
| HST-10 | Antigravity CLI (Google's replacement for Gemini CLI for individual plans since 18 June 2026) | Planned: hook format read on Google's page 24 Nov 2026 and differs from Gemini CLI's (docs/adapters.md); adapter not built | |
| HST-11 | opencode 2.x through the V2 half of the plugin (`id`, `setup`); fields verified against the v2.4.1 types where the docs are silent | Built (0.6.0): not run in a live opencode 2 | `test/adapters/opencode/v2-shape.test.ts` |
| HST-12 | OpenClaw: a plugin on `before_tool_call` (native ask through `requireApproval`, never `allow-always`; blocks on any failure), `after_tool_call` outcomes and inbound scan, `llm_output` tokens | Built (0.6.0): not run in a live OpenClaw | `test/adapters/openclaw/openclaw.test.ts` |
| HST-13 | Claude Code: judge MCP and other tools without their own mapping on their top-level path and URL arguments (`argActions`, as the other adapters) and ask on an `mcp__` tool named like a delete (`adapter.mcp-delete`); built-in tools judged as before | Built (0.8.1): recorded event shapes only, not run in a live Claude Code | `test/claude-code-mcp.test.ts`, MCP rows in `cases/secrets.cases.yaml` and `cases/online-delete.cases.yaml` |

## Records and privacy (REC)

| Id | Requirement | Status | Checked by |
|---|---|---|---|
| REC-01 | Append every decision to a JSONL audit log; `openmorals audit` prints it | Built (0.1.0) | `test/bylaws-audit.test.ts` |
| REC-02 | Redact secret values before anything is written; never log file contents | Built (0.1.0) | `test/bylaws-audit.test.ts` |
| REC-03 | If the audit log or session file cannot be written, ask | Built (0.1.0) | `test/adapter-cli.test.ts` (audit log) |
| REC-04 | No network connection except the reviewer, which is off by default | Built (0.1.0; reviewer 0.3.0) | code review; reviewer tests use a fake `fetch` |
| REC-05 | Hash-chain the audit log so a missing or edited line is detected: one chain per session file (`seq`, `prev`), the head kept in the session file; `openmorals audit verify` reports an edited line, a deleted line, a cut-off tail, lines removed from the end and a session restart, and with `--run` a missing log; it states that a program running as the user can still rewrite the log and recompute the chain | Built (0.8.0) | `test/audit-chain.test.ts` (tamper fixtures; checked to fail with the chain check removed) |
| REC-06 | Tell a missing audit log from an empty one (`readAudit` status, `openmorals audit` text) | Built (0.6.2) | `test/fail-toward-caution.test.ts` |
| REC-08 | Each record carries the openmorals version, a digest of the bylaws in force, the host event, the run id from `OPENMORALS_RUN` and the host's agent id; a field the host does not give is left out | Built (0.8.0) | `test/audit-chain.test.ts` |
| REC-09 | Record the outcome of an ask: a post-tool event for a call that was asked about writes `ask.approved` | Built (0.8.0) | `test/audit-chain.test.ts` |
| REC-10 | `openmorals audit --run <id>` summarises a run: denies, asks, approved asks, taint marks, loosening notes and whether the record verifies | Built (0.8.0) | `test/audit-chain.test.ts` |
| REC-07 | A session file that exists but cannot be read or parsed reads as tainted, and the next judged call asks once; only a missing file starts a clean session | Built (0.6.2) | `test/fail-toward-caution.test.ts` |

## Undo, guidance, packs, scanner (EXT)

| Id | Requirement | Status | Checked by |
|---|---|---|---|
| EXT-01 | `trash` moves into `.openmorals/trash` with an undo log; refuses paths outside the project, symlink escapes and the trash itself | Built (0.2.0) | `test/extras/undo.test.ts` (`TRASH_CASES`) |
| EXT-02 | `purge` is the only real delete, and deletes nothing without `--yes` | Built (0.2.0) | `test/extras/undo.test.ts`, `test/cli-extras.test.ts` |
| EXT-03 | The trash is never committed (`.openmorals/.gitignore` written on first use) | Built (0.2.0) | `test/cli-extras.test.ts` |
| EXT-04 | `guidance` writes a marked block, never touches text outside it, is idempotent, refuses symlinks | Built (0.2.0) | `test/extras/guidance.test.ts` |
| EXT-05 | Five packs that all validate; `strict` never looser than `solo-dev` | Built (0.2.0) | `test/extras/packs.test.ts` |
| EXT-06 | `scan` reads skills, plugins, MCP configs and npm packages without running anything; never follows symlinks; verdict from the worst finding | Built (0.2.0) | `test/scanner/` (`CASES`: half must be flagged, half benign look-alikes) |
| EXT-08 | `openmorals eval` scores every case row the way the tests do and prints, per guard, the catch rate, the false-alarm rate, rule mismatches and p50/p95 time per decision; lists every wrong row by file and index; exit 0/1/2 (2: unreadable rows, nothing scored); no model call; works from the npm package and the binary | Built (0.7.0) | `test/eval.test.ts` (real numbers, a wrong row, garbage input, `--json` shape, a guard set that allows everything); `scripts/compare-binary.mjs` |
| EXT-07 | Every subcommand prints help for `--help` (and `-h`, `help <command>`) and does nothing else; an unknown option on a command that writes files is a usage error | Built (0.5.0; defect D-1 fixed) | `test/cli-help.test.ts` |

## Reviewer and sandbox (RVS)

| Id | Requirement | Status | Checked by |
|---|---|---|---|
| RVS-01 | The reviewer can never turn ask or deny into allow | Built (0.3.0) | `test/reviewer/` (exhaustive combination test) |
| RVS-02 | The reviewer is off by default, sees only asks, and any failure keeps the ask | Built (0.3.0) | `test/reviewer-wiring.test.ts` |
| RVS-03 | Untrusted text reaches the reviewer only as data in a fixed frame, redacted and size-capped | Built (0.3.0) | `test/reviewer/` (`REVIEW_CASES`) |
| RVS-04 | `sandbox run` refuses, running nothing, when the sandbox tool is missing or on Windows (exit 125) | Built (0.3.0) | `test/sandbox/`, `test/sandbox-wiring.test.ts` |
| RVS-05 | The sandbox keeps the bylaws and host hook files read-only, denies reads of credential files and turns the network off | Built (0.3.0) | `test/sandbox/` (`PLAN_CASES`) |
| RVS-06 | Enforced sandbox on Windows | Planned | |
| RVS-07 | Allowed hosts in the sandbox through Anthropic's `srt` | Planned | |
| RVS-08 | Reviewer protocols `anthropic-messages`, `openai-chat` (local servers by base URL) and `gemini`, hand-written on `fetch`, no new dependency; endpoint, key variable and model from the user-level file only; https or loopback http; any failure escalates | Built (0.6.0) | `test/reviewer/protocols.test.ts` |

## Inbound content (INB)

| Id | Requirement | Status | Checked by |
|---|---|---|---|
| INB-01 | Scan fetched pages and tool results with the scanner's hidden-instruction rules as they arrive, and taint the session on a hit; never block reading | Built (0.5.0): Claude Code, Codex, Gemini CLI, opencode (not run against the live tools) | `cases/inbound.table.yaml`, `test/inbound.test.ts` |
| INB-02 | Scan the user's prompt on submit where the host provides a hook for it; act only on hidden characters and secret shapes, never block the user's visible words | Built (0.5.0): Claude Code, Codex, Gemini CLI; opencode warns the model only (it cannot block or warn the user) | same |
| INB-04 | No tokens by default: a finding is recorded silently (taint and audit); the model is told only when a later action is stopped; a per-finding notice is opt-in (`guards.inbound.notify`) | Built (0.5.0) | `test/inbound.test.ts` |
| INB-05 | Bounded work: at most `guards.inbound.max_bytes` per result or prompt (default 256 KiB), the added time measured and documented | Built (0.5.0) | `test/inbound.test.ts`; [docs/scanner.md](../scanner.md#inbound-scanning-050) |
| INB-06 | Optional model screening of flagged content, escalate-only, off by default | Built (0.6.0): weak findings in tool results, Claude Code hook only, user-level switch `guards.inbound.judge`; not measured on a corpus | `test/inbound-judge.test.ts` |
| INB-03 | Load all rules into the agent's context as the main defence | Rejected ([ADR 0004](../adr/0004-enforcement-outside-the-model.md)) | |

## Non-functional (NFR)

| Id | Requirement | Status | Checked by |
|---|---|---|---|
| NFR-01 | Runs on Windows, macOS and Linux with Node 20 or later | Built | CI on all three (Node 22, 24) |
| NFR-02 | Strict TypeScript, no `any`; one runtime dependency | Built | `npm run build` |
| NFR-03 | No shell scripts in the product; paths through `node:path` | Built | code review |
| NFR-04 | No model tokens spent on allowed actions | Built (0.1.0) | allow prints nothing (`toHookOutput`) |
| NFR-05 | A hook call adds well under a second | Built: about 0.09 s measured once on one laptop (24 Nov 2026); Linux and Windows not measured | manual timing |
| NFR-06 | Never answer allow to a host | Built (0.1.0) | adapter tests |
| NFR-07 | Every guard has a case table; every known evasion is listed | Built | [guards.md](../architecture/guards.md) |
| NFR-08 | Install without Node: single binary per OS, and a thin Python package that runs it | Built (0.4.0); not published | `.github/workflows/release.yml`, `python/tests/` |
| NFR-10 | The binary gives the same answer as the Node CLI for every guard case and the main commands | Built (0.4.0) | `scripts/compare-binary.mjs` (CI and release workflow) |
| NFR-11 | The Python package makes no decisions, checks the binary's SHA-256 before running it, and fails closed | Built (0.4.0) | `python/tests/` |
| NFR-09 | One engine; no second implementation in another language | Built (0.1.0) | [ADR 0002](../adr/0002-typescript-on-node-as-the-one-engine.md) |
