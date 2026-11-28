# 0021. An embedded check and a run wrapper: local, no listener, the calling program decides

- Status: Accepted
- Date: 2026-11-28 (decided by the maintainer)

## Context

openmorals reaches an agent through its host's hook: the host waits for the answer before the call runs ([ADR 0004](0004-enforcement-outside-the-model.md)). Five hosts have one. A program that drives a model itself, with its own tool loop, has no hook to install, and the only check it could call before 0.43.0 was `decide`, which reads no user file and keeps no session ([API.md](../../API.md#what-a-library-check-is-not)).

Three forms were planned for such programs, in this order:

1. `guardCall`, a TypeScript function (built in 0.43.0);
2. the same check as a command that reads one request on standard input, and a Python call over it (planned);
3. a command that starts a host's agent after checking that its hook is installed (planned).

Each could be built as a server instead: a local port, a socket, an MCP server, an endpoint a gateway calls. This record says how all three are built, so the two that are planned do not need a record of their own.

## Decision

1. **Local, and no listener.** Each form runs inside the calling program's process, or as a child process it starts, on the same machine. None opens a port, a socket or any other listener, and none forwards traffic. They hold no credential. [ADR 0016](0016-no-proxy-or-gateway-for-now.md) stands unchanged: these are the "local pieces that hold no credential and forward nothing" of its point 4. A listener of any kind needs its own record first.
2. **Advice, not enforcement.** An embedded check answers the program that asks. That program decides whether to call it, and whether to obey. Nothing stops a program that never calls it or ignores the answer, so the docs never describe it with the hook's promises. A program with no person to answer an ask passes `unattended`, and an ask becomes a deny. The docs say plainly: never treat ask as allow.
3. **The user's policy always applies, and the caller cannot choose the guards.** The check takes no guards, rules or policy argument. It reads the user file, then the project file over it (which can only tighten, [ADR 0010](0010-the-user-file-is-a-floor.md)), then runs the built-in guards and the session's memory. A request that carries guards, a policy or an unknown key asks, so nobody believes it took effect. A session id is required, so the history the guards need is kept.
4. **A caller's guard cannot approve.** Where a building block (`decide`) does take a guard list, a guard that answers allow is dropped and only objections count. The embedded check takes none at all. A program's own checks can only be stricter than the answer, never looser, because the program applies them after it.
5. **No model approves anything.** The embedded check calls no model and spends no tokens. The optional reviewer, where it runs (the Claude Code hook only), can only make an answer stricter ([ADR 0007](0007-reviewer-can-only-escalate.md)).
6. **It never throws.** Anything it cannot read as given asks, with a rule that says so; an internal failure asks; a failure to save the session or write the audit line turns an allow into an ask.
7. **One pipeline.** The embedded check is the pipeline four of the hooks already share, under a public name; it is not a second engine. A test sends the shipped guard rows through it and through the Claude Code hook and requires the same answers, except where a feature only the Claude Code hook has is named.
8. **Preview.** The request and answer shapes are Preview ([ADR 0020](0020-what-is-stable-before-1-0.md)): a live run may still change them.

For the planned forms the same holds. The standard-input command reads one request, prints one answer and exits; an unreadable request asks, and it never exits as allowed. The run wrapper checks that the host's hook is installed and refuses to start the agent otherwise; it passes an argument list, never a shell line; it does not contain files or the network and is never described as if it did.

## Alternatives and why they lost

- **A local server or an MCP server** that programs and agents call. Rejected: it adds a listener for nothing the in-process call or the standard-input command lacks, and a check the agent itself chooses to call is advice the agent can skip ([ADR 0004](0004-enforcement-outside-the-model.md)).
- **Let the caller pass its own guards or policy.** Rejected: an empty list would allow everything, and a program could quietly run without the user's file. The user's file is the floor on every path that reads it.
- **Fold the Claude Code hook onto the same pipeline first.** Rejected for now: it rewrites the one path that has been run live, before the next measurement. The differential test stands in; a difference outside the named features would make the fold a fix.
- **Promise the request shape as Stable.** Rejected: nothing has been run live through it yet.

## Consequences

- `API.md` documents `guardCall`, its fields and what it does not cover, and keeps it in the Preview tier.
- Deferred asks, the reviewer, the token budget and the run budget stay on the Claude Code hook only, and the docs say so.
- A program can point the config folder elsewhere through the environment, as any code in the same process can. This is stated, not prevented: the check is advice inside the program.
- The standard-input command and the run wrapper stay Planned until they are built under this record.
