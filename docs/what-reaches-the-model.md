# What reaches the model, and what openmorals can do about it (0.40.1)

An agent's model reads more than your prompt: the instructions and memory files its host loads, every tool result, pages it fetches, what other agents hand it. openmorals sits in the host's hooks, so it can act only where a hook can. This page lists each way content reaches the model, what a hook can see and change there, what openmorals does with it today, and what it cannot do.

Status words are those of the [docs index](README.md). Facts about Claude Code's hooks are from its hooks reference (https://code.claude.com/docs/en/hooks), read 27 Nov 2026. Facts about the other hosts are in [adapters.md](adapters.md), with their sources and dates. Hook formats change often; check a host's current docs before relying on a row.

## Three things a guard can do

- **Refuse the step that would fetch it**: a read, a command, a fetch. This happens before the content exists, so it is the strongest.
- **Mark and ask later**: let the content in, scan it, mark the session as having read untrusted content, and ask before a later step that sends, deletes or pushes.
- **Replace it before the model reads it.** openmorals does not do this on any host ([ADR 0014](adr/0014-the-checker-can-only-refuse-ask-or-report.md): the checker can only refuse, ask or report).

## Each way in, on Claude Code

| What reaches the model | What openmorals does today | What it cannot do |
|---|---|---|
| Your prompt | Scans it on `UserPromptSubmit`: hidden characters warn or block, secret-shaped values are held back, phrases only mark the session ([scanner.md](scanner.md#inbound-scanning-050)) | Rewrite it. The hook can block a prompt or add context beside it, but "can't replace the prompt" |
| Instructions and memory files the host loads (`CLAUDE.md`, `AGENTS.md`, rules, `MEMORY.md`, skills) | Nothing at load time. Writes into them are judged by the learn guard since 0.35.0 ([learn.md](learn.md)): the added text is scanned, and a write from a session that read untrusted content asks | Filter them at load. The host's `InstructionsLoaded` event only observes ("Exit code is ignored"), and openmorals does not install it |
| A file read or a command's output | Before it: the secrets guard asks before a secret file is read, your own `rules` can ask or refuse by path or command, and inside the sandbox `sandbox.read.deny` refuses the read. After it: scans the result, marks the session, and later outward steps ask | Stop content it allowed from reaching the model |
| A fetched page | Your own `rules` can ask or refuse by tool (`match.tool`); a rule on the site itself is not built yet ([ROADMAP.md](../ROADMAP.md)). After it: scans the result and marks the session | Stop a page it allowed from reaching the model |
| An MCP tool's result | As for a file read: judged by its arguments before, scanned and marked after. MCP results always count as untrusted | Check a tool's description, which reaches the model with no tool call (`openmorals scan` reads MCP config files before you use them) |
| Tools the model provider runs on its own servers | Nothing | They never pass a hook on your machine |
| A sub-agent's report, a message from another agent | Scanned and recorded as a handoff, with whether the sender had read untrusted content and labels for claims of approval (0.38.0, [agent-messages.md](agent-messages.md)) | Treat any of it as approval; only you approve |
| The whole request to the model | Nothing | There is no hook before each model request on Claude Code. `PostToolBatch` fires "before the next model call" only after a batch of tool calls. Only a proxy in front of the model API could see each request, which openmorals does not run ([ADR 0016](adr/0016-no-proxy-or-gateway-for-now.md)) |
| What leaves the machine (a fetch, a form, a message, a push) | The secrets guard refuses a secret sent to the network; the outbound guard judges where a form or message sends data ([outbound.md](outbound.md)); the rule of two asks once untrusted content and private data meet | See data sent to a site you allowed, or a program that runs as you outside the hooks ([sandbox.md](sandbox.md) is the backstop) |

## Events openmorals does not install

`openmorals init` installs four Claude Code events: `PreToolUse`, `PostToolUse`, `PostToolUseFailure` and `UserPromptSubmit`. It does not install `SessionStart`, `InstructionsLoaded`, `PostToolBatch`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `Stop`, `SessionEnd` or `PermissionRequest`. So:

- Nothing is given back to the model after a compaction or when a sub-agent starts. The session's state (taint, counts, history) lives on disk, so it survives both.
- Session rows in `openmorals eval` send compaction and sub-agent events to the hook to test that state is kept ([eval.md](eval.md#session-rows-sessionsyaml-0340)); a live host with the default install does not send them.

## On the other hosts

The same three levels apply. What differs is what each host passes to a hook ([adapters.md](adapters.md)):

- **Codex CLI:** hosted tools such as web search do not pass through its tool hooks, so their results are not scanned.
- **Gemini CLI:** results arrive on `AfterTool`. Gemini CLI also has a `BeforeModel` event that sees each model request; openmorals does not use it.
- **opencode:** a plugin can append a notice to a tool result but cannot block a message; a prompt the bylaws would block goes through with a notice.
- **OpenClaw:** `after_tool_call` only observes and cannot change the result. Since 0.40.1, if a result never reached openmorals, the session's next call asks.

## What the scans can honestly claim

| | Secrets and personal data | Prompt injection and hidden instructions |
|---|---|---|
| By pattern | Good for keys and tokens, which have shapes and prefixes, and for card numbers, which have checksums. Fair for emails, phone numbers and ids. Poor for names, addresses and health facts in prose | Hidden characters, hidden markup and encoded text are found. Instructions in plain prose are not |
| What openmorals relies on | Detection, then a refusal before the data leaves | Not detection but the gate: once untrusted content is in, outward or hard-to-undo steps ask |
| The claim | Catches known secret shapes and common personal-data formats before they leave; does not understand meaning | Does not detect all injection; makes an injected agent ask before it can send, delete or push |

The optional inbound judge (a model, off by default, can only raise) is the one place a model adds recall here ([scanner.md](scanner.md)).

## Planned

- Replacing a tool result that holds a secret before the model reads it. Claude Code's `PostToolUse` can do this (`updatedToolOutput`, "Replaces the tool's output with the provided value before it is sent to Claude", built-in tools included; a value of the wrong shape "is ignored and the original output is used"). Using it needs a decision record that replaces part of ADR 0014. Not built.
