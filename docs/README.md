# openmorals documentation

Start with the [project README](../README.md) for what openmorals does and a 60-second demo. This folder holds everything else.

## Status words

Every document here marks what it describes:

- **Built (version)**: released in that version and tested.
- **Planned**: not built. It may change or be dropped.
- **Rejected**: considered and turned down; the reason is recorded.

Figures are marked as measured (with how and when) or as an estimate.

## Product

| Document | What it covers |
|---|---|
| [product/vision.md](product/vision.md) | the problem, what openmorals is and is not, its principles, where it is going |
| [product/layers.md](product/layers.md) | learn, guard, review, score: what openmorals does at each layer today, and what is planned |
| [product/design-principles-and-limits.md](product/design-principles-and-limits.md) | model-independent, host-dependent; what openmorals does not do and what to use instead; the limits that matter most |
| [product/prd.md](product/prd.md) | users, goals, non-goals, user stories, release scope, risks |
| [product/features.md](product/features.md) | every feature with its status |
| [product/requirements.md](product/requirements.md) | numbered requirements with status and the test that checks each |
| [product/requirements-log.md](product/requirements-log.md) | where the former decision log went (CHANGELOG.md and the ADRs), the decisions it recorded with their ADRs, and the known defects |
| [product/direction.md](product/direction.md) | proposed direction, not decided: four promises (safe through the whole session, affordable, verifiable, any model or agent), scenarios, proposed requirements DR-1 to DR-18, order of work, open questions |

## Architecture

| Document | What it covers |
|---|---|
| [architecture/overview.md](architecture/overview.md) | the components, where data lives, runtime and distribution |
| [architecture/enforcement-model.md](architecture/enforcement-model.md) | how actions are checked outside the model, what it costs in tokens and time, the six ways to guard an agent compared, and what to build next |
| [architecture/threat-model.md](architecture/threat-model.md) | assets, attackers, trust boundaries, threats and mitigations, what has and has not been run |
| [architecture/guards.md](architecture/guards.md) | every guard and rule id: what it catches, its default, its case count (with the command to recount) and known evasions |
| [architecture/multi-agent-guards.md](architecture/multi-agent-guards.md) | how the rules stay in force across sub-agents, handoffs and compaction, the known limits, and what you can do now |

## Decisions (ADRs)

One decision per file: context, decision, alternatives and why they lost, consequences, status and date. Numbers are never reused; a changed decision gets a new record that supersedes the old one.

| # | Decision |
|---|---|
| [0001](adr/0001-a-guard-layer-not-a-factory-platform-or-standard.md) | A guard layer, not an agent factory, an agent platform or a new standard |
| [0002](adr/0002-typescript-on-node-as-the-one-engine.md) | TypeScript on Node as the one engine; a binary and a Python wrapper are distribution, not rewrites |
| [0003](adr/0003-apache-2-core-and-a-separate-team-package.md) | Apache-2.0 for this repository; team features in a separate package |
| [0004](adr/0004-enforcement-outside-the-model.md) | Enforcement runs outside the model, as deterministic code at action time |
| [0005](adr/0005-fail-closed-ask-on-error.md) | Fail closed: when openmorals cannot judge, it asks |
| [0006](adr/0006-ask-by-default-not-forbid.md) | Ask is the default answer for risky actions, not forbid |
| [0007](adr/0007-reviewer-can-only-escalate.md) | The reviewer model can only escalate, never approve |
| [0008](adr/0008-windows-three-dialects-keep-the-strictest.md) | On Windows, read every command in three shell dialects and keep the strictest answer |
| [0009](adr/0009-never-grant-permission-the-host-would-not.md) | openmorals never answers "allow" to a host; it stays silent instead |
| [0010](adr/0010-the-user-file-is-a-floor.md) | The user-level bylaws are a floor that a project file can only tighten |
| [0011](adr/0011-reviewer-protocols-not-sdks.md) | The reviewer speaks three wire protocols through small hand-written clients |
| [0012](adr/0012-silent-taint-and-an-opt-in-judge.md) | Inbound findings taint silently; a model judge is opt-in and can only raise |
| [0013](adr/0013-a-merge-verdict-decided-in-ci-the-record-can-only-raise-review.md) | A merge verdict decided in CI from the diff; the run record can only raise review (classes A1 and A2 built in 0.12.0; the docs tier not built) |
| [0014](adr/0014-the-checker-can-only-refuse-ask-or-report.md) | The checker holds no power to act: it refuses, asks or reports; no model lowers a decision; approvals come only from the user |

