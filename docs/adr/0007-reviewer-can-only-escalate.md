# 0007. The reviewer model can only escalate, never approve

- Status: Accepted
- Date: 2026-11-23 (built in 0.3.0)

## Context

Pattern rules cannot judge intent. A second model with no tools could look at an action and ask "is this really what the user wants, or a mistake?". But a model can be fooled by text inside the action it reviews, and a model call costs tokens, time and a network connection.

## Decision

- The reviewer is **off by default** (`reviewer.enabled: false`). Built (0.3.0).
- It is called **only for actions the guards already marked ask**, so most tool calls never reach it. Built (0.3.0).
- It answers escalate or no-objection. **No-objection keeps the ask** (with the reviewer's note added to the reason). **Escalate keeps the ask, or turns it into a deny** when `reviewer.on_escalate: deny`. It can never produce allow; this is a property of the types and is tested over every combination. Built (0.3.0).
- Any failure (timeout, network error, missing key, a refusal, a reply that cannot be parsed) keeps the ask. Built (0.3.0).
- What is sent: a fixed instruction frame, and the redacted action text, the guard's reason and a short redacted context (the project folder and the last five step descriptions) as data between boundary lines with a random nonce. Caps: the action whole within 4,000 characters (otherwise it is not sent and the answer is escalate), context cut to the last 2,000 characters, the message capped at 12,000 characters. Built (0.3.0).
- Default model: the smallest current model of the configured provider (Anthropic Messages API); a `fake` provider sends nothing. Built (0.3.0).
- Where it runs: the Claude Code hook and `openmorals check --review`. Not on Codex, Gemini CLI or opencode yet (Planned). Not in `--unattended` runs, where an ask is already a deny.

## Alternatives and why they lost

- **A reviewer that can approve asks.** Rejected. A fooled reviewer would then let through exactly the actions it was meant to catch.
- **A reviewer on every tool call.** Rejected. It would add a model call to each step and spend tokens on actions nobody worried about.
- **No reviewer.** Kept as the default. The reviewer exists for users who want a second opinion before being asked.

## Consequences

- The worst a fooled reviewer can do is add nothing.
- Turning it on sends redacted action text to a model provider. Redaction is pattern-based, so an unknown secret format could pass. This is stated where it is configured ([docs/reviewer.md](../reviewer.md)).
- The reviewer has never called a real API; its request shape is tested against a fake `fetch`.
