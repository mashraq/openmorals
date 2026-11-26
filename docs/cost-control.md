# Token and cost control

How AI coding agents spend tokens, what openmorals does about it today, what you can set on your own host now, and what is planned for agents that spawn other agents.

Status words as in [README.md](README.md): **Built (version)**, **Planned**, **Rejected**. Figures are marked as measured (with the source and the date it was read) or as an estimate. Everything here was checked on 25 Nov 2026; host settings change often, so check your host's own docs before relying on a name.

## In one minute

- **Built:** the budget guard asks at a soft limit and refuses at a hard limit, per session: tool calls on every host (0.1.0); tokens, and cost with your own price table, where the host reports usage: Codex and OpenClaw (0.6.0), and Claude Code from its own session log (0.36.0). On Gemini CLI and opencode it counts tool calls only. On Claude Code it also counts sub-agent runs and asks at a fan-out limit, and `openmorals stop` halts a session and every sub-agent in it (0.36.0). Defaults and rule ids: [architecture/guards.md](architecture/guards.md#budget); per host: [adapters.md](adapters.md#token-usage-per-host-060).
- **What drives cost is turns and cache misses, not big outputs.** In published measurements of coding agents, cache reads were about 97 to 99% of input tokens, and the number of turns explained most of the difference in cost between runs (sources below). So the controls cap turns and spawns first, and are designed not to break your prompt cache.
- **Agents that spawn agents are where spend runs away.** No coding host today bounds a whole tree of agents across processes. Today openmorals bounds sub-agents within one Claude Code session; the planned budget ledger would give each task one budget across processes that its child agents draw slices from.
- **What a hook can promise.** A hook can stop the next tool call or the next spawn, not a model reply already being written. So a budget enforced by hooks can be overshot by one or two model turns per running agent, and by more for background sub-agents still running. openmorals says so rather than claim a hard zero.

## Where agent tokens go (measured)

| Finding | Source |
|---|---|
| Cache reads were 98.6% of input tokens across 600 coding-agent runs; turn count explained 84% of the variance in cost, observation size 4% | TurnCost, https://arxiv.org/pdf/2610.15093 |
| Runs of the same task differed by up to 30x in tokens; more spend did not mean more success | https://arxiv.org/abs/2604.22750v2 |
| Agents use about 4x the tokens of chat; multi-agent systems about 15x; early versions spawned 50 sub-agents for simple questions | https://www.anthropic.com/engineering/multi-agent-research-system |
| Claude Code agent teams use about 7x the tokens of a standard session (teammates in plan mode) | https://code.claude.com/docs/en/costs |
| Tool definitions from five common MCP servers took about 55K tokens per request when loaded upfront; tool search cut definition tokens by about 85% | https://anthropic.com/engineering/advanced-tool-use |
| Keeping only recent tool outputs whole (masking older ones) cut agent cost by more than half with no loss in solve rate | https://arxiv.org/abs/2508.21433 |
| Switching models mid-session throws away the prompt cache; routing per request saved far less than routing at phase boundaries | https://code.claude.com/docs/en/prompt-caching.md, https://towardsdatascience.com/the-hidden-cost-of-llm-routing-why-switching-models-costs-more/ |

**Things that break a prompt cache** (and so make the next turn pay full price, or more, to write the whole context to the cache again): changing, adding, removing or reordering tools mid-session (including connecting an MCP server); a timestamp or other changing text in the system prompt or instruction files; editing earlier messages; switching model, effort or speed; compaction; pauses longer than the cache lifetime (often 5 minutes); routing to another provider or region. This holds across vendors that cache, including Anthropic, OpenAI, Gemini, DeepSeek, Kimi, xAI and Mistral, and for self-hosted servers such as vLLM and SGLang. Each vendor prices cache reads differently; take prices from the vendor's own page.

## What you can set today

**Claude Code** (names from https://code.claude.com/docs; check your version):

| Setting | Suggestion | Why |
|---|---|---|
| `CLAUDE_CODE_SUBAGENT_MODEL` | a cheaper model for exploring and searching sub-agents | sub-agents often do most of the reading |
| `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` | 2 for everyday work (default 3; `1` turns nesting off) | bounds trees of agents |
| `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` | 5 to 8 (default 20) | bounds bursts |
| `ENABLE_TOOL_SEARCH` | leave on (the default) | MCP tool definitions load only when needed |
| `MAX_MCP_OUTPUT_TOKENS` | 10,000 to 15,000 (default 25,000) | large tool results go to a file instead of the context |
| CLAUDE.md | under about 200 lines; detail in skills | it is re-sent on every request |
| MCP servers | only the ones the task needs; a CLI (such as `gh`) where it does the same job | each loaded server adds its definitions to every request |
| `--max-budget-usd` | for headless (`-p`) runs | the host stops the run at the cap |
| One model per session | avoid switching mid-session | a switch re-writes the whole context to the cache |

**Codex CLI:** `agents.max_concurrent_threads_per_session`, `tool_output_token_limit`, `model_auto_compact_token_limit`, `model_reasoning_effort`, `model_verbosity` (https://learn.chatgpt.com/docs). **Gemini CLI:** `tools.truncateToolOutputThreshold`, `model.compressionThreshold`, `model.maxSessionTurns` (https://geminicli.com/docs). **Agent frameworks:** Claude Agent SDK `max_budget_usd` (covers sub-agents in the same process), Pydantic AI `UsageLimits` (pass `ctx.usage` to a delegate agent so it counts), Google ADK `max_llm_calls`, LangGraph `recursion_limit`, AutoGen `TokenUsageTermination`, OpenAI Agents SDK `max_turns`.

## What a guard can enforce, per integration point

| Where openmorals runs | Can enforce | Can only observe or advise |
|---|---|---|
| Tool hook (every host) | refuse or ask before the next tool call or spawn (Built: a spawn is a tool call); end the agent's turn when you stop the session (Built 0.36.0 on Claude Code; Planned on other hosts that allow it) | a model reply already being written |
| Claude Code statusline command | nothing by itself | live cost, context size, cache and plan usage, which the next hook can act on (Planned) |
| Gemini CLI `BeforeModel` hook (not installed by openmorals today) | refuse or re-route a model call before it is sent | — |
| Host settings written at setup | the host's own caps (depth, concurrency, model, output size) | you can still change them |
| Python and TypeScript agent wrappers | in-process caps set from the task's budget (Planned) | totals across processes need the ledger |

A gateway in front of the model API can refuse single requests, but only for API-key traffic; subscription logins do not pass through it. openmorals does not ship one (**Rejected** for now: it would not cover subscription users, and rewriting requests would break caches).

## Built in 0.36.0: token control on Claude Code

| Control | What it does | Setting (in `guards.budget`) |
|---|---|---|
| Real token counts | The budget guard reads the usage numbers from Claude Code's own session log (the main one and each sub-agent's), and adds them to `tokens`. Each model response is counted once. Input, output and cache writes count against the budget; cache reads are kept apart, because they are cheap and would swamp the figure. Only the usage numbers are read, never the text ([ADR 0015](adr/0015-claude-code-token-counts-from-its-session-log.md)). Sub-agents that run in the background are counted as their log grows, so a limit can still be overshot by the turns in flight. | `transcript: false` turns it off (only in your user file) |
| Per-agent counts | Tool calls are counted per sub-agent as well as per session, with the sub-agent's kind (such as `Explore`) when Claude Code passes it. Off by default. | `agent_tool_calls: { soft, hard, step }` |
| Sub-agent runs | Every start of a sub-agent is counted. Sub-agents that one agent starts together, with no other tool call in between, count as one run, so a planned fan-out of N parallel variants uses one run of the budget. Asks at 25 runs and every 25 after; no hard limit by default. A hard limit refuses every later spawn, in a batch too. Sub-agents started by parallel hooks can count as separate runs, which only raises the count. | `spawns: { soft, hard, step }` |
| Fan-out | Asks when one batch starts more than 10 sub-agents. Sub-agents started by parallel hooks can pass the limit by those in flight before the ask. | `fanout: 10` (`0` turns it off) |
| Stop | `openmorals stop <session>` or `openmorals stop --all`: every later tool call of that session, in the main conversation and in every sub-agent, is refused and the agent's turn ends. Work already done is kept. Only you can set or lift it (`openmorals stop --clear`); an agent that runs either is asked about first. | none |
| Sessions | `openmorals sessions` lists recent sessions with tool calls, tokens, cache reads, sub-agent runs, the busiest sub-agents and whether a session is stopped (`--json` for scripts). | none |
| Hook fails closed | `openmorals init` now installs the Claude Code tool and prompt hooks with `onFailure: "block"`, so a crash or timeout of the hook stops the call instead of letting it run (Claude Code 2.1.295 or later; older versions ignore the setting). Run `openmorals init` again to upgrade a hook installed before 0.36.0; it changes only the openmorals hook entries. | none |

As with every budget setting, a project file can make these stricter, never looser.

**Not built: a separate allowance for monitoring loops.** An agent that polls (checks a build, waits on a reply) spends a model turn on each poll, so its polls are ordinary tool calls and tokens and belong in the same budget. Where polling is the job, use the host's own background tasks or monitor tools, which wait without model turns, and raise `tool_calls` if you need to.

## Planned controls

All **Planned**; names and defaults may change after the evals below.

| Control | What it does |
|---|---|
| Token counts from OpenTelemetry and a status line | Claude Code's OpenTelemetry export for headless runs; an optional `openmorals statusline` command for live figures in interactive sessions, which prints your existing status line unchanged |
| Budget ledger for a task and its agents | one budget per task (tokens, cost with your price table, turns, spawns, or a share of a subscription's usage window); each child agent gets a slice; unspent slices return to the parent; append-only and hash-chained like the audit log; fails closed |
| More spawn limits | depth, children per parent and live children, across processes (a total per session is built); a refused spawn tells the agent to do the work itself or report, never to retry the spawn |
| Stop by scope | today a stop covers one session or all of them; later scopes (one kind of agent, one task across processes) add a key to the stop file, which older versions keep as it is |
| Loops and duplicate work across agents | the loop detector extended to the whole tree, with result hashes so honest polling is not flagged, a check for a new sub-task that repeats a sibling's, and two agents asking each other in circles |
| Turn budget | today's per-session tool-call budget also counted per child agent and per task (a hook sees a turn only when it calls a tool), since turns drive most of the cost |
| Cache-safe guarding | openmorals never changes tools or system prompts, never rewrites a tool result ([ADR 0014](adr/0014-the-checker-can-only-refuse-ask-or-report.md)), and speaks to the model only when it stops something or a budget nears its end; it can ask before a mid-session model switch, flag an MCP server connecting mid-session, and point out changing text (dates, IDs) in instruction files |
| Lean setup report | `openmorals init --lean` lists what loads on every request (MCP servers with their token cost, instruction file size, memory file sizes, skill descriptions) and suggests cuts; it changes nothing without your yes |
| Budget line near the limit | one short line to the agent at 90% of its slice, and nothing at 50% or 75%, because each line added to the conversation breaks the prompt cache |
| Cost report | `openmorals report cost`: the agent tree with tokens, cost, turns, cache hit rate, spawns and loops caught; OpenTelemetry export |
| openmorals' own spend counts | reviewer and judge calls are charged to the same task budget, cheapest check first |

**Not planned:** replacing a large tool result by its head, tail and a file path (it would rewrite tool output, which [ADR 0014](adr/0014-the-checker-can-only-refuse-ask-or-report.md) rules out), switching models per request inside a running agent (it breaks the cache and can cost more), a model judge on every call by default, and editing your instruction files or MCP settings without asking.

## How the savings will be checked

No saving is claimed until it is measured. The plan: run the same set of tasks (the existing [eval](eval.md) suite plus sub-agent-heavy tasks) with openmorals off, with the counting and setup report only, and with all the controls above; report solve rate, turns, cost, cache hit rate, spawns per task and the tokens spent before the agent's first tool call (the fixed cost of setup files, memory and tool definitions). Published studies suggest masking old outputs alone can halve agent cost and that practical truncation saves 11 to 19% with caching on; much of any saving on an ordinary day comes from the host settings above rather than from openmorals itself, so no combined figure is given until the evals have run. The main value of the controls is on a bad day: a runaway tree stops at a limit you set.

**What the budget ledger can and cannot stop.** It stops accidents and runaway loops. It is not a security boundary against a determined agent running as the same user on the same machine; for that, run agents in the OS sandbox ([sandbox.md](sandbox.md)).

**Order of work.** The simple parts are built in 0.36.0: per-agent counters, a total-spawns limit, the stop command and token counts from the session log. Host caps stay as advice in the table above: openmorals does not write them into your settings without your yes. Slices, reservations, the cost report and cache checks follow only if evals show runaway trees getting past the host caps.
