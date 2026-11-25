# Architecture outline for the planned work

The current architecture is in [../architecture/overview.md](../architecture/overview.md) and [../architecture/enforcement-model.md](../architecture/enforcement-model.md). This page shows only how the planned pieces attach. None of them adds a second engine or changes who decides: deterministic code decides, a model can only raise, errors ask.

```
                 the person (the only one who can say yes)
                        ^         approvals bound to the exact act
                        |
  ┌──────────── where calls are caught ──────────────────────────┐
  │ host hooks      framework adapters     MCP proxy    network  │
  │ (built)         (planned)              (planned)    edge     │
  └───────────────────────────┬──────────────────────────────────┘
                              v
        ┌──────── one engine: decide(action, session) ───────┐
        │ guards · packs · rules · taint · loop and stall    │
        │ context checks (budget, references, tool cap)      │
        │ optional model-backed checks (raise-only)          │
        └──────┬──────────────────────────────┬──────────────┘
               v                              v
     session state on disk            audit log (hash chain)
     (outside the context; safe       decisions, token source,
      under parallel writers;         tests the session wrote
      linked to the parent agent)               │
               │                                v
               └──> compaction, reset,   eval · baseline · live-host runs
                    child spawn          diff-class · claim check · blind reviewer
```

## The session's life

| Moment | What openmorals does |
|---|---|
| Start | load the short guard-state block; pick packs from deterministic triggers (tool name, file type, domain, MCP server) |
| Each tool call | decide; check the budget, the active-tool cap and any approval bound to the act |
| Each result | scan, mark untrusted, record the outcome for the loop and stall checks; replace a large or flagged result with a reference where the host allows |
| Compaction | keep guard state before the host summarizes; give it back after, so the summary is never the only carrier |
| Fresh start | write a hand-off note (goal, done, failed, unproven guesses, guard state); the new session starts from the note and the state on disk |
| Child agent | the child gets no more than the parent; it inherits the parent's marks; one budget for the tree; what comes back is scanned (built) |

## State

- Counters move to a form that several hooks of one session can update at once without losing a write (an append-only record summed on read, or a lock).
- Marks such as "read untrusted content" can only be set, never cleared by a later write; state that can't be read counts as marked (today's rule).
- A child records its parent, so limits apply across the tree.

## Context checks are ordinary guards

A context budget, a stall step or a cap on active tools gives an ordinary answer (a note, an ask, a pause) through the same engine, so precedence, the audit and fail-closed behaviour apply unchanged. Every budget record names where its count came from: the host's own report, or a stand-in that reads no transcript content.

## Optional model-backed checks

```
deterministic answer ──> unsure? ──no──> done
                            │yes
                            v
              small typed check (answers: no change, raise to ask, raise to deny)
                            │ unsure
                            v
              escalate-only reviewer (opt-in)
                            │
                            v
                        the person
```

The answer type has no "allow"; thresholds live in code and are set from labelled rows for each pinned model version; an outage or a malformed answer keeps the deterministic decision.

## Where calls are caught

| Edge | Catches | Status |
|---|---|---|
| Host hooks | every tool call and result the host routes through hooks | Built for five hosts, from documentation |
| Framework adapters | every tool call inside a Python agent framework, including tools the framework's own checks skip | Planned |
| MCP proxy | tool listings, calls and results for any MCP client | Planned |
| Network edge and sandbox | network and files, for any process | one-command sandbox Built (0.3.0); network allowlist Planned |

Each edge calls the same `decide`.

## Verifying finished work

```
session ──> audit: which tests were written or changed, by which call
diff ──> diff-class ──> may merge unread ──> merge; sampled by audit sample
              │ needs review
              v
     test-integrity reasons · tests compare · tests fail-first
     claim check: rerun claimed tests on a clean checkout
     blind reviewer: diff, work order and results, never the transcript
              │
              v
          the person
```
