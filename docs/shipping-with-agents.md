# Shipping with agents

Status labels: **Built (version)**, **Planned**, **Rejected**. This page describes 0.34.0. Planned items may change or be dropped.

Some small teams now ship almost everything through agents: tiny changes pushed many times a day, each watched before the next; new systems run beside old ones to check they give the same results; agents asked for many versions of a design at once; and a support loop where an agent fixes a reported bug, finds everyone else who hit it in the logs, writes to them and credits their accounts. Often there are no pull requests and no mandatory review. This page says what a guard should do in that way of working, and what openmorals already does.

## Writing to many people, and giving money back

The support loop is where an agent's actions reach the most people. Writing to one customer is ordinary; writing to every customer the logs name is a different act, and so is crediting each of them.

What already holds: the `outbound` guard (0.20.0) asks when a message goes to an address that appeared only inside untrusted output, when a reply adds someone who was not on the thread, and when a blind copy is added; reading logs through a network command or an MCP tool marks the session as having read untrusted content. The opt-in [`outward-actions`](packs/outward-actions.md) pack asks before command-line mail and messaging, and before Stripe charges, refunds and payouts.

**Planned:**

- **A count of the people one session writes to.** Past a line you set, the next send asks once and names everyone on the list. Unattended runs stop there.
- **Credits as money.** Credits, coupons, promotion codes and account balance changes join the pack's spending rules, and so do payment tools reached through MCP, matched by name.

## Pushing small changes often

Small, watched pushes lower the risk of an outage. They do not make a deploy something an agent should do unasked.

**Planned:**

- **A deploy rule in `outward-actions`:** ask before commands that ship code to a running system (for example `vercel deploy --prod`, `fly deploy`, `kubectl apply`, `helm upgrade`, `terraform apply`). A plain `git push` asks only for branches you list, because most pushes are not deploys.
- **The release hold covers deploys.** With a [work order](order.md) set, a deploy asks while the order's last check failed, is missing or is older than the newest change it covers: the next push waits for a check you wrote, not for the agent's word that it watched.

**Rejected:** monitoring, canary analysis and rollback. Those are deploy and observability tools' jobs.

## No pull requests

openmorals never assumed pull requests. [`diff-class`](merge-verdict.md) judges a diff wherever one exists: a pre-push hook, a local gate, CI on a direct push. Nothing is review-free unless you switch a class on, a note or an agent's summary can only add review (0.33.0), and since 0.32.0 an agent is asked before it changes git hook files, so it cannot quietly remove the gate.

**Planned:**

- **A pre-push recipe:** `diff-class --map` as a git `pre-push` hook.
- **Suggested always-review paths** for code where a bug costs money or access (payments, billing, checkout, auth, migrations), to copy into `merge.always_review`. openmorals judges the change, never who wrote it: payment code needs a second look whether an engineer or anyone else wrote it.

## Proving it works

Agents are good at checking their own work in ways no person has patience for. A check counts in openmorals only when code reruns it against a baseline you took: `tests fail-first` (0.17.0) shows a bug test failed before the fix, `tests compare` (0.10.0) shows nothing else was lost, `tests claim` (0.32.0) checks "the tests pass" against your own run, and `order baseline` is yours, not the agent's.

**Planned:** a work-order condition that compares two result files row by row, for running a new system beside an old one on the same inputs. Any row that differs fails unless you approve it, as with `tests compare`.

## Many versions at once, and long watches

Asking for nine versions is one planned spend, not nine accidents; watching a deploy for an hour is many cheap calls. The planned [budget across a tree of agents](../ROADMAP.md) should let you start a run with a stated number of children and a budget for each, and should not let a long run of status checks use up the tool-call budget meant to catch runaway work. The loop check already ignores polling commands such as `tail`, `kubectl logs` and `gh run view`.

## Tools agents build for themselves

When a team replaces a hosted product with a small tool its agents call directly, the agents lose that product's permissions, audit log and approvals. The planned **MCP tool classification** (mark each tool read-only, writes, sends, spends or deletes, and ask for unknown ones) matters more there, because every in-house tool arrives as an unknown MCP tool. A skill or server the agent installs is still checked by `openmorals scan` before install.

None of this is built yet. [ROADMAP.md](../ROADMAP.md) lists what is next.
