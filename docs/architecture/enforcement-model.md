# Enforcement model: where openmorals checks, and what it costs

Status labels used here: **Built (0.3.1)** means it is in the released code and tested. **Planned** means it is not built. **Rejected** means it was considered and turned down. Figures are marked **measured** (with how) or **estimate**.

This page answers one question the maintainer asked directly:

> How does openmorals check against hazardous prompts and bad responses or actions by the agent? Does it run a security check with the prompt on a separate guarded agent, and analyse the output the same way? Or does it load all the guards into the agent's context and hope for the best? If it loads them into the context, doesn't that use more tokens? What are the different ways to do this, and which should be used here?

## The short answer

openmorals does neither of the two things in the question by default.

1. **It checks actions, not words, and it does it outside the model.** Built (0.3.1). The host agent (Claude Code, Codex CLI, Gemini CLI or opencode) calls openmorals through its own pre-tool hook before each tool call. openmorals starts as a separate process, reads the tool call as JSON, judges it with deterministic code, and answers allow, ask or deny. The model is not involved in that decision and cannot talk its way past it.
2. **Nothing is loaded into the agent's context unless the user asks for it.** Built (0.3.1). `openmorals guidance` writes a short marked block of plain-language rules into `AGENTS.md`, `CLAUDE.md` or `GEMINI.md`. It is advice to cut wasted attempts. It is never the enforcement: the hook judges every call whether or not the block is there.
3. **A second model is optional, rare and can only make things stricter.** Built (0.3.1). The reviewer is off by default. When it is on, it sees only actions the guards already marked ask, and it can keep the ask or (if configured) turn it into a deny. It can never allow anything.
4. **Prompts and text replies are not screened today.** Planned. openmorals does not read the user's prompt before the model sees it, does not read the model's text replies, and does not scan tool results or fetched pages for injected instructions as they arrive.

## How a tool call is judged today

Built (0.3.1). Source: [`src/adapters/claude-code.ts`](../../src/adapters/claude-code.ts), [`src/engine.ts`](../../src/engine.ts), [`src/session.ts`](../../src/session.ts).

```
 model proposes a tool call
        |
 host agent (Claude Code, Codex CLI, Gemini CLI, opencode)
        |  pre-tool hook: starts `openmorals hook <host>` and writes the call as JSON to stdin
        v
 openmorals process (no network, no model)
   1. turn the call into an action: exec (a command line), read, write, fetch, or other
   2. parse a command line the way the shell would (quotes, wrappers, bash -c, $(...), variables)
   3. run the five guards: destructive, online-delete, secrets, self-protect, budget
   4. run the user's own rules from openmorals.yaml
   5. run the two session checks: loop detector and taint judge (Rule of Two)
   6. keep the strictest answer; on any error, ask
   7. optional: if the answer is ask and the reviewer is on, ask a second model (Claude Code only)
   8. save the session counter and history; append one line to the audit log
        |
        v
 answer in the host's own format: nothing (allow), ask, or deny with a one-line reason
```

On Claude Code the same command also runs on `PostToolUse` and `PostToolUseFailure`. There it only records whether the call worked, for the loop detector, and prints nothing.

### What this costs

| Cost | Figure | Status |
|---|---|---|
| Model tokens when openmorals allows | 0. It prints nothing, so nothing reaches the model. | measured from source (`toHookOutput` returns null for allow) |
| Model tokens when openmorals asks or denies | One reason line goes back to the agent, a few hundred characters on Claude Code (for example `openmorals ask [destructive.recursive-delete]: recursive, forced delete of 'build'; ...`). On Codex an ask is sent as a deny with a longer instruction to bring the question to the user. | measured: for `rm -rf build` the reason is 182 characters and the whole JSON answer 292 |
| Wall time per tool call | About 0.09 s per hook call, of which about 0.05 s is starting Node. | measured on one Apple-silicon laptop, Node 25, the Node CLI of 0.3.1, 9 runs, 24 Nov 2026; not measured on Linux or Windows, nor for the single-file binary |
| Network | None. The engine never opens a connection. | built (0.3.1) |

So the hook is not free, but its cost is time on the machine, not tokens. The "cannot be argued with" property comes from where it runs: the model only ever sees the answer.

