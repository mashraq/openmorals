# Vision

Status labels: **Built (version)**, **Planned**, **Rejected**. Planned items may change or be dropped.

This page says where openmorals is going and why. It builds on the product's founding goals and principles in [../vision.md](../vision.md) and the four layers in [../layers.md](../layers.md). What exists today is in [product-analysis.md](product-analysis.md); the phases ahead are in [roadmap.md](roadmap.md).

## In one line

**openmorals is the part of an agent that the agent can't argue with.** It keeps agent work safe to run, bounded in spend and possible to verify, on whatever model, and on every host that gives it a place to stand, and it never lets a model approve anything.

## The goals, and what openmorals commits to

| Goal | Commitment | Not promised |
|---|---|---|
| Work with any model | Already true: the engine judges actions, never words | nothing to add |
| Work with any agent or harness | Every host with a check point before a tool runs, each verified on the live tool before it is listed; the merge check for any agent's change; the MCP tools and model address you control | agents that expose nothing, such as agents running in a vendor's cloud, are named as out of reach |
| Control tokens, even for trees and swarms of agents | Turn, spawn and tool-call limits across a whole tree; token budgets where the host or a gateway reports usage | no savings claim until measured; a hook stops the next call, so a tree can overshoot by a turn or two per live agent |
| Keep principles intact | Rules in code, state outside the context, both carried through every sub-agent, compaction and reset | what a program the agent writes does is the sandbox's job |
| Evaluate and review everything | openmorals scores itself on every change and publishes how; every agent change is checkable at the merge | it does not evaluate or grade agents ([ADR 0001](../../adr/0001-a-guard-layer-not-a-factory-platform-or-standard.md)) |

## Four promises

None is made as a claim before its measure exists.

1. **Nothing irreversible without you.** No agent, and no agent it starts, deletes work, force-pushes, deletes something online, drops data, sends a secret off the machine, or writes a lasting instruction after reading untrusted content, without you seeing the real action. If openmorals cannot judge, it asks. *Measure:* catch and false-ask rates on an outside corpus and on live hosts; no guard state lost through compaction, resets or sub-agents.
2. **Every agent change is checkable.** A change an agent hands back comes with facts: which tests it wrote, whether its "tests pass" holds on a clean run, which files to read first, and what needs a person. *Measure:* how often reviewers agree that a flagged line needed a look.
3. **Spend stays bounded.** Runaway trees, loops and stalls stop at limits you set, across every agent in the tree, with no model call for the check. *Measure:* runaways bounded on a recorded set; tokens per finished task reported, not promised.
4. **One policy everywhere it can see, and plain words where it can't.** The same file gives the same answer on every verified host, and a table says what each host honours and how it fails. *Measure:* identical decisions on the shared rows through every adapter.

## Principles

The founding principles stand: check outside the model, ask don't forbid, fail closed, never loosen the host, make undo easy, say what it cannot do, cheap by default, work with what exists. Five more guide what comes next:

- **Rules that must hold live in code.** A rule in a prompt lowers how often a guard fires; it never replaces the guard.
- **State outside the context.** Anything the guard must remember survives a summary, a reset or a hand-off.
- **Cheap first, and every later step can only raise.** Deterministic checks always; any model-backed check is optional and can only make an answer stricter.
- **Capabilities, not detection.** Keep untrusted input, private data and outward actions from meeting in one session unseen; detectors are signals, never boundaries.
- **Measure before claiming.** No host claim before a live run; no catch rate before an outside corpus; no savings claim before a measured set.

## What openmorals will not become

- A coding agent, an orchestrator, a memory product or an agent evaluation platform.
- A gateway, a hosted detector or a monitoring service; it works alongside them.
- Anything that approves on your behalf, rewrites what a tool returned, or lets a model lower a decision ([ADR 0009](../../adr/0009-never-grant-permission-the-host-would-not.md), [ADR 0014](../../adr/0014-the-checker-can-only-refuse-ask-or-report.md)).

Everything one person needs to be safe on their own machine stays in this Apache-2.0 repository. Features only an organisation needs live in a separate package ([ADR 0003](../../adr/0003-apache-2-core-and-a-separate-team-package.md)).

## How we will know it is working

A person can say: "My agent ran for hours with sub-agents, compacted twice, read a poisoned page, and still asked before sending; the change it opened came with a clean-run check of every test it claimed; and I knew which files I had to read." Each part of that sentence is a row in `openmorals eval` or a line in the audit log, and the numbers are published with their method.
