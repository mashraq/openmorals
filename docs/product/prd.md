# Product requirements document (PRD)

Status labels: **Built (version)**, **Planned**, **Rejected**. Current version: 0.5.0 (nothing published yet). The numbered requirements are in [requirements.md](requirements.md); the feature list is in [features.md](features.md); the history of asks and decisions is in [requirements-log.md](requirements-log.md).

## 1. Problem

Coding agents run commands with the user's rights. A small mistake (an empty variable, a wrong folder, an instruction hidden in a web page) can delete work, delete something online, leak a credential, or burn hours of tool calls. Vendors' permission settings cover their own agent only. See [vision.md](vision.md).

## 2. Users

| User | Situation | What they need |
|---|---|---|
| A developer working alone | runs one or two coding agents on their own machine | to be asked before deletes, force-pushes and secret leaks, with undo; no tokens wasted; setup in one command |
| A developer new to coding agents | not yet sure what the agent may do | conservative defaults (the `beginner` pack) and plain reasons |
| Someone running agents in CI | nobody is there to answer a question | asks turned into denies (`--unattended`, the `ci-unattended` pack) |
| Someone working near production | the repository can reach live systems | online deletes refused and apply-type commands asked about (the `production-ops` pack) |
| A tool builder | an orchestrator, CI system or other agent tool | a decision service to call before acting (`check --json`, the library) |

Teams that need one shared policy, CI enforcement and reports across members are served by a separate package (see [ADR 0003](../adr/0003-apache-2-core-and-a-separate-team-package.md)).

## 3. Goals

1. Stop the common destructive and leaking actions of coding agents before they run, and ask the user. Built (0.1.0).
2. Work the same way across Claude Code, Codex CLI, Gemini CLI and opencode. Built (0.3.0); live runs on the last three Planned.
3. Cost no model tokens on allowed actions and no network by default. Built (0.1.0).
4. Fail closed. Built (0.1.0).
5. Make the safe path easy: trash and restore instead of delete. Built (0.2.0).
6. Vet skills, plugins and MCP configs before install. Built (0.2.0).
7. Catch waste: loops, polling, repeated failures, budgets. Built (0.1.0 budgets, 0.2.0 loops).
8. Run on Windows, macOS and Linux. Built (CI on all three, 0.3.1); live hosts on Windows not run.

## 4. Non-goals

- Running or orchestrating agents. Rejected ([ADR 0001](../adr/0001-a-guard-layer-not-a-factory-platform-or-standard.md)).
- Defining a new format for agents or skills. Rejected.
- Approving actions on the user's behalf. Rejected ([ADR 0009](../adr/0009-never-grant-permission-the-host-would-not.md)).
- Being the only layer of security. A hook is one layer; a sandbox and the host's own settings remain needed.

## 5. User stories

- As a developer, when my agent tries `rm -rf build`, I am asked first, told why, and offered `openmorals trash build` so I can undo it. Built (0.2.0).
- As a developer, when my agent tries to pipe `.env` to `curl`, the call is refused. Built (0.1.0).
- As a developer, I can see every decision later with `openmorals audit`, with secrets redacted. Built (0.1.0).
- As a developer, when the agent runs the same failing command again and again, I am asked whether to continue. Built (0.2.0, Claude Code for repeated failures).
- As a developer, before I install a skill from the internet, I can run `openmorals scan` and see hidden instructions, exfiltration or download-and-run code. Built (0.2.0).
- As a developer, after a web page entered the session, any step that touches my secrets and reaches the network asks first. Built (0.2.0).
- As a developer, I can tell my agent the rules up front in `AGENTS.md` so it wastes fewer attempts. Built (0.2.0).
- As a developer, I can ask a second model for an opinion on each ask, knowing it can never approve anything. Built (0.3.0).
- As a developer on Windows, a command is never judged more loosely than on macOS or Linux. Built (0.3.1).
- As a CI owner, nothing waits on a question: every ask is a deny. Built (0.2.0).
- As a developer without Node, I can install a single binary, or a Python package that runs it. Built (0.4.0); not yet published.
- As a developer, prompts I paste and pages the agent fetches are checked for hidden instructions. Planned.

## 6. Release scope

| Release | Date | Scope |
|---|---|---|
| 0.1.0 | 2026-11-23 | engine, bylaws and validator, five guards with case files, Claude Code `PreToolUse` hook, `check`, `init`, `validate`, `audit` |
| 0.2.0 | 2026-11-23 | install scanner; trash, restore, purge; guidance writer; packs; loop detector and taint judge in the hook; post-tool events; `--unattended` |
| 0.3.0 | 2026-11-23 | Codex CLI, Gemini CLI and opencode adapters; the reviewer; `sandbox plan` and `sandbox run` |
| 0.3.1 | 2026-11-24 | Windows: every shell command read in three dialects, strictest wins |
| 0.4.0 | 2026-11-24 | single-file binary per OS, a Python package that runs it, a release workflow with checksums; nothing published yet |
| 0.5.0 | 2026-11-24 | inbound scanning of tool results, fetched pages and prompts (silent by default, no tokens); post-tool and prompt hooks on Codex, Gemini CLI and opencode; `--help` on every subcommand (D-1); D-2, D-3; Windows CI fixes |
| 0.6.0 | 2026-11-24 | the user-level bylaws are a floor a project file can only tighten (security fix); reviewer protocols `anthropic-messages`, `openai-chat` (local servers) and `gemini`; opt-in inbound judge; token counting on Codex and OpenClaw and an optional cost limit from the user's price table; opencode 2.x field fixes; OpenClaw adapter |
| next | | see [ROADMAP.md](../../ROADMAP.md): publish, live runs on the other hosts, the reviewer on the other hosts, Antigravity CLI, token budgets for Claude Code, Gemini CLI and opencode, MCP tool classification |

## 7. How success is judged

These measures are Planned; none is collected yet, and openmorals sends no telemetry.

- Each guard's case table stays green, and every known evasion is either fixed or listed in [guards.md](../architecture/guards.md).
- The time a hook adds per tool call (measured once: about 0.09 s on one laptop; to be measured on Linux and Windows).
- How often users are asked, and how often they say no, from their own audit logs (a local report is Planned).
- Whether the guidance block saves more tokens than it costs (not measured).

## 8. Constraints

- One engine in TypeScript with strict settings; Node 20 or later, or the single-file binary; one runtime dependency (`yaml`).
- No network except the reviewer, which is off by default.
- No shell scripts in the product; every path through `node:path`.
- Secrets never written to disk by openmorals; file contents never logged.

## 9. Risks

- **Host hooks change.** A host may change its hook format or stop routing some tools through hooks. Mitigation: adapters cite the documentation and date they were built from; live runs are next.
- **A hook that does not start lets the tool run** on Claude Code. Mitigation: documented; `check` after `init`; the binary (0.4.0) removes the Node dependency once released.
- **Ask fatigue.** Mitigation: trash, allow-targets, packs, and a reviewer that cannot add approvals.
- **Pattern rules miss things.** Mitigation: fail closed on what cannot be parsed, list evasions, add the sandbox as a second layer.

## 10. Open questions

- How should a prompt-submit or post-tool scan show its finding to the user on each host? To be checked against each host's current hook documentation before building.
- Which MCP tools should be asked about by default when the bylaws do not classify them?
