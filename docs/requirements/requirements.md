# Product requirements

25 Nov 2026, checked against release 0.35.0; the hook and token rows against 0.36.0. Status words are explained in [README.md](README.md). The detailed checks, each with its own id and test, are in [product/requirements.md](../product/requirements.md).

## 1. Foundation

| # | Requirement | Met when | Status |
|---|---|---|---|
| 1.1 | Deterministic code decides each action it judges: allow, ask or deny, with a rule id and a reason. The strictest finding wins | The same input gives the same answer, and every shipped case row matches | Built (0.1.0) |
| 1.2 | Any error inside the guard asks, or denies where marked hard. openmorals never answers "allow" to a host ([ADR 0009](../adr/0009-never-grant-permission-the-host-would-not.md)) | Invalid bylaws, a throwing guard and an unreadable session file each give ask; no adapter emits allow | Built (0.1.0) |
| 1.3 | The guard cannot be off without you knowing: `init` writes each host's own fail-closed setting where one exists, the first session says the guard is active, and a `doctor` command checks the install | A missing binary, a crash, a timeout or bad output blocks or warns loudly, and never lets the call run silently | Partly (0.36.0): `init` writes Claude Code's `onFailure: "block"` on the tool and prompt hooks; not tried on a live host. The first-session notice and `doctor` are Planned |
| 1.4 | Your user-level file is a floor: a project file can only make it stricter | Looser project settings are ignored and reported | Built (0.6.0) |
| 1.5 | Self-protect: the agent cannot change the bylaws, the host's hook files, the audit log, the trash or git hook settings | Every route in `cases/self-protect.cases.yaml` asks | Built (0.1.0, widened since) |
| 1.6 | Session state holds under parallel calls from sub-agents | 64 concurrent hook processes keep every call and taint mark | Built (0.32.1) |
| 1.7 | A hash-chained audit log that `audit verify` checks | A removed or edited line is reported | Built (0.8.0) |
| 1.8 | No network call and no model tokens unless you switch on the reviewer or the inbound judge | A default install makes no outbound connection | Built (0.1.0) |
| 1.9 | A hook call adds well under a second | Measured per host | Built: about 0.09 s, measured on one laptop |
| 1.10 | Windows, macOS and Linux; on Windows a command is judged in every shell reading and the strictest kept | Case rows pass in each reading | Built (0.3.1) |

## 2. Guard

| # | Requirement | Met when | Status |
|---|---|---|---|
| 2.1 | Ask before destructive local acts (recursive or forced deletes, force push, hard reset, history rewrite, dropping tables, formatting disks) and their evasions | `cases/destructive.cases.yaml` passes | Built (0.1.0) |
| 2.2 | Ask before online deletes (repositories, buckets, cloud resources, published packages) | `cases/online-delete.cases.yaml` | Built (0.1.0) |
| 2.3 | A plain delete or a losing move goes to a project trash where it can, with restore and purge | A refused delete names the recoverable alternative | Built (0.2.0 to 0.22.0) |
| 2.4 | Secrets: reading or writing a secret file asks; reading a secret and reaching the network is denied | `cases/secrets.cases.yaml` | Built (0.1.0) |
| 2.5 | Rule of Two: a network step asks once untrusted content and private data are both in the session | Taint tests and case rows | Built (0.2.0; private paths 0.16.0) |
| 2.6 | Loop detection, with the last error in the ask | Loop tests and session rows | Built (0.2.0; error text 0.32.0). Limits in the bylaws: Planned |
| 2.7 | Document, replace and outbound guards (deleting most of a document, where data is being sent) | Their case tables | Built (0.18.0 to 0.24.0); not run live |
| 2.8 | Deferred asks: when nobody can answer, the action is held and approved later, once, bound to the exact action | A changed action needs a new approval | Built on Claude Code (0.19.0), not run live; other hosts Planned |
| 2.9 | Inbound scan of pages, tool results, prompts and messages between agents, with no tokens by default | `cases/inbound.table.yaml` | Built (0.5.0, 0.14.0); not run live |
| 2.10 | Your own rules over content, with detectors for cards, account numbers and tokens; a rule can only add ask or deny | Patterns run in linear time; values are never logged | Built (0.15.0, 0.16.0) |
| 2.11 | Installing a package the project's manifest and lockfile do not list asks | `cases/packages.cases.yaml` | Built (0.32.0). A registry check for invented names: Planned, opt-in |
| 2.12 | Policy packs, off unless chosen, never claiming compliance | Removing any rule fails exactly its rows | Built (0.26.0 to 0.31.0); evidence synthetic |
| 2.13 | MCP tools can be marked read-only or destructive, and an unknown MCP tool asks | A new tool name asks until marked | Planned |
| 2.14 | A changed MCP tool list or argument shape asks again before use | Changed tools used before re-approval: none | Planned |
| 2.15 | OS sandbox for one command, with protected paths; writing the host's own sandbox settings from the bylaws | `sandbox run` refuses when its tool is missing | Built (0.3.0, 0.17.0 on macOS). Host settings: Planned |
| 2.16 | An agent CLI launched by an agent with a skip-permissions flag is denied | Such launches allowed: none | Planned |
| 2.17 | Work orders and the release hold | `order check`, `cases/hold.cases.yaml` | Built (0.27.0 to 0.30.0) |

