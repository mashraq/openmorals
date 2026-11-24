# 0006. Ask is the default answer for risky actions, not forbid

- Status: Accepted
- Date: 2026-11-23 (built in 0.1.0)

## Context

The maintainer's request was to not delete folders or online information, to check whether an action really makes sense or was a mistake, and otherwise to ask the user. He framed risky actions as "ask first", not "never". Many deletes, force-pushes and resets are the right thing to do; the problem is doing them by mistake.

## Decision

- Destructive actions, online deletes, secret reads and writes, edits to openmorals' own files, loops and Rule-of-Two cases default to **ask**. Built (0.1.0 to 0.2.0).
- **Deny** is the default only where there is almost never a good reason for an agent to do it: sending a secret over the network, and the hard budget limit. Built (0.1.0).
- The user can set any of these to deny (the `strict` pack does) or to allow, per guard, in `openmorals.yaml`. Built (0.1.0; packs 0.2.0).
- To reduce ask fatigue, the destructive guard names a recoverable alternative in its reason: `openmorals trash <path>`, which the user can undo with `openmorals restore <id>`. Built (0.2.0). `allow_targets` lets the user name build folders that may be deleted without asking.
- Where the host cannot ask (Codex hooks, opencode's V1 plugin API), an ask is sent as a block with a message telling the model to bring the question to the user. Built (0.3.0).
- With nobody to answer (`--unattended`), ask becomes deny. Built (0.2.0).

## Alternatives and why they lost

- **Forbid by default.** Rejected. It blocks legitimate work, pushes users to switch the guard off, and is not what was asked for.
- **Allow by default, log only.** Rejected. A log after a deleted home folder does not bring it back.

## Consequences

- Too many asks train people to click yes. Allowing routine safe actions silently, offering trash, and keeping the reviewer escalate-only are the current answers. Measuring how often users are asked is Planned.
- On hosts that cannot ask, an ask stops the call; the user has to run the command themselves or change the bylaws.
