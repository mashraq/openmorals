# 0013. A merge verdict decided in CI from the diff; the run record can only raise review

- Status: Accepted; not built yet, except where a line below says so
- Date: 2026-11-24

## Context

Users let agents open pull requests and ask whether some of that work can merge without a person reading it. openmorals already decides single tool calls with deterministic code (ADR 0004) and keeps an audit log of those decisions. Three facts limit what that log can show:
- The hook sees one tool call at a time. What runs inside a script, a test runner or a build step is out of its view (ADR 0004). A `package.json` script edited with a file tool and then run with `npm test` appears as one allowed call.
- The log and the session state are files owned by the same user as the agent. The self-protect guard asks before edits it can see, but a program the agent starts can still change them (threat model).
- If the host cannot start the hook, Claude Code runs the tool and nothing is logged. So the cleanest-looking record is also what a run with no hook at all leaves behind.
An agent stating that it followed principles is text, and cannot be checked.

## Decision

- `openmorals diff-class` classifies a diff, as computed by CI between the base and the head, into class A (may merge without human review) or class B (human review). It reads the base branch's `openmorals.yaml` `merge:` section, and a project file can only narrow it. It fails closed: input it cannot read is class B (ADR 0005).
- Class A is off by default. It is switched on only in the user-level file or a team file, never in a project file (ADR 0010). When on, class A is limited to:
  - A1: changes that can only tighten the declared policy. Added case rows whose expected decision is ask or deny; bylaws changes for which `loosenings()` is empty; protected or deny lists that only grow.
  - A2: a diff equal, byte for byte, to the output of a deterministic, network-free tool pinned in the base branch, run by CI.
  - A3: an opt-in docs tier, under conditions to be written in `docs/merge-verdict.md` when it is built. Switching it on shows its measured miss rate on a seeded docs-injection corpus.
- Always class B, whatever else holds: CI configuration, `CODEOWNERS`, manifests and lockfiles, build and install scripts, executable source and test files, test-runner configuration, agent-instruction files and host configuration, `README`, `SECURITY`, `LICENSE` and `NOTICE` files, the classifier's own rules, and any path declared regulated.
- The run's audit record is an input that can only raise the class. A deny, an approved ask, a taint mark, an ignored loosening, a break in the record's sequence or chain, or a missing record when a run was declared each make the change class B. A clean record never makes a change class A.
- The verdict is meaningful only when CI computes it from the base branch's code, posts it as a required status pinned to an app identity the agent holds no credential for, runs the tests itself, and merging does not publish. `diff-class` states which of these it cannot see, and the documentation shows a workflow that meets them.
- The audit log is hardened in place: each record carries a per-session sequence number, the hash of the previous record in its session, a digest of the bylaws in force, the openmorals version, the host event, the run id and the host's agent id. The outcome of each ask is logged. `openmorals audit verify` reports edits, gaps, truncation and sequence restarts. A missing log is reported as missing, not as empty (built in 0.6.2). This makes careless loss and truncation visible. It does not stop a program running as the user from rewriting the log and recomputing the chain. Only an OS sandbox around the agent's commands, or a copy of each chain head held elsewhere, does that.
- For class B, the verdict names in one to three lines the facts that put the change there, so a reviewer knows where to look.
- A separate team package may pin the class for many repositories, run the verdict as an organisation-level check, and hold copies of chain heads. It uses the same public rules.
- No model call is part of the verdict.

## Alternatives and why they lost

- **A wider low-risk class (small diffs, docs, tests that ran, a clean record).** Rejected. Size does not bound effect. Documents are instructions to the next agent. "Tests ran" is reported by the agent's own environment. A clean record is also what a missing hook leaves.
- **Letting a clean record lower the review level.** Rejected for the reason in ADR 0007: a component the agent can fool or edit may add review, never remove it.
- **A model that approves low-risk changes.** Rejected, as in ADR 0007 and 0012.
- **A separate evidence-record format.** Rejected. The trustworthy evidence is what CI computes. The existing log is kept as an escalation input and hardened.
- **Executable test files in class A.** Rejected. A new test is code that runs in every later CI run and on every developer machine.
- **openmorals merging changes itself.** Rejected. The host's own auto-merge consumes the required check. openmorals holds no credential that can merge (ROADMAP, "Not planned").

## Consequences

- Most agent changes remain class B. On this repository's history to 24 Nov 2026, the default class would have covered none of 43 commits, and the docs tier two. The class widens only on measured evidence: the escape rate of seeded changes in `openmorals eval`, and revert rates on real pull requests.
- Every part costs zero model tokens. Per-call cost is one hash and one extra field write.
- A hostile agent on a machine with no OS sandbox can still rewrite its own record. Such a record is good for finding careless gaps and for escalation, not as proof.
