# openmorals and your agent's own settings

Every agent openmorals works with has its own permission modes, allow rules, sandbox and undo. openmorals sits beside them, not in place of them. This page says how the two fit together, what was seen in testing, and how to check that the guard is really live: `openmorals doctor`.

## Check the guard is live: `openmorals doctor`

```sh
cd your-project
openmorals doctor            # every agent set up here, with a self-test on Claude Code
openmorals doctor --no-run   # the same checks without running the hook
openmorals doctor --json     # for scripts
```

What it checks depends on the agent it finds in the project:

- **Claude Code** (`.claude/settings.json`, `.claude/settings.local.json` and your user settings): full checks and a self-test, below.
- **Codex** (`.codex/hooks.json` or `.codex/config.toml`) and **Gemini CLI** (`.gemini/settings.json`): that the file has an openmorals hook, how the agent treats a hook that fails or times out (both let the call run), and that `openmorals` is on `PATH` when the hook calls it by that name.
- **opencode** (`.opencode/plugins/openmorals.js`) and **OpenClaw** (`.openclaw/plugins/openmorals/index.js`): that the plugin file is there and mentions openmorals, and how the agent treats a plugin that fails (both block the call).

On Claude Code it checks:

1. **The hook is installed** for every event openmorals uses, and the `PreToolUse` hook covers every tool (matcher `*` or none).
2. **It blocks the call when it fails**: one and the same `PreToolUse` hook entry must both cover every tool and have `"onFailure": "block"`, and the `UserPromptSubmit` hook must have it too. Without it, Claude Code runs the call when the hook crashes, times out or cannot start.
3. **The hook's command can be found**: the program on `PATH` (leading `NAME=value` words are skipped as environment settings), or the absolute script a `node ...` command points at. A program or script given as a path relative to the project is not looked at.
4. **The hook is this openmorals**: the program (or the `node` script) must be the very file of the openmorals that runs `doctor`. If it is anything else, the self-test is skipped and this counts as a problem to look at, not a pass.
5. **Self-test.** doctor runs its own openmorals hook (`node <its own cli.js> hook claude-code`, or the openmorals binary itself, with `--unattended` if the settings' command has it; never a command from the project or its settings) on three made-up events: a harmless `ls` (expect no objection), an `rm -rf` of a folder that does not exist (expect an ask or a refusal) and a prompt (expect it to pass). Each answer is timed. A risky call that comes back allowed is a problem. The hook runs unattended, so the reviewer is off and there is no network call, with only `PATH`, the home and config-folder variables (`HOME`, `USERPROFILE`, `APPDATA`, `XDG_CONFIG_HOME`, and `SystemRoot` on Windows) and `OPENMORALS_HOME` from your environment. Nothing in the project is touched.
6. **The agent's sandbox.** A note, never a failure, when Claude Code's own sandbox is not turned on (`sandbox.enabled`), with the advice below.

Output is one line per check, with a short "what to do" line for each problem. Exit 0 when nothing needs fixing, 1 when something does, 64 on a usage error. Commands are printed with secrets masked. No network call. The only writes are the hook's own: its audit lines, which you can tell apart because their session name starts with `openmorals-doctor-`; its session file; and the request it may hold for approval in an unattended run. doctor removes the session file and that request afterwards.

A passing `doctor` means the guard is installed and answering. It does not mean the project is safe: see "Known limits" below.

## How an answer from openmorals meets the agent's own rules

- **An ask is an ask.** When openmorals asks, the agent shows you the reason and waits for you, whatever its own mode.
- **No objection is not a yes.** When openmorals has no objection it prints nothing, so the agent's own allow rules and prompts still decide. openmorals never answers "allow" on Claude Code, because that would skip the agent's own prompts.
- **Unattended runs.** In a run with nobody to answer (Claude Code's `-p`, CI), an ask cannot be answered, so it ends as a refusal. Anything the agent itself would have asked about is refused the same way. For CI, see [`ci-unattended`](../README.md#unattended-runs-ci) and the `--unattended` hook flag.
- **The recoverable delete.** When openmorals refuses or asks about a delete, its reason offers `openmorals trash` instead. The agent can switch to it on its own only if the agent's settings already allow that command. On Claude Code, `openmorals init` adds that allow rule, `Bash(openmorals trash:*)`, after a trash-and-restore self-test in a temp folder (it does not test the project's own trash); the hook still asks about a trash call outside the project or one that would move `.claude`, `.git`, the bylaws or openmorals' config. On other agents the trash command is one more prompt from the agent. Details: [delete.md](delete.md#the-trash-command-without-a-second-prompt-claude-code).

## Seen in testing

From runs of openmorals on Claude Code 2.1.332 (26 Nov 2026), with openmorals 0.36.2:

- An openmorals ask still appeared under Claude Code's `default`, `acceptEdits` and `auto` modes, and over an allow rule in Claude Code's own settings for the same command.
- When the hook command could not be found, every prompt was blocked with only an exit code (127). `openmorals doctor` names the cause.
- After a private file was read, a network call asked and named both halves (the rule of two). A declined ask left nothing behind.
- Claude Code's `bypassPermissions` mode was not tested.

## Pair the guard with the agent's sandbox

openmorals judges each call from its text. A sandbox stops what a process actually does, however the command was spelled, including inside a script the agent wrote. Use both where the agent has one:

- **Claude Code** has an OS sandbox for shell commands, off by default ([sandboxing](https://code.claude.com/docs/en/sandboxing)). `doctor` notes when `sandbox.enabled` is not `true`.
- **Fail modes differ by agent.** On Claude Code a hook failure blocks the call when `onFailure: "block"` is set. On Codex and Gemini CLI a hook that fails or times out lets the call run. On opencode and OpenClaw a throw (and on OpenClaw a timeout) blocks. Sources and dates: [adapters.md](adapters.md).
- **Undo does not cover the shell.** Claude Code's rewind does not track files changed only by shell commands ([checkpointing](https://code.claude.com/docs/en/checkpointing)), and opencode's restore does not reverse shell commands, services, databases or git state ([snapshots](https://opencode.ai/docs/snapshots/)). openmorals' own trash and undo log cover only what goes through them ([extras.md](extras.md)).
- For one risky command, openmorals has its own sandbox runner: [sandbox.md](sandbox.md).

## Known limits

- openmorals is not a sandbox. It decides on what the agent shows it, before the call runs.
- Rule matching cannot know every way to spell a command. A script the agent writes and then runs is out of its view.
- It guards only what the agent sends to the hook. An agent with hooks turned off, or a tool the agent does not route through the hook, is not guarded.
