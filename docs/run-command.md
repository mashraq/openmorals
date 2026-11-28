# openmorals run: start your agent with a run id

**Built (0.44.0).** Starts your agent with a run id, after checking its hook is installed, and prints what the run did.

```sh
openmorals run -- claude
openmorals run --tokens 2000000 --tool-calls 300:1000 -- claude -p "fix the failing test"
openmorals run --agent codex -- /opt/tools/codex exec "..."
```

It does four things, in this order, and starts nothing if any check fails:

1. Finds the host: `--agent NAME`, or the base name of the command (`claude`, `codex`, `gemini`, `opencode`, `openclaw`). A path whose last part is one of those counts (`/usr/local/bin/claude`). Anything else, such as a wrapper script or `claude-dev`, needs `--agent`.
2. Checks that the host's hook is installed in this folder and starts, with the same code as [`openmorals doctor`](../API.md#doctor-0380). For Claude Code: the hook is there for every event and every tool, blocks the call when it fails, its command is found and is this openmorals, and it answers doctor's self-test. If the self-test cannot run, the hook is not shown to start, and `run` refuses. For the other hosts: the hook file is in the project, and for Codex and Gemini CLI `openmorals` is on PATH, which is all doctor checks there.
3. Starts a run: the run id goes into the command's environment as `OPENMORALS_RUN`, and `--tokens` and `--tool-calls` set the run's limits as [`openmorals budget start`](runs.md) does.
4. Starts the command from its words, never through a shell, in this folder, with your terminal. When it ends, `run` prints the run card, which is what `openmorals audit --run ID` prints.

## What it checks, and what it does not

It checks that the hook is installed and starts. It does not check that the command it starts loads that hook. A host can be started with its own flags or settings that leave the hook out, or the agent can start a session in another folder with no hook. Those calls are not judged.

This does not limit what the agent can reach on disk or on the network. The hook judges the tool calls the host sends to it, as it does without `run`.

At start it prints, on standard error:

```
openmorals run: this does not limit what the agent can reach on disk or on the network. The hook judges the tool calls the host sends to it.
openmorals run: run run-20261128T101500-3fa2c1, host claude-code. Checked: its hook in /path/to/project is installed and starts (as openmorals doctor checks it). Not checked: that claude loads it.
```

## The command and its environment

- Every word after `--` goes to the command as given, including words that look like `run`'s own options (`-- claude --help` shows Claude Code's help). Without `--`, or with nothing after it, nothing starts (exit 64).
- The command gets `OPENMORALS_RUN`. Every other variable is passed on unchanged. Standard input, output and error are the terminal's, so an interactive agent works, and nothing of `run` goes to standard output: the start lines, the end line and the run card are on standard error.
- Ctrl-C and other signals: while the command runs, SIGTERM and SIGHUP sent to `run` are passed on to it, and `run` waits for it to end and prints the run card. The terminal sends Ctrl-C (SIGINT) and Ctrl-\ (SIGQUIT) to the command itself, so `run` does not send them again; with no terminal it passes them on.

## The run id

- With no `--id`, `run` makes a new id the way `budget start` does (the time and six random hex digits, made on this machine). It never takes an id that a stop already names, or that has a run folder, so a new run never starts stopped. It claims the id by making its run folder.
- `--id ID` names the run. The id is checked as `budget start` checks it: letters, digits, `.`, `-` and `_`, at most 128, not starting or ending with `.`. Any other id is refused (exit 64), so two ids never share one folder. An id that already has a run is joined: what it has counted goes on.
- Inside a run (`OPENMORALS_RUN` already set, for example by an agent that starts another agent), `run` joins that run. The command gets the same id, so it counts against the same budget, as any agent started under that id does. `--id` with another id, and new limits, are refused (exit 64): a nested `run` cannot give itself a fresh budget. An empty `OPENMORALS_RUN` is no run, as the hook reads it.
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
| 125 | refused: the hook is not installed or does not start, or the run is stopped, or the run could not be set up. Nothing was started. The message names what doctor found and the `init` command to run |
| 126, 127 | the command could not be started (126: not allowed to run it; 127: not found) |

The command's own code can be any of these numbers too. Read standard error to tell them apart.

## The run card

When the command ends, `run` prints the run card: denies, asks, approved asks, taint marks and loosening notes from the audit log, what the run used from its run folder, files written and commits ([audit.md](audit.md)). If no hook call was recorded under the run, it says so in one line and prints no figures. For a run that was joined, the card covers the whole run, its other sessions too.

## Not covered

- Files and the network are not limited. `run` is a convenience that starts a host after checking its hook.
- Sessions the agent starts in folders with no hook, or a host started with settings that leave the hook out.
- Budgets on the four hosts other than Claude Code.
- Agents that run in a vendor's cloud.
- doctor's checks of Codex, Gemini CLI, opencode and OpenClaw read the project's files only; a hook installed only in your user-level settings of those hosts is not seen, so `run` refuses there.
- Windows has not been run. An npm launcher such as `claude.cmd` cannot be started without a shell, and `run` never uses one, so it would end with 127 there (INFERRED from how Node starts programs, not run).
- It has not been run with a real host. Its tests start `node` in place of one.
