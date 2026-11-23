# Changelog

All notable changes to openmorals. Versions follow [semantic versioning](https://semver.org/); while the version is 0.x, a minor release may change behaviour, and every API change is listed in [API.md](API.md#changes).

## 0.3.0 (2026-11-23)

### Added
- `openmorals hook codex`, `hook gemini-cli` and `hook opencode`, and `openmorals init --agent claude-code|codex|gemini-cli|opencode`: the same guards, loop detector, taint judge, budget and audit log for Codex CLI (`PreToolUse` hook), Gemini CLI (`BeforeTool` hook) and opencode (a plugin). An existing config file is merged and backed up first; one that cannot be parsed is left alone and the snippet is printed. Built from each tool's documentation and source; not yet run against the live tools.
- The independent reviewer: with `reviewer.enabled: true`, every ask in the Claude Code hook is first shown to a second model, which can add a note or (with `on_escalate: deny`) turn it into a deny, never an allow. Failures keep the ask. Off by default; `provider: fake` is a dry run. `openmorals check --review` runs it on demand.
- `openmorals sandbox plan [--json] [--platform ...]` and `openmorals sandbox run -- <cmd>`: run a command under macOS `sandbox-exec` or Linux `bwrap` with writes limited to the project and temp folders, credential files unreadable and the network off; exit code 125, running nothing, when the tool is missing or on Windows (plan only). Optional `sandbox` section in the bylaws.
- Library exports: the reviewer, the sandbox, the three adapters as namespaces (`codexAdapter`, `geminiCliAdapter`, `opencodeAdapter`), `installAgentHook`, the destructive guard's `normalizeAllowTarget`, `matchesAllowTarget` and `isSafeAllowTarget`, and `hasOpenMoralsHook(settings)`.

### Changed
- The self-protect guard also covers the Codex, Gemini CLI and opencode hook and plugin files (`.codex/hooks.json`, `.codex/config.toml`, `.gemini/settings.json`, `.opencode/plugins/`, `opencode.json` and their user-level forms), and the sandbox keeps them read-only.
- `packs.loosenings` also reports a reviewer switched off, a softer `reviewer.on_escalate`, and wider sandbox settings.

## 0.2.0 (2026-11-23)

### Added
- `openmorals scan <path> [--json]`: a static scanner for skills, Claude Code plugins, MCP configs and npm packages before you install them (hidden instructions, secret exfiltration, download-and-execute, persistence, over-broad permissions, unpinned remote servers, obfuscation). Exit code 0 allow, 1 ask, 2 deny.
- `openmorals trash <path>`, `trash --list`, `restore <id>` and `purge --older-than <days> --yes`: move files into a per-project trash with an undo log instead of deleting them. The first trash writes `.openmorals/.gitignore` so the trash is never committed.
- `openmorals guidance [--file AGENTS.md|CLAUDE.md|GEMINI.md] [--remove]`: writes the bylaws as plain instructions for the agent into a marked block, leaving the rest of the file alone.
- `openmorals packs` and `openmorals init --pack <name>`: five ready-made bylaws (`solo-dev`, `strict`, `beginner`, `production-ops`, `ci-unattended`).
- Loop detector and taint judge (Rule of Two) in the Claude Code hook, switchable with `guards.loop` and `guards.taint` in the bylaws (`taint.trusted_hosts` exempts trusted sites). The session file keeps the last 20 actions, redacted, and the taint state.
- `PostToolUse` and `PostToolUseFailure` handling: the hook records each call's outcome so a command that keeps failing the same way is caught. `openmorals init` installs these two events next to `PreToolUse`.
- `--unattended` on `check`, `scan` and `hook claude-code` (or `OPENMORALS_UNATTENDED=1`): every ask becomes deny, for CI.
- Library exports for the scanner (by name) and for `undo`, `guidance`, `loop`, `taint` and `packs` (as namespaces), plus `reachesNetwork`, `NETWORK_COMMANDS` and the session helpers. The package now ships `packs/`.

### Changed
- When the destructive guard stops an `rm`, `Remove-Item`, `del` or `rd`, its reason names `openmorals trash <path>` as the recoverable alternative.
- The self-protect guard also covers `.openmorals/` (the trash and undo log) and `openmorals init`/`purge` run by the agent.
- The secrets guard and the taint tracker share one network-command list, so the secrets guard now also counts `git push`, `npm publish`, `docker push` and cloud CLIs as reaching the network (for example, `git add -f .env && git push` is denied as a send).

### Fixed
- In cmd and PowerShell, `timeout /t 5` is the Windows sleep command; the parser had treated it as the POSIX `timeout` wrapper around a command named `5`.

## 0.1.0 (2026-11-23)

- First release: the policy engine (`decide`), the bylaws file and its validator, the destructive, online-delete, secrets, self-protect and budget guards with their case files, the Claude Code `PreToolUse` hook, and the `check`, `init`, `validate` and `audit` commands.
