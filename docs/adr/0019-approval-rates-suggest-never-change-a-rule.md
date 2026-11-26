# 0019. Approval rates suggest an allow; they never change a rule

- Status: Accepted
- Date: 2026-11-26 (decided by the maintainer)

## Context

From 0.37.0, `openmorals audit oversight` counts, for each rule, how often its asks were approved: how often the asked call then ran. People approve the great majority of the prompts they are shown, so a rule that is approved almost every time is giving the person little to decide. The report needs a stated answer to what follows from such a rate: may a rule switch to an allow, or to a refusal, because of it, and may it switch by itself?

## Decision

1. **No rule changes because of its approval rate, in either direction, on its own.** The report reads the log and changes nothing.
2. **A rule asked at least 20 times and approved 95% of the time or more is shown as a candidate for an allow** (`mostly-approved-rule`). It becomes an allow only when the person sets it so in their own bylaws file.
3. **A high approval rate is never a reason to refuse.** Being approved almost every time is evidence that the step is usually fine. Refusals stay where the person sets them, and where an ask would only be retried in a loop ([ADR 0017](0017-refuse-only-where-an-ask-would-loop.md)).
4. The 95% and 20-ask marks are starting points and may change with measurements from real use; a change needs a record of its own.

## Alternatives and why they lost

- **Switch a mostly approved rule to allow automatically.** Rejected: the log shows that a call ran, not that the person meant it or understood it, and a silent loosening is the change a guard most needs to show. The person stays the one who loosens.
- **Let a mostly approved rule become a refusal.** Rejected: it reads the evidence backwards (a step approved nearly every time is usually fine), it would block work people keep approving and push them to switch the guard off, and it goes against ADR 0017's limit on new default refusals.
- **Show nothing.** Rejected: an ask approved nearly every time trains people to click yes, which weakens the asks that matter.

## Consequences

- `mostly-approved-rule` is a reason to look, worded as a candidate for an allow, never as a pass or a fault.
- A person who thinks an ask they keep approving should not be approved can still set that rule to deny in their own file; that is their choice, not the report's.
