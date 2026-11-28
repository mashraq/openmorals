# openmorals run: start your agent with a run id

**Built (0.44.0).** Starts your agent with a run id, after checking its hook is installed, and prints what the run did.

```sh
openmorals run -- claude
openmorals run --tokens 2000000 --tool-calls 300:1000 -- claude -p "fix the failing test"
openmorals run --agent codex -- /opt/tools/codex exec "..."
```

It does four things, in this order, and starts nothing if any check fails:

1. Finds the host: `--agent NAME`, or the base name of the command (`claude`, `codex`, `gemini`, `opencode`, `openclaw`). A path whose last part is one of those counts (`/usr/local/bin/claude`). Anything else, such as a wrapper script or `claude-dev`, needs `--agent`. With `--agent`, the program you name is started, whatever it is: the check is of the named host's hook, not of that program. If the command's base name is a different host (`--agent claude-code -- codex`), `run` refuses with exit 64 and names both, since that host would not load the hook that was checked.
2. Checks the host's hook in this folder, with the same code as [`openmorals doctor`](../API.md#doctor-0380). What is checked differs by host:
   - Claude Code: the hook is there for every event and every tool, blocks the call when it fails, its command is found and is this openmorals, and it answers doctor's self-test, so the hook is shown to start. If the self-test cannot run, `run` refuses.
   - Codex and Gemini CLI: a hook entry that runs `openmorals hook codex` (or `gemini-cli`) is found in the project's settings (`.codex/hooks.json` or `.codex/config.toml`, `.gemini/settings.json`), and `openmorals` is on PATH when the entry runs it by that name. This is a check of the file's text. The hook is not started, and whether the host loads it is not checked. Codex loads project hooks only in a trusted project.
   - opencode and OpenClaw: the plugin file (`.opencode/plugins/openmorals.js`, `.openclaw/plugins/openmorals/index.js`) is there and its text contains the word `openmorals`. That is all. It is not started, and whether the host loads it is not checked.
   - For the four hosts other than Claude Code only this project's files are read. A hook in your user-level settings of those hosts is not seen, so `run` refuses; install the hook in the project, or start the host directly.
   - doctor's warnings for the host, and its next step (such as trusting the project in Codex), are printed before the start line. They do not stop the start.
3. Starts a run: the run id goes into the command's environment as `OPENMORALS_RUN`, and `--tokens` and `--tool-calls` set the run's limits as [`openmorals budget start`](runs.md) does.
4. Starts the command from its words, never through a shell, in this folder, with your terminal. When it ends, `run` prints the run card, which is what `openmorals audit --run ID` prints.

## What it checks, and what it does not

It checks what step 2 says, and the start line says it again for the host. It does not check that the command it starts loads that hook. A host can be started with its own flags or settings that leave the hook out, or the agent can start a session in another folder with no hook. Those calls are not judged.

This does not limit what the agent can reach on disk or on the network. The hook judges the tool calls the host sends to it, as it does without `run`.

At start it prints, on standard error:

```
openmorals run: this does not limit what the agent can reach on disk or on the network. The hook judges the tool calls the host sends to it.
openmorals run: run run-20261128T101500-3fa2c1, host claude-code. Checked: its hook in /path/to/project is installed and starts (doctor's self-test ran it). Not checked: that claude loads it.
```

For Codex the second line reads, for example:

```
openmorals run: doctor warns (codex, on failure): Codex runs the call when a hook fails or times out
openmorals run: doctor notes (codex, next step): trust the hook in Codex with /hooks; Codex loads project hooks only in a trusted project
openmorals run: run run-20261128T101500-3fa2c1, host codex. Checked: a codex hook entry was found in this project's settings in /path/to/project (a text check; it was not started, and whether Codex loads it is not checked). Not checked: that codex loads it.
```

With `--agent` and a program that is not a host, the end of the line is `Not checked: that ./my-agent.sh, the program you named, is claude-code or loads its hook.`

## When an agent runs `openmorals run`

The hook judges the command after `--` as if the agent had typed it. `openmorals run --agent claude-code -- rm -rf ~/work` is asked about the way `rm -rf ~/work` is, and `openmorals run -- openmorals init` the way `openmorals init` is. This holds for `openmorals` by any path, `npx openmorals`, `npm exec openmorals` and the other package runners, `node .../openmorals/dist/src/cli.js`, `python -m openmorals`, behind `env`, `sudo`, `time`, `nice` and the other wrappers the hook already reads through, and for a `run` inside a `run`. The words after `--` are a program and its arguments, so no shell alias applies to them.

A `run` whose command cannot be read is asked about: no `--`, nothing after it, or a program named like a shell keyword (`for`, `select`, `case`). A `run` started from a source checkout of openmorals that only its `package.json` shows (`node dist/src/cli.js run -- ...` in the checkout) is asked about too, since the words alone do not show it is openmorals.

## The command and its environment

