# 0017. New default refusals only where an ask would loop; otherwise ask

- Status: Accepted. Supersedes [ADR 0006](0006-ask-by-default-not-forbid.md) in part: its list of what is refused by default. The rest of ADR 0006 stands
- Date: 2026-11-25 (decided by the maintainer; written 2026-11-26)

## Context

ADR 0006 made ask the default for risky actions and limited default refusals to two cases: a secret sent over the network, and the hard budget limit.

That list is already out of date. Built guards refuse by default in more places, each recorded in its [CHANGELOG](../../CHANGELOG.md) entry: `delete.trash` and `delete.blind` (0.21.0), the two outbound combinations (0.20.0: a password or code typed into a look-alike of one of your sites, and a one-time code typed into a site its message did not name), and `budget.stopped` after `openmorals stop` (0.36.0). Most are steers: the refusal names a recoverable way to do the same thing, such as `openmorals trash`.

Planned work proposed more refusals by default: an agent started with its permission prompts switched off, a child agent given a looser mode or looser rules than its parent, and limits on how many sub-agents start and how deep they nest.

## Decision

1. **A new default refusal is allowed only where an ask would be retried in a loop.** Two cases are named:
   - a command that starts an agent with its permission prompts or sandbox switched off (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`, `bypassPermissions`, `--yolo` and the like), because the agent it starts would never ask again, and an agent refused once tends to retry with another spelling;
   - a sub-agent start that was already refused or declined once in the session, tried again, because asking the person the same question again trains them to say yes.
   Both are Planned. Neither is built.
2. **Everything else that is new asks by default**, including a looser mode or looser rules for a child agent and the sub-agent limits. The spawn and fan-out limits built in 0.36.0 already ask, and stay that way.
3. **A guard that asks is switched by default, to a refusal that names a recoverable alternative or to silence, only when its median asks per active hour, on recorded real use, pass 3.** The switch needs a record of its own, citing the measurement. Nothing has been measured at that scale yet: the first live run ([live-runs/2026-11-26-claude-code.md](../live-runs/2026-11-26-claude-code.md)) was a few short headless runs.
4. **Refusals already built stay as they are.** This record does not change them; each is reviewed against statement 1 once there are measurements from real use.
5. **Unchanged from ADR 0006:** you can set any guard to ask, deny or allow in your own file (a project file can only tighten, [ADR 0010](0010-the-user-file-is-a-floor.md)); with nobody to answer (`--unattended`), every ask is a refusal.

## Alternatives and why they lost

- **Refuse everything proposed.** Rejected: it blocks legitimate work (a child agent with a narrower mode is often right), pushes people to switch the guard off, and goes against ADR 0006.
- **Ask for the skip-permission launch too.** Rejected: a yes gives an agent that never asks again, so one answer stands in for every later one, and on hosts that cannot ask, an ask is a block anyway. You can start such an agent yourself.
- **Switch a guard as soon as the whole layer misses its pass mark** (under 1 ask per 100 harmless calls). Rejected: that figure is a pass mark for the layer, not a reason to refuse. A guard that asks too often should first be made to ask less; refusing is the last step.

## Consequences

- The refusal of a skip-permission agent launch can be built under this record, with case rows for each spelling and harmless twins (`--help`, the flag inside a quoted string or a document).
- The over-blocking measured in the first live run (about 9 asks per 100 harmless calls) came from two other causes, not from any refusal: a declined ask still marked the session, and `rm -f` of one file asks. Neither is decided by this record.
