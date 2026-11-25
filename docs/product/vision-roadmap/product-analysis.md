# Product analysis

Status labels: **Built (version)**, **Planned**, **Rejected**. Figures are marked as measured (with where) or as an estimate. Read on 25 Nov 2026; the figures will drift.

This page looks at openmorals as a product: the problem, who it is for, how it differs from other ways to guard an agent, and which of its claims are proven, which are built but not yet proven, and which it does not make. The vision is in [vision.md](vision.md) and the phases ahead are in [roadmap.md](roadmap.md).

## In short

1. **openmorals is a small, local, deterministic check that answers before a coding agent runs something hard to undo, plus checks that make an agent's change verifiable before it merges.** Both are built and tested against their own case tables. Neither has yet been run against a live agent, and nothing is published yet.
2. **Proof comes before breadth.** The next work is a live run on a real host, an outside test corpus, a measured ask rate and a first release, before more guards, packs or hosts.
3. **Model-independent, host-dependent.** openmorals judges actions, not words, so the model behind the agent does not matter to the decision. What matters is whether the agent's host offers a check point before a tool runs. The merge check works for any agent's change, wherever it was written.
4. **Bounded spend, not a savings claim.** openmorals can stop runaway loops, spawns and tool calls at zero tokens per check. It makes no claim to cut token use until that is measured.

## Where it stands (measured, 25 Nov 2026)

| | |
|---|---|
| Version | 0.35.0 |
| Guards | destructive commands, online deletes, deletes to trash, documents, whole-file replaces, secrets, self-protect, budget, packages, outbound (look-alike sites, codes, recipients), and in 0.35.0 writes to instructions, memory and skill files; the taint judge; the loop detector; inbound scanning |
| Merge checks | `diff-class` with a review map, `test-lock`, `tests compare`, `tests fail-first`, `tests provenance`, `tests claim`, `tests coverage`, secrets and lockfile rules in a diff |
| Hosts | Claude Code (0.1.0), Codex CLI, Gemini CLI, opencode (0.3.0), OpenClaw (0.6.0), built from each host's documentation and recorded event shapes |
| Self-evaluation | `openmorals eval`: 1,377 case rows, 157 merge-check rows and 55 session steps; every row matches, on rows written alongside the guards ([eval.md](../../eval.md)) |
| Run against a live host | not yet |
| Published | not yet (npm, PyPI and binaries are built, not released) |

## The problem

Coding agents run with broad permissions and real access: they delete folders, force-push, call cloud APIs, read credential files and run for hours. Most of that is the job. A few acts cannot be undone, and published reports show agents doing them by mistake. Hosts ship their own permission systems and classifiers, which catch most of these and document their own gaps. A person asked to approve every step soon approves everything.

Around that core sit four problems people raise about agents, each only partly a guard's to solve:

| Problem | How much a guard can own |
|---|---|
| Agent changes get merged unread | **A lot.** The merge is outside the agent, and the checks are deterministic. |
| Rules in prompts don't hold through compaction, resets and sub-agents | **A lot, for tool calls that reach a hook.** openmorals keeps its state on disk, outside the model's context. A program the agent writes and runs is the sandbox's job. |
| Spend runs away in trees of agents | **Some.** A hook can stop the next call or spawn; it cannot stop a model request already in flight. Tool calls can be counted on every host; tokens only where the host or a gateway reports them. |
| The context degrades in long sessions | **Little.** Hosts own compaction and which tools load. A guard can keep its own marks through it and catch loops and stalls. |

## Who it is for

| User | What they want | Where they meet openmorals |
|---|---|---|
| A developer running a coding agent with broad permissions on their own machine | "Let it run, but stop it before it does something I can't undo, and let me undo the rest" | the hook, `trash` and `restore`, `scan` before installing a skill |
| Someone merging agent-written changes, including from cloud agents no local hook reaches | "Tell me which changes I must read, and give me facts about the rest" | `diff-class` and the test checks, locally or in CI |
| Someone building agents on a framework | "The same rules in the agent I'm writing" | the engine called from code or the Python package (later, on request) |
| Someone using an everyday agent for mail, documents and forms | "Don't let it send, delete or pay without me" | only where the agent's host has a check point; agents running in a vendor's cloud expose none |

## How it differs

The full fact sheet is [comparison.md](../../comparison.md). In short, openmorals works alongside host controls, gateways and sandboxes rather than replacing them:

