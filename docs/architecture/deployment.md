# Deployment guide

For 0.34.0, written 25 Nov 2026 from the install code and the workflows; the hook check (`doctor`) added for 0.40.1. Check [prerequisites.md](prerequisites.md) first.

## Install

Nothing is published yet (no npm package, PyPI package or release). Install from a clone:

```sh
git clone https://github.com/mashraq/openmorals.git
cd openmorals
npm ci
npm run build
npm link
openmorals --version
```

When releases start, the same engine will also come as an npm package, a single-file binary per OS, and a Python launcher that checks the binary's hash before running it ([distribution.md](../distribution.md)).

## Configure

1. **Your user file** at `<config>/openmorals.yaml` is the floor. `<config>` is `$OPENMORALS_HOME`, else `%APPDATA%\openmorals`, else `$XDG_CONFIG_HOME/openmorals` or `~/.config/openmorals`. Reviewer settings, prices and `merge.review_free` are read only from this file.
2. **A project file** `openmorals.yaml` can only tighten your floor.
3. **Packs:** `openmorals packs` lists them, `openmorals init --pack NAME` copies one as the project file.
4. Check with `openmorals validate` and `openmorals check "<command>"`.

## Install the hook

`openmorals init [DIR] --agent <host> [--pack NAME]`

`init` writes `openmorals.yaml` only if none exists and merges the hook into the host's config. It never replaces a config: a file it cannot parse is left alone and the snippet is printed; a backup `<file>.openmorals-backup-<time>` is saved first; running it twice adds nothing.

| Host | File | Events | Then |
|---|---|---|---|
| Claude Code (default) | `.claude/settings.json` | PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit | see below |
| Codex | `.codex/hooks.json` | PreToolUse, PostToolUse, UserPromptSubmit, PostModelRequest | trust the hook in `/hooks` |
| Gemini CLI | `.gemini/settings.json` | BeforeTool, AfterTool, BeforeAgent | accept the hook fingerprint |
| opencode | `.opencode/plugins/openmorals.js` | before and after each tool, permission, prompt | restart opencode |
| OpenClaw | `.openclaw/plugins/openmorals/` | before and after each tool call, model output | `openclaw plugins install <folder>`; re-run `init` if the project moves |

### Claude Code

`openmorals init` (0.36.0 and later) sets `"onFailure": "block"` on the openmorals tool and prompt hooks in `.claude/settings.json`, so a hook that crashes or times out stops the call instead of letting it run; run `init` again to upgrade an older install. Keep hooks enabled.

### Check that it is live

Run `openmorals doctor` in the project after `init`, and again after upgrading openmorals or the agent. On Claude Code it checks that the hook is installed for every event, that the tool hook blocks the call when it fails, and that its command is this openmorals, then runs its own hook on three made-up events (a harmless call, a risky one and a prompt). On Codex, Gemini CLI, opencode and OpenClaw it checks only that the hook or plugin is there and how the agent treats a failed hook. Exit 0 when nothing needs fixing, 1 when something does; `--no-run` skips the self-test and `--json` is for scripts. A pass means the guard is installed and answering, not that the project is safe. Details: [host-settings.md](../host-settings.md#check-the-guard-is-live-openmorals-doctor).

### Unattended runs

For CI or scheduled agents, set `OPENMORALS_UNATTENDED=1` (or pass `--unattended` in the hook command) so every ask becomes a deny. On Claude Code, `defer: true` holds those steps for later review with `openmorals pending`, `approve` and `refuse`.

### Removing it

There is no uninstall command yet. Restore the backup file or delete the openmorals entries; `openmorals guidance --remove` removes the guidance block.

## Optional parts

- **Reviewer** (Claude Code, off by default, can only escalate): set `reviewer.enabled`, `provider` (`anthropic`, `openai-chat` with any compatible endpoint including local servers, or `gemini`), `model` and `api_key_env` in your user file ([reviewer.md](../reviewer.md)).
- **Sandbox:** `openmorals sandbox plan` and `openmorals sandbox run -- <command>` ([sandbox.md](../sandbox.md)).
- **Install scanner:** `openmorals scan <path>` before adding a skill, plugin, MCP config or package ([scanner.md](../scanner.md)).

## CI

| Step | Command | Exit codes |
|---|---|---|
| Merge verdict | make the diff with the line in [merge-verdict.md](../merge-verdict.md), then `openmorals diff-class pr.diff [--map] [--note FILE]` | 0 may merge without review, 1 review, 2 unreadable, 64 usage |
| Tests | `openmorals tests compare`, `openmorals tests fail-first --base REV` | see [test-integrity.md](../test-integrity.md) |
| Score drift | `openmorals eval --save FILE`, later `openmorals eval --since FILE` | 1 if any decision moved |
| Audit | `openmorals audit verify`, `openmorals audit sample` | see [audit.md](../audit.md) |

Nothing is review-free unless your user-level file says so. In CI, point `OPENMORALS_HOME` at a folder holding the CI's own user file so the runner's home cannot change the verdict.

## Checklist

| Where | Do |
|---|---|
| Your laptop | install, `init` (which sets `onFailure: "block"` on Claude Code), set your user file, `openmorals doctor`, try a risky command once to see the ask |
| An agent in CI | `OPENMORALS_UNATTENDED=1`, `OPENMORALS_HOME` set to a clean folder, `audit verify` at the end |
| A merge gate | `diff-class` as a required check; `tests fail-first` where the project has tests |

## Upgrades

Rebuild (or replace the binary), run `init` again so the hook config gets any new setting, run `openmorals doctor`, then compare `eval --since` against a file saved before the upgrade to see any decision that changed.
