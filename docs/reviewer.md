# Reviewer (second-model check on `ask` decisions)

## How it is wired (0.3.0)

- **Bylaws**: the `reviewer` section (schema in [API.md](../API.md#openmoralsyaml-schema-version-1)), off by default:
  ```yaml
  reviewer:
    enabled: false          # off by default: it sends redacted action text to a model API
    provider: anthropic-messages   # or openai-chat, gemini (0.6.0), or fake: a dry run that sends nothing
    model: claude-haiku-5-5
    api_key_env: ANTHROPIC_API_KEY   # the variable's NAME; the key itself never goes in the file
    timeout_ms: 8000        # 100 to 25000, below the hook's 30-second timeout
    on_escalate: ask        # or deny: what a model's escalate does
  ```
- **Claude Code hook**: `openmorals hook claude-code` runs `runClaudeCodeHookReviewed`. When the bylaws are
  valid, `reviewer.enabled` is true and the guards, the loop detector and the taint judge answer `ask`, the
  reviewer sees the action and a short context (the host, the tool, the project folder and the last five
  steps, all redacted) and its note is added to the reason. The audit log records the final answer.
- **Failures keep the ask.** A model's `escalate` honours `on_escalate`; a timeout, HTTP or network error,
  missing key, refusal, unparseable reply or crash keeps the `ask` whatever `on_escalate` says, so a flaky
  network never turns into a hard deny while a person can answer.
- **Unattended runs skip it**: there an `ask` is already a `deny`, and the reviewer can only tighten.
- **CLI**: `openmorals check --review "<command>"` runs the reviewer on an `ask` as the bylaws configure it,
  even with `enabled: false` (the flag is the consent), and prints its verdict on a `reviewer:` line.
- **Other hosts**: the Codex, Gemini CLI and opencode hooks do not call the reviewer in 0.3.0.
- **Package entry point**: `reviewAction`, `reviewVerdict`, `reviewerProvider`, `applyReview`,
  `createAnthropicProvider`, `createFakeProvider`, `parseReviewReply`, `buildReviewPrompt`,
  `DEFAULT_REVIEW_MODEL`, `DRY_RUN_REPLY`, `REVIEW_VERDICTS` and the types.
- **Dependencies**: none. Uses Node's global `fetch` and `node:crypto`.
- **Tested with the fake provider only** (`test/reviewer-wiring.test.ts`: 13 bylaws cases, 13 hook cases, the
  CLI). The global `fetch` is stubbed to fail the run if reached. The real API has never been called.

## What it does

When a guard returns `ask`, the reviewer can show the action to a second, independent model
(no tools, fresh context) and add its opinion to the reason the user sees. It answers one of
two things:

- `escalate`: a careful human should look hard at this (or the review could not be done);
- `no-objection`: the action looks like what the task needs.

**The reviewer cannot approve anything.** `ReviewVerdict` is `'escalate' | 'no-objection'`; there
is no way to express `allow`. `applyReview(verdict, review, onEscalate)` returns
`strictest(verdict.decision, ...)`, so its result is never looser than the guard's decision:
`no-objection` keeps the decision as it was (the user is still asked) and only adds a note;
`escalate` keeps `ask`, or hardens it to `deny` when `onEscalate: 'deny'` (for unattended runs
where nobody can answer a prompt).

Only `ask` decisions are sent. `allow` and `deny` come back unchanged with `sent: false`; the
provider is never called for them.

## What leaves the machine, and how

- The action and context are put in a **fixed frame**: a constant system prompt, then a user
  message whose only variable part is one line of JSON between two boundary lines carrying a
  random nonce. The JSON escapes `<`, `>`, `&`, U+2028/9 and breaks the boundary word, so text
  inside the action cannot close the data block or forge a markup tag. The system prompt tells
  the model the data is untrusted and must be judged, not followed.
- **Redaction**: the action text, the guard's reason and the context go through the core's
  `redact()` (the same function the audit log uses: known token shapes, `Authorization`
  headers, `user:password@` in URLs, `*_TOKEN=`-style assignments, `--password` values, PEM
  private keys) before framing. A write's contents are never part of an `Action`, only its path.
- **Size caps** (defaults): the redacted action must fit whole in 4000 characters, or it is not
  sent and the result is `escalate` (a cut action could hide its dangerous half); context is cut
  to its most recent 2000 characters and marked `context_truncated`; the framed user message
  is capped at 12000 characters; replies over 2000 characters are rejected.

## Strict parsing and failure

The reply must be exactly one JSON object with exactly the keys `verdict` and `reason`
(non-empty, single line, at most 300 characters), surrounded by nothing but whitespace. A code
fence, a sentence before it, a second object, an extra key, `"allow"`, an upper-case verdict:
each is unparseable. Every one of these means `escalate`:

| cause | `review.source` |
|---|---|
| invalid options or nonce | `bad-config` (not sent) |
| action over the cap | `too-large` (not sent) |
| no reply within `timeoutMs` (default 20000 ms) | `timeout` |
| HTTP status not 2xx | `http-error` |
| fetch failed | `network-error` |
| API key variable unset or blank (no request made) | `missing-key` |
| `stop_reason: "refusal"` | `refusal` |
| `stop_reason` other than `end_turn` (for example `max_tokens`) | `incomplete` |
| malformed API response, or reply not in the strict shape | `unparseable` |
| provider threw | `provider-error` |

## Providers

- `createAnthropicProvider({ apiKeyEnv?, env?, fetch?, baseUrl?, anthropicVersion?, maxResponseChars? })`:
  `POST https://api.anthropic.com/v1/messages` with headers `content-type: application/json`,
  `x-api-key: <key from the environment variable, default ANTHROPIC_API_KEY>`,
  `anthropic-version: 2026-10-21`, and body
  `{ model, max_tokens, system, messages: [{ role: "user", content }] }`. It reads only `text`
  content blocks (thinking blocks are skipped), follows no redirects, accepts only an `https`
  base URL, and never puts the key in an error message. Default model: `claude-haiku-5-5`
  (the smallest current model), from `ReviewOptions.model`.
- `createOpenAIChatProvider({ baseUrl?, apiKeyEnv?, env?, fetch?, tokenParam?, systemRole?, maxResponseChars? })`
  (0.6.0, `provider: openai-chat`): `POST {base_url}/chat/completions`, default base
  `https://api.openai.com/v1`, header `authorization: Bearer <key>` (no header with `auth: none`,
  for a local server), body `{ model, messages: [{ role: "system" (or "developer"), content }, { role: "user", content }], max_tokens (or max_completion_tokens) }`.
  It accepts only `finish_reason: "stop"` with a non-empty string `message.content`; a
  `message.refusal` or `content_filter` is `refusal`, `length` and anything else `incomplete`.
  The same client serves OpenAI-compatible services and local servers at their base URL; Ollama
  documents `http://localhost:11434/v1/chat/completions`, a key that clients require "but
  Ollama ignores", and `max_tokens`.
- `createGeminiProvider({ baseUrl?, apiKeyEnv?, env?, fetch?, maxResponseChars? })` (0.6.0,
  `provider: gemini`): `POST {base_url}/v1beta/models/{model}:generateContent`, default base
  `https://generativelanguage.googleapis.com`, header `x-goog-api-key: <key>` (never in the URL),
  body `{ systemInstruction: { parts: [{ text }] }, contents: [{ role: "user", parts: [{ text }] }], generationConfig: { maxOutputTokens } }`.
  It accepts only `finishReason: "STOP"` and joins the text parts (thought parts are skipped);
  `promptFeedback.blockReason` and the stops `SAFETY`, `RECITATION`, `BLOCKLIST`,
  `PROHIBITED_CONTENT`, `SPII`, `LANGUAGE` are `refusal`, `MAX_TOKENS` and anything else
  `incomplete`. A model id must be letters, digits, dots, dashes and underscores, so it cannot
  change the URL path.
- `createFakeProvider(behaviour)`: no network; replies, fails, throws or hangs as told, and
  records every request. Every test uses it or a fake `fetch`.

### Choosing a protocol (0.6.0)

Only the user-level `openmorals.yaml` (in the config directory) can set these; a project file's
`provider`, `model`, `base_url`, `api_key_env`, `auth`, `compat` and `timeout_ms` are ignored
and reported ([ADR 0010](adr/0010-the-user-file-is-a-floor.md), [ADR 0011](adr/0011-reviewer-protocols-not-sdks.md)).

```yaml
reviewer:
  enabled: true
  provider: openai-chat        # anthropic-messages (default; "anthropic" is the 0.3 name) | openai-chat | gemini | fake
  model: gpt-example-mini      # required for openai-chat and gemini
  # api_key_env: OPENAI_API_KEY  # default per protocol: ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY
  # base_url: https://api.openai.com/v1
  # compat: { token_param: max_completion_tokens, system_role: developer }
```

A local server (no key leaves the machine, nothing is billed):

```yaml
reviewer:
  enabled: true
  provider: openai-chat
  model: "qwen3:8b"
  base_url: http://127.0.0.1:11434/v1
  auth: none
```

- `base_url` must be `https`, or `http` only to `localhost`, `127.0.0.0/8` or `[::1]`; no user
  name, password, query or fragment. It is checked when the file loads and again before each
  request, and no redirect is followed, so the key is only ever sent to that host.
- When the file names a protocol but no `api_key_env`, the protocol's own variable is used, so
  switching to `openai-chat` never sends `ANTHROPIC_API_KEY` to another vendor.
- `api_key_env` must look like a variable name, not a key: 1-64 letters, digits and underscores,
  not starting with a digit, all upper case or all lower case, no run of more than 24 characters
  between underscores, and nothing the redactors take for a key. Anything else is refused when the
  file loads, and the error never repeats the value. A CamelCase name is refused too; write it in
  upper case (on Windows that finds the same variable) or export an upper-case copy.
- `compat` applies only to `openai-chat`: OpenAI marks `max_tokens` "deprecated in favor of
  `max_completion_tokens`" and recommends the `developer` role for newer models, while many
  compatible servers accept only `max_tokens` and `system`.
- Not covered: providers that need request signing or a cloud login rather than a key
  (Bedrock, Vertex with application credentials) and subscription logins without an API key.

Source of the API shape, MEASURED 23 Nov 2026:
- request and response shape, `anthropic-version` value, `x-api-key`, `ANTHROPIC_API_KEY`:
  https://platform.claude.com/docs/en/get-started
- model ids (`claude-haiku-5-5`): https://platform.claude.com/docs/en/about-claude/models/overview
- `stop_reason` values including `refusal` (returned with HTTP 200): https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons

Sources for the 0.6.0 protocols, MEASURED 24 Nov 2026:
- Chat Completions (method, path, Bearer header, roles, `max_tokens` deprecation, `refusal`,
  `finish_reason` values): https://developers.openai.com/api/reference/resources/chat
- Ollama's OpenAI-compatible endpoint: https://docs.ollama.com/api/openai-compatibility
- generateContent (path, `systemInstruction`, `contents`, `generationConfig.maxOutputTokens`,
  `finishReason` and `blockReason` values): https://aistudio.google.com/api-reference/generate-content/generate-content
- the `x-goog-api-key` header: https://aistudio.google.com/docs/api-key (its example is the
  `/v1beta/interactions` endpoint on the same host; the generateContent reference example passes
  `?key=` instead. That the header also works for generateContent is INFERRED, not tested.)

No real API was called while building these modules; every request shape is tested only
against a fake `fetch` (`test/reviewer/protocols.test.ts`), and the global `fetch` is stubbed to
fail the run if reached.

## Tests

`test/reviewer/cases.ts` is a table of 36 cases (input decision, action, context, fake provider
behaviour, expected `sent`, provider call count, review verdict and source, final decision, and
strings that must or must not appear in what is sent), including injection attempts inside the
action and the context. `test/reviewer/reviewer.test.ts` also runs an exhaustive check of
`applyReview` over every decision, verdict, source and `onEscalate` value, `@ts-expect-error`
checks that `'allow'` is not a `ReviewVerdict`, the strict parser, and the Anthropic provider
against a fake `fetch`. The global `fetch` is replaced with a stub that fails the run if any
test reaches it.

## Limits, stated plainly

- A reviewer model can be fooled by text in the action. That is why it cannot loosen anything:
  the worst a fooled reviewer can do is say `no-objection`, and the user is still asked.
- It costs a model call and latency per `ask`, and it sends redacted action text off the
  machine. It is off unless the bylaws switch it on.
- Redaction is pattern-based; a secret in an unrecognised shape is sent as written.
- Only the Anthropic provider exists; others would implement `ReviewProvider`.
