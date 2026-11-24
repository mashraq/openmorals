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
| ENG-07 | A user rule can only add ask or deny, never allow | Built (0.1.0) | the validator in `src/bylaws.ts` (no dedicated test found on 24 Nov 2026) |
| ENG-08 | Removing any built-in guard makes its ask and deny cases fail (each guard is load-bearing) | Built (0.1.0) | `test/engine.test.ts` |
| ENG-09 | Nearest `openmorals.yaml` walking up, else the config directory, else defaults | Built (0.1.0) | `test/bylaws-audit.test.ts` |

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
| GRD-08 | Ask before an agent edits openmorals' own bylaws, any supported host's hook config, the audit log or the trash, or runs `openmorals init`/`purge` | ask | Built (0.1.0; other hosts 0.3.0) | `cases/self-protect.cases.yaml` |
| GRD-09 | Count tool calls per session; ask at the soft limit and every step after; deny at the hard limit; 0 switches a limit off | 400 / 1500 / 100 | Built (0.1.0) | `cases/budget.cases.yaml` |
| GRD-10 | Count tokens per session when the host reports them | 2M / 5M / 500k | Built (0.1.0); Planned for Claude Code | `cases/budget.cases.yaml` |
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
| HST-08 | Post-tool outcomes on Codex, Gemini CLI and opencode | Planned | |
| HST-09 | Adapters run against each live tool, with a published transcript | Planned | |

## Records and privacy (REC)

| Id | Requirement | Status | Checked by |
|---|---|---|---|
| REC-01 | Append every decision to a JSONL audit log; `openmorals audit` prints it | Built (0.1.0) | `test/bylaws-audit.test.ts` |
| REC-02 | Redact secret values before anything is written; never log file contents | Built (0.1.0) | `test/bylaws-audit.test.ts` |
| REC-03 | If the audit log or session file cannot be written, ask | Built (0.1.0) | `test/adapter-cli.test.ts` (audit log) |
| REC-04 | No network connection except the reviewer, which is off by default | Built (0.1.0; reviewer 0.3.0) | code review; reviewer tests use a fake `fetch` |
| REC-05 | Hash-chain the audit log so a missing or edited line is detected | Planned | |

## Undo, guidance, packs, scanner (EXT)

| Id | Requirement | Status | Checked by |
|---|---|---|---|
| EXT-01 | `trash` moves into `.openmorals/trash` with an undo log; refuses paths outside the project, symlink escapes and the trash itself | Built (0.2.0) | `test/extras/undo.test.ts` (`TRASH_CASES`) |
| EXT-02 | `purge` is the only real delete, and deletes nothing without `--yes` | Built (0.2.0) | `test/extras/undo.test.ts`, `test/cli-extras.test.ts` |
| EXT-03 | The trash is never committed (`.openmorals/.gitignore` written on first use) | Built (0.2.0) | `test/cli-extras.test.ts` |
| EXT-04 | `guidance` writes a marked block, never touches text outside it, is idempotent, refuses symlinks | Built (0.2.0) | `test/extras/guidance.test.ts` |
| EXT-05 | Five packs that all validate; `strict` never looser than `solo-dev` | Built (0.2.0) | `test/extras/packs.test.ts` |
| EXT-06 | `scan` reads skills, plugins, MCP configs and npm packages without running anything; never follows symlinks; verdict from the worst finding | Built (0.2.0) | `test/scanner/` (`CASES`: half must be flagged, half benign look-alikes) |
| EXT-07 | Every subcommand prints help for `--help` and does nothing else | **Not met** (defect) | [requirements-log.md](requirements-log.md#known-defects) |

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

## Inbound content (INB)

| Id | Requirement | Status | Checked by |
|---|---|---|---|
| INB-01 | Scan fetched pages and tool results with the scanner's injection and exfiltration rules as they arrive, and taint the session on a hit | Planned | |
| INB-02 | Scan the user's prompt on submit where the host provides a hook for it | Planned | |
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
