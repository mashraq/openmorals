# Reviewer (second-model check on `ask` decisions)

## Wiring needed

Nothing below is wired yet; the module only exports functions from `src/reviewer/index.ts`.

- **Package entry point** (`src/index.ts`): add
  `export * from './reviewer/index.js';` or, to keep the surface small:
  `reviewAction`, `applyReview`, `createAnthropicProvider`, `createFakeProvider`,
  `parseReviewReply`, `buildReviewPrompt`, `DEFAULT_REVIEW_MODEL` and the types
  `Review`, `ReviewVerdict`, `ReviewProvider`, `ReviewOutcome`, `ReviewOptions`.
- **Claude Code hook** (`src/adapters/claude-code.ts`): after `decide()` returns `ask`, and only
  when the reviewer is switched on, call `reviewAction({ action, verdict, context }, provider, opts)`
  and print `outcome.final` instead of the guard verdict. The hook has a time budget, so pass a
  `timeoutMs` well under the hook timeout. Audit the final verdict (its reason carries the
  reviewer's note).
- **Bylaws schema** (`src/bylaws.ts`, strict validation rejects unknown keys today): a section
  ```yaml
  reviewer:
    enabled: false          # off by default: it sends redacted action text to a model API
    provider: anthropic     # only value for now
    model: claude-haiku-5-5
    api_key_env: ANTHROPIC_API_KEY
    timeout_ms: 8000
    on_escalate: ask        # or deny, for unattended runs
  ```
  mapped to `createAnthropicProvider({ apiKeyEnv })` and `ReviewOptions { model, timeoutMs, onEscalate }`.
- **CLI**: optional `openmorals check --review "<command>"` to show the reviewer's note in the demo.
- **Dependencies**: none. Uses Node's global `fetch` and `node:crypto`.

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
- `createFakeProvider(behaviour)`: no network; replies, fails, throws or hangs as told, and
  records every request. Every test uses it or a fake `fetch`.

Source of the API shape, MEASURED 23 Nov 2026:
- request and response shape, `anthropic-version` value, `x-api-key`, `ANTHROPIC_API_KEY`:
  https://platform.claude.com/docs/en/get-started
- model ids (`claude-haiku-5-5`): https://platform.claude.com/docs/en/about-claude/models/overview
- `stop_reason` values including `refusal` (returned with HTTP 200): https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons

The real API was never called while building this module; the request shape is tested only
against a fake `fetch`.

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
  machine. It is off unless the bylaws switch it on (once wired).
- Redaction is pattern-based; a secret in an unrecognised shape is sent as written.
- Only the Anthropic provider exists; others would implement `ReviewProvider`.
