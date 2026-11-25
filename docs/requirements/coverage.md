# Features and coverage

25 Nov 2026, checked against release 0.35.0; the hook and token rows against 0.36.0. What each layer offers, how strong the evidence is, and which hosts and model APIs openmorals reaches. Facts about other products come from their own public documentation; see [integrations.md](../integrations.md) and [adapters.md](../adapters.md) for sources and dates.

## How to read the evidence column

- **Own cases**: the project's case tables, written by the same people who wrote the guard. They show the guard does what it was built to do, not how it fares on real work.
- **Session rows**: multi-step scenarios in `cases/`, including compaction and sub-agents, replayed through the engine (0.34.0).
- **Not run live**: no live agent has run with it yet. True of every host today.

## Features by layer

| Layer | Feature | Status | Evidence |
|---|---|---|---|
| Guard | Destructive local and online acts, secrets, Rule of Two, loops | Built | Own cases; session rows |
| Guard | Trash instead of delete | Built | Own cases |
| Guard | Document, replace and outbound guards | Built | Own cases; not run live; ask rate on real work not measured |
| Guard | Deferred asks | Built on Claude Code | Own cases; not run live |
| Guard | Inbound scan | Built | Own table; not measured on outside data |
| Guard | Content rules and detectors | Built | Own cases |
| Guard | Install guard for unlisted packages | Built (0.32.0) | 22 of 22 caught, 0 of 23 false alarms on own rows |
| Guard | Policy packs | Built | Synthetic rows only |
| Guard | OS sandbox for one command | Built | Tests; Linux plan not run |
| Guard | MCP tool marking, fail-closed install, nested agent launches | Planned | |
| Learn | Guidance block, pre-install scan, daily guidance | Built | Tests |
| Learn | Memory-file guard | Built (0.35.0) | Own cases: 32 of 32 caught, 0 of 17 false alarms; all shipped session rows 20 of 20 steps caught, 0 of 35 false alarms; not run live |
| Review | Merge verdict and integrity reasons | Built | Replay on own history; own rows |
| Review | Test checks, provenance and the claim check | Built | Fixture repositories only |
| Review | Review map, split suggestion, notes | Built (0.33.0) | Own rows |
| Review | Escalate-only reviewer model | Built | Never called against a real API |
| Score | `eval`, session rows, rescore on change | Built | Runs in the test suite |
| Score | Live smoke runs, outside corpora, ask-rate meter, model and harness scorecard | Planned | |
| Tokens | Tool-call budget, token budget on three hosts, cost limit | Built | Own cases |
| Tokens | Claude Code token counts, per-sub-agent counts, sub-agent run limit and fan-out ask, `stop` | Built (0.36.0) | Own tests and session rows; not run live |
| Tokens | Host caps written at install, a budget across processes, depth limits | Planned | [next.md §3](next.md#3-token-control) |
| Many agents | State shared across sub-agents of one session | Built on Claude Code | Session rows; not run live |
| Many agents | State across a tree of separate sessions; judged spawns | Planned | |

## Coding agents with a built adapter

| Host | Blocks before a call | Native ask | Tokens reach the hook | Run live |
|---|---|---|---|---|
| Claude Code | yes | yes | read from its session log (0.36.0) | no |
| Codex CLI | yes | no: ask is sent as deny | yes | no |
| Gemini CLI | yes | yes | no (tool-call budget) | no |
| opencode | yes | V2 API yes; V1 no | no (tool-call budget) | no |
| OpenClaw | yes | yes | yes | no |

On some hosts a hook that fails to start, errors or times out lets the call run. On Claude Code that is so unless the hook entry sets `onFailure: "block"`, which `init` writes since 0.36.0 (requirement 1.3); not yet tried on a live host.

Many other coding agents document a hook format modelled on Claude Code's. Each one is Planned, and is added only after a payload captured from that product passes.

## Other kinds of agent

| Kind | How openmorals could reach it | Status |
|---|---|---|
| Agents you build with a framework or SDK | An in-process adapter | Planned |
| Any agent whose API address you can set | A model-API guard behind an existing gateway | Planned |
| Any agent using MCP | An MCP proxy | Planned |
| Agents with no hook at all | Git hooks and CI (the [merge verdict](../merge-verdict.md)), the [OS sandbox](../sandbox.md) | Built for those pieces |
| Agents that run in a vendor's cloud | None from your machine | Rejected |

## Model APIs

Decisions do not depend on the model. What does depend on it: how usage is reported, tools that run on the provider's servers, encrypted reasoning that must be sent back unchanged, and prompt caching ([integrations.md](../integrations.md#the-model-does-matter-in-a-few-places)).

| API shape | Optional reviewer model can call it | Called against the real API |
|---|---|---|
| Anthropic Messages | Built (0.3.0) | not yet |
| OpenAI Chat Completions (and compatible local runners such as Ollama) | Built (0.6.0) | not yet |
| Gemini generateContent | Built (0.6.0) | not yet |

Tokens are counted from what the host's hook reports (Codex and OpenClaw today), not from the API itself. Counting at the API for every agent would need the model-API guard (requirement 6.7).
