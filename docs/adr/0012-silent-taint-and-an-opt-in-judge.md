# 0012. Inbound findings taint silently; a model judge is opt-in and can only raise

- Status: Accepted
- Date: 2026-11-24 (silent taint built in 0.5.0; judge built in 0.6.0)

## Context

The inbound scan (0.5.0) looks for hidden instructions in tool results and prompts. Anything a hook returns to the agent stays in its context and is re-sent with every later model call, so a notice per finding costs tokens for the rest of the session. A pattern scan also has a weak signal it cannot settle on its own: visible text that reads like an instruction ("ignore previous instructions ...") is sometimes an attack and often documentation or a quoted example.

## Decision

- **Silent taint is the default.** A finding marks the session and writes an audit line (never the content); nothing is sent to the model. The model hears one reason line only when a later step is stopped by the taint guard. A per-finding notice is opt-in (`guards.inbound.notify`). Built (0.5.0).
- **Hidden content is treated as an injection; a visible phrase is only untrusted content.** A strong finding marks the session `injected` (later network or private-data steps ask); a weak one marks it untrusted (only a step that touches private data and reaches the network asks).
- **An opt-in judge for weak findings.** With `guards.inbound.judge: true` in the user-level file, only the flagged lines (at most 1,000 characters, hidden characters removed, redacted) go to the reviewer's provider in a fixed frame. `escalate`, and every failure, upgrades the mark to `injected`; `no-objection` changes nothing. So the judge can only raise a later decision. Built (0.6.0).
- **Cost stays bounded.** Off by default (zero tokens); strong findings and prompts are never sent; answers are cached by a hash of provider, model, endpoint and span (no text in the cache); at most 256 output tokens per call.
- **Only the user can switch it on**, like every setting that sends data or spends tokens ([ADR 0010](0010-the-user-file-is-a-floor.md)).

## Alternatives and why they lost

- **Tell the model about every finding.** Rejected as the default: it costs tokens on every later call and echoes suspicious material into the context.
- **Let the judge clear a finding** (no-objection removes the mark). Rejected: a model can be talked out of a finding by the very text it judges; a judge that can lower a decision becomes the attack surface.
- **Send the whole result to the judge.** Rejected: more tokens and more private text leaving the machine, for no better answer on the flagged lines.
- **Judge prompts too.** Rejected: the user's own words are never blocked for visible text, so a judge could change nothing there.

## Consequences

- With the judge on and no key or no network, every weak finding counts as an injection (fail closed): more asks, never fewer.
- The judge is wired in the Claude Code hook only; the other hosts keep the silent taint.
- Whether the judge improves on the pattern scan has not been measured on a corpus.
