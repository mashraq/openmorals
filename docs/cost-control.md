# Token and cost control

How AI coding agents spend tokens, what openmorals does about it today, what you can set on your own host now, and what is planned for agents that spawn other agents.

Status words as in [README.md](README.md): **Built (version)**, **Planned**, **Rejected**. Figures are marked as measured (with the source and the date it was read) or as an estimate. Everything here was checked on 25 Nov 2026; host settings change often, so check your host's own docs before relying on a name.

## In one minute

- **Built (0.6.0):** the budget guard asks at a soft limit and refuses at a hard limit, per session, for tool calls on every host and for tokens (and, with your own price table, cost) where the host reports them: Codex and OpenClaw. On Claude Code, Gemini CLI and opencode it counts tool calls only. See [adapters.md](adapters.md#token-usage-per-host-060).
- **What drives cost is turns and cache misses, not big outputs.** In published measurements of coding agents, cache reads were about 97 to 99% of input tokens, and the number of turns explained most of the difference in cost between runs (sources below). So the planned controls cap turns and spawns first, and openmorals is designed never to break your prompt cache itself.
- **Agents that spawn agents are where spend runs away.** No coding host today bounds a whole tree of agents across processes. The planned budget ledger gives each task one budget that its child agents draw slices from, with limits on depth and fan-out and one command to stop the whole tree.
- **What a hook can promise.** A hook can stop the next tool call or the next spawn, not a model reply already being written. So a budget enforced by hooks can be overshot by one or two model turns per running agent, and by more for background sub-agents whose usage is known only when they finish. openmorals will say so rather than claim a hard zero.

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

**Things that break a prompt cache** (and so make every later turn pay full price for the whole context): changing, adding, removing or reordering tools mid-session (including connecting an MCP server); a timestamp or other changing text in the system prompt or instruction files; editing earlier messages; switching model, effort or speed; compaction; pauses longer than the cache lifetime (often 5 minutes); routing to another provider or region. This holds across vendors that cache, including Anthropic, OpenAI, Gemini, DeepSeek, Kimi, xAI and Mistral, and for self-hosted servers such as vLLM and SGLang. Each vendor prices cache reads differently; take prices from the vendor's own page.

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
| Tool hook (every host) | refuse or ask before the next tool call or spawn; end the agent on hosts that allow it | a model reply already being written |
| Claude Code statusline command | nothing by itself | live cost, context size, cache and plan usage, which the next hook can act on (Planned) |
| Gemini CLI `BeforeModel` hook | refuse or re-route a model call before it is sent | — |
| Host settings written at setup | the host's own caps (depth, concurrency, model, output size) | you can still change them |
| Python and TypeScript agent wrappers | in-process caps set from the task's budget (Planned) | totals across processes need the ledger |

A gateway in front of the model API can refuse single requests, but only for API-key traffic; subscription logins do not pass through it. openmorals does not ship one (**Rejected** for now: it would not cover subscription users, and rewriting requests would break caches).

## Planned controls

All **Planned**; names and defaults may change after the evals below.

| Control | What it does |
|---|---|
| Real token counts on Claude Code | the budget guard reads usage from Claude Code's own session transcripts (each response counted once, each sub-agent's transcript added when it finishes), or from Claude Code's OpenTelemetry export for headless runs; input, output, cache reads and cache writes are kept as separate counts. An optional `openmorals statusline` command can add live figures in interactive sessions; it prints your existing status line unchanged |
| Budget ledger for a task and its agents | one budget per task (tokens, cost with your price table, turns, spawns, or a share of a subscription's usage window); each child agent gets a slice; unspent slices return to the parent; append-only and hash-chained like the audit log; fails closed |
| Spawn limits | depth, children per parent, total spawns per task and live children; a refused spawn tells the agent to do the work itself or report, never to retry the spawn |
| Stop the whole tree | `openmorals stop <task>`: every agent in the tree is refused on its next step; finished work is kept |
| Loops and duplicate work across agents | the loop detector extended to the whole tree, with result hashes so honest polling is not flagged, a check for a new sub-task that repeats a sibling's, and two agents asking each other in circles |
| Turn budget | turns per task and per child, since turns drive most of the cost |
| Cache-safe guarding | openmorals never changes tools or system prompts, rewrites a tool result only when it first arrives, and speaks to the model only when it stops something; it can ask before a mid-session model switch, flag an MCP server connecting mid-session, and point out changing text (dates, IDs) in instruction files |
| Lean setup report | `openmorals init --lean` lists what loads on every request (MCP servers with their token cost, instruction file size, skill descriptions) and suggests cuts; it changes nothing without your yes |
| Large outputs as files | a tool result over a size limit is saved to a local file and replaced by its head, tail and path when it first arrives |
| Budget line at thresholds | one short line to the agent at 50%, 75% and 90% of its slice, never every turn |
| Cost report | `openmorals report cost`: the agent tree with tokens, cost, turns, cache hit rate, spawns and loops caught; OpenTelemetry export |
| openmorals' own spend counts | reviewer and judge calls are charged to the same task budget, cheapest check first |

**Not planned:** switching models per request inside a running agent (it breaks the cache and can cost more), a model judge on every call by default, and editing your instruction files or MCP settings without asking.

## How the savings will be checked

No saving is claimed until it is measured. The plan: run the same set of tasks (the existing eval suite plus sub-agent-heavy tasks) with openmorals off, with the counting and setup report only, and with all the controls above; report solve rate, turns, cost, cache hit rate and spawns per task. Published studies suggest masking old outputs alone can halve agent cost and that practical truncation saves 11 to 19% with caching on; much of any saving on an ordinary day comes from the host settings above rather than from openmorals itself, so no combined figure is given until the evals have run. The main value of the controls is on a bad day: a runaway tree stops at a limit you set.

**What the budget ledger can and cannot stop.** It stops accidents and runaway loops. It does not stop a determined agent running as the same user on the same machine: a child process can drop the variables that tie it to its task, and the ledger files sit on the same disk. For that, run agents in the OS sandbox ([sandbox.md](sandbox.md)).

**Order of work.** First the simple parts: host caps written at setup, per-agent counters (which also fix a lost-update race between parallel sub-agents in today's session file), a total-spawns limit, the stop command and transcript-based token counts. Slices, reservations, the cost report and cache checks follow only if evals show runaway trees getting past the host caps.
