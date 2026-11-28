# Proposed direction

**Status: proposed, not decided.** Nothing on this page is scheduled or promised. Every item not marked **Built (version)** is **Planned** in the sense of [../README.md](../README.md): it may change or be dropped, and nothing here has been measured on a live agent. What exists today is in [features.md](features.md); what is scheduled next is in [ROADMAP.md](../../ROADMAP.md). A requirement here moves into [requirements.md](requirements.md), with an id in its own series, only once it is accepted.

## In one line

openmorals is a check outside the model: for every tool call the host sends it, the answer comes from rules, not from the agent's reasoning. What it stops is mistakes; an agent set on getting round a rule is stopped only when an OS sandbox is on as well. The proposed direction is to keep long, parallel, multi-model agent work **safe**, **affordable** and **verifiable**, whatever model or host is underneath, without ever letting a model approve anything. It stays a guard layer ([ADR 0001](../adr/0001-a-guard-layer-not-a-factory-platform-or-standard.md)) and it still only refuses, asks or reports ([ADR 0014](../adr/0014-the-checker-can-only-refuse-ask-or-report.md)).

## Four promises, and what already exists for each

1. **Safe through the whole session.** The rules are checked on every call the host sends, from the first to the last, and the guard's state survives context compactions and resets because it is kept outside the model. Whether a host calls the hook inside a child agent is not yet confirmed by a live run on any host ([adapters.md](../adapters.md)). Today: guard state (budget counters, taint, loop history, held asks) is kept on disk outside the model's context (0.1.0 onwards), and what one agent hands to another is scanned (0.14.0).
2. **Affordable by default.** The guard that sees every call also stops runaway sessions and stalled loops. Today: tool-call and token budgets (0.1.0; tokens only where the host reports them), the loop detector (0.2.0), and daily guidance that loads a short block always and the rest on demand (0.29.0).
3. **Verifiable without reading every line.** Work an agent hands back comes with facts a person can check. Today: `diff-class` (0.12.0), test-lock (0.9.0), test-integrity reasons (0.13.0), `tests compare` (0.10.0), `tests fail-first` (0.17.0), `audit sample` (0.11.0) and work orders (0.27.0).
4. **Any model, five local hosts.** One engine and the same decision for the same action, wherever the host calls it. Today: hooks for five hosts (Claude Code 0.1.0; Codex CLI, Gemini CLI, opencode 0.3.0; OpenClaw 0.6.0; the last four not yet run against the live tools), an escalate-only reviewer over three protocols (0.3.0, more providers 0.6.0), and a Python package (0.4.0). The decision never depends on which model is behind the agent.

## Principles

- **Rules that must hold live in code.** A rule repeated in a prompt lowers how often a guard fires; it never replaces the guard ([ADR 0004](../adr/0004-enforcement-outside-the-model.md)).
- **State outside the context.** Anything the guard needs to remember survives a summary, a reset or a hand-off to another agent.
- **Cheap first, and every later step can only raise.** Deterministic checks always run; any model-backed check is optional and can only make an answer stricter ([ADR 0007](../adr/0007-reviewer-can-only-escalate.md)).
- **Errors ask** ([ADR 0005](../adr/0005-fail-closed-ask-on-error.md)).
- **Measure before claiming.** No claim about a host before a live run, and no claim about savings before a measured set.

## The problems

| Problem | What users see |
|---|---|
| The context degrades | Long sessions get confused, fixate on one subtask, or follow stale or injected instructions. |
| Spend runs away | Agents start agents, repeat near-identical calls or stall, and nobody owns the count. |
| Agent work goes unread | People accept large agent changes without reading them, with nothing checkable behind "all tests pass". |
| Rules in prompts don't hold | Instructions lower bad behaviour but never to zero, and compaction, resets and sub-agents can drop what the agent was told. |
| Guards stop at the hook | Agents built with Python frameworks, or reached only through MCP or the network, have no deterministic gate. |

## Scenarios

