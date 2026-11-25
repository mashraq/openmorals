# Where the architecture is going

Written 25 Nov 2026. This is direction, not a promise: every item is **Planned** until a version builds it, and some need a new ADR first. What exists today is in [as-built.md](as-built.md).

## What stays the same

- One deterministic engine in one program (ADR 0002). Every new surface is a thin adapter that turns its event into the same actions and calls the same engine.
- Enforcement outside the model (ADR 0004); fail closed to ask (ADR 0005); ask by default (ADR 0006); never grant what the host would not (ADR 0009); the checker can only refuse, ask or report (ADR 0014).
- A guard layer that hosts and gateways call, not a platform that sits in all traffic or runs agents (ADR 0001).

## More agents, one engine

1. **Live runs** of the five built adapters, and fail-closed install on Claude Code.
2. **One common event shape** for every surface, with a per-host table of what the host can do (ask or not, whether hooks fire in sub-agents, whether it reports tokens), and a command that prints what is actually enforced on your machine.
3. **More hook hosts**, one at a time, each gated on a real captured event in the tests. Many coding agents already use the Claude Code hook format.
4. **MCP:** a check that existing MCP gateways can call on each tool call and result.
5. **Model API:** a guardrail check that existing model gateways can call, which can inspect, meter and refuse a proposed tool call but never rewrites a conversation.
6. **SDKs:** a helper for agents built on an agent SDK, starting with one.
7. **CI stays the backstop** for agents with no hooks and for anything a host lets through.

See [integrations.md](../integrations.md).

## Teams of agents

The goal is that rules, leak checks and attack defences stay in force when agents start other agents, hand work back, or have their context compacted.

- **A run tree.** State keyed by run, agent and parent, so a whole tree of agents shares one record, one budget and one audit trail, whichever host it runs on.
- **Authority only narrows.** A child gets no more tools or permissions than its parent.
- **Taint only spreads.** A child starts with its parent's taint; what a child read comes back with its result.
- **Rules survive the context.** A short, code-generated reminder of the guard's state after compaction and when a sub-agent starts.
- **The guard is not writable by the guarded.** The learn guard (in review) covers instructions, memory and skill files.

See [multi-agent-guards.md](multi-agent-guards.md) and [swarms-and-memory.md](../swarms-and-memory.md).

## Token control

- Token counts from every host that offers them, and from model gateways where one is in use.
- Limits per agent and per tree: spawn depth and count, a shared budget across a tree of agents, and a stop switch for a whole run.
- Host settings written at install where the host has its own caps, protected from the agent.
- Honest limit: a hook sees usage after a model turn, so a tree can overshoot by a turn or two per live agent.

See [cost-control.md](../cost-control.md).

## Teams of people

A separate team package (ADR 0003) builds on the public API only: shared bylaws that members cannot loosen, CI checks, and reports. Anything one person on one machine needs to be safe stays in this open package.
