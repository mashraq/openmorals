# Where openmorals is heading

Status labels: **Built (version)**, **Planned**, **Rejected**, as in [../README.md](../README.md). Everything on these pages that is not marked Built is Planned: it may change or be dropped, and nothing here is measured on a live agent yet.

## In one line

openmorals is the part of an agent that the agent can't argue with. The direction is to keep long, parallel, multi-model agent work **safe**, **affordable** and **verifiable**, whatever model or harness is underneath, without ever letting a model approve anything.

## Three promises

1. **Safe through the whole session.** The rules hold from the first call to the last, through context compactions, resets and every agent the agent spawns.
2. **Affordable by default.** The guard that sees every call also keeps the context lean and stops runaway agent trees and stalled loops, so users don't have to remember to.
3. **Verifiable without reading every line.** Work an agent hands back comes with facts a person can check: which tests it wrote, whether the tests it claims pass actually pass on a clean run, and whether the change may merge unread.

Each promise uses what openmorals already has: it sees every tool call and every result, it keeps its state on disk outside the model's context, and deterministic code makes every decision ([ADR 0004](../adr/0004-enforcement-outside-the-model.md)). It stays a guard layer ([ADR 0001](../adr/0001-a-guard-layer-not-a-factory-platform-or-standard.md)).

## Principles

- **Rules that must hold live in code.** A rule repeated in a system prompt lowers how often a guard fires; it never replaces the guard.
- **State outside the context.** Anything the guard needs to remember survives a summary, a reset or a hand-off to another agent.
- **Cheap first, and every step can only raise.** Deterministic checks always run; any model-backed check is optional and can only make an answer stricter ([ADR 0007](../adr/0007-reviewer-can-only-escalate.md), [ADR 0014](../adr/0014-the-checker-can-only-refuse-ask-or-report.md)).
- **Errors ask** ([ADR 0005](../adr/0005-fail-closed-ask-on-error.md)).
- **Measure before claiming.** No claim about a host before a live run, and no claim about savings before a measured set.

## The pages

| Page | What it covers |
|---|---|
| [requirements.md](requirements.md) | the problems, the scenarios each planned feature must pass, goals and non-goals |
| [features.md](features.md) | the planned features, grouped by promise, with what is already built |
| [architecture.md](architecture.md) | how the planned pieces attach to the one engine |
| [plan.md](plan.md) | the order of work |
| [handover.md](handover.md) | for contributors: where to start and what is open |

These pages describe direction. What exists today is in [../product/features.md](../product/features.md); what comes next release by release is in [ROADMAP.md](../../ROADMAP.md).