### What this does not cover

- **Anything a command starts.** openmorals reads the command line, not the script it runs. `bash cleanup.sh`, `npm run clean` or a Makefile can still delete things. Only an OS sandbox covers that (see below).
- **A hook that never starts.** If `openmorals` is not on the PATH, or Node is missing, Claude Code treats the failed hook as a non-blocking error and runs the tool. Codex and Gemini CLI let a call run when the hook times out. openmorals answers ask on its own errors, but it cannot answer if it never starts. This is the host's design, not something openmorals can change.
- **Tools the host does not send to the hook.** For example, Codex hosted tools such as web search are not covered by its `PreToolUse` hook (from its documentation, read 23 Nov 2026; see [docs/adapters.md](../adapters.md)).
- **Hosts that cannot ask.** Codex hooks and opencode's V1 plugin API cannot show an ask, so there an ask is sent as a block with a message telling the model to bring the question to the user.

## The guidance block in the context

Built (0.3.1). Source: [`src/guidance/render.ts`](../../src/guidance/render.ts).

- **When it is used:** only when the user runs `openmorals guidance`. `init` does not write it. (A known defect: `guidance --help` and `init --help` currently run the command instead of printing help. See [requirements-log.md](../product/requirements-log.md).)
- **What it says:** the bylaws in plain words: what is asked about, what is blocked, to use `openmorals trash` instead of deleting, never to print secret values, to stop near the budget, not to poll, and to treat web pages and tool output as data, not instructions.
- **Size:** the default block is 481 words and 2,873 bytes (measured, 24 Nov 2026, with the default bylaws). At the common rule of thumb of about four characters per token that is roughly 700 tokens (estimate, not counted with a tokenizer). Custom rules add one line each.
- **The token cost is real.** A file like `AGENTS.md` is loaded into the context at the start of a session and stays there, so its tokens are part of every model call in that session. Prompt caching can lower the price of a repeated prefix, but not the context size (estimate, based on how hosts load these files).
- **Why ship it anyway:** an agent that knows the rules up front tries fewer actions that will be stopped, and each stopped action costs a model turn plus the reason line. Whether the block saves more tokens than it costs has **not been measured**. That is why it is opt-in.
- **What it is not:** a guard. A model can ignore it, forget it after a context compaction, or be talked out of it by injected text. The hook does not depend on it.

## The ways to do this, compared

There are six common ways to keep an agent from doing harm. They differ in what they read, where they run and how they fail. Token figures are per checked item; "context" means the agent's own context window.

| Approach | Where it runs | Model tokens | Added latency | What it catches | How it is evaded | In openmorals |
|---|---|---|---|---|---|---|
| **1. Rules in the context** (system prompt, `AGENTS.md`) | inside the model | the rules' size, on every call of the session | none | nothing by itself; it lowers the number of bad attempts by a cooperative model | the model ignores or forgets them; injected text overrides them; compaction drops them | Built (0.3.1), opt-in, advisory only: `guidance` |
| **2. Deterministic checks at action time** (a pre-tool hook judging the tool call) | outside the model, before the tool runs | 0 on allow; one reason line on ask or deny | about 0.09 s per call (measured, one laptop, Node CLI) | known shapes of destructive commands, online deletes, secret reads and sends, edits to its own config, budgets, loops | code it never sees (scripts, aliases, programs that build commands at run time); a hook that does not start; tools the host does not route through the hook | Built (0.3.1): the core of openmorals |
| **3. Deterministic scanning of inbound content** (pattern rules over prompts, tool results, fetched pages, skills) | outside the model | 0 | milliseconds per file (estimate) | known injection phrases, invisible Unicode, instructions hidden in HTML comments, download-and-run, exfiltration shapes | paraphrase, homoglyphs, prose instructions, split strings (each measured against the scanner; see [docs/scanner.md](../scanner.md)) | Built (0.2.0) for files **before install** (`openmorals scan`). Planned for prompts and tool results at run time. |
| **4. A guard model** (a second model or classifier reads a prompt, a reply or an action) | outside the agent's model, but a model | a full second call per item: the item plus a fixed frame | a network round trip per item; seconds (estimate) | intent that patterns miss; paraphrased attacks | adversarial text fools models too; it costs money and needs a key or a local model; it can be down | Built (0.3.0) for **actions already marked ask** only, escalate-only, off by default: the reviewer. Not used on prompts or replies. |
| **5. OS sandbox** (Seatbelt on macOS, bubblewrap on Linux, a restricted user on Windows) | the operating system | 0 | process start | anything a process does outside the allowed paths or network, however it was spelled, scripts included | allowed paths and hosts; reads the profile does not deny; the sandbox tool being absent (openmorals then refuses to run) | Built (0.3.0) as `sandbox run` for one command (macOS run once, Linux in CI only, Windows a written plan). Not around the whole agent. |
| **6. Taint tracking** (Rule of Two: after untrusted input, a step that touches private data and reaches the network needs approval) | outside the model | 0 | microseconds (estimate) | the shape of an injection-driven leak, even when the injected text was never read by a scanner | data passed through a script; untrusted content the tracker did not see enter; the session-level view asks on harmless network steps too | Built (0.2.0): marks come from the shape of the action (a web fetch, an `mcp__` tool, a read outside the project), not from reading the content |

