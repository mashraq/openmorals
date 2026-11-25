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
| [product/prd.md](product/prd.md) | users, goals, non-goals, user stories, release scope, risks |
| [product/features.md](product/features.md) | every feature with its status |
| [product/requirements.md](product/requirements.md) | numbered requirements with status and the test that checks each |
| [product/requirements-log.md](product/requirements-log.md) | append-only, dated log of what was asked, decided and built; known defects |

## Architecture

| Document | What it covers |
|---|---|
| [architecture/overview.md](architecture/overview.md) | the components, where data lives, runtime and distribution |
| [architecture/enforcement-model.md](architecture/enforcement-model.md) | how actions are checked outside the model, what it costs in tokens and time, the six ways to guard an agent compared, and what to build next |
| [architecture/threat-model.md](architecture/threat-model.md) | assets, attackers, trust boundaries, threats and mitigations, what has and has not been run |
| [architecture/guards.md](architecture/guards.md) | every guard and rule id: what it catches, its default, its case count (with the command to recount) and known evasions |

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
| [scanner.md](scanner.md) | the install scanner: rules, caps, tests, limits |
| [reviewer.md](reviewer.md) | the second-model reviewer: wiring, what leaves the machine, parsing and failure |
| [sandbox.md](sandbox.md) | the OS sandbox: plans per platform, what was run |
| [extras.md](extras.md) | trash and undo, guidance writer, loop detector, taint tracker, policy packs |
| [outbound.md](outbound.md) | where a form, a message or a link sends data: the outbound guard's signals and rule ids, the two denies, once per site and field, the `sites` and `data_classes` settings, what the session keeps (hashes), what it cannot see, the bundled data |
| [delete.md](delete.md) | deleting any file (0.21.0): the delete guard refuses a plain delete the project trash can take with `openmorals trash <path>` named, asks where it cannot, refuses a path built at run time; the line at your next message; `purge` lists and asks; settings, limits, what was measured |
| [deferred-asks.md](deferred-asks.md) | holding a deletion or document ask for the person while the agent carries on: when it holds, the code and the approval channels, what an approval is bound to, the queue files, failure, what is and is not guaranteed (Claude Code) |
| [audit.md](audit.md) | the audit record: its fields, the per-session hash chain, `audit verify`, `audit --run` and `audit sample`, and what they cannot show |
| [tests-compare.md](tests-compare.md) | `openmorals tests compare`: two test reports compared by test name, approvals, exit codes for a local gate, and what it cannot tell |
| [tests-fail-first.md](tests-fail-first.md) | `openmorals tests fail-first`: the change's test files run on the base commit from your own gate; per test, red by assertion, red for the wrong reason, or passing on base; the user-level test command, exit codes, cleanup and what it cannot tell |
| [merge-verdict.md](merge-verdict.md) | `openmorals diff-class`: the merge verdict from a diff, the classes (off by default), what always needs review, the run record, what it cannot see, a local gate |
| [test-integrity.md](test-integrity.md) | the test-integrity reason lines of `diff-class`: each rule's id, published pattern, what it misses and fire rate; declared paths, boundaries and size line |
| [eval.md](eval.md) | `openmorals eval`: catch rate, false alarms and time per decision for every guard, the row format for your own rows |
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

- When a feature ships, change its status in [features.md](product/features.md) and [requirements.md](product/requirements.md) in the same change, and add a dated entry to [requirements-log.md](product/requirements-log.md).
- When a decision changes, write a new ADR and mark the old one superseded; do not rewrite history.
- Do not copy case counts into prose; point to the command in [guards.md](architecture/guards.md).
