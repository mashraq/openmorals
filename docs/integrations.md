# Integrations: where openmorals can sit around an agent

openmorals judges what an agent is about to do (run a command, read or write a file, fetch a URL, call a tool) with deterministic code. That judgment does not depend on which model proposed the action, so Claude, GPT, Gemini, DeepSeek, Kimi, Grok, Qwen, Mistral and open models such as Llama look the same to it. What decides how well openmorals can guard an agent is the **harness** around the model: whether it lets a guard see each action before it runs, and whether it reports how many tokens it used.

This page lists the places a guard can sit, what each can and cannot do, and which of them openmorals uses today. It uses the status words from the [docs index](README.md): **Built (version)**, **Planned**, **Rejected**.

Facts about other products come from their own public documentation, read on 25 Nov 2026. None of the planned integrations below has been run against the real product yet. Products and hook formats change often; check a host's current docs before relying on a row.

## The short answer

- **On agents with hooks, openmorals judges every tool call before it runs.** Built for Claude Code (0.1.0 onward), Codex CLI, Gemini CLI and opencode (0.3.0) and OpenClaw (0.6.0); see [adapters.md](adapters.md).
- **Many other coding agents now document a hook format modelled on Claude Code's** (the same event names, JSON on standard input, exit code 2 to block). One adapter could cover several of them, but the details differ per host: whether "ask" works, whether a hook can hide a tool result, whether hooks run inside subagents, and whether a failed hook blocks or lets the call through. Planned.
- **Token use is reported to hooks by very few hosts.** Of the five built hosts, openmorals counts tokens on Codex and OpenClaw (0.6.0); Claude Code, Gemini CLI and opencode give a hook no session token count, so the budget there counts tool calls ([adapters.md](adapters.md#token-usage-per-host-060)). The one place that sees every token for every agent is the model API itself, through a proxy or gateway in front of it. Planned.
- **Agents that run in the vendor's cloud cannot be guarded from your machine.** A personal agent that works in a cloud computer with its own browser never passes through anything on your device. openmorals can guard only the tools you connect to such an agent through a server you control (an MCP server), and the provider's own settings. It cannot see or stop anything else, and this page will not claim otherwise.
- **Some agents have no hook at all.** For those, the options are the model proxy (where the agent lets you set the API address), the MCP layer, git hooks and CI (the [merge verdict](merge-verdict.md)), and the [OS sandbox](sandbox.md).

## The places a guard can sit

| Place | What it sees | Can it stop an action before it runs? | Can it ask you? | Does it see tokens? | In openmorals |
|---|---|---|---|---|---|
| **Native hook** (a command or plugin the agent calls before and after each tool) | every tool call the harness routes through it; your prompts | yes | if the host supports ask | rarely | **Built** for five hosts |
| **In-process adapter** for an agent framework (middleware or callback in code you write) | model calls and tool calls inside your own agent | yes, for tool calls in nearly every framework; for model calls in many | where the framework supports pausing for approval | usually | Planned |
| **Model API proxy or gateway** (the agent's API address points at it) | every request and response: the tool calls the model proposes, the results sent back, the token counts | it can refuse a proposed tool call, but cannot stop a harness that runs something without asking the model | no | **yes, for every agent that uses it** | Planned |
| **MCP proxy** (sits between an agent and the MCP servers it uses) | every MCP tool call and its result | yes | only where the client supports it | no | Planned |
| **OS sandbox and network allowlist** | what a process actually does to files and the network, however it was spelled | yes | no | no | **Built (0.3.0)** for one command (`sandbox run`); around the whole agent Planned |
| **Browser extension** | form fields, pastes and links in your own browser | best effort only; an agent driving the browser directly can go around it | a warning | no | Planned, low priority |
| **Logs after the fact** (OpenTelemetry traces, provider audit logs) | what happened, afterwards | no | no | often | Planned |

Two points matter most:

1. **Only the OS sandbox stops an action whatever the model or harness does.** Hooks, adapters, proxies and MCP proxies judge proposals and rely on the harness to honour the answer. That is why openmorals keeps the sandbox in its design ([enforcement-model.md](architecture/enforcement-model.md)).
2. **Only the model API proxy counts every token across many agents,** including agents that spawn other agents in different tools. Hooks rarely receive token counts.

## The model does matter in a few places

The guard's decisions do not depend on the model, but five practical things do:

| Where | Why |
|---|---|
| Counting tokens | Each API reports usage differently (cached and uncached input, thinking tokens, streamed totals). A proxy needs a small translator per API shape. |
| Tools that run on the provider's servers | Some providers run web search, web fetch, code execution or remote tool connectors on their own servers. No guard on your machine sees those calls before they run; a proxy can only remove or restrict them in the request. |
| Encrypted reasoning | Several APIs require earlier reasoning blocks to be sent back exactly as received. A guard that edits earlier turns breaks the next request. |
| Prompt caching | Caching needs an unchanged prefix. A guard that rewrites earlier turns or the tool list makes every turn cost full price. openmorals' rule: refuse rather than rewrite, and change only the newest turn. |
| API shape | Two request formats cover nearly every provider and local runner today: the OpenAI format (Chat Completions and Responses) and the Anthropic Messages format. Google's own tools also use Gemini's native format. |

## Design direction (Planned)

These are the planned pieces, in the order they unlock the most. None is built. Each host will first be run for real, and no row will be marked Built until a payload captured from the real product passes; each piece will get its own page, tests and measured costs.

1. **One event shape for every integration.** Every place above turns into the same event (before a model call, after it, before a tool, after it, a prompt, a spawned agent, the end), carrying what the host can and cannot do. If a host cannot ask, an "ask" is held for you to approve where a way to reach you exists (as [deferred asks](deferred-asks.md) already do on Claude Code), and becomes a refusal with a reason you can see only when nobody can be asked. openmorals only ever moves toward stricter, never looser.
2. **A long-running local engine.** Today each hook call starts the CLI, about 0.09 s (measured, one laptop). That is fine for a hook but too slow for a proxy holding a streamed tool call. A local mode that stays running, with the same session files and audit chain, removes that cost.
3. **One adapter for the hosts that share Claude Code's hook format,** with a table per host of what is enforced and what is not, printed at install, so nobody believes they are better covered than they are. Self-protect will watch every new hook file path, since on most hosts an agent can edit its own hooks.
4. **Adapters for hosts with their own formats,** where their documentation shows a hook that can block.
5. **An MCP proxy** that judges each MCP tool call with the same engine, for any model and any MCP client.
6. **A model API guard,** as a service that existing AI gateways with an external-guardrail hook can call, and as a small optional local proxy that only inspects, counts and refuses: it forwards everything else unchanged, never edits earlier turns, and lets text stream.
7. **Framework adapters** for agents people build themselves, starting with the most used SDKs.
8. **An OpenTelemetry reader** that totals token use from traces, for frameworks that emit them.

### Rejected

- **Intercepting your encrypted traffic** with a local root certificate to read closed apps. It would see your banking and mail too, breaks on apps that pin certificates, and depends on private APIs. If your organisation already runs an inspection proxy, agents that honour it can be pointed at it.
- **Building a general multi-provider AI gateway.** Keeping up with every provider's API is a large job that other open-source projects already do; openmorals will plug into them instead.

## What openmorals will not claim

- That it guards "any agent". It guards what passes through a place it sits, and on each host it will say which places those are.
- That a proxy alone is enforcement. A proxy can refuse; only the harness or the sandbox can stop.
- That it sees inside cloud-run agents. It does not.
- That a host is supported before it has been run against that host. Until then a row stays Planned.

## Related

- [adapters.md](adapters.md): the five built hosts in detail, with sources and dates.
- [architecture/enforcement-model.md](architecture/enforcement-model.md): the six ways to guard an agent compared, and what openmorals uses.
- [sandbox.md](sandbox.md): the OS sandbox.
- [merge-verdict.md](merge-verdict.md): the check that runs in CI on whatever an agent changed.
