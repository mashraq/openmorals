# 0016. No proxy, hosted connector or managed gateway for now

- Status: Accepted
- Date: 2026-11-25 (decided by the maintainer; written 2026-11-26)

## Context

[ADR 0014](0014-the-checker-can-only-refuse-ask-or-report.md) statement 1 says openmorals holds no credential that can send, write, delete, merge or approve, and that nothing outside the optional reviewer makes a network request. [ADR 0001](0001-a-guard-layer-not-a-factory-platform-or-standard.md) keeps openmorals a guard layer.

Several ways to reach agents that have no hooks, or to count tokens on every host, would put openmorals in the traffic instead of beside it:

- a pass-through proxy in front of a model API;
- a hosted connector that holds a user's tokens for mail, tickets or other services, and guards what an agent does there;
- a managed gateway that carries agent and model traffic.

Each of these makes openmorals a traffic operator, and each needs it to hold credentials that ADR 0014 rules out.

## Decision

1. **None of these is built for now.** openmorals does not carry agent or model traffic and holds no credential for anyone's systems. ADR 0014 statement 1 stands unchanged.
2. **Any of them later needs its own record** that amends ADR 0014 statement 1 and says what credential it holds, where it is kept, who can revoke it, and what can and cannot be done with it.
3. **A guardrail check that an existing gateway calls** (the gateway sends a proposed call, openmorals answers) holds no credential and fits ADR 0001. It is not decided here and gets its own record when it is taken up.
4. **Local pieces that hold no credential and forward nothing**, such as an interceptor that judges MCP tool calls on the same machine, are not affected by this record.

## Alternatives and why they lost

- **Build a proxy now**, for token control and for hosts with no hooks. Rejected for now: it needs credentials ADR 0014 forbids, it sits in the path of every model call (an outage stops the user's work), and the current priority is proving what is built. Reading usage where the host reports it ([ADR 0015](0015-claude-code-token-counts-from-its-session-log.md)) covers the main token need without it.
- **A hosted connector holding a user's tokens.** Rejected for now: a stolen or misused token would act in the user's own accounts, which is the harm the guard exists to stop.

## Consequences

- openmorals keeps running only where the agent's host calls it, as the [README](../../README.md) says; agents with no check point are covered only at the merge, the sandbox or the MCP tools you control ([integrations.md](../integrations.md)).
- Planned items that need a proxy or a hosted connector stay Planned until a record of their own is accepted.
- A run wrapper (`openmorals run`, 0.44.0) and a standard-input check (`openmorals guard --json`, 0.43.1) fall under point 4: local, no credential, nothing forwarded.
- Since 0.41.1 `test/no-network.test.ts` scans the sources for new network calls, as ADR 0014 owed; a proxy or gateway would fail it unless its allow-list says why.
