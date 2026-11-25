# Vision

Status labels: **Built (version)**, **Planned**, **Rejected**.

## The problem

Coding agents now run real commands on real machines. They delete folders, force-push, drop tables, call cloud APIs, read credential files and run for hours. Most of the time that is the job. Sometimes it is a mistake: a variable that was empty, a folder named `~`, a cleanup that went one level too high, a page that told the model to post a key somewhere. Public reports describe agents deleting a user's home folder, and a production database during an explicit code freeze.

Each agent vendor ships its own permission settings for its own agent. People who use more than one agent, or who want the same rules on every machine, have no single place to say "ask me before this".

## What openmorals is

A small, local guard that sits in front of the coding agents people already use and makes them ask before they do something that is hard to undo, leaks something private or wastes time and money.

- One plain YAML file of rules (`openmorals.yaml`).
- One decision function that judges each tool call as allow, ask or deny, and names the rule and the reason.
- One audit log of every decision.
- The same rules in Claude Code, Codex CLI, Gemini CLI and opencode (Built 0.3.0) and OpenClaw (Built 0.6.0).

## What the maintainer asked for, in plain words

These are the product's founding requests, kept with their nuance:

- **Do not delete folders, and do not delete information online, without checking.** The default is to stop and ask the user, not to forbid. Check whether the action really makes sense or is a mistake; otherwise ask the user again.
- **Protect private information very carefully.** Secrets should not be read casually and should not leave the machine.
- **Do not use too many tokens or too many resources.** Stop loops, stop polling, respect budgets.
- **Always look for security holes and patch them.** Every guard ships with its own test cases, and every known way past a guard is written down.
- **Work everywhere.** Windows matters as much as macOS and Linux.

## Principles

1. **Check actions outside the model.** A model can ignore advice; it cannot argue with a separate process that answers before the tool runs. ([ADR 0004](../adr/0004-enforcement-outside-the-model.md))
2. **Ask, don't forbid.** Most risky actions are sometimes right. The user decides. ([ADR 0006](../adr/0006-ask-by-default-not-forbid.md))
3. **Fail closed.** If openmorals cannot judge, it asks. ([ADR 0005](../adr/0005-fail-closed-ask-on-error.md))
4. **Never loosen the host.** openmorals only adds friction; it never grants a permission the agent's host would not. ([ADR 0009](../adr/0009-never-grant-permission-the-host-would-not.md))
5. **Make undo easy.** Offer trash instead of delete, so the safe path is also the easy one. Built (0.2.0).
6. **Say what it cannot do.** Every limit is stated next to the feature, and nothing unbuilt is described as built.
7. **Cheap by default.** No model calls, no network, no tokens on allowed actions. A model reviewer is optional and can only make answers stricter. ([ADR 0007](../adr/0007-reviewer-can-only-escalate.md))
8. **Work with what exists.** Read `AGENTS.md`, Agent Skills, MCP configs and each host's hooks as they are; do not invent a new agent format. ([ADR 0001](../adr/0001-a-guard-layer-not-a-factory-platform-or-standard.md))

## What it is not

- Not a coding agent, not an agent platform, not an orchestrator. It scores its own guards (`openmorals eval`, Built 0.7.0) but does not grade an agent's answers.
- Not a full sandbox. A hook sees tool calls, not what the programs they start do. `openmorals sandbox run` adds an OS sandbox for one command (Built 0.3.0); wrapping a whole agent is Planned.
- Not a replacement for the host's own permission settings. It adds to them.

## Learn, guard, review, score

An agent harness can be seen as four layers around the model loop: what the agent is told before it acts (learn), deterministic checks it cannot argue with (guard), a second look before work is accepted (review), and measuring the harness itself after every change (score). openmorals is the guard layer, and it reaches into the other three only where a check can run outside the model and can only add caution. What it does at each layer today, and what is planned, is in [layers.md](layers.md).

## Where it is going

Planned, in rough order (details in [ROADMAP.md](../../ROADMAP.md), [prd.md](prd.md) and [layers.md](layers.md)):

1. Run every adapter against the live tool, and keep a scripted run per host that catches a host update changing its hook events.
2. Publish: npm, the first release of the single-file binaries and the Python package (all built in 0.4.0, none published yet).
3. Score the guards across several steps, turns, compactions and child agents, not only single calls, and rescore on every change to the bylaws, packs, skills, reviewer model or host version.
4. Close the remaining guard gaps: hooks that fail closed where the host allows, approvals tied to the exact action, who wrote each test, and a check of the agent's own "tests pass" claim.
5. Wrap the whole agent in the OS sandbox.
6. Token budgets for Claude Code, MCP tool classification.

Everyday agents are started: the document, delete and outbound guards, the outward-actions, privacy and health-data packs, work orders with office before-after checks and daily guidance for documents, forms, email and links (Built 0.18.0 to 0.31.0) apply the same policy core to work outside code.
