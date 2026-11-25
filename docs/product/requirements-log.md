# Requirements log

This page used to hold a dated, append-only log of what was requested, what was decided and what was built for each release. It is no longer kept here. The same information is published in three places that stay current:

- **What changed for users, release by release:** [CHANGELOG.md](../../CHANGELOG.md).
- **Why the product is shaped the way it is:** the decision records in [docs/adr/](../adr/). A decision that changes gets a new record, and the old one is marked superseded.
- **What is required and how each requirement is checked:** [requirements.md](requirements.md) (numbered requirements with their status and test) and [features.md](features.md) (every feature with its status).

## Decisions the log recorded, now in decision records

| Decision | Record |
|---|---|
| A guard layer in front of existing agents, not an agent platform, factory or new standard | [ADR 0001](../adr/0001-a-guard-layer-not-a-factory-platform-or-standard.md) |
| One engine in TypeScript on Node, the same on Windows, macOS and Linux | [ADR 0002](../adr/0002-typescript-on-node-as-the-one-engine.md) |
| Actions are checked outside the model, by a process the model cannot argue with | [ADR 0004](../adr/0004-enforcement-outside-the-model.md) |
| On any error, ask rather than allow | [ADR 0005](../adr/0005-fail-closed-ask-on-error.md) |
| Risky actions ask by default; they are not forbidden | [ADR 0006](../adr/0006-ask-by-default-not-forbid.md) |
| A model reviewer can only make an answer stricter | [ADR 0007](../adr/0007-reviewer-can-only-escalate.md) |
| A Windows command is read as PowerShell, POSIX and cmd, and the strictest reading wins | [ADR 0008](../adr/0008-windows-three-dialects-keep-the-strictest.md) |
| openmorals never grants a permission the host would not | [ADR 0009](../adr/0009-never-grant-permission-the-host-would-not.md) |
| A merge verdict is decided in CI from the diff, and the run record can only raise review | [ADR 0013](../adr/0013-a-merge-verdict-decided-in-ci-the-record-can-only-raise-review.md) |
| The checker holds no power to act: it refuses, asks or reports | [ADR 0014](../adr/0014-the-checker-can-only-refuse-ask-or-report.md) |

## Known defects

Defects found in released versions, with the date found and the version that fixed them. New defects are reported through the issue tracker, or privately as described in [SECURITY.md](../../SECURITY.md) when they are security holes; fixes are listed in [CHANGELOG.md](../../CHANGELOG.md).

### D-1: `--help` after a subcommand runs the subcommand (found 2026-11-24)

- `openmorals guidance --help` wrote an `AGENTS.md` with the openmorals block into the current folder instead of printing help; `openmorals init --help` wrote `openmorals.yaml` and installed the Claude Code hook. Other subcommands ran their command or printed a usage line and exited 64.
- Cause: the command dispatcher in `src/cli.ts` checked `--help` only when no subcommand was given. Requirement EXT-07.
- Fixed in 0.5.0: every subcommand prints its usage for `--help` or `-h` (and `help <command>`) and exits 0 before any file is opened; an unknown option on a command other than `hook` is a usage error. `test/cli-help.test.ts` walks every subcommand in an empty folder.

### D-2: guidance wording (found 2026-11-23)

- The guidance block said openmorals "asks" about loops and Rule-of-Two cases even when the bylaws set those to deny, and its self-protect line named `.claude/settings.json` but not the other hosts' hook files, which the guard does protect. Cosmetic: the hook always enforced the real decision.
- Fixed in 0.5.0: the loop and taint lines say "blocks" for deny; the self-protect line names `.codex/hooks.json`, `.gemini/settings.json` and `.opencode/plugins/`.

### D-3: `packs.loosenings` compared lists differently from the engine (found 2026-11-23)

- It compared `allow_targets` lower-cased and without the engine's normalisation, and did not report a change of budget `step`. Reports only, not decisions.
- Fixed in 0.5.0: `allow_targets` are compared with the engine's own matcher, and a budget `step` that asks less often is reported.
