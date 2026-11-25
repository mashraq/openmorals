# Design principles and known limits

What openmorals deliberately does, what it deliberately does not do, and why. This complements the principles in [vision.md](vision.md) and the detailed limits in the [README](../../README.md#limits-stated-plainly). Written 25 Nov 2026 for 0.31.0.

## In one paragraph

openmorals is a seatbelt, not a wall. It is a small, deterministic check that answers before an agent's tool runs, aimed at the few actions that are hard to undo: deleting work, overwriting shared history, deleting cloud resources, dropping data, and sending a secret off the machine. It does not see the model, it does not manage the agent's context, and it cannot see inside the programs an agent runs. Pair it with your host's own sandbox and permission settings, not instead of them.

## Principles

1. **Model-independent, host-dependent.** openmorals never talks to the model; it reads the tool call the host is about to run. So it works the same whichever model the agent uses. What it depends on is the host: it can only guard an agent whose host offers a check point before a tool runs, and each host's check point behaves differently (some cannot ask, only block; some let a call run if the check fails to start). The list of hosts and what each can express is in [adapters.md](../adapters.md).
2. **Claim only what has been run.** A host counts as supported once openmorals has been run against the live tool, not only against its documentation. As of 0.31.0, the Codex, Gemini CLI, opencode and OpenClaw adapters are built from documentation and not yet run live. Catch rates are reported with the data they were measured on; rows written alongside the guards are not an independent measure.
3. **Deterministic in the default path.** No model calls, no network and no tokens on allowed actions. Classifiers and model reviewers can be fooled by the text they judge, and adaptive attacks have bypassed many published injection defences ([Nasr et al., 2025](https://arxiv.org/abs/2510.09023)). Where a model is used at all, it is opt-in and can only make an answer stricter.
4. **Separate capabilities rather than detect attacks.** Pattern scanning for hidden instructions is defence in depth, never a promise to block injection. The stronger idea is to stop untrusted input, private data and outward actions from meeting in one session without a person seeing it, which is what the taint judge does ([CaMeL](https://arxiv.org/abs/2503.18813) takes the same approach further).
5. **Show the real action, not the agent's description of it.** The reason you see when openmorals asks is built from the parsed command, so text the agent writes cannot dress up what will run ([lies-in-the-loop](https://checkmarx.com/zero-post/bypassing-ai-agent-defenses-with-lies-in-the-loop/)).
6. **Few asks, each worth reading.** A person asked too often approves everything. Every guard has a cost in interruptions, so the preferred answer is a safe alternative (move to trash instead of delete) or silence, and an ask only where the person's judgement is needed.
7. **Make the safe path the easy path.** Trash and restore instead of delete; a copy kept before a file is replaced whole.
8. **Use what already exists.** Where a host, an operating system or a well-known tool already does a job, openmorals points to it rather than rebuilding it.

## What openmorals deliberately does not do

| It does not | Why | What to use instead |
|---|---|---|
| Manage the agent's context (compaction, resets, pruning, which tools load) | A pre-tool check can block a call; it cannot change what the model sees. That belongs to the host. | Your host's own context settings |
| Save tokens | A guard adds a little text (guidance, reasons); it does not shrink the conversation. openmorals makes no token-saving claim. | Your host's own settings |
| Enforce token or spend budgets across many agents | Several hosts do not report token use to hooks, and agents spawned by agents may run where no hook fires. Budgets are best enforced where every request passes: the API gateway or key. | A gateway with per-key budgets, for example [LiteLLM virtual keys](https://docs.litellm.ai/docs/proxy/virtual_keys); openmorals counts tool calls and can ask past a limit you set |
| Isolate programs the agent runs | It reads command lines, not what a script or build step does. | Your host's sandbox, for example [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing), or a container |
| Guard agents with no check point | Chat assistants, browser agents and cloud agents that expose no pre-tool hook give openmorals nothing to attach to. | Review at the merge: `openmorals diff-class` and the test-integrity checks read any agent's diff, wherever it was written |
| Evaluate, train or improve agents | openmorals is a guard layer ([ADR 0001](../adr/0001-a-guard-layer-not-a-factory-platform-or-standard.md)); it evaluates only itself (`openmorals eval`). | An agent evaluation tool of your choice |
| Write or manage the agent's skills and memory | Every line a tool writes into an agent's memory is a place an injection can persist. | Your host's own features; `openmorals scan` checks a skill or plugin before you install it |

## Known limits that matter most

- **If the hook cannot start, some hosts run the tool anyway.** Claude Code treats a hook that fails to start as a non-blocking error unless the hook is configured to block on failure ([hooks reference](https://code.claude.com/docs/en/hooks)). After installing, run `openmorals check "rm -rf x"` from the same shell to confirm the command resolves.
- **Host semantics differ.** On some hosts an ask becomes a block; on some, an ask on a shell command is not enforced; subagent tool calls have not always reached hooks. Check your host in [adapters.md](../adapters.md).
- **The guard's own files belong to the same user as the agent.** A program the agent runs can change them. An OS sandbox that keeps the config directory read-only to the agent closes this.
- **Pattern matching has blind spots and false alarms.** Both are listed per guard in [guards.md](../architecture/guards.md); mistakes are made on the safe side.
- **One process per checked call.** About 0.09 s each on the machine it was measured on; post-tool checks add a second.

## How to read the rest of the docs with this in mind

Treat every "Built" status as "built and tested on events in the host's documented shape" unless the document says it was run against the live host. Treat every pack as advice and checks for common mistakes, not as a compliance control.
