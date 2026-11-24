# 0011. The reviewer speaks three wire protocols through small hand-written clients

- Status: Accepted
- Date: 2026-11-24 (built in 0.6.0)

## Context

Up to 0.5.0 the reviewer ([ADR 0007](0007-reviewer-can-only-escalate.md)) had one client, for the Anthropic Messages API. People run many models: hosted ones from several vendors and local ones on their own machine. The reviewer's needs are small: one system prompt, one user message, one short text reply, no tools, no streaming. Its safety rests on properties already built: the key read at call time and placed only in a header, no redirects, a size cap on the reply, a strict parse, and every failure is `escalate`.

## Decision

- Clients are keyed by **protocol**, not by vendor: `anthropic-messages`, `openai-chat` and `gemini`. Each is a small module on the global `fetch` (`src/reviewer/anthropic.ts`, `openai-chat.ts`, `gemini.ts`) sharing one helper for the URL policy, the key and the POST (`http.ts`). No dependency was added. Built (0.6.0).
- `openai-chat` covers OpenAI and the services and local servers that speak the same Chat Completions shape (Ollama, LM Studio, vLLM, llama.cpp) through `base_url`, with `auth: none` for a server that needs no key and a small `compat` block for the two known differences (`max_tokens` or `max_completion_tokens`; `system` or `developer` role).
- Where data goes and with which credential is set only in the user-level file ([ADR 0010](0010-the-user-file-is-a-floor.md)): `provider`, `model`, `base_url`, `api_key_env`, `auth`, `compat`, `timeout_ms`. `base_url` must be https, or http to this machine only, with no user name, password, query or fragment; it is checked at load and before each request. A protocol named without `api_key_env` reads its own variable, so a key is never sent to another vendor.
- Every reply that is not one finished text answer (refusal, content filter, safety stop, truncation, wrong shape, HTTP error, redirect, oversize body) is a failure, so the review escalates and the ask stays. The type-level rule is unchanged: a reviewer cannot produce `allow`.
- Tests use a fake `fetch` only; the global `fetch` is stubbed to fail the run if reached.

## Alternatives and why they lost

- **A multi-provider SDK.** Rejected: several packages and a peer dependency for a one-turn text call, and the key and redirect handling would sit in code openmorals does not control.
- **A provider catalogue fetched at run time** (base URLs, key variables, prices). Rejected: a compromised catalogue could pair a key variable with its own URL. A catalogue could only ever be a local file the user supplies.
- **Shelling out to the user's agent CLI as the reviewer.** Rejected for now: the child is a full agent with tools unless switched off, its own hooks could call openmorals again, and it adds seconds per ask.
- **An external command (JSON over stdin) as a fourth protocol.** Deferred: it is the way to reach signed or login-based providers (Bedrock, Vertex, subscription logins) later, but it is code execution from configuration and needs the same care as the guards.

## Consequences

- Three request and response shapes to keep current. A server that drifts produces `escalate`, never an allow.
- Providers that need request signing or a cloud login, and subscription logins without an API key, are not reachable yet.
- The reviewer still only runs in the Claude Code hook and `openmorals check --review`.
