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

## Addendum, 0.41.0: a tool the adapter does not know

The list above named errors. A call the adapter cannot judge because it does not know the tool was not on it: until 0.40.1 a tool name with no mapping was judged only by its arguments, and a hook event the adapter did not handle was allowed. Since 0.41.0 the same rule covers both, on the hosts where it can be applied ([docs/adapters.md](../adapters.md#tools-and-events-openmorals-does-not-know-0410)):

- **A tool name that is not one of the host's documented built-in tools and not an MCP tool asks** (`adapter.unknown-tool`), on Claude Code, Codex CLI and Gemini CLI. It asks once per name per session: when the host reports that a call of that name which openmorals asked about ran, the person approved it, and the name is not asked about again in that session. A report with no asked call before it approves nothing. Where the host cannot ask (Codex, `--unattended`), the call is blocked each time, because a blocked call never runs and so is never approved.
- **A hook event the host does not document, carrying a tool call, is judged** like the pre-tool event instead of being allowed. Documented events openmorals does not judge are left as before.
- **MCP tools keep their own path**, judged on their arguments and by name, until MCP tool classification is built.
- **opencode and OpenClaw are not covered.** There an MCP or plugin tool can have any name, so a new built-in tool cannot be told from one; a tool they do not map is still judged only by its arguments. Both already block an event they do not know.

This adds a case to the decision; it does not change it. The user can allow a name, or switch the check off, in the user-level file (`guards.unknown-tools`); a project file can only make it stricter ([ADR 0010](0010-the-user-file-is-a-floor.md)).