- Every word after `--` goes to the command as given, including words that look like `run`'s own options (`-- claude --help` shows Claude Code's help). Without `--`, or with nothing after it, nothing starts (exit 64).
- The command gets `OPENMORALS_RUN`. Every other variable is passed on unchanged. Standard input, output and error are the terminal's, so an interactive agent works, and nothing of `run` goes to standard output: the start lines, the end line and the run card are on standard error.
- Ctrl-C and other signals: while the command runs, SIGTERM and SIGHUP sent to `run` are passed on to it, and `run` waits for it to end and prints the run card. The terminal sends Ctrl-C (SIGINT) and Ctrl-\ (SIGQUIT) to the command itself, so `run` does not send them again; with no terminal it passes them on.

## The run id

- With no `--id`, `run` makes a new id the way `budget start` does (the time and six random hex digits, made on this machine). It never takes an id that a stop already names, or that has a run folder, so a new run never starts stopped. It claims the id by making its run folder.
- `--id ID` names the run. The id is checked as `budget start` checks it: letters, digits, `.`, `-` and `_`, at most 128, not starting or ending with `.`. Any other id is refused (exit 64), so two ids never share one folder. An id that already has a run is joined: what it has counted goes on.
- Inside a run (`OPENMORALS_RUN` already set, for example by an agent that starts another agent), `run` joins that run. The command gets the same id, so it counts against the same budget, as any agent started under that id does. `--id` with another id, and new limits, are refused (exit 64): a nested `run` cannot give itself a fresh budget. An empty `OPENMORALS_RUN` is no run, as the hook reads it.
- `OPENMORALS_RUN` or `--id` naming a run that was never started here (no run folder) is not refused: the hook treats such an id as a new run with no limits and counts it from the first call. The start line says so: `joins run ID (OPENMORALS_RUN; no run by this id was started here, so it has no limits; ...)`.
- If the run is stopped (`openmorals stop --run ID`), every session is stopped (`openmorals stop --all`), or the stop file cannot be read, `run` refuses (exit 125): the agent's every call would be refused.

## Limits

- `--tokens N` and `--tool-calls N` or `SOFT:HARD`, as `budget start`: N alone is a hard limit; `SOFT:HARD` asks once for the whole run at SOFT. They are counted by the Claude Code hook only, so with any other host they are refused with "limits are counted on Claude Code only" (exit 64).
- A run's limits are set once: `--tokens` with an `--id` that already has limits is refused (exit 64).
- They never loosen your user file. Your user file's per-session limits (`guards.budget`) still apply to each session; the run's limits are counted beside them, so the lower one stops first.
- Only you set a run's budget: an agent that runs `openmorals run` with `--tokens` or `--tool-calls` is asked first, as for `budget start`.

## Exit codes

| Code | Meaning |
|---|---|
| the command's own | the command ended with that code |
| 128 + N | signal N ended the command (130 for SIGINT, 143 for SIGTERM), as a shell reports it |
| 64 | usage error: no `--`, nothing after it, an unknown option or host, a bad id, limits on another host. Nothing was started |
| 125 | refused: the hook check found a problem or could not be made, or the run is stopped, or the run could not be set up. Nothing was started. The message names what doctor found and the `init` command to run |
| 126, 127 | the command could not be started (126: not allowed to run it; 127: not found or could not be started, as with a `.cmd` launcher on Windows) |
| 70 | openmorals itself failed in a way it does not expect (a bug); the message says what failed |

The command's own code can be any of these numbers too: a command that exits 64, 125, 126 or 127 itself cannot be told apart by the code. Read standard error instead. If the start line (`openmorals run: run ..., host ... Checked: ...`) was printed, the command was started, and the code is its own, unless the next line is `could not start`. If there is no start line, nothing was started.

## The run card

When the command ends, `run` prints the run card: denies, asks, approved asks, taint marks and loosening notes from the audit log, what the run used from its run folder, files written and commits ([audit.md](audit.md)). If no hook call was recorded under the run, it says so in one line and prints no figures. For a run that was joined, the card covers the whole run, its other sessions too.

## Not covered

- Files and the network are not limited. `run` is a convenience that starts a host after checking its hook.
- With `--agent`, any program starts under the named host's check. The check says nothing about that program.
- For Codex, Gemini CLI, opencode and OpenClaw only the text of the project's hook files is checked, not that the hook starts or that the host loads it. A Codex project that is not trusted passes the check while Codex does not load its hooks.
- `openmorals sandbox run`: the command after its `--` is not judged by the hook in this release.
- If `run` itself is killed with SIGKILL, the command keeps running, keeps the terminal, and no run card is printed.
- Ctrl-C with a real terminal and an interactive host has not been run in a test. With standard input redirected from a file in a terminal (`run -- claude -p ... < prompt.txt`), the terminal and `run` may both send Ctrl-C, so the host gets two; and with standard input a terminal, a SIGINT sent to `run` from elsewhere is not passed on.
- Sessions the agent starts in folders with no hook, or a host started with settings that leave the hook out.
- Budgets on the four hosts other than Claude Code.
- Agents that run in a vendor's cloud.
- doctor's checks of Codex, Gemini CLI, opencode and OpenClaw read the project's files only; a hook installed only in your user-level settings of those hosts is not seen, so `run` refuses there.
- Windows has not been run. An npm launcher such as `claude.cmd` cannot be started without a shell, and `run` never uses one, so it would end with 127 there (INFERRED from how Node starts programs, not run).
- It has not been run with a real host. Its tests start `node` in place of one.
