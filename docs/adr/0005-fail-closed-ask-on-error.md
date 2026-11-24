# 0005. Fail closed: when openmorals cannot judge, it asks

- Status: Accepted
- Date: 2026-11-23 (built in 0.1.0)

## Context

A guard that crashes, cannot read its input or cannot parse a command has to answer something. If that answer is allow, every bug in openmorals becomes a way past it. Some hosts make this worse: Claude Code treats a hook that exits with an unexpected code as a non-blocking error and runs the tool.

## Decision

Any failure gives **ask**, never allow. Built (0.1.0, extended in every release since):

- an invalid `openmorals.yaml`: the defaults are used and openmorals asks (`bylaws.invalid`);
- a guard that throws: ask, or **deny** if the guard is marked hard (the secrets guard is hard by default);
- a user rule that throws: ask, or deny if the rule is hard;
- a command openmorals cannot see into (`curl ... | sh`, a computed command name, `base64 -d | bash`): ask (`parser.opaque`);
- hook input it cannot read, a session file or audit log it cannot write: ask;
- a crash of the CLI while answering a hook: it still prints ask in the host's format and exits 0, so the host reads an answer rather than an error;
- under `--unattended` (CI), every ask becomes deny.

The same rule applies elsewhere: `sandbox run` refuses with exit code 125 and runs nothing when the sandbox tool is missing; the reviewer's failures keep the ask; the scanner reports files it could not check.

## Alternatives and why they lost

- **Fail open (allow on error), to avoid annoying the user.** Rejected. A security tool that fails open teaches attackers to cause errors.
- **Deny on every error.** Rejected as the default, because an interactive user can answer an ask, and a hard deny on a transient error stops work for no reason. Deny is used where nobody can answer (`--unattended`) or where the user marked a rule hard.

## Consequences

- Bugs show up as extra asks, which users report. That is the intended failure mode.
- openmorals cannot fail closed if it never starts. That limit belongs to the host and is stated in the [threat model](../architecture/threat-model.md).