## 3. Learn (what the agent is told and what it keeps)

| # | Requirement | Met when | Status |
|---|---|---|---|
| 3.1 | `openmorals guidance` writes the rules into the agents file in a marked block | Idempotent; text outside the block untouched | Built (0.2.0) |
| 3.2 | Scan a skill, plugin, MCP config or package before install | Runs nothing, follows no link | Built (0.2.0) |
| 3.3 | Memory-file guard: writes to files every later session loads (agent instructions, memory notes, skills) are scanned, size-limited, and asked about when they come from a shell command or a session holding untrusted content | [next.md §1](next.md#1-the-memory-file-guard) | Built (0.35.0); not run live. Source of each line and a host-matched memory limit: Planned |
| 3.4 | Guard state survives compaction | Guard state lost across a real compaction: none | Partly: state is on disk and session rows keep taint across compaction events; a real compaction not yet run |
| 3.5 | A diff of memory files before and after a clean-up pass | An added instruction or a dropped guarded note is listed | Planned |
| 3.6 | openmorals' own state is never rewritten or summarised by a model | Design rule | Built by design |
| 3.7 | Daily guidance, advice only | Off by default | Built (0.29.0) |

## 4. Review

| # | Requirement | Met when | Status |
|---|---|---|---|
| 4.1 | A merge verdict from the diff; nothing skips review by default | Replay on the repository's own history | Built (0.12.0) |
| 4.2 | Integrity reasons that can only add review: weakened tests, skips, snapshot updates, secrets added in the diff | `cases/diff-class.cases.yaml` | Built (0.13.0, 0.32.0) |
| 4.3 | Test checks: two runs compared by test id, new tests run against the base, coverage drop | Exit codes as documented | Built (0.10.0 to 0.32.0); not run on real projects |
| 4.4 | Which tests the agent wrote, and a check of its "tests pass" claim against a clean run | Exits 1 on an agent-written test or a false claim | Built (0.32.0) |
| 4.5 | A review map, a split suggestion for large changes, and notes that can only add review | An approving note changes nothing | Built (0.33.0) |
| 4.6 | An optional reviewer model that can only escalate | It can never turn ask or deny into allow | Built (0.3.0, 0.6.0); not yet called against a real API |
| 4.7 | `audit sample`: a random draw of finished runs for a close read | Each run considered once | Built (0.11.0) |

## 5. Score

| # | Requirement | Met when | Status |
|---|---|---|---|
| 5.1 | `openmorals eval` scores every case row per guard and per pack | No model, no network; a mismatched row fails the tests | Built (0.7.0) |
| 5.2 | Session rows: decisions that depend on earlier steps, compaction, sub-agents and a second conversation | All rows pass | Built (0.34.0) |
| 5.3 | Rescore on change: a saved score with a fingerprint; a change lists every row that moved | A change cannot pass on an old score | Built (0.34.0) |
| 5.4 | Benign twins scored in pairs, and the case files protected from agent edits | An agent edit to `cases/` asks | Planned |
| 5.5 | Evidence from data the project did not write (public attack corpora) | A figure published with its corpus and method | Planned |
| 5.6 | A live smoke run per host: scripted tasks, the audit shows the expected events and the risky step never ran | Passes on Claude Code first | Planned ([next.md §2](next.md#2-a-first-run-on-a-live-agent)) |
| 5.7 | Asks per active hour measured per session | Reported per session | Planned |
| 5.8 | Models and harnesses scored side by side: success with and without the guard, ask rate, tokens per finished task | A first scorecard on three models | Planned |

## 6. Integrations

| # | Requirement | Met when | Status |
|---|---|---|---|
| 6.1 | Claude Code adapter | Recorded event shapes pass; a live run | Built (0.1.0 onward); not run live |
| 6.2 | Codex CLI, Gemini CLI, opencode and OpenClaw adapters | Recorded shapes pass; a live run per host | Built (0.3.0, 0.6.0) from documentation; not run live |
| 6.3 | No host is called supported before a payload captured from the real product passes | Each host says "not run live" until then | In force; no host has passed yet |
| 6.4 | One event shape for every integration, with what each host can and cannot do; a missing ability moves toward stricter | A host that cannot ask turns ask into deny | Planned |
| 6.5 | More hosts that share Claude Code's hook format, one at a time, each after its own captured payload | Self-protect covers every new hook file | Planned |
| 6.6 | An MCP proxy using the same engine | Known MCP attack fixtures are blocked through it | Planned |
| 6.7 | A model-API guard that existing gateways can call: count tokens, refuse a proposed tool call, never rewrite earlier turns | Recorded fixtures pass for the main API shapes | Planned |
| 6.8 | Model independence stated plainly: decisions do not depend on the model; token counting, provider-hosted tools and the reviewer do | Public pages say "model-independent, host-dependent" | Built by design ([integrations.md](../integrations.md)) |
| 6.9 | Intercepting encrypted traffic with a local root certificate | | Rejected: it would see banking and mail, and breaks on pinned apps |
| 6.10 | A general multi-provider AI gateway | | Rejected: plug into existing gateways instead |
| 6.11 | Guarding agents that run entirely in a vendor's cloud | | Rejected: nothing on your machine sees their actions |

## 7. Tokens and cost

| # | Requirement | Met when | Status |
|---|---|---|---|
| 7.1 | A token budget where the host reports usage (Codex, OpenClaw) or where openmorals reads it (Claude Code's session log); a tool-call budget everywhere, counting sub-agents | `cases/budget.cases.yaml`, session rows | Built (0.1.0, 0.6.0, 0.34.0, 0.36.0) |
| 7.2 | A cost limit from a price table you write; no prices shipped | Usage tests | Built (0.6.0) |
| 7.3 | Cached and uncached input counted separately | Recorded usage totals correctly | Partly (0.36.0): on Claude Code, cache reads are kept apart from input, output and cache writes; not yet checked against the host's own figure |
| 7.4 | Real token counts on Claude Code, the host's own caps written at install, counters per agent, a spawn limit and a stop command for a whole tree of agents | [next.md §3](next.md#3-token-control) | Built (0.36.0) for one Claude Code session: token counts from its session log, per-sub-agent counts, a sub-agent run limit and a fan-out ask, and `openmorals stop`; not run live. Host caps written at install, and depth across processes: Planned |
| 7.5 | A budget shared across a tree of agents in separate processes | No overspend under concurrent use | Planned |
| 7.6 | Never edit the tool list, system prompt or earlier turns, so prompt caching keeps working | Cache hit ratio unchanged with the guard on | Built by design ([ADR 0014](../adr/0014-the-checker-can-only-refuse-ask-or-report.md)) |
| 7.7 | No token or cost saving is published until measured runs with and without the guard exist | A published figure names its runs and method | In force; no figure published |
| 7.8 | A hard stop at a context size, pruning tool results, timed context resets | | Rejected for hooks: a hook cannot shrink the context, and rewriting results would break ADR 0014 |

## 8. Many agents

| # | Requirement | Met when | Status |
|---|---|---|---|
| 8.1 | Taint, budgets and loops reach sub-agents of one session; text handed between agents is scanned | Session rows | Built on Claude Code (0.14.0, 0.32.1); other hosts give a child its own session |
| 8.2 | Guard state follows the tree of agents where a child gets its own session: taint passed down, merged up, never loosened | Taint lost between parent and child: none | Planned |
| 8.3 | Starting an agent is a judged act: the child gets no more tools than its parent, and bypass modes are refused | Escalations granted to a child: none | Planned |
| 8.4 | A child's report is scanned, and its claims of approval change nothing | | Partly: scan built (0.14.0) |
| 8.5 | Run, agent and parent ids in every audit record | `audit` shows the tree | Partly: run id (0.8.0) |
| 8.6 | Shared databases and queues used between agents treated as untrusted text | Reading one marks the session | Planned |
| 8.7 | Signed messages between agents | | Rejected: a signature does not constrain what a model does |

## 9. Distribution

| # | Requirement | Met when | Status |
|---|---|---|---|
| 9.1 | A single binary per OS, a Python package that checks its hash, and the npm package | Same answer as the Node CLI on every row | Built (0.4.0); not yet published |
| 9.2 | Publish to npm, then GitHub releases and PyPI | | Planned |
| 9.3 | Provenance, signatures and an SBOM on each release; signed binaries | | Planned |
