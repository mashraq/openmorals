# 0008. On Windows, read every command in three shell dialects and keep the strictest answer

- Status: Accepted
- Date: 2026-11-24 (built in 0.3.1)

## Context

Codex CLI, Gemini CLI and opencode do not say which shell will run a command. On Windows it may be PowerShell, cmd.exe, Git Bash or WSL, and the same text means different things: in Windows PowerShell `rm` is `Remove-Item`, which has no `-rf` parameter, while in Git Bash it is the POSIX `rm`.

Before 0.3.1 the three adapters read every Windows command as PowerShell. CI on Windows found that `rm -rf build`, `sudo rm -rf /var/www`, `rm -fr` and `rm --recursive` were allowed there. A survey of the guard case files found 30 of 155 non-allow POSIX commands dropped to allow under the PowerShell reading, and 20 under the cmd reading.

Claude Code was not affected: its `Bash` and `PowerShell` tools name their shell.

## Decision

- On Windows, the Codex, Gemini CLI and opencode adapters read each shell command as **PowerShell, POSIX and cmd**, and keep the **strictest** verdict. When a reading other than the host's own decides, the reason says which. Built (0.3.1).
- The destructive guard also reads a PowerShell `rm` as the POSIX `rm`, because PowerShell on macOS and Linux runs `/bin/rm`. Built (0.3.1).
- A command is never judged more loosely on Windows than on macOS or Linux. A test checks this for every POSIX command in the guard case files, through all three adapters. Built (0.3.1).

## Alternatives and why they lost

- **Guess the shell from the platform.** That was the bug.
- **Detect the shell from the environment.** The hook process does not run in the shell that will run the command, so it cannot know.
- **Ask on every Windows command.** Rejected: too many asks for no gain.

## Consequences

- On the case files plus 32 everyday commands, no command allowed as POSIX was asked about under the extra readings (measured 24 Nov 2026), so the extra readings added no asks there.
- The session history and audit log record each call once.
- Two Windows-only CLI tests can only be confirmed on a real Windows runner in CI.
