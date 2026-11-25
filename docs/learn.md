# The learn guard (0.35.0)

On by default, with decision `ask`. It guards what an agent writes into the files that teach later sessions. A line written into one of them keeps working after the session that wrote it has ended: the next session starts clean and loads it, so a wrong note or a planted instruction reaches every session after it.

Three kinds of file, told apart by path alone:

| Kind | Paths | Why it matters |
|---|---|---|
| instructions | `AGENTS.md`, `AGENT.md`, `CLAUDE.md`, `CLAUDE.local.md`, `GEMINI.md`, `MEMORY.md`, `.cursorrules`, `.windsurfrules`, `.github/copilot-instructions.md`, and files in `.claude/rules/`, `.cursor/rules/`, `.windsurf/rules/`, `.github/instructions/`, `.clinerules/` | loaded at the start of every session |
| memory | files in a `memory` folder under `.claude/` (an agent's own notes, read back on demand) | read back by later sessions |
| skill | `SKILL.md` anywhere, and files in `.claude/skills/`, `.claude/agents/`, `.claude/commands/`, `.agents/skills/`, `.codex/skills/`, `.gemini/commands/` | loaded and run by later sessions, and can carry scripts |

Four checks:

- **`learn.scan`**: what a write adds (a whole file, a patch's added lines, each edit's new text) is run through the [install scanner](scanner.md). For instructions and memory, only its hidden-instruction rules (`inject.*`: text telling the model to drop its instructions or skip asking, invisible characters, instructions in HTML comments), since these files often quote commands on purpose. For a skill, every scanner rule. A critical finding is refused; a high or medium one gets `decision`.
- **`learn.budget`**: a write that grows an instructions file past `tokens` (about four bytes to a token; 10,000 by default, roughly 40 KB). Every session pays for each line of such a file, and a long one buries the lines that matter. A write that keeps the file the same size or shrinks it is not held to the budget, so trimming an oversized file is never asked about.
- **`learn.shell-write`**: a shell command that writes one of these files (a redirect, `tee`, `cp`, `mv`, `install`, `ln`, `rsync`, `curl -o`, `wget`, `unzip`, `tar`, `dd of=`, `sed -i`, `perl -i`, `git clone` into a skills folder, and the PowerShell equivalents). openmorals cannot see or scan what goes in, so it asks; the agent's file-edit tool gives a change that can be checked.
- **`learn.tainted-write`**: a write to one of these files in a session that has read untrusted content (a web page or search, an MCP tool's output, a network command's output, a file from outside the project, or content where the inbound scanner found hidden instructions). What the agent writes may come from that content rather than from you. It counts across compactions and sub-agents, like the [taint check](architecture/guards.md). The reason names the last untrusted source.

A write whose content the host does not pass is asked about (`learn.unseen`). A delete is left to the [delete guard](delete.md).

```yaml
guards:
  learn:
    decision: ask    # deny refuses instead; allow switches it off
    tokens: 10000    # 0 turns the size check off; the scans stay on
```

A project file can make it stricter (a stricter decision, a lower budget), never looser: it cannot switch the guard off, raise the budget, or set `tokens: 0`.

## What it misses

- A note that is wrong but harmless-looking ("the tests on main are flaky, skip them") trips no scanner rule. Outside a session with untrusted content, it goes through. The budget and the taint check are the only other things standing in its way.
- It does not say where each line came from, and it does not keep a history of the notes. A later clean-up pass that rewrites a memory file is judged like any other write.
- A file the agent loads that is not named above, a shared database or a document store an agent reads from, and files written by a program the agent starts (a script that edits `CLAUDE.md` itself) are not seen.
- Hidden instructions in a language or wording the scanner's rules do not know are not found.

Measured on its case table (`cases/learn.cases.yaml`, 33 rows): 20 of 20 caught, 0 of 13 false alarms, and on five session rows in `cases/multi-step.sessions.yaml` (11 checked steps, including a project file that tries to switch it off). On this repository's 76 Markdown files, the hidden-instruction rules alone flag 5, all of them documents about attacks that quote the phrases; the full rule set, used for skills, flags 24, which is why instructions files get only the first. How often it asks in real sessions is not measured.