- **Host controls** come with your agent; use them. openmorals runs inside them, can only make a decision stricter, and adds one policy across hosts, decisions on what a command means rather than its tool name, taint across steps, a restorable trash, test integrity and one audit format.
- **Gateways** are the best place for token and dollar budgets across many agents; they never see what a tool does on your machine. openmorals is meant to read their usage and to be callable from them.
- **Classifiers** are useful signals and are beaten by adaptive attacks; openmorals keeps them out of the default path and limits what an agent can do instead.
- **Sandboxes** limit where damage lands; the project folder stays writable inside them, which is where deletes, secret reads and test edits happen.

What openmorals offers that is hard to find together: deterministic decisions with no model call on the default path, a contract that a model can only make an answer stricter and an error asks, a project file that can only tighten the user's floor, depth on coding-agent harm (trash and restore, online deletes, test integrity, merge checks, memory and skill writes), and an evaluation anyone can rerun on their own rows.

## Proven, built, and not claimed

| Claim | Status today | What would prove it |
|---|---|---|
| Stops the hard-to-undo acts (delete, force-push, online delete, dropping data, secret off the machine) | **Built**; every row matches, on rows written alongside the guards | an outside corpus of real commands and transcripts, and a live run |
| Fails closed | **Not yet on every host.** If the hook cannot start, Claude Code goes ahead unless the hook entry asks it to block ([design-principles-and-limits.md](../design-principles-and-limits.md)) | `init` writing each host's fail-closed setting; a fail-safe row per host; a liveness check |
| Works with any model | **True by design**: the decision never depends on the model | nothing more |
| Works with any agent | **Host-dependent**: five hosts built, none run live yet; agents with no check point can be covered only at the merge, the MCP tools you control, the model URL or the sandbox ([integrations.md](../../integrations.md)) | a captured real payload per host and a per-host table of what it honours |
| Rules survive compaction, resets and sub-agents | **Built for one process**: parallel sub-agent calls keep every mark (0.32.1, measured); session rows replay compaction events (0.34.0) | a real host's compaction and sub-agents on a live run |
| A lasting instruction can't be planted after reading untrusted content | **Built in 0.35.0** | a live check of where the host writes its memory |
| An agent's change can be checked without reading every line | **Mostly built** (0.12.0 to 0.33.0) | reviewer agreement measured on real agent pull requests; the aim is "know what to read", not "merge unread" |
| Controls spend for trees of agents | **Partly**: tool-call budgets on every host, tokens on Codex and OpenClaw; no budget across a tree yet | a tree budget keyed by the host's own ids, gateway usage read in, a measured run |
| Saves tokens | **Not claimed** | a before-and-after run on a recorded task set ([cost-control.md](../../cost-control.md)) |
| Asks rarely | **Not yet measured** | asks per active hour on real sessions |

## The main trade-offs, and how they are settled

| Trade-off | Settled as | Why |
|---|---|---|
| More features, or proof of the ones built | proof first | a guard nobody has seen run live is a claim, not a protection |
| Ask, or forbid | ask by default, but prefer a safe alternative (trash) or silence, and measure the ask rate | a person asked too often approves everything |
| Count tokens in the guard, or use a gateway | the guard bounds calls, spawns and turns at zero tokens; tokens come from the host or a gateway | a hook cannot see or stop a model request on most hosts |
| Reach every agent with new layers, or verify hosts one at a time | verify one host at a time; the merge check covers the rest | each host's hook semantics differ and most fail open |
| Models in the decision | only optional, typed and raise-only, and only once evaluations show they help | adaptive attacks beat detectors; zero tokens per check is part of the product |
| Learn and score as platforms | only as checks on writes to memory and skills, and as openmorals scoring itself | a memory or evaluation product is outside a guard layer ([ADR 0001](../../adr/0001-a-guard-layer-not-a-factory-platform-or-standard.md)) |

## Risks

- **Hosts absorb the guard.** Answer: sit where hosts are weak (one policy across hosts, meaning over tool names, test integrity, the merge boundary), and write each host's own settings rather than compete with them.
- **It fails open silently.** Answer: fail-closed install and a liveness check, before publishing.
- **It nags.** Answer: measure asks per hour and prefer safe alternatives to asks.
- **Claims outrun proof.** Answer: no host or catch-rate claim before a live run and an outside corpus; every limit stated next to the feature.
- **Programs the agent runs are out of a hook's view.** Answer: pair with the host's sandbox.