### What each would get wrong alone

- **Rules in context alone** is "hope for the best". Public reports of agents deleting a home folder, or a production database during an explicit code freeze, show that telling a model not to is not enough.
- **A guard model alone** has the same weakness as the agent: text can fool it. It also costs a second model call on every checked item, which is the token cost the maintainer asked about, moved rather than removed.
- **Deterministic checks alone** miss anything they cannot see, and the parser is not a full shell.
- **A sandbox alone** does not know intent: `rm -rf src` inside the project is allowed by any sandbox that lets the agent edit the project.
- **Taint alone** only asks about one combination, and it is coarse.

### What openmorals uses, and why

Layers, deterministic first.

1. **The hook judges every action with deterministic code.** Built (0.3.1). It is cheap, it costs no tokens on allow, and a model cannot argue with it. See [ADR 0004](../adr/0004-enforcement-outside-the-model.md).
2. **When it cannot see, it asks.** Built (0.3.1). A command it cannot read (`curl ... | sh`, a computed command name) and any internal error give ask, not allow. See [ADR 0005](../adr/0005-fail-closed-ask-on-error.md).
3. **Taint covers injection-driven leaks without reading the content.** Built (0.2.0).
4. **A model is an optional second opinion that can only escalate.** Built (0.3.0). It is only consulted on asks, so most calls pay nothing. See [ADR 0007](../adr/0007-reviewer-can-only-escalate.md).
5. **The rules in the context are advice.** Built (0.2.0), opt-in.
6. **The sandbox is the guarantee for what the hook cannot see.** Partly built: `sandbox run` runs one command. Wrapping the whole agent is planned.

### What to build next

Planned, in this order (none of it is built):

1. **Scan inbound content with the existing scanner rules.** Run the install scanner's injection and exfiltration rules over fetched pages and tool results as they arrive (a post-tool hook) and mark the session as tainted when they fire, with the rule and line as evidence. Cost: no tokens, milliseconds. It makes taint depend on what came in, not only on where it came from. Before building, check what each host lets a post-tool hook do with a result (record only, warn the model, or block), from the host's current documentation.
2. **Screen the user's prompt on submit** with the same rules (for example a pasted page carrying hidden instructions), where the host has a prompt-submit hook. Planned; each host's hook must be checked against its current documentation first.
3. **Optional model screening of prompts or tool results,** off by default, escalate-only, with the same frame, redaction and size caps as the reviewer. Only if the deterministic scan proves too weak on a measured corpus.
4. **Run the whole agent inside the sandbox,** so scripts and programs it starts are covered too.

Rejected: putting every rule into the agent's context as the main defence, because it is the one layer a model can ignore. Rejected: a guard model on every prompt and every reply by default, because it doubles model calls and is evaded the same way the agent is.

## Related

- [overview.md](overview.md): the components and how they fit.
- [threat-model.md](threat-model.md): who attacks what, and what stays open.
- [guards.md](guards.md): every guard and rule id, with case counts and known evasions.
- [docs/reviewer.md](../reviewer.md), [docs/sandbox.md](../sandbox.md), [docs/scanner.md](../scanner.md), [docs/extras.md](../extras.md): component details.
