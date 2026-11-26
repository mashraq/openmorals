# openmorals and your agent's own settings

Every agent openmorals works with has its own permission modes, allow rules, sandbox and undo. openmorals sits beside them, not in place of them. This page says how the two fit together, what was seen in testing, and how to check that the guard is really live: `openmorals doctor`.

## Check the guard is live: `openmorals doctor`

```sh
cd your-project
openmorals doctor            # every agent set up here, with a self-test on Claude Code
openmorals doctor --no-run   # the same checks without running the hook
openmorals doctor --json     # for scripts
```

For each agent it finds in the project (Claude Code `.claude/settings.json`; Codex `.codex/hooks.json` or `.codex/config.toml`; Gemini CLI `.gemini/settings.json`; opencode `.opencode/plugins/openmorals.js`; OpenClaw `.openclaw/plugins/openmorals/`), it checks:

1. **The hook is installed** for the events the agent needs, and covers every tool (matcher `*` or none).
2. **It blocks the call when it fails**, where the agent supports that (`"onFailure": "block"` on Claude Code's `PreToolUse` and `UserPromptSubmit`). It names the agents whose hooks let the call run when the hook fails or times out.
3. **The hook's command can be found**: the first word on `PATH`, or the script a `node ...` command points at.
4. **Self-test, Claude Code only.** It runs the installed hook on three made-up events: a harmless `ls` (expect no objection), an `rm -rf` of a folder that does not exist (expect an ask or a refusal) and a prompt (expect it to pass). Each answer is timed. Nothing in the project is touched. The test runs only when the hook command is a plain `openmorals hook claude-code` or `node .../cli.js hook claude-code`; any other command is never run. The hook records the three calls as usual, under a session named `openmorals-doctor-...`, and the session file is removed afterwards.
5. **The agent's sandbox.** A note, never a failure, when Claude Code's own sandbox is not turned on (`sandbox.enabled`), with the advice below.

Output is one line per check, with a short "what to do" line for each problem. Exit 0 when nothing needs fixing, 1 when something does, 64 on a usage error. No network call; the only writes are the hook's own log lines and the session file it removes.

A passing `doctor` means the guard is installed and answering. It does not mean the project is safe: see "Known limits" below.

## How an answer from openmorals meets the agent's own rules

- **An ask is an ask.** When openmorals asks, the agent shows you the reason and waits for you, whatever its own mode.
- **No objection is not a yes.** When openmorals has no objection it prints nothing, so the agent's own allow rules and prompts still decide. openmorals never answers "allow" on Claude Code, because that would skip the agent's own prompts.
- **Unattended runs.** In a run with nobody to answer (Claude Code's `-p`, CI), an ask cannot be answered, so it ends as a refusal. Anything the agent itself would have asked about is refused the same way. For CI, see [`ci-unattended`](../README.md#unattended-runs-ci) and the `--unattended` hook flag.
- **The recoverable delete.** When openmorals asks about a delete, its reason offers `openmorals trash` instead. The agent can switch to it on its own only if the agent's settings already allow that command (on Claude Code, a `Bash(openmorals trash:*)` allow rule). Otherwise the trash command is one more prompt from the agent.

## Seen in testing

From runs of openmorals on Claude Code 2.1.332 (26 Nov 2026), with openmorals 0.36.2:

- An openmorals ask still appeared under Claude Code's `default`, `acceptEdits` and `auto` modes, and over an allow rule in Claude Code's own settings for the same command.
- In a folder Claude Code did not yet trust, it ignored the project's allow rules but still ran the project's hooks.
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
