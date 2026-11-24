# 0004. Enforcement runs outside the model, as deterministic code at action time

- Status: Accepted
- Date: 2026-11-23 (built in 0.1.0); 2026-11-24 (recorded with the comparison)

## Context

There are two common ways to make an agent behave: tell it the rules (in the system prompt or a file like `AGENTS.md`), or check what it tries to do before it happens. The maintainer asked whether openmorals runs prompts and outputs through a separate guarded agent, or loads all the guards into the agent's context and hopes for the best, and whether the second wastes tokens.

Public incident reports (an agent running `rm -rf` on a home folder; another deleting a production database during an explicit code freeze) show that a model can be told not to and still do it.

## Decision

- The decision about each tool call is made by **openmorals, a separate process, with deterministic code**, called by the host's pre-tool hook. Built (0.1.0 for Claude Code; 0.3.0 for Codex CLI, Gemini CLI and opencode).
- The model's context carries **no rules by default**. `openmorals guidance` can add a short advisory block to `AGENTS.md`, `CLAUDE.md` or `GEMINI.md`. It is opt-in and never relied on. Built (0.2.0).
- A second model is used only as an optional reviewer of actions already marked ask, and can only escalate ([ADR 0007](0007-reviewer-can-only-escalate.md)). Built (0.3.0).

The full comparison of approaches, with costs, is in [enforcement-model.md](../architecture/enforcement-model.md).

## Alternatives and why they lost

- **Rules in the context as the main defence.** Rejected. It costs tokens on every model call of the session, and it is the one layer the model can ignore, forget after compaction, or be argued out of by injected text.
- **A guard model on every prompt and every reply.** Rejected as a default. It adds a second model call per item, needs a key and network, and text can fool it just as it fools the agent. Kept as an optional, escalate-only reviewer.
- **Only an OS sandbox.** Not enough alone: a sandbox that lets the agent edit the project also lets it delete the project. Kept as a second layer (`sandbox run`, built 0.3.0 for one command).

## Consequences

- No model tokens are spent when openmorals allows a call: it prints nothing. On ask or deny, one reason line reaches the agent (for `rm -rf build`, 182 characters; measured 24 Nov 2026).
- Each call costs a process start: about 0.09 s on one Apple-silicon laptop (measured 24 Nov 2026).
- The check sees only the tool call. Code it does not see (a script, an alias, a program that builds a command at run time) is out of its view; that is what the sandbox is for.
- If the host cannot start the hook, the host decides what happens; Claude Code then runs the tool. This is stated in the README and the threat model.
