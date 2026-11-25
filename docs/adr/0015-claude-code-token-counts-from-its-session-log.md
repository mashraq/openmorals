# 0015. Claude Code token counts come from its session log: usage numbers only

- Status: Accepted. Built in 0.36.0 (`src/tokens/transcript.ts`)
- Date: 2026-11-25

## Context

The budget guard counts tokens only where a host reports them to a hook (ADR 0004 keeps enforcement in code the host calls). Claude Code reports none: no hook input carries a session's token usage, and the two fields that come close (a sub-agent's final request on `PostToolUse`, `context_tokens` on a model switch) are not session counts. So on the most used host a token budget never triggered, and a tree of sub-agents could spend without a limit other than tool calls.

Until 0.36.0 the rule was that openmorals never reads a transcript file. The reason was privacy and trust: a session log holds the whole conversation, including what the user typed and what tools returned, and a guard that reads it could leak it or be steered by it.

Claude Code writes, for each assistant reply, a line in the session log (`transcript_path`, a field of every hook input) with the reply's `message.id` and a `message.usage` object: input, output, cache-creation and cache-read token counts. Sub-agents write their own logs in a `subagents` folder beside it. The format is not documented.

## Decision

1. **Read the numbers, never the text.** For each line the hook reads only `message.id` (or the line's `uuid` when there is none) and the four integer fields of `message.usage`, and only on lines whose `type` is `assistant`. No other field is kept, logged, scanned or sent anywhere.
2. **Count each reply once.** One reply is written as several lines with the same id; a repeat counts only by how far its usage rose. Input, output and cache-creation tokens count toward `guards.budget.tokens`; cache reads are kept apart, because they are cheap and would swamp the figure.
3. **Read only what is new.** The hook keeps, per log file, how far it has read, and reads at most 8 MB per call. A file that shrank is read again from the start.
4. **Fail soft on the count, not on the guard.** A line that cannot be parsed adds nothing. A missing or unreadable log adds nothing. The tool-call budget, which needs no log, still holds. This is the one place where an error adds nothing rather than asking: an ask on every call whenever Claude Code changes its log format would make the guard unusable, and an undercount here can only miss a token limit, never let through an action another guard would stop.
5. **The user can turn it off; a project cannot.** `guards.budget.transcript: false` in the user-level file stops the reads. A project file that sets it is a loosening and is ignored (ADR 0010).

## Alternatives and why they lost

- **Keep tool calls only on Claude Code.** Rejected: tool calls are a weak stand-in for spend, and sub-agent trees are where spend runs away.
- **Claude Code's OpenTelemetry export.** Kept as a later option for headless runs. It needs a collector the user sets up, and it is not available to a hook during an interactive session.
- **A status-line command.** Kept as a later option. It sees live cost, but only while a status line is shown, and it cannot refuse anything.
- **Estimating from the bytes of tool results the hook has seen.** Rejected: it misses the model's own output and every cached re-send, which are most of the spend.

## Consequences

- The count depends on an undocumented format. When Claude Code changes it, the token count can stop without warning; tests pin the shape openmorals reads, and the docs say the count is best effort.
- A hook can still be overshot by the turns already in flight, and a background sub-agent's usage is known only as its log grows.
- The threat model gains one input: a log line is untrusted text, so it is parsed as JSON and only integer fields are used.
