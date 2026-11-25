# Swarms and memory

Status labels: **Built (version)**, **Planned**, **Rejected**. This page describes 0.33.0. Planned items may change or be dropped.

Two recent results change what a guard for agents has to cover. Anthropic has described a team of about 1,000 agents working together for many hours with only two shared tools, Git and a database, each agent in its own sandbox. And agents now keep memory: notes written during one session and loaded into the next, sometimes rewritten offline by a consolidation pass ("dreaming"). See [The components of agent memory](https://www.anthropic.com/research/components-of-agent-memory) (Anthropic, 6 Nov 2026). This page says what each means for openmorals.

## Many agents: guard the edges

When every agent runs in its own sandbox, the risk moves to the few places they share:

- **The shared store.** A table or folder that one agent writes and hundreds read is how one bad line reaches everyone. That text is another agent's message and should be treated as untrusted.
- **The landing gate.** What makes a large team safe to leave alone is a check nobody can argue with deciding what lands. openmorals' merge-side checks are built for this: `diff-class` (0.12.0), `test-lock` (0.9.0), `tests compare` (0.10.0), `tests fail-first` (0.17.0) and work orders (0.27.0). The check itself has to be protected too, so an agent cannot change what "passing" means.
- **Each agent's own actions.** The hook judges every tool call inside each sandbox, as it does for one agent.

What already holds: `git fetch`, `pull` and `clone` count as reading from the network and mark the session; hook calls running at the same time no longer erase each other's marks (0.32.1); every audit record can carry a run id (`audit --run`).

**Planned:**

- A recipe for running many agents under openmorals: the host sandbox for each agent, the hook set to fail closed, unattended mode, one run id set by the launcher, and the landing gate in CI.
- A setting that names the tools, commands or folders agents use to talk to each other, so what is read from them is treated as another agent's message and what is written to them from a marked session asks.
- Budgets for a run started by a launcher rather than by an agent's spawn tool, with limits the person sets for that run. For many agents on API keys, a model gateway's per-key budgets remain the right tool; openmorals passes the run id along.

**Rejected:** coordinating agents, or a shared store of openmorals' own. Agents build their own coordination from simple tools; a guard's job is the edges ([ADR 0001](adr/0001-a-guard-layer-not-a-factory-platform-or-standard.md)).

## Memory: guard what gets promoted

A file the host loads at the start of every session (`CLAUDE.md`, `AGENTS.md`, a memory index such as `MEMORY.md`, a skill) is a standing instruction. If a session that read untrusted content can write one line there, the next session starts with no mark and loads it. Honest mistakes travel the same way: a wrong note can send an agent down the same dead end in every session.

Today openmorals marks a session that read untrusted content and asks before it sends or touches private data, but it does not judge file writes by that mark, and a new session starts clean ([multi-agent-guards.md](architecture/multi-agent-guards.md#known-limits)). `diff-class` already refuses to call a change to agent instruction files review-free.

**Planned:**

- **A write into a file loaded at every session start asks when the session has read untrusted content**, and names the source. In unattended runs it is refused.
- **The added text is scanned** with the same rules `openmorals scan` uses (hidden instructions, invisible characters, exfiltration and download-and-execute patterns), whether or not the session is marked. This widens the planned "scan a skill whenever it is written" to memory.
- **Each such write is recorded** in the audit log with its source, so you can list every line that reached memory from a marked session.
- **A size warning** for memory index files, alongside the planned one for agents files.
- **A diff for consolidation passes:** record the memory folder before a consolidation run and list what it added afterwards, scanner findings first, for a person to keep or revert.

openmorals' own state (marks, budgets, approvals) is never rewritten by a model; it changes only by code or by you.

**Rejected:** writing, curating or forgetting memory on the agent's behalf. That is the agent's job; openmorals checks what crosses into every session.

## Scoring it

- **Rows across sessions.** Beside rows across steps, turns, compactions and child agents ([layers.md](product/layers.md#score)): a list of sessions sharing a memory folder, where a line written after reading an injected page must ask, and a clean note must not.
- **Cost on a memory benchmark.** [Continual Learning Bench](https://arxiv.org/abs/2606.05661) runs fresh sessions that share memory. Running it with and without openmorals would show whether the memory guard costs task accuracy and how often it asks on harmless notes. openmorals scores only itself, not the agent's memory.

None of this is built yet. [ROADMAP.md](../ROADMAP.md) lists what is next.