Each scenario is the test a proposed feature must pass.

1. **Compaction after an injected page.** A session reads a page carrying hidden instructions, compacts, and three turns later tries to send mail. It must ask, naming the page.
2. **The very long session.** Past a warning size, the agent and the person get one line; past a hard limit (opt-in), the next call asks for a compaction or a fresh start, with every guard mark carried across.
3. **The stuck agent.** The same test fails the same way five times while one file keeps changing. The agent gets a step-back note, then a note asking for a fresh start from a written hand-off, then a pause for the person.
4. **The runaway tree.** An agent starts agents that start more. Depth, fan-out and one shared budget stop the tree; no child has more power than its parent; a child of a session that read untrusted content inherits that mark.
5. **The unread pull request.** An agent opens a large change and says all tests pass. openmorals lists which tests the session wrote or changed, reruns the claimed tests on a clean checkout, reports any that fail, and says whether the diff may merge unread.
6. **A framework agent with an email tool.** A Python agent reads a document that says to forward the thread. The send asks.
7. **A changed model or agents file.** The baseline evaluation reruns and reports any guard whose results moved.
8. **Untrusted memory.** In a session that read untrusted content, the agent writes a standing instruction to memory. The line is marked untrusted and never becomes a rule.

## Goals and non-goals

| Goal | Measure |
|---|---|
| No guard state lost through compaction, resets, child agents or parallel hooks | evaluation rows for each; zero losses as a release gate |
| Lower spend without lost work | tokens per completed task on a recorded set, before and after; reported, not promised |
| Stalls caught early | minutes from the first repeated failure to a step back or fresh start |
| Unread merges stay safe | escapes found by `audit sample` among merges `diff-class` let through |
| Low friction | false asks on a benign everyday-work set and on replayed sessions; proposed budget 10% or less |
| The same answer everywhere | the shared case rows give identical decisions through every adapter |

Non-goals: not an agent framework, planner or memory product; no model ever approves, lowers a decision or resets a session; no reading of the conversation's text to count tokens (since 0.36.0 the usage numbers in Claude Code's session log are read, nothing else; ADR 0015); no claim to guard the inside of an agent that exposes no hooks, only the edges it exposes (MCP, network, sandbox); no prompts that change themselves at run time.

## Proposed requirements

Ids are DR-n so they don't collide with [requirements.md](requirements.md).

