# Guards across many agents

Status labels: **Built (version)**, **Planned**, **Rejected**. This page describes 0.31.0.

Agents now start other agents: a coding agent hands a search to a sub-agent, an orchestrator runs a team, a script launches another agent CLI, a tool server runs its own model loop, and long sessions get compacted or cleared. This page says what openmorals does to keep its rules in force when work moves between agents, where that stops today, and what you can do about the gaps.

## The short version

- **Rules that must hold live in code, not in the model's context.** Published studies keep finding that telling a model "don't" lowers how often it misbehaves but does not stop it, and that safety checked one agent at a time does not add up to a safe system of agents. So openmorals decides allow, ask and deny in its own process, and treats any rule text the model sees as a reminder only.
- **Authority only narrows.** A sub-agent should never be able to do something its parent could not. Nothing another agent says (including "the user approved this") counts as approval.
- **Taint only spreads.** Once an agent has read untrusted content (a web page, an issue, a tool result, another agent's message), its outward and irreversible steps should need you, and so should the steps of anyone it hands that content to.
- **Guard state lives on disk, outside every context window**, so a compaction does not drop it.

## What works today

| What | How | Status |
|---|---|---|
| Sub-agent tool calls on Claude Code | Claude Code runs settings hooks inside sub-agents, so every sub-agent tool call goes through the same openmorals check as the parent's | Host behaviour, documented by Claude Code; not run live with openmorals |
| Text handed from one agent to another | The prompt given to a sub-agent, a sub-agent's report and messages to other agents are scanned with the inbound rules on Claude Code, Codex, Gemini CLI, opencode and OpenClaw. A finding marks the session, so later network or private-data steps ask | Built (0.14.0); the call itself is not stopped |
| Shared state for a parent and its sub-agents | On Claude Code a sub-agent's calls arrive under the parent's session, so taint, budget and loop history are shared; Codex documents the parent's session id for sub-agent hooks but does not say that every pre-tool hook fires inside a sub-agent | Built (0.1.0); inferred from the hosts' documentation, not run live. See Known limits for sub-agents running at the same time |
| Compaction | Session state (taint, budget, loop history, audit chain head) is a file outside the context, keyed by session, so compaction within a session does not clear it; held asks have their own store ([deferred-asks.md](../deferred-asks.md)) | Built (0.1.0); not tested on a live compaction |
| Unreadable state | An unreadable or corrupt session file reads as tainted, not as a clean start | Built (0.6.2) |
| Your rules can't be loosened by a project | Your user-level file is a floor; a project file can only tighten it; an invalid file falls back to the floor | Built (0.6.0) |
| Self-protection | Agent writes to openmorals' own config, the host's hook settings, the state and audit folders ask | Built (0.1.0, hardened 0.6.2) |
| Models can only add caution | The optional reviewer and injection judge can raise a decision, never lower one | Built (0.3.0, 0.6.0) |
| Unattended runs | Every ask becomes a deny | Built (0.2.0) |
| Audit | Each record carries the host's agent id where the host sends one, in a per-session hash chain | Built (0.8.0) |

## Known limits

Read these before relying on openmorals with many agents:

- **If the hook cannot start, most hosts go ahead.** Claude Code, Codex and Gemini CLI let a tool call through when a hook crashes or times out (on Claude Code also when it exits with any code other than 2), unless you set the host's fail-closed option (item 2 below). openmorals fails closed inside its own process ([ADR 0005](../adr/0005-fail-closed-ask-on-error.md)), but it cannot answer if it never runs. Per host: [comparison.md](../comparison.md).
- **Child sessions on opencode and OpenClaw start without the parent's mark.** So do agent-team members and any other session of yours ([threat model](threat-model.md)). Keep untrusted reading in a narrow sub-agent (item 8 below) and use the sandbox.
- **Sub-agents running at the same time share one session record.** Since 0.32.1 their saves no longer erase each other's taint marks, history or counts. Two records written at the same moment can still get the same audit sequence number, which [audit.md](../audit.md) shows as a `fork` in the chain.
- **A new session starts clean.** Clearing the conversation or starting a new session starts with no taint and a fresh per-session budget. A session started under a run budget (`OPENMORALS_RUN`, 0.37.0) still counts against the run's budget, and counts as one more session of it ([runs.md](../runs.md)); taint does not carry over.
- **The rules text is dropped by compaction.** The optional `guidance` block in the context is advisory; the hook does not depend on it, but the model may forget it.
- **Agents launched from a shell command are new agents.** If an agent runs another agent CLI through a shell command, openmorals sees one command, not the new agent's steps, unless openmorals is also installed for that CLI.
- **A sub-agent inherits a loosened parent mode on Claude Code.** Per Claude Code's documentation, a parent in `bypassPermissions`, `acceptEdits` or auto mode forces that mode on its sub-agents. openmorals' own deny and ask still apply, but the host's own prompts are skipped.
- **Tool descriptions from MCP servers are checked only at install time** by `openmorals scan`, not when they change later.
- **Agent-to-agent protocols such as A2A are not handled.**
- **Messages a host delivers through files are not seen by a hook**, such as teammate mailboxes in Claude Code's experimental agent teams ([adapters.md](../adapters.md)). The sandbox is the answer there.

## What you can do now

1. **Turn on your host's sandbox.** Claude Code and Codex can run commands in an operating-system sandbox with limited file and network access. It contains things no hook sees, such as a script or install step that launches another agent, and it is the right answer to a program the agent writes and runs.
2. **Make the hook fail closed where your host allows it.** Claude Code's documentation describes `"onFailure": "block"` on command hooks (2.1.295 and later; see [comparison.md](../comparison.md)); without it, a timeout, a crash or exit code 1 lets the call through. `openmorals init` adds it to the openmorals tool and prompt hook entries since 0.36.0, so a crash or timeout blocks the call instead of letting it through. In the first live run on Claude Code a hook that exited 1 or hung past its timeout blocked the call ([live run](../live-runs/2026-11-26-claude-code.md)).
3. **Lock the hook config at machine or org level.** Claude Code's managed settings can allow only managed hooks (`allowManagedHooksOnly`); Codex has `allow_managed_hooks_only`. Installed that way, a project cannot remove or override the guard.
4. **Don't run the parent in a bypass mode.** Sub-agents inherit it.
5. **Never launch agent CLIs with permission-skipping flags from scripts, CI or install hooks.** Real supply-chain attacks have used exactly that to turn local agents into tools for stealing secrets.
6. **Install openmorals for every agent CLI you use**, not just the main one, so an agent started from another agent is still checked.
7. **Use unattended mode for runs nobody watches**, so a question you can't answer becomes a stop.
8. **Keep research and reading in a sub-agent with fewer tools.** A sub-agent that only reads, with no network-out or write tools, and returns a short summary keeps untrusted text away from the agent that can act.
9. **Give a task of many agents one run budget.** `eval "$(openmorals budget start --tokens N --sessions N)"` in the launcher, then start every worker from it: they share one budget across processes and restarts, and `openmorals stop --run` stops them all (0.37.0, Claude Code; [runs.md](../runs.md)).
10. **Check the audit log** after a multi-agent run: `openmorals audit verify` shows edits, cuts and resets in the chain, and each record names the agent where the host sends an id.

## Where this is going

Planned, in no fixed order, and each starting with a failing test. Most of these are proposed requirements in [direction.md](../product/direction.md) (DR-1, DR-2, DR-4, DR-11, DR-13), with how each will be tested in [evaluation-plan.md](../evaluation-plan.md); budgets across a tree of agents are in [cost-control.md](../cost-control.md).

- Judging the spawn of a sub-agent as a step in its own right: limits on depth and number of agents, no child with more tools or a looser mode than its parent, and a check on private data handed to a child that can reach the network.
- One shared record per run, so a parent's taint reaches its children on every host, a child that could act on the outside world passes its taint back when it reports, and restarting a session inside the same run does not wipe it.
- Writing your host's own sandbox and fail-closed settings from your openmorals rules at install.
- Putting a short, code-generated reminder of the guard state (pending approvals first) back into the context after a compaction and at the start of a sub-agent.
- Remembered "once per site" approvals ([outbound.md](../outbound.md)) kept per agent rather than per session.
- Denying permission-skipping flags when an agent CLI is launched directly from a shell command; launches inside scripts are left to the sandbox.
- Pinning MCP tool descriptions so a changed description is blocked until you approve it again.

These are plans, not promises; this page will mark each one Built with its version when it ships.
