# Contributor roadmap

The work planned next, in the order it is meant to happen, with what each piece needs before it and how we will know it is done. It is for people who want to help build openmorals. [ROADMAP.md](../../ROADMAP.md) is the product-level list of what is planned; [product/direction.md](../product/direction.md) is the proposed direction behind it. The longer view, with vision and phases, is in [product/vision-roadmap/](../product/vision-roadmap/README.md). This page turns those into an order of work. Everything here is **Planned**: not built, and it may change or be dropped.

New here? Read [handover.md](handover.md) first: where the code lives, how to build and test it, and the conventions every change follows.

## Where things stand

- Built and on `main`: the guard, review, score and learn layers (0.32.0 to 0.35.0). The learn layer checks what an agent writes into `CLAUDE.md`, `AGENTS.md`, memory notes and skills.
- **Nothing has been run against a live agent yet.** Every adapter was built from host documentation and recorded event shapes, and every figure in the changelog comes from case rows in this repository. That is why the first real step below is a live run.
- Nothing is published to npm or PyPI yet.

## What every change needs

The same bar for every item below (details in [CONTRIBUTING.md](../../CONTRIBUTING.md) and [handover.md](handover.md#conventions)):

1. Failing rows first: case rows in `cases/`, and session rows when the behaviour spans several calls. At least one row that fails without the change and one harmless row that stays allowed.
2. Every existing row decides the same as before, or the change says which rows moved and why.
3. Fail closed. A project file can only tighten what the user-level file sets.
4. A changelog entry with what was added, what is unchanged, what was measured and what is not claimed.
5. No host is called supported for a feature until a payload captured from that host passes.

## 1. Now: groundwork

**Make the test suite green everywhere.** A few tests depend on the platform or the Node version (see [handover.md](handover.md#tests-that-depend-on-the-machine)). Done when each one passes on Linux, macOS and Windows on Node 22 and 24, or is skipped with a stated condition, so a red test on `main` always means a real failure. A good first contribution.

**A repeatable live run on Claude Code.** A script that installs openmorals from a clean machine into a throwaway project and runs headless sessions that try each risky act the guards cover, plus one sub-agent, one MCP tool, one compaction and a second conversation. It records the host version, which hook events fired with what payload, and what the host did with each decision. Questions it must answer:
- Does the pre-tool hook fire for MCP tools, for starting a sub-agent (with its prompt), for a sub-agent handing back, and for agents messaging each other?
- Do sub-agent calls carry an agent id? Are deny and ask honoured for each?
- What happens when the hook is missing, slow or crashes, with and without the host's fail-closed option?
- Does extra context reach the model, and does a message meant for the person reach only the person?
- After a delete is refused, does the agent use `openmorals trash`?
- Where does the host write its own memory, and can a sub-agent write there?

Done when: the script and a dated results summary are in `docs/live-runs/`, each answer marked as observed or not observed, and the captured payloads are saved as test fixtures. Every claim in the docs about Claude Code then cites the run, or is removed.

**Fail-closed install and `openmorals doctor`.** `init` writes the host's fail-closed hook option where the host version supports it; a `doctor` command proves the hook fires and lists hosts that fail open; the first session says "guard active" or warns clearly. Done when a deliberately broken PATH gives a block or a loud warning, never silence.

**Host sandbox settings from your rules.** `init` writes Claude Code's and Codex's own sandbox settings from the bylaws, so a script the hook cannot see still meets the host's sandbox. Done when the written settings are shown and a rerun changes nothing.

**Hardening the Claude Code adapter for look-alike hosts.** Several other agents already run hooks from `.claude/settings.json`. Detect which host sent an event, never read a foreign payload as a known one, strip a byte-order mark, read cache fields in usage, protect every new hook file path from the agent, and deny a nested agent CLI launched with permission-skipping flags. Done when there are rows for each host shape.

**An ask counter.** `openmorals audit --asks` counts asks per guard per hour; above a user-level threshold, one line to the person (never to the agent) names the guard and one narrower setting, and never loosens anything itself. Done when a log with one ask over the threshold prints exactly one line, and hook output is unchanged below it. This counter is how every later default gets set from data rather than guesses.

## 2. Next: tokens across agent trees

In this order. Design notes are in [cost-control.md](../cost-control.md#planned-controls).

1. **Host caps at install:** sub-agent model, headless budget flags, and an `init --lean` report of what loads on every request. Reports only; changes nothing without a yes.
2. **Counters per agent and per task**, not only per session, without a lock on the hot path. Done when two sub-agents each under their limit but over the task's limit are caught, and 64 overlapping hook calls lose no count.
3. **Spawn limits:** depth, children per parent, total and live children. A refused spawn tells the agent to finish the work itself or report, never to retry; a repeated refused spawn becomes a hard deny. A person can declare a planned fan-out ("make nine versions") so it is not refused.
4. **Stop the whole tree:** `openmorals stop <task>`; every agent is refused on its next step; finished work is kept.
5. **A task id set by a launcher**, so sessions started under one task share one budget.
6. **Real token counts on Claude Code.** This reverses today's rule that openmorals never reads a transcript file, so it needs a new ADR first.
7. **Measure the saving** on a fixed task set, with and without the controls, reporting net tokens per finished task. No saving figure is published before two runs agree.

## 3. Then: memory, shared stores and outward actions

**Memory-file follow-ups** to the learn layer: an audit record for every write into an instructions, memory or skill file, naming what tainted the session; the host's own memory folder, once the live run finds it; rows where one conversation writes a note and the next one loads it.

**Shared stores.** Today `psql`, `mysql`, `redis-cli` and similar clients pointed at a remote server do not count as reaching the network, so a tainted session can write into a shared database that a clean session later reads. Planned: count a remote host as network, and a `channels:` setting so reading a declared shared store taints a session and a tainted write to one asks. Rows first; built once someone runs agents that share a store.

**Outward actions.** A per-session count of the people an agent writes to, so many single-recipient mails ask once; payment rules for credits, coupons and payment MCP tools; a rule that asks before deploy commands, and a release hold that covers deploys while a work order's check is failing; marking MCP tools as read-only or destructive in the bylaws, with unknown ones asking.

## 4. Then: guards across many agents

Plans are in [multi-agent-guards.md](../architecture/multi-agent-guards.md#where-this-is-going). Ask rates are measured with the ask counter before tree-wide taint is switched on.

1. A short, code-generated note of the guard state (pending approvals first) put back after a compaction and at a sub-agent's start.
2. Spawning a sub-agent judged as a step: no child with more tools or a looser mode than its parent; private data handed to a child that can reach the network asks.
3. One record per task, so a parent's taint reaches its children and a child that could act on the outside world passes taint back.
4. A sub-agent's handback scanned like any other untrusted text.
5. "Once per site" approvals kept per agent.
6. Audit records that carry task, agent and parent ids.
7. More tamper protection: MCP config and managed settings; tests compared at the base commit in `diff-class`.

## 5. Then: evidence from outside this repository

1. Paired harmless rows for every guard, and the case files and saved scores protected from agent edits by the `test-lock` pack.
2. Session rows that run through every adapter, not only Claude Code.
3. Live smoke runs on Claude Code, then Codex, then opencode: scripted tasks, pass when the audit shows the expected events and the risky step never ran.
4. An outside corpus and public benchmarks (agent prompt-injection and unsafe-code suites, each with a benign set), with the method published, for a first catch rate and false-ask rate the guards were not written against.
5. Host version added to the rescoring fingerprint, and a CI recipe for `eval --since`.

## 6. Then: more hosts and integration points

Plans are in [integrations.md](../integrations.md#design-direction-planned).

1. Live runs on Codex, Gemini CLI, opencode, OpenClaw and Antigravity CLI, including whether each host's hook fires inside a child agent.
2. One event shape for every integration, with a table of what each host can express; an ask becomes a held ask where a person can be reached, and a refusal only when nobody can.
3. More hosts that share Claude Code's hook format, each after a real payload passes, each printing what is enforced there.
4. An MCP interceptor that an existing MCP gateway calls, with tool definitions pinned.
5. A guardrail webhook for existing AI gateways, backed by a long-running local engine; veto only, never editing a call.
6. A Claude Agent SDK adapter; other frameworks on request.

## 7. Release

Publishing waits for the live run on Claude Code. When it happens: npm first, with Claude Code marked verified only where the live run shows it and every other adapter marked "not verified live"; then the binaries and PyPI. CI runs at least one Linux job per release.

## Open questions

- **Token counts on hosts that do not report them:** read usage from the transcript (needs a new ADR) or use a stand-in such as the transcript's size, read without opening it.
- **Remote database clients:** should they count as network by default?
- **Tree-wide taint:** if passing taint back up from children raises asks too much, ship without it?
- **`git push` as a deploy:** opt-in per branch (proposed), or by default where CI deploys on push?
- **Over-blocking target:** asks per 100 harmless calls, or share of harmless tasks with any ask?

## How to pick something up

Open an issue naming the item from this page, write the failing rows first and link them, and say which host you can test on. Small items in section 1 are the best place to start.
