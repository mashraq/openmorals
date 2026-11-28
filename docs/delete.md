# Deleting files: the delete guard (0.21.0; moves, overwrites and documents 0.22.0)

A plain delete of any existing file is never let through silently by default. When the project trash can take the file, the call is refused and the reason names the command that reaches the same goal recoverably, `openmorals trash <path>`; the agent can run that at once and carry on. When the trash cannot take it, the call asks. A delete whose path is built at run time is refused. Nothing is exempt: no extension, no folder, no "the agent made this file". Since 0.22.0 a move into a temp folder counts as a delete of what is moved, `mv` or `cp` onto an existing file counts as a delete of the file it replaces, and a document is steered to the trash like any other file.

What this page claims, and what it does not: openmorals **refuses the delete with the trash command named**. Whether a live agent then runs the trash command, rather than finding another way to delete the file, has not been observed: nothing here has been run against a live agent.

## What it judges

| Seen as a delete | Notes |
|---|---|
| `rm`, `unlink`, `del`, `erase`, `Remove-Item` (`ri`) naming files | in Bash, PowerShell and cmd; several files in one call |
| `git rm` without `--cached` | git could restore the file; that is not an exemption. `git rm -r <folder>` (0.21.1): the folder too, with `openmorals trash <folder> && git rm -r -q --cached <folder>` named |
| a patch's `*** Delete File:` | Codex, opencode and OpenClaw `apply_patch` / `patch` |
| an MCP or plugin tool whose name says it deletes (`delete`, `remove`, `rm`, `unlink`, `erase`) and that names a path | e.g. `mcp__files__delete_file { path }` |
| a move into a system temp folder (0.22.0): `mv`, `move`, `Move-Item` | the file or folder moved; see [temp folders](#temp-folders-0220). `git mv` cannot move out of the repository, so it never counts |
| `mv` or `cp` onto an existing file (0.22.0); also `copy`, `Copy-Item`, `install`, `ditto`, `Move-Item -Force`, `git mv -f` | the file replaced: the destination, or the file of the same name inside a destination folder. The reason names `openmorals trash <old file>` first, then the same move |

Left to other guards, so one action is asked about once: `rm -r`, `rm -f` (except, since 0.41.3, `rm -f` of plain names in the working folder with no other option, which this guard judges as `rm`), wildcards, `find -delete`, `xargs rm`, `git clean` and the other forms the [destructive guard](architecture/guards.md#destructive) flags; a plain delete of a **document the trash cannot take** (outside the project, on another volume, a secret name, or under `steer: ask`): the [document guard](architecture/guards.md#document-0180) asks, as before, at the stricter of `guards.document.decision` and `guards.delete.decision`; emptying a file (`> f`, `cp /dev/null f`, `sort f > f`): the document guard. With the destructive guard or the document guard switched off, this guard judges those files too.

Silent, because nothing is lost: `mv -n` and `cp -n` (`--no-clobber`, `--update=none`; the last of `-f`, `-i`, `-n` decides), a kept backup (`-b`, `--backup`, `-S`), `Move-Item` without `-Force` and `git mv` without `-f` (both refuse to replace), a rename (`ren`, `Rename-Item`), a move or copy to a name that does not exist yet, a copy into a temp folder (the file stays), and a move out of the project to anywhere that is not a temp folder (`mv build.log /srv/archive/`): the file is kept, so it is not a delete. A **document** moved out of the project keeps the ask it has had since 0.18.0 (`document.delete`).

### Documents (0.22.0)

A document (`md`, `txt`, `docx`, `pdf` and the rest of `guards.document.extensions`) inside the project is steered to the trash like any file: `rm notes.md` is refused with `openmorals trash notes.md` named. It is asked about only under `steer: ask` or where the trash cannot take it, as for any file. Before 0.22.0 a document delete asked even where the trash could take it, so raising `guards.document.decision` from `allow` to `ask` turned a refusal into an ask. Now no setting gives a weaker outcome by being stricter: for document decision `allow`, `ask` and `deny` an in-project document delete is refused in all three, and a test checks every pair of settings.

### Temp folders (0.22.0)

A move counts as a delete when its destination is one of the system's temp folders and outside the project folder: on macOS `/tmp`, `/var/tmp` and `/var/folders` (each also under `/private`; the per-user `$TMPDIR` lives in `/var/folders`); on Linux `/tmp`, `/var/tmp` and `/dev/shm`; on Windows `<drive>:\Windows\Temp` and any `\AppData\Local\Temp`; and a destination written with `$TMPDIR`, `$TMP`, `$TEMP`, `%TEMP%`, `%TMP%`, `$env:TEMP` or `$env:TMP`. The system or its cleaners remove files there at restart or after some days unused, so a file moved there is not kept. A project that itself lives in a temp folder keeps its own subfolders; a file already in a temp folder outside the project is not judged when it moves to another.

### After a change of folder (0.21.1)

A delete that follows `cd`, `chdir`, `pushd`/`popd`, `Set-Location` (`sl`, `Push-Location`) in the same call, or `git -C <dir> rm`, is read from the folder the call moves to: `cd sub && rm c.py` is judged as `sub/c.py`, and the trash command names `sub/c.py`. Because the parser does not see where a subshell or `||` ends, the folders before the `cd` stay candidates: the target is judged in each folder where it exists. When the folder cannot be known (`cd "$D"`, `cd -`, `cd $(...)`, a `popd` with nothing pushed in the call, more than eight candidates), a relative delete after it is refused as `delete.blind`, with a reason to name the file from the project folder; an absolute path is judged as usual. The document guard follows the same folders, and after an unknown one asks about a relative document delete (`document.unknown`).

## What it decides

| Rule id | Decision | When |
|---|---|---|
| `delete.trash` | deny (a refusal) | every file the call names exists, is inside the project folder, is on the same volume as it, is not one of openmorals' own files and is not a secret file, and the project folder is not your home folder or above it. The reason names the command, e.g. `` Use `openmorals trash src/a.js` instead ``; for `git rm` it names `openmorals trash <path> && git rm -q --cached <path>`; for an overwrite, `` Run `openmorals trash src/a.js` first, then the mv `` |
| `delete.ask` | `guards.delete.decision` (ask) | a file the trash cannot take: outside the project, on another volume, inside `.openmorals` or the config folder, in a project rooted at the home folder, unreadable, or a secret file (`.env`, keys, credentials: the trash would keep the secret on disk, so you are asked for a real delete). A file in the system's temp folder says it can be left for the system to clear |
| `delete.blind` | deny | a path built at run time: a variable openmorals cannot expand (`$f`, `"$OUT/a.txt"`), `` `...` ``, `$(...)`, `%VAR%`, `$env:VAR`. The reason says to write the path out or use `openmorals trash` with the same word (the trash refuses anything outside the project). Also a move of such a path into a temp folder |

The ask's decision is the stricter of `guards.delete.decision` and, when the file is a document, `guards.document.decision` (0.22.0).

A missing file and a folder are never asked about (plain `rm` cannot remove a folder). An unreadable file asks.

The trash prediction is the trash's own tests, made from one `stat` of each file and of the project folder; nothing is written. The project folder is the one holding the nearest `openmorals.yaml`, else the agent's working folder, the same rule `openmorals trash` uses. If the prediction is wrong (a permission the stat did not show), `openmorals trash` fails and moves nothing, and the agent's retry of the delete is refused again: it fails closed, at a token cost.

### Held when nobody can answer

`delete.ask` is held like a document delete ([deferred asks](deferred-asks.md)), for moves and overwrites too: under `--unattended` or with `defer: true` on Claude Code it is refused with "queued for the user's approval", the agent carries on, and you approve that exact call later. For a move or copy into a folder the approval is bound to the file it would replace inside that folder, not to the folder, whose modified time changes whenever anything is made there (0.22.0). `delete.trash` and `delete.blind` are refusals, never held: there is nothing to approve, because the trash command already reaches the goal.

### The line at your next message

On a host whose prompt hook has a line only you see (`systemMessage`), openmorals adds one line at your next message when items went into this project's trash since the session began, once per new count. Since 0.22.0 it names the newest three (a long path keeps its end, at most 48 characters each), then counts the rest:

```
openmorals: 5 items moved to this project's trash since this session began (docs/notes.md, data.csv, src/a.js and 2 more); nothing is deleted until you purge (openmorals trash --list).
```

The model is not shown it. The first message of a session only starts the count; another session working in the same project is counted too (the count is of the project's trash log). Per host: Claude Code `UserPromptSubmit`, Codex `UserPromptSubmit` and Gemini CLI `BeforeAgent` carry it; opencode's prompt event has no line for the person only, and OpenClaw has no prompt event, so neither shows it. Whether the line reaches the person on any host has not been checked live; `openmorals trash --list` is the fallback.

## Only the person deletes for good

`openmorals trash` moves a file (`openmorals trash --copy` keeps a copy and leaves the file, 0.24.0, see [replace.md](replace.md)); `openmorals purge` is the real delete:

- It prints every item it will delete (id, time, size, path) first. In a terminal it then asks you to type `yes`; where nobody can be asked it deletes nothing unless `--yes` is given. It deletes exactly the listed items.
- `openmorals purge --older-than <days>` takes every trashed item older than that; `openmorals purge <id>...` takes the items you name, for example one trashed `.env`.
- An agent running `openmorals purge` in any form openmorals recognises (`openmorals`, `npx`, `npm exec`, `python -m`, `node <path>/openmorals/dist/src/cli.js`) is asked first (`self-protect.write`), and under `--unattended` refused. It is never held for later approval.

A secret file in the trash: `openmorals trash .env` is itself asked about (the secrets guard), the trashed copy keeps its permissions, `.openmorals/.gitignore` keeps it out of git, and reading it is asked about like any `.env`. It stays on disk until purged, which is why this guard asks about deleting a secret file instead of steering it to the trash.

## Settings

```yaml
guards:
  delete:
    decision: ask   # ask (default), deny, allow. allow switches the guard off
    steer: trash    # trash (default): refuse with the trash command named; ask: ask about each delete
```

| Setting | Values | Default | A project file |
|---|---|---|---|
| `guards.delete.decision` | `allow`, `ask`, `deny` | `ask` | may raise it, never lower it |
| `guards.delete.steer` | `trash`, `ask` | `trash` | may set `trash` over your `ask`, never `ask` over your `trash` |

`deny` turns every `delete.ask` into a refusal. `steer: ask` asks about every delete the trash could take (the reason still names the trash command as the recoverable route); it is for a person who wants every delete in front of them. There is no exclude list. `openmorals.yaml` in the project may only tighten your own file ([ADR 0010](adr/0010-the-user-file-is-a-floor.md)), and `loosenings()` reports a looser value. An invalid file never switches the guard off.

## Tension with "ask the user" (recorded, not hidden)

The default is a refusal, and "ask the user" is the default elsewhere. The refusal does not forbid the goal: it names the command that reaches it, and the permission is asked where the data really disappears, at `purge`. A person who wants to be asked per delete sets `steer: ask`.

## What it cannot see

- Files removed by a program the agent runs: a script, `python -c 'os.remove(...)'`, `make clean`, `npm run clean`. The OS sandbox is the answer there ([sandbox](sandbox.md)).
- A file replaced whole by the agent's Write tool, or by a redirect with content (`echo hi > data.csv`, `curl ... > photo.jpg`), and in-place rewriters (`sed -i`, `sips`, `mogrify`): this guard does not judge them, and by default nothing is asked (a document still gets the document guard's checks; emptying any file is asked). `guards.replace.steer: keep` (0.24.0, off by default) refuses such a replacement outside git until a copy is kept with `openmorals trash --copy`: see [replace.md](replace.md).
- `cp -r` or `mv` of a folder over files that already exist inside the destination; a move or copy whose destination openmorals cannot resolve (`"$OUT/x"`, `$RUNNER_TEMP` and other variables than the temp ones above); a temp folder reached through a link or a `TMPDIR` set elsewhere.
- A file the same call creates before deleting it (`make && rm out.o`): it does not exist when the call is judged, so nothing is asked.
- `rmdir`.
- A delete on a host that does not call openmorals before the tool runs.
- Whether a live agent follows the refusal (unmeasured).

## Measured

- Case rows: [`cases/delete.cases.yaml`](../cases/delete.cases.yaml), 57 rows at 0.21.0 (42 ask or deny, 15 allow), 85 at 0.21.1 (62, 23); unit and hook tests in [`test/delete.test.ts`](../test/delete.test.ts). `openmorals eval` at 0.21.1: 62/62 caught, 0/23 false alarms; every earlier row decides as in 0.20.0 (a test runs every other row with and without this guard).
- Reason lengths, measured in a run of the built hook (the whole reason the agent reads, including the `openmorals deny [rule]: ` prefix): 208 characters for `rm` of one file (about 50 tokens at four characters a token, an estimate), 241 for `git rm`, 231 for an MCP delete, 166 to 171 for a path built at run time, 113 for a `steer: ask` ask. An ask about a file outside the project carries its path (at most 80 characters shown) and was 255.
- 0.22.0: 141 case rows (101 ask or deny, 40 allow); `openmorals eval`: 101/101 caught, 0/40 false alarms. A test runs every pair of document and delete settings over fifteen delete, move and copy calls and checks that the stricter setting never gives a lower-ranked decision. Reasons (the guard's text, without the host's prefix): a temp-move refusal 215 to 223 characters, an overwrite refusal 189 to 206, an overwrite ask 106 to 112. Replaying the 29 `mv` and `cp` lines found in this repository and a separate team package (scripts, workflows, tests, docs) from their own folders: 25 silent, 4 asked (all self-protect, unchanged), none refused; with every named file made to exist on a model disk: 12 refused, 7 asked, 10 silent. A live session's rate of moves and overwrites is unmeasured.
- Replay over this repository's history: it has no deleted file, so no rate could be measured. Judging every tracked file as `rm <path>` gives 246 refusals with the trash command named and 46 document asks out of 292 files: every existing file is covered, which says nothing about how often an agent deletes. The rate in a live session is unmeasured.
