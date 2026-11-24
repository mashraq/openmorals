# 0009. openmorals never answers "allow" to a host; it stays silent instead

- Status: Accepted
- Date: 2026-11-23 (built in 0.1.0)

## Context

Claude Code's hook protocol accepts `permissionDecision: "allow"`, and that answer skips Claude Code's own permission prompt (from the Claude Code hooks reference, read 23 Nov 2026). Other hosts have similar answers. A guard that answers allow would therefore loosen the host's own safety settings.

## Decision

- When openmorals has no objection, it prints nothing and exits 0, which the host reads as "no decision": its normal permission rules still apply. Built (0.1.0).
- openmorals only ever adds friction (ask or deny). It never grants permission the host would not give on its own. This is also listed as "Not planned" in the [roadmap](../../ROADMAP.md).
- In openmorals' own output (`check`, the audit log) the word allow means only "openmorals has no objection".

## Alternatives and why they lost

- **Answer allow for actions openmorals judges safe, to cut prompts.** Rejected. It would turn a guard into a way around the host's settings, and a parser mistake would then remove a safety prompt instead of adding one.

## Consequences

- Users still see their host's own prompts. openmorals cannot reduce them, only add to them.
- The other hosts follow the same rule (0.3.0): Codex gets no output, Gemini CLI gets `{}` (no decision), and opencode's V2 permission hook keeps the host's own effect and can only make it stricter (see [docs/adapters.md](../adapters.md)).