## Components

| Document | What it covers |
|---|---|
| [adapters.md](adapters.md) | Codex CLI, Gemini CLI and opencode: mechanisms, sources and dates, what each host can express |
| [integrations.md](integrations.md) | where a guard can sit around any model and any agent (hooks, framework adapters, a model API proxy, an MCP proxy, the sandbox, a browser extension, logs), what each can and cannot do, what is built and what is planned, and what openmorals will not claim |
| [scanner.md](scanner.md) | the install scanner: rules, caps, tests, limits |
| [reviewer.md](reviewer.md) | the second-model reviewer: wiring, what leaves the machine, parsing and failure |
| [sandbox.md](sandbox.md) | the OS sandbox: plans per platform, what was run |
| [extras.md](extras.md) | trash and undo, guidance writer, loop detector, taint tracker, policy packs, a pack's principles and disclaimer (0.25.0) |
| [packs/information-security.md](packs/information-security.md) | the `information-security` pack (0.26.0): rules, the guards it sets, principles checked and advice only, what it does not cover, false alarms, measured cost |
| [packs/outward-actions.md](packs/outward-actions.md) | the `outward-actions` pack (0.26.0): rules, the guards it sets, principles checked and advice only, what it does not cover, false alarms, measured cost |
| [packs/privacy.md](packs/privacy.md) | the `privacy` pack (0.31.0): rules (one refuses identifiers sent over the network), the guard it sets, principles checked and advice only, what it does not cover, false alarms, measured cost |
| [packs/health-data.md](packs/health-data.md) | the `health-data` pack (0.31.0): its fixed first line and disclaimer, rules, clinical paths (ask on write, marked on read), principles checked and advice only, what it does not cover, false alarms, measured cost |
| [packs/regulated-software.md](packs/regulated-software.md) | the `regulated-software` pack (0.31.0): rules, declared paths and `merge.always_review`, principles checked and advice only, what it does not cover, false alarms, measured cost |
| [outbound.md](outbound.md) | where a form, a message or a link sends data: the outbound guard's signals and rule ids, the two denies, once per site and field, the `sites`, `protect` (0.23.0) and `data_classes` settings, what the session keeps (hashes), what it cannot see, the bundled data |
| [delete.md](delete.md) | deleting any file (0.21.0): the delete guard refuses a plain delete the project trash can take with `openmorals trash <path>` named, asks where it cannot, refuses a path built at run time; since 0.22.0 also a move into a temp folder, `mv`/`cp` onto an existing file, and documents inside the project like any file; the line at your next message; `purge` lists and asks; settings, limits, what was measured |
| [replace.md](replace.md) | replacing a file whole (0.24.0, off by default): `guards.replace.steer: keep` refuses the Write tool, `> file`, `tee`, `sed -i` and `perl -i` over an existing file with no `.git` above it until `openmorals trash --copy <path>` keeps a copy; when a copy counts (sha256 in the undo log, the session's own output), asks, restore and purge, cost, limits |
| [deferred-asks.md](deferred-asks.md) | holding a deletion or document ask for the person while the agent carries on: when it holds, the code and the approval channels, what an approval is bound to, the queue files, failure, what is and is not guaranteed (Claude Code) |
| [audit.md](audit.md) | the audit record: its fields, the per-session hash chain, `audit verify`, `audit --run` and `audit sample`, and what they cannot show |
| [tests-compare.md](tests-compare.md) | `openmorals tests compare`: two test reports compared by test name, approvals, exit codes for a local gate, and what it cannot tell |
| [tests-fail-first.md](tests-fail-first.md) | `openmorals tests fail-first`: the change's test files run on the base commit from your own gate; per test, red by assertion, red for the wrong reason, or passing on base; the user-level test command, exit codes, cleanup and what it cannot tell |
| [tests-guard.md](tests-guard.md) | 0.32.0: `tests provenance` (which test files the agent wrote), `tests claim` (does what it said passed pass in your clean run), held flaky tests in `tests-quarantine.txt`, and `tests coverage` (which files lost coverage) |
| [packages.md](packages.md) | 0.32.0: the `packages` guard: an install of a package the project's manifest and lockfile do not list; what it reads, what it misses |
| [learn.md](learn.md) | 0.35.0: the `learn` guard: what an agent writes into instructions files, memory notes and skills; the scans, the token budget, the check after untrusted content, and what it misses |
| [order.md](order.md) | `openmorals order` (0.27.0): a work order written and approved before the work; the 14 conditions, the office baseline and before-after checks (0.30.0), approval and edits shown as loosenings or tightenings, templates that only grow, the check's exit codes and record, what a pass does not show, a worked code order and a worked office order, when it would be narrowed. The release hold (0.28.0): which outward steps on which files are held while the last check failed, is missing or is stale, which order counts, what a hold does not show |
| [daily.md](daily.md) | Daily guidance (0.29.0), advice only, not checked: the `daily` pack, tier 0, the three skills, the opt-in first-activity note from the hook, what each costs (measured), how to turn each on and off, how an activity is recognised. [daily-risks.md](daily-risks.md): the 29-risk catalogue with what this release checks for each (generated) |
| [merge-verdict.md](merge-verdict.md) | `openmorals diff-class`: the merge verdict from a diff, the classes (off by default), what always needs review, the run record, what it cannot see, a local gate |
| [test-integrity.md](test-integrity.md) | the test-integrity reason lines of `diff-class`: each rule's id, published pattern, what it misses and fire rate; declared paths, boundaries and size line |
| [review-map.md](review-map.md) | 0.33.0: `diff-class --map` (files riskiest first, a suggested split for an oversized change) and `--note` (a review bot's or an AI summary's note can only add review) |
| [cost-control.md](cost-control.md) | token and cost control: where agent tokens go (measured), what the budget guard does today, host settings you can use now, what a hook can and cannot enforce, and the planned budget ledger for agents that spawn agents |
| [swarms-and-memory.md](swarms-and-memory.md) | many agents and agent memory: guarding the shared store and the landing gate when agents work as a team, and the check on what an agent writes into files loaded at every session start (built in 0.35.0) |
| [shipping-with-agents.md](shipping-with-agents.md) | teams that ship through agents: a count of the people one session writes to, credits treated as money, a deploy rule and the release hold over deploys, review without pull requests, proving a change works, and tools agents build for themselves |
| [eval.md](eval.md) | `openmorals eval`: catch rate, false alarms and time per decision for every guard, the row format for your own rows, session rows run step by step through the hook, and rescoring when packs, skills or the model change (0.34.0) |
| [evaluation-plan.md](evaluation-plan.md) | Planned: how to prove openmorals works on any model and any agent, over-blocking, rules across turns, compaction and sub-agents, token savings, adaptive attacks, public benchmarks, when each check runs |
| [comparison.md](comparison.md) | a fact sheet: openmorals beside host controls, guardrail libraries, classifiers, gateways, sandboxes and other policy hooks; what each screens, where it runs, how it fails, what openmorals does not do |
| [distribution.md](distribution.md) | npm, the single-file binary and the Python package: how each is built and verified, and what has been run where |

## Elsewhere in the repository

| Document | What it covers |
|---|---|
| [README.md](../README.md) | what it is, demo, use with each host, limits |
| [API.md](../API.md) | the library API and the `openmorals.yaml` schema |
| [ROADMAP.md](../ROADMAP.md) | what is planned next |
| [CHANGELOG.md](../CHANGELOG.md) | what each release added |
| [SECURITY.md](../SECURITY.md) | how to report a security hole |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | how to contribute (DCO sign-off) |
| [cases/](../cases/) | the guard case tables |
| [packs/](../packs/) | ready-made bylaws |

## Keeping these documents true

- When a feature ships, change its status in [features.md](product/features.md) and [requirements.md](product/requirements.md) in the same change, and add an entry to [CHANGELOG.md](../CHANGELOG.md).
- When a decision changes, write a new ADR and mark the old one superseded; do not rewrite history.
- Do not copy case counts into prose; point to the command in [guards.md](architecture/guards.md).
