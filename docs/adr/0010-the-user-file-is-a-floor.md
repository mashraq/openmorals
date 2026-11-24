# 0010. The user-level bylaws are a floor that a project file can only tighten

- Status: Accepted
- Date: 2026-11-24 (built in 0.6.0)

## Context

Up to 0.5.0, `resolveBylaws` used the nearest project `openmorals.yaml` and read the user-level file only when there was none. A project file arrives with the repository, so anyone who can put a file in a repository the user clones could set `destructive: allow`, switch off the budget, the audit log or inbound scanning, trust their own host, or point the reviewer at a model and key variable of their choosing. The guard would then be configured by the party it guards against.

## Decision

- The user-level file in the config directory is loaded first; without one, the built-in defaults are the floor. Built (0.6.0).
- The nearest project file is read on top of it (settings it does not mention come from the floor) and may only tighten: decisions order allow < ask < deny; limits may fall, never rise, and `0` (off) is the loosest; exemption lists may only shrink; protected lists may only grow; switches that turn a check on may not be turned off; the user's rules are kept as written and the project's are added beside them.
- A looser project setting is ignored, never a crash. It is reported three ways: a stderr line from `openmorals check` and `openmorals validate`, a `note bylaws.loosening-ignored` appended to the reason of each verdict, and so the audit record of each decision.
- Settings that decide where data goes or what it costs are read from the user-level file only: the reviewer's provider, model, key variable name, timeout and switch, and `guards.inbound.notify`. Later settings of this kind (reviewer endpoints, the inbound judge, model prices) follow the same rule.
- The comparison is the one `packs.loosenings` already used, now one walk with a "fix" switch (`src/packs/compare.ts`), so reporting a loosening and refusing one cannot disagree.
- An invalid project file still fails closed (ask on everything that would be allowed), but on the user floor rather than the defaults, so a broken file cannot weaken a stricter user setting.

## Alternatives and why they lost

- **Keep "nearest file wins" and warn.** Rejected: a warning does not stop the action, and in unattended runs nobody reads it.
- **Ignore project files entirely.** Rejected: teams and projects legitimately need stricter rules (a production folder that denies deletes), and tightening is safe.
- **Refuse a project file that loosens anything (treat it as invalid).** Rejected: it would turn every such file into an ask-on-everything session, which punishes the user for a file they did not write. Dropping the looser settings keeps the stricter ones working.

## Consequences

- Someone who wants a looser policy for one project must change their own user-level file; a repository cannot do it for them.
- A project file that repeats a user rule with a different pattern adds a second rule beside it; the user's rule is never replaced.
- The team package's "team rules cannot be loosened locally" uses the same idea at another level.
