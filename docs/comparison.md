# How openmorals compares with other ways to guard an agent

**Status:** a fact sheet, read from each project's own documentation on 25 Nov 2026. Nothing here was installed or run. Products change quickly; check the linked source before relying on a row. Corrections are welcome as pull requests.

openmorals is one of several ways to keep an AI agent from doing damage. Most real setups combine a few of them. This page says what each kind does, where it runs and what it costs, so you can pick the combination that fits. How openmorals checks an action, and why, is in [architecture/enforcement-model.md](architecture/enforcement-model.md).

## The short version

- **Host controls** (Claude Code permissions and hooks, Codex sandbox and hooks, Gemini CLI hooks) come with your agent. Use them. openmorals runs inside them and can only make a decision stricter: a host's deny rule still wins, and openmorals never answers "allow" to a host ([ADR 0009](adr/0009-never-grant-permission-the-host-would-not.md)).
- **Guardrail libraries** (NeMo Guardrails, Guardrails AI, openai-guardrails) belong inside an application you are writing. They are not something you can attach to a coding agent you run.
- **Classifier models** (Llama Guard, Prompt Guard, Lakera, Model Armor) screen text for known attacks or harmful content. Published studies of several such detectors show that adaptive attackers often get past them (see [below](#what-model-based-screening-can-and-cannot-do)), so treat a classifier as a signal, not a gate.
- **AI gateways** (LiteLLM, Portkey, Kong AI) sit between the agent and the model provider. They are the best place for token and dollar budgets across many agents and models. They see model requests, not what a tool does on your machine.
- **Sandboxes** (OS sandboxes, E2B, Modal) limit where damage can land. They don't judge whether a step is wise, and the project folder is usually writable inside them.
- **Policy hooks for coding agents** (openmorals, Microsoft Agent Governance Toolkit, and hosted commercial offerings) judge each tool call before it runs, inside the host.

## The table

Scope letters: **P** your prompt, **O** the model's reply, **TC** a tool call before it runs, **TR** a tool result or fetched page, **C** written code or a diff, **M** tool or skill descriptions.

| Product | Scope | Where it runs | Coding agents documented | Sub-agents | Extra model calls per check | Budgets | Licence |
|---|---|---|---|---|---|---|---|
| **openmorals** | P, TC, TR, C, M | hook inside the host, plus a CLI; local | Claude Code, Codex CLI, Gemini CLI, opencode, OpenClaw (the last four built from documentation, not yet run live) | a child's prompt, its report and messages between agents are scanned; state is shared only where the child runs in the same session | none (an optional reviewer and judge can only raise) | tool calls per session on every host; tokens where the host reports them (Codex, OpenClaw) | Apache-2.0 |
| Microsoft Agent Governance Toolkit | P, TC | hooks inside the host; YAML, OPA Rego or Cedar policies; local | Claude Code, OpenCode, Copilot CLI, Antigravity CLI | not stated | none for policy checks | docs list budget tutorials (not read) | MIT |
| NVIDIA NeMo Guardrails | P, O, retrieval, TC, TR | Python library or server in your app | none | per-agent config in LangGraph | yes for self-check rails | none | Apache-2.0 |
| Guardrails AI | P, O | Python library or server in your app | none | none | yes for model-based validators | none | Apache-2.0 (hosted Hub closed Aug 2026) |
| Meta Llama Guard 4, Prompt Guard 2, LlamaFirewall | P, O; P, TR; agent reasoning; C | models plus a Python library | none | not covered | the check is a model | none | Llama 4 Community License (models) |
| Lakera Guard | P, O, TC, TR, M | hosted API or self-hosted container | not checked | per step | one API call per screen | none | proprietary |
| LLM Guard (Protect AI) | P, O | Python library | none | none | local classifiers | none | MIT; archived 9 Jul 2026 |
| Invariant Guardrails / Agent Scan (Snyk) | flows between TC, TR; M | proxy or library; scanner | Agent Scan lists many coding agents | rules can span calls | detectors may use models | none | Apache-2.0 |
| Claude Code permissions, hooks, auto mode | TC (auto mode also screens TR) | the host | native | hooks run inside sub-agents | command hooks: none; auto mode: a classifier model | `--max-budget-usd` covers sub-agents in print mode and the SDK | proprietary host |
| OpenAI openai-guardrails, Agents SDK, Codex CLI | P, O, TC, TR | library; Codex hooks and OS sandbox | Codex | SDK input checks run on the first agent only, output on the last | yes for model-based checks | `max_turns`; Codex caps concurrent sub-agents | MIT; Apache-2.0 (Codex CLI) |
| Google Model Armor, ADK, Gemini CLI | P, O; ADK plugins on every agent and tool | hosted API; framework plugins; host hooks | Gemini CLI | ADK plugins cover every agent under a runner | hosted screening per call | ADK `max_llm_calls` per run | Apache-2.0 (Gemini CLI); Model Armor proprietary |
| LiteLLM, Portkey, Kong AI | P, O, TC as the model emits it | proxy at the model API | Claude Code and Codex can be routed through a gateway | by key, team or trace id | depends on the guardrails you add | token and dollar budgets, rate limits (some features need paid editions) | MIT (LiteLLM core, Portkey); Apache-2.0 (Kong core) |
| E2B and other sandboxes | contains execution | microVM or container | used by agent platforms | n/a | none | none | Apache-2.0 (E2B) |

Sources: each project's own documentation and repository, read on 25 Nov 2026. Main pages: [Microsoft AGT](https://microsoft.github.io/agent-governance-toolkit/packages/claude-code-governance/), [NeMo Guardrails](https://github.com/NVIDIA/NeMo-Guardrails), [Guardrails AI hub update](https://raw.githubusercontent.com/guardrails-ai/guardrails/main/HUB_UPDATE.md), [Llama Prompt Guard 2](https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M), [LlamaFirewall paper](https://arxiv.org/html/2505.03574v1), [Lakera integration](https://docs.lakera.ai/docs/integration), [LLM Guard](https://github.com/protectai/llm-guard), [Invariant](https://github.com/invariantlabs-ai/invariant), [Snyk Agent Scan](https://github.com/snyk/agent-scan), [Claude Code hooks](https://code.claude.com/docs/en/hooks), [Claude Code permissions](https://code.claude.com/docs/en/permissions), [Agent SDK loop](https://code.claude.com/docs/en/agent-sdk/agent-loop), [openai-guardrails prompt injection check](https://openai.github.io/openai-guardrails-python/ref/checks/prompt_injection_detection/), [Agents SDK guardrails](https://openai.github.io/openai-agents-python/guardrails/), [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Model Armor](https://cloud.google.com/security/products/model-armor), [ADK plugins](https://adk.dev/plugins/), [Gemini CLI hooks](https://geminicli.com/docs/hooks/reference/), [LiteLLM budgets](https://docs.litellm.ai/docs/proxy/users), [Portkey gateway](https://github.com/Portkey-AI/gateway), [Kong AI rate limiting](https://developer.konghq.com/plugins/ai-rate-limiting-advanced/), [E2B](https://e2b.dev/pricing).

## What happens when the check itself fails

A guard that lets the action through when it crashes is weaker than it looks. As documented on 25 Nov 2026:

| Where | On a crash, timeout or malformed answer |
|---|---|
| Claude Code command hooks | the call goes ahead, unless the hook sets `"onFailure": "block"` (Claude Code 2.1.295 and later) |
| Codex hooks | an error, timeout or malformed answer "can let the tool run" |
| Gemini CLI hooks | other exit codes let the step proceed; malformed output is treated as allow |
| OpenAI Agents SDK guardrails | a guardrail that raises counts as no verdict |
| NeMo Guardrails | no library-wide failure policy; set per rail |
| LiteLLM global budget | fails open without a database |
| Claude Code auto mode | fails closed: if the classifier is unreachable, each checked action is denied |
| openmorals | decides "ask" when it cannot judge ([ADR 0005](adr/0005-fail-closed-ask-on-error.md)); but if the host cannot start the hook at all, the host's own failure rule above applies. Today `openmorals init` does not yet write `onFailure: block` for Claude Code |

## What model-based screening can and cannot do

Published numbers, as their authors report them:

- OpenAI's own prompt-injection check reports recall at a 1% false-positive rate of 0.000 for gpt-4.1-mini, gpt-4.1 and gpt-5-mini, and 0.584 for gpt-5, at a median of about 1.5 seconds per check ([source](https://openai.github.io/openai-guardrails-python/ref/checks/prompt_injection_detection/)).
- Meta's LlamaFirewall paper reports AgentDojo attack success falling from 17.6% with no guard to 7.5% with Prompt Guard 2 and 1.75% with Prompt Guard 2 plus AlignmentCheck, with utility falling from 47.7% to 42.7% ([source](https://arxiv.org/html/2505.03574v1)).
- Independent studies report detectors, including Prompt Guard and NeMo's jailbreak detector, evaded in most attempts by character injection and adaptive search ([Hackett et al.](https://arxiv.org/html/2504.11168v3), ["The Attacker Moves Second"](https://arxiv.org/html/2510.09023v1)).

That is why openmorals lets a model add caution but never remove it, and why it limits what an agent can *do* after reading something untrusted (the taint rule) instead of trying to recognise every attack.

## What openmorals does not do

Stated so you can choose well:

- It does not screen the model's replies (O), and it does not filter harmful content categories. Use the host's or provider's safety settings, or a classifier, for that.
- It cannot see a program the agent writes and then runs. Use a sandbox; `openmorals sandbox run` builds one from the same bylaws.
- It has no hosted console, central deployment or single sign-on.
- Its token budget works only where the host reports token usage to hooks (Codex, OpenClaw). For token and dollar caps across many agents and models, a gateway is the better tool today.
- It has no adapter yet for Cursor, Copilot CLI, Antigravity or Windsurf.
- Its policies are YAML bylaws and patterns, not Rego or Cedar.
- Its Codex, Gemini CLI, opencode and OpenClaw adapters are built from documentation and tested with recorded event shapes; they have not yet run against the live tools, and several Claude Code features have not been checked in a live session either. How we plan to prove each claim is in [evaluation-plan.md](evaluation-plan.md).

## What openmorals is built for

- **Decisions in code, outside the model.** Each tool call gets allow (silence), ask or deny from deterministic rules, naming the rule and the reason. A model can raise a decision, never lower it.
- **No model tokens and microseconds per decision.** Measured at 17 to 36 µs per decision in a warm process, about 0.09 s per hook start ([eval.md](eval.md)).
- **Works whatever model or plan the host uses**, because it runs in the host, not at the model API.
- **Coding-agent harm in depth:** deletes steered to a restorable trash, online deletes, secrets read and sent, steps after untrusted content, look-alike sites, test tampering, merge verdicts, and packs for privacy, health data and regulated software.
- **One set of bylaws across five hosts**, and a project file that can only tighten your own.
- **Local and checkable:** sends nothing anywhere by default, and `openmorals eval` lets you score the guards on your own rows.
