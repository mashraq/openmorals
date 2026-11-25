# Design principles and known limits

What openmorals does, what it does not do, and why. This adds to the principles in [vision.md](vision.md) (check outside the model, ask don't forbid, fail closed, never loosen the host, make undo easy, cheap by default, work with what exists) and does not repeat them. The full list of limits is in the [README](../../README.md#limits-stated-plainly) and the [threat model](../architecture/threat-model.md). Written 25 Nov 2026 for 0.31.0.

## In one paragraph

openmorals is a seatbelt, not a wall. It is a small, deterministic check that answers before an agent's tool runs. Its core guards aim at actions that are hard to undo, such as deleting work, overwriting shared history, deleting cloud resources, dropping data and sending a secret off the machine. It does not see the model, it does not manage the agent's context, and it cannot see inside the programs an agent runs. Use it alongside your host's own sandbox and permission settings, not instead of them.

## Principles

1. **Model-independent, host-dependent.** openmorals never talks to the model; it reads the tool call the host is about to run. So it works the same whichever model the agent uses. What it depends on is the host: it can only guard an agent whose host offers a check point before a tool runs, and each host's check point behaves differently (some cannot ask, only block; some let a call run if the check fails). The hosts and what each can express are in [adapters.md](../adapters.md).
2. **Say what has been run.** An adapter built from a host's documentation is marked as not run against the live tool until it has been. As of 0.31.0 that is true of the Codex, Gemini CLI, opencode and OpenClaw adapters. The shipped `eval` score shows the guards still match their own case tables; it is not a catch rate on attacks nobody wrote down ([eval.md](../eval.md)).
3. **No detector is a promise.** Classifiers and model reviewers can be fooled by the text they judge, and adaptive attacks have bypassed many published prompt-injection defences ([Nasr et al., 2025](https://arxiv.org/abs/2510.09023)). That is why the default path has no model in it, and why the optional reviewer can only make an answer stricter ([ADR 0007](../adr/0007-reviewer-can-only-escalate.md)).
4. **Separate capabilities rather than detect attacks.** Pattern scanning for hidden instructions is defence in depth, never a promise to block injection. The stronger idea is to stop untrusted input, private data and outward actions from meeting in one session without a person seeing it, which is what the taint judge does ([CaMeL](https://arxiv.org/abs/2503.18813) takes the same approach further).
5. **Show the real action, not the agent's description of it.** The reason you see when openmorals asks is built from the parsed command, so text the agent writes cannot dress up what will run ([lies-in-the-loop](https://checkmarx.com/zero-post/bypassing-ai-agent-defenses-with-lies-in-the-loop/)).
6. **Few asks, each worth reading.** A person asked too often approves everything. Every guard has a cost in interruptions, so the preferred answer is a safe alternative (move to trash instead of delete) or silence, and an ask only where the person's judgement is needed.

## What openmorals does not do

Some of these are outside what a pre-tool check can do; others are simply not built. Where something is planned, [features.md](features.md) and the [ROADMAP](../../ROADMAP.md) say so.

| It does not | Why | What to use instead |
|---|---|---|
| Manage the agent's context (compaction, resets, pruning, which tools load) | A pre-tool check can block a call; it cannot change what the model sees. That belongs to the host. | Your host's own context settings |
| Save tokens | A guard adds a little text (guidance, reasons); it does not shrink the conversation. openmorals makes no token-saving claim. | Your host's own settings |
| Enforce token or spend budgets across many agents | Several hosts do not report token use to hooks ([adapters.md](../adapters.md#token-usage-per-host-060)), and agents spawned by agents may run where no hook fires. A budget for many agents is best enforced where every request passes: the model API gateway or key. | A gateway with per-key budgets, for example [LiteLLM virtual keys](https://docs.litellm.ai/docs/proxy/virtual_keys). Within one session openmorals counts tool calls (and tokens where the host reports them) and acts past a limit you set |
| Isolate the programs the agent runs | It reads command lines, not what a script or build step does. `openmorals sandbox run` sandboxes one command ([sandbox.md](../sandbox.md)); it does not wrap the whole agent. | Your host's sandbox, for example [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing), or a container |
| Guard agents with no check point | Chat assistants, browser agents and cloud agents that expose no pre-tool hook give openmorals nothing to attach to. | Review at the merge: `openmorals diff-class` and the test-integrity checks read any agent's diff, wherever it was written ([merge-verdict.md](../merge-verdict.md)) |
| Evaluate, train or improve agents | openmorals is a guard layer ([ADR 0001](../adr/0001-a-guard-layer-not-a-factory-platform-or-standard.md)); it evaluates only itself (`openmorals eval`). | An agent evaluation tool of your choice |
| Write or manage the agent's skills and memory | Every line a tool writes into an agent's memory is a place an injection can persist. | Your host's own features; `openmorals scan` checks a skill or plugin before you install it |

## Known limits that matter most

- **If the hook cannot start, fails or times out, some hosts run the tool anyway.** In Claude Code an exit code other than 0 or 2, or a timeout, is a non-blocking error unless the hook entry sets `onFailure: "block"` ([hooks reference](https://code.claude.com/docs/en/hooks)); `openmorals init` adds that setting on the tool and prompt hooks since 0.36.0 (not yet tried on a live host; older Claude Code versions ignore it). openmorals catches its own errors and answers ask, but it cannot answer if it never starts. After installing, run `openmorals check "rm -rf x"` from the same shell to confirm the command resolves. A hook that times out also lets the call run in Codex and Gemini CLI.
- **Host semantics differ.** On Codex and opencode's V1 plugin API an ask becomes a block; on opencode V2 an ask seen only in the whole command, not in one sub-command, is not raised; a public opencode issue reports that V1 does not see subagents' tool calls. Check your host in [adapters.md](../adapters.md).
- **The guard's own files belong to the same user as the agent.** Self-protect asks before the agent's tool calls change them, but a program the agent runs can still change them. An OS sandbox that keeps the config directory read-only to the agent closes this ([threat model](../architecture/threat-model.md)).
- **Pattern matching has blind spots and false alarms.** Both are listed per guard in [guards.md](../architecture/guards.md); mistakes are made on the safe side.
- **One process per checked call.** About 0.09 s each on the machine it was measured on ([enforcement-model.md](../architecture/enforcement-model.md)); post-tool checks add a second.

## How to read the rest of the docs with this in mind

Treat a "Built" host adapter as "built and tested on events in the host's documented shape" unless the document says it was run against the live host. Treat every pack as advice and checks for common mistakes, not as a compliance control.
