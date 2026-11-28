# Run budget: one budget for a whole task of agents

**Built (0.37.0), Claude Code.** One budget for every agent you start for one task: the main session, its sub-agents, sessions started in other processes, and every restart or re-dispatch of a worker. One stop for all of them.

## In one minute

```sh
eval "$(openmorals budget start --tokens 2000000 --tool-calls 300:1000 --sessions 12)"
claude -p "..." &          # every agent started from this shell carries OPENMORALS_RUN
claude -p "..." &
openmorals budget status   # what the run has used, against its limits
openmorals stop --run "$OPENMORALS_RUN"   # stop every agent of the run
```

- `budget start` sets the run's limits once and prints `export OPENMORALS_RUN=<id>`. Starting the same id again is refused, so a run cannot be given a fresh budget by starting it over.
- Every Claude Code session whose environment has `OPENMORALS_RUN` counts against the run: tool calls, tokens (from Claude Code's session log, as in 0.36.0), and runs of sub-agents.
- A **hard** limit refuses every later tool call of every session of the run. A **soft** limit (`SOFT:HARD`) asks once for the whole run, in whichever session crosses it; the other sessions do not ask again.
- `--sessions N` counts sessions: a restarted, resumed or re-dispatched worker is a new session. Past the limit a new session is refused when it joins and is not counted; the sessions already in the run go on.
- The first time a session sees the run at 90% of a hard limit, the agent gets one line beside an allowed call: finish the current step and report. Nothing at 50% or 75%, because each line added to the conversation breaks the prompt cache.
- `openmorals stop --run <id>` refuses every later call of every session of the run, in every process, and ends the agent's turn. `openmorals stop --clear --run <id>` lifts it.
- Only you set a run's budget, stop it or clear the stop: an agent that runs `budget start`, `stop` or `stop --clear` is asked about first.
- For one agent, `openmorals run --tokens N --tool-calls SOFT:HARD -- claude` (0.44.0) starts the run, checks the hook and starts the agent with the id, then prints the run card ([run-command.md](run-command.md)).

## Why a run, not a session

Public docs and source of agent frameworks, software factories and published failure studies show the same gap again and again: limits are counted per process, per invocation or per session, while the work runs as a tree of agents across processes and restarts.

| What we found | Where |
|---|---|
| LangGraph's `recursion_limit` is counted from the point a run resumes, so each resume starts a fresh count | [graph API](https://docs.langchain.com/oss/python/langgraph/graph-api), [`pregel/_loop.py`](https://github.com/langchain-ai/langgraph/blob/main/libs/langgraph/langgraph/pregel/_loop.py) |
| OpenAI Agents SDK: handoffs share a run's `max_turns` and a resume keeps the count, but an agent used as a tool starts a nested run with its own `max_turns` (10 by default), so limits multiply with nesting; usage is added up across them | [running agents](https://openai.github.io/openai-agents-python/running_agents/), [usage](https://openai.github.io/openai-agents-python/usage/) |
| Claude Agent SDK: `max_budget_usd` covers sub-agents and refuses new spawns at the cap, per `query()` call | [agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop), [sub-agents](https://code.claude.com/docs/en/agent-sdk/subagents) |
| Google ADK: `max_llm_calls` (500) is per invocation; our reading of the source is that an agent used as a tool runs in a new runner with its own count; resumed tool calls run at least once | [run config](https://adk.dev/runtime/runconfig/), [`apps/_configs.py`](https://github.com/google/adk-python/blob/main/src/google/adk/apps/_configs.py) |
| Retry policies re-run a failed step: Temporal retries activities without a limit by default; LangGraph retries most exceptions three times | [Temporal retry policies](https://docs.temporal.io/encyclopedia/retry-policies), [`pregel/_retry.py`](https://github.com/langchain-ai/langgraph/blob/main/libs/langgraph/langgraph/pregel/_retry.py) |
| Stopping a parent does not always stop its children: Temporal's abandoned child workflows keep running; cancellation across remote LangGraph agents has to be built by hand | [parent close policy](https://docs.temporal.io/parent-close-policy), [LangChain forum](https://forum.langchain.com/t/how-to-propagate-cancellation-across-multi-level-langgraph-agents/3265) |
| Coding hosts: one request started 48 or more agents; a permission refusal led to more spawning, 50 or more levels deep | [claude-code#68110](https://github.com/anthropics/claude-code/issues/68110), [claude-code#68619](https://github.com/anthropics/claude-code/issues/68619) |
| Loops that restart the agent each iteration, and factories that hand work to fresh sessions, reset any per-session count; the studies of failed multi-agent runs put step repetition and not knowing when to stop among the most common failures | [MAST](https://arxiv.org/html/2503.13657v3) |

So the run budget is keyed to the task you start, not to a process: every agent under the id draws on one budget, and a restart is one more session of the same run, not a new budget.

## Setting it up

| Flag of `budget start` | Counts | Note |
|---|---|---|
| `--tool-calls N` or `SOFT:HARD` | tool calls, summed over the run's sessions | |
| `--tokens N` or `SOFT:HARD` | tokens from Claude Code's session log, main conversation and sub-agents, cache reads left out | as `guards.budget.tokens` per session |
| `--spawns N` or `SOFT:HARD` | runs of sub-agents, summed over sessions | sub-agents one agent starts together are one run |
| `--sessions N` or `SOFT:HARD` | sessions that joined the run | each restart, resume or re-dispatch is one more |
| `--id ID` | the run id (letters, digits, `.`, `-`, `_`; not starting or ending with `.`) | default `run-<time>-<random>` |

A single number is a hard limit. `SOFT:HARD` asks once at SOFT and refuses at HARD: for tool calls, tokens and spawns the call that reaches HARD is refused; for sessions, up to HARD sessions run and the next one is refused. Give at least one limit.

Start every agent of the task with the variable in its environment: run `eval "$(openmorals budget start ...)"` in the shell or script that launches them, or pass `OPENMORALS_RUN=<id>` in the launcher's environment for each worker. A run with no limits file (an id set but never started) is counted, and `budget status` shows it, but it has no limits.

The per-session budget in your bylaws still applies to each session as before: the run budget adds a limit for the whole run, it never loosens a session's own.

`openmorals budget status [ID] [--json]` lists each run with what it has used against its limits, and whether it is stopped. `openmorals audit --run <id>` shows the run's audit records and, since 0.40.0, the same counts beside them as a run card: what the run used, the files and test files it wrote, its `git commit`s, and a "no check recorded" line when it wrote files with no check in its records ([audit.md](audit.md#the-run-card-0400)). A run with no limits file and no session counts says "no counts for this run" there, never zero.

## Where the state lives

`<config>/runs/<id>/run.json` holds the limits, written once. Each session writes its own counts to `<config>/runs/<id>/nodes/<session>.json`, keeping the highest count it has seen, and the hook adds them up on every call. The stop is a key in the existing stop file. Nothing is sent anywhere.

It fails closed: a limits file or a session file that cannot be read makes the call ask (and, unattended, refuse), never counts as unlimited.

## Known limits

- **Claude Code only** in 0.37.0. On the other hosts `OPENMORALS_RUN` still tags audit records, but nothing counts against a run budget.
- **One machine.** The run lives in the config folder of the machine it runs on. Agents of one run on several machines each count against that machine's copy.
- **Overshoot.** A hook acts at the next tool call. A model reply already being written is not stopped, so a run can pass a limit by the turns in flight on each agent, and by more for background sub-agents still running.
- **Siblings in flight.** Each session's counts are added up when it calls a tool, with no reservation ahead of time, so several agents near a hard limit at the same moment can pass it together by their last calls.
- **Parallel calls of one session.** A session's file under the run is written without a lock, so two of its calls at the same moment can leave the smaller of their counts there until its next call, and the 90% line can show twice. The session's own counts are kept under a lock, so the next call puts it right.
- **A session's own totals.** Each session's counts are its totals since it started, so a session that called tools before it got `OPENMORALS_RUN` brings those calls into the run.
- **The variable is the link.** A session counts against the run only while `OPENMORALS_RUN` is in its environment. A session started without it is a session of its own under your bylaws' per-session limits, not an unlimited one. The run budget stops accidents and runaway trees; it is not a security boundary against an agent running as your user on your machine (for that, see [sandbox.md](sandbox.md)).
- **What a hook cannot see:** agents that run elsewhere (cloud workers, remote agents) except where they are started or land on this machine, and model turns that call no tool.

## Planned

- Reserving a share of the run's budget before a spawn, so siblings cannot pass a limit together.
- The run id on the other hosts.
- A declared fan-out for planned parallel work, so a fan-out you planned is not treated like a runaway.

See also [cost-control.md](cost-control.md) for the per-session budget and host settings, [architecture/multi-agent-guards.md](architecture/multi-agent-guards.md) for the other rules across sub-agents, and [software-factories.md](software-factories.md) for factories.
