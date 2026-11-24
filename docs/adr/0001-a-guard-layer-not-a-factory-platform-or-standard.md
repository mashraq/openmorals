# 0001. A guard layer, not an agent factory, an agent platform or a new standard

- Status: Accepted
- Date: 2026-11-23 (scope); 2026-11-24 (recorded)

## Context

The project started from a wider idea: an "agent factory", a generic framework to build agents, skills and plugins, with orchestration, evaluation and delivery around them. The maintainer asked why this is not a factory, not an agent standard and not an agent platform, and how users can still use what other projects in those spaces offer.

Facts that shaped the answer (from public sources read 23 Nov 2026):

- Coding agents with their own hooks already exist and are widely used: Claude Code, Codex CLI, Gemini CLI, opencode. Each has a pre-tool hook or plugin point that can stop a tool call.
- Open standards for agent instructions and extensions already exist: `AGENTS.md`, Agent Skills (`SKILL.md`) and MCP, all now under the Agentic AI Foundation. Claude Code still reads `CLAUDE.md` and Gemini CLI reads `GEMINI.md`.
- Each vendor governs its own agent. No neutral layer applies one policy across all of them.
- Orchestration, evaluation and hosted sandboxes are mature product categories with many options.

## Decision

openmorals is a **guard layer**: one local policy, one decision function and one audit log that sit in front of the agents people already use.

- It does not run a model loop, plan tasks, or host agents. Built (0.3.1): it has no agent of its own.
- It does not define a new format for agents, skills or plugins. It reads the existing ones unchanged: `openmorals scan` reads `SKILL.md` folders, Claude Code plugins, MCP configs and npm packages as they are; `openmorals guidance` writes a marked block into `AGENTS.md`, `CLAUDE.md` or `GEMINI.md` and leaves the rest of the file alone. Built (0.2.0).
- It has one file of its own, `openmorals.yaml`, because no existing standard describes allow/ask/deny policy for agent actions. Built (0.1.0).

How users keep using everything else:

- **Their agent:** an adapter per host translates that host's hook event into one action shape and the answer back into the host's format. Built (0.3.0) for Claude Code, Codex CLI, Gemini CLI and opencode.
- **Their skills, plugins and MCP servers:** unchanged; scanned before install if they choose. Built (0.2.0).
- **Their orchestrator, CI or evaluation tool:** can call openmorals as a plain decision service. Built (0.2.0): `openmorals check --json "<command>"` prints `{decision, rule, reason, bylaws}` and exits 0, 1 or 2; the library exports `decide()`. Planned: the same decision behind a documented JSON-over-stdin interface for any action kind, and as an MCP server, so a tool that speaks MCP can ask before acting.

## Alternatives and why they lost

- **An agent factory (a framework to build and run agents).** Rejected. It competes with every agent and orchestrator at once, it is a large build for a small team, and it would still need this guard layer underneath.
- **A new agent platform or runtime.** Rejected. Users would have to switch agents to get the protection. A guard that works with the agent they have is adopted in one command.
- **A new standard for agent policy.** Rejected for now. A standard needs adoption by the hosts before it enforces anything. If a cross-vendor policy standard appears, openmorals should read and test it rather than compete with it.

## Consequences

- Enforcement depends on each host's hook. Hooks differ, change between versions, and do not all cover every tool. The adapters must be checked against each host's current documentation, and the limits stated per host ([docs/adapters.md](../adapters.md)).
- A hook is one layer, not a sandbox. Guarantees for what the hook cannot see come from an OS sandbox ([enforcement-model.md](../architecture/enforcement-model.md)).
- The scope stays small enough to test every rule with case tables.