| Id | Requirement | Test |
|---|---|---|
| DR-1 | `init` writes a fail-closed hook setting wherever the host supports one (built for Claude Code in 0.36.0, which installs its tool and prompt hooks with `onFailure: "block"`; other hosts still open; see the [README](../../README.md)) | crash, timeout and malformed-output rows ask or deny on each adapter |
| DR-2 | Session state stays exact when several hooks of one session write at once | parallel writers; final counts exact; marks never cleared |
| DR-3 | `eval` supports rows across several calls, turns, compactions and child agents; test-lock can cover evaluation rows and baselines | scenarios 1 and 4 as rows |
| DR-4 | Guard state is kept before a host compaction and given back after, so the summary is never its only carrier | scenario 1 on a live host |
| DR-5 | The audit records which tests a session wrote or changed | a session that adds one test and edits another |
| DR-6 | A claim check reruns the tests an agent says pass, on a clean checkout | scenario 5 with one claimed test that fails |
| DR-7 | A recipe runs each supported host headless on a scripted task and checks the audit log | one recorded run per host |
| DR-8 | A context budget with a warning and an opt-in hard limit, using the host's token count where reported and a declared stand-in otherwise; every record says which | scenario 2 on a host that reports tokens and on one that doesn't |
| DR-9 | Large or flagged tool results replaced by a short reference that keeps the flag, where the host allows. **Conflicts with [ADR 0014](../adr/0014-the-checker-can-only-refuse-ask-or-report.md)** (no adapter rewrites a tool's output); would need a superseding ADR; settled 25 Nov 2026 as not built | a large page result becomes a reference; a later slice keeps the flag |
| DR-10 | A stall ladder: step-back note, a note asking for a fresh start from a hand-off note, pause | scenario 3 |
| DR-11 | One budget, depth and fan-out limits across an agent tree; children never gain power and inherit marks | scenario 4 |
| DR-12 | Adapters for Python agent frameworks call the same engine (proposed order: DSPy, Pydantic AI, the OpenAI Agents SDK) | the shared rows give identical decisions |
| DR-13 | A local MCP proxy pins, scans and namespaces tool descriptions and marks every result untrusted | a tool whose description changes after approval asks again |
| DR-14 | Approvals bound to the exact act and used once, on every host (today on Claude Code only, for held asks, 0.19.0) | approve an email, add an attachment, send: asks again |
| DR-15 | Memory written after untrusted input is marked untrusted and never holds a rule | scenario 8 |
| DR-16 | `eval` keeps a baseline and reruns when bylaws, packs, skills, the model or the host version change | scenario 7 |
| DR-17 | Any model-backed check uses a typed answer with no "allow" value; thresholds live in code; an outage keeps the deterministic decision | an outage row and a "safe" answer on an ask row leave the decision unchanged |
| DR-18 | A diff reviewer that never receives the agent's transcript, and can only add review | the reviewer's request holds no transcript |

## How the pieces would attach

The current design is in [../architecture/overview.md](../architecture/overview.md). None of the proposed pieces adds a second engine or changes who decides.

```
                 the person (the only one who can say yes)
                              ^
  ┌──────────── where calls are caught ──────────────────────────┐
  │ host hooks      framework adapters     MCP proxy    network  │
  │ (built)         (proposed)             (proposed)   (sandbox │
  │                                                     built)   │
  └───────────────────────────┬──────────────────────────────────┘
                              v
        ┌──────── one engine: decide(action, session) ───────┐
        │ guards · packs · rules · taint · loop and stall    │
        │ context checks (budget, tool cap)                  │
        │ optional model-backed checks (raise-only)          │
        └──────┬──────────────────────────────┬──────────────┘
               v                              v
     session state on disk            audit log (hash chain)
     (outside the context; safe       decisions, count source,
      under parallel writers;         tests the session wrote
      linked to the parent agent)
```

Context checks are ordinary guards: a budget, a stall step or a tool cap gives an ordinary answer (a note, an ask, a pause) through the same engine, so precedence, the audit and fail-closed behaviour apply unchanged.

## Order of work

1. **Make the core promise true everywhere:** DR-1, DR-2, DR-3, DR-4, DR-5 then DR-6, DR-7. Done when every row passes on every adapter that can express it and one host has a recorded live run.
2. **Context, spend and reach:** DR-8, DR-10, DR-11, DR-14, DR-15, DR-16, then DR-12 and DR-13. Done when tokens per completed task and stall minutes are reported on a recorded set, and three frameworks give the same decisions as the hooks.
3. **Later:** DR-17, only once evaluation rows show it raises the catch rate without raising false asks past the budget; DR-18; a cap on active tools; a network allowlist for agents with no hooks (see [ROADMAP.md](../../ROADMAP.md)).

Parked: to-do tracking outside the context, pruning of rejected attempts, agent-facing repository maps, a local search index over traces.

## Open questions

- **Counting tokens where a host doesn't report them.** Settled for Claude Code in 0.36.0: the usage numbers in its session log (ADR 0015). Still open for Gemini CLI and opencode.
- **Hard context limits.** Proposed as opt-in until the false-ask measure is in.
- **Compaction on hosts other than Claude Code.** Each host's before-and-after-compaction event has to be found and confirmed live.
- **Result references (DR-9).** Settled 25 Nov 2026: not built. ADR 0014 stands, so tool results are never replaced by references.

To contribute to any of this, start with [CONTRIBUTING.md](../../CONTRIBUTING.md), open an issue naming the DR id, and write the test in the table first.
