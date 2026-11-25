# Plan

The order of the planned work, by what each step unlocks. Version numbers are left out on purpose: [ROADMAP.md](../../ROADMAP.md) carries them as work is scheduled.

## First: make the core promise true everywhere

- Fail-closed hook install, with crash, timeout and malformed-output rows (DR-1).
- Session state that survives parallel writers (DR-2).
- Evaluation rows across several calls, turns, compactions and child agents; test-lock covers evaluation rows (DR-3).
- Guard state through compaction and fresh starts (DR-4).
- Which tests a session wrote, then the claim check (DR-5, DR-6).
- A recipe for live runs on each host, starting with one (DR-7).

Done when every row passes on every adapter that can express it, and one host has a recorded live run.

## Then: context, spend and reach

- Context budget with a named count source (DR-8), result references (DR-9), the stall ladder (DR-10), one budget across agent trees (DR-11).
- Approvals bound to the exact act (DR-14), memory marks (DR-15), a baseline that reruns on change (DR-16).
- Adapters for DSPy, Pydantic AI and the OpenAI Agents SDK (DR-12); a local MCP proxy (DR-13).

Done when tokens per completed task and stall minutes are reported on a recorded set, and three frameworks give the same decisions as the hooks.

## Later: optional model-backed checks and more edges

- Typed, raise-only model checks on the unsure band (DR-17), only once the evaluation rows can show they raise the catch rate without raising false asks past the budget.
- The blind diff reviewer (DR-18).
- A cap on active tools and skills; tested context formats per pack; a network allowlist for agents with no hooks.

## Parked

To-do and plan tracking outside the context, pruning of rejected attempts in long sessions, agent-facing repository maps, a local search index over traces. Useful; revisited after the steps above.

## What this plan assumes, and how each is checked

| Assumption | Checked by |
|---|---|
| Hosts behave as documented for compaction, output rewriting and fail-closed hooks | the live-host recipe |
| Context checks save tokens on coding work | measured on a recorded set before any claim |
| Stall signals don't fire on honest slow work | the false-ask measure |
| Adapters can wrap every tool a framework runs | the shared case rows through each adapter |
