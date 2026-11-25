# Replacing a file whole: the replace guard (0.24.0, off by default)

An ordinary edit passes silently, and so, by default, does a call that replaces a file's whole content: the Write tool over an existing file, `echo hi > data.csv`, `curl ... > photo.jpg`, `sed -i`. In a folder under git the old content can be brought back; in a folder without git (Documents, Pictures, a downloads folder) it is gone. `guards.replace.steer: keep` is for a person who wants those replacements to keep the old content first.

**It is off by default**, because it costs tokens on every first replacement in a folder without git: one refused call and one extra command per file (counted below), and no rate of such replacements in a real session is known. Switching it on is one line.

What this page claims, and what it does not: with `keep`, openmorals **refuses the replacement once and names the command that keeps a copy**. Whether a live agent then runs that command, rather than finding another way to write the file, has not been observed: nothing here has been run against a live agent.

## What it does

With `keep`, a call that would replace the whole content of an existing, non-empty file that has no `.git` folder (or `.git` file) above it is refused:

```
Write would replace 'data.csv' (31 bytes) whole, with no .git above it: not run. Run `openmorals trash --copy data.csv` (it keeps a copy in the project trash the person can restore; the file stays), then repeat the Write. Carry on.
```

`openmorals trash --copy data.csv` copies the file into the project trash (`.openmorals/trash/<id>/`) and leaves it in place. The same call then passes. The agent may run the copy command without an ask; it cannot purge (`openmorals purge` asks, as before).

| Judged (with `keep`) | Notes |
|---|---|
| the Write tool (and every host's whole-file write) over an existing file | `write_file`, a patch's `Add File` over an existing file |
| a `>` or `>|` redirect onto an existing file, from a command with output | `echo hi > data.csv`, `curl ... > photo.jpg`, `python3 gen.py > out.json` |
| `tee` without `-a`/`--append` | each file it names |
| `sed -i` and `perl -i` with no backup suffix | `sed -i 's/a/b/' f`, `sed -i '' ...` (BSD), `perl -pi -e ...`. With a suffix (`-i.bak`, `-i .bak`, `--in-place=.orig`, GNU's `-ie`) a copy is kept, so they pass |

`sed -i` and `perl -i` are judged although they are edits, because openmorals sees neither the old nor the new text (unlike the Edit tool, whose strings it reads), so it cannot tell a small change from a rewrite, and without git the old content is then nowhere.

Not judged, by design:

- **The Edit tool, a patch's update, an append (`>>`)**: ordinary edits stay silent, with the setting on or off.
- **A new file, an empty file**: there is nothing to keep.
- **A file with a `.git` above it**: git can bring it back. The check is a `stat` of `.git` in the file's folder and each folder above, stopping below your home folder for a file inside it (a dotfiles repository in your home folder does not mark your Documents as kept). openmorals starts no process. **A file inside a git folder that git does not track, or ignores, passes too**: telling it apart needs git, and the hook never runs it. This is a limit.
- **A secret file** (`.env`, keys): the secrets guard asks about every write to one; a copy in the trash would keep the secret on disk.
- **Emptying a file** (`: > f`, a Write with empty content, `sort f > f`) when `guards.document.decision` is `deny`: the document guard refuses it. Under `allow` and under `ask` (the default) this guard refuses it until a copy is kept, like any other replacement, and then the document guard decides as it does with this setting off (0.25.0; in 0.24.0 the default `ask` gave only an ask while `allow` gave the refusal, so the stricter setting gave the weaker answer).
- **`mv` or `cp` onto a file**: the delete guard refuses it toward `openmorals trash <file>` (0.22.0), with or without this setting.

## When a copy counts

A replacement passes when the file's current bytes are kept:

1. **A kept copy**: the project's undo log (`.openmorals/undo.jsonl`) holds a live `trash --copy` entry for this file (not restored, not purged) whose sha256 is the sha256 of the file now, and the copy is still in its trash slot with that size. The log is a file, so this holds across hook processes and across sessions. A copy of an older version does not count for a newer one: change the file by hand after the copy, and the next replacement is refused again (those typed bytes exist nowhere else).
2. **The session's own output**: after a Write, a redirect or a `tee` that ran (the host's post-tool event says it worked, and the call is in the session's history), openmorals stores the sha256 of what the file then holds in the session file. Rewriting exactly that content again passes, so an agent rewriting its own output is refused once per file, not once per write. An Edit or `sed -i` is never stored, because the file still holds mostly your content; a host that sends no post-tool event just refuses again (a cost, not a loss). At most 64 files per session are remembered.

Neither can be written by the agent without an ask: the undo log and the trash slots are under `.openmorals/`, the session file is in openmorals' config folder, and the self-protect guard asks about any write to either. A copy the agent makes elsewhere (`data.csv.bak`), or a log it writes in another folder, counts for nothing.

The file is hashed by the hook (sha256, read in 1 MiB pieces, at most 64 MiB); the undo log is read up to 4 MiB.

## Asks

`replace.ask` (deferrable, like `delete.ask`): the file is outside the project folder, on another volume, inside openmorals' own folders, in a project rooted at your home folder, a link to a file outside the project, over 64 MiB, unreadable, or the undo log cannot be read. Its decision is `ask`, or `deny` when `guards.delete.decision` is `deny`. Under `--unattended` or `defer: true` (Claude Code) it is held for your approval like a delete. `replace.keep` is a refusal and is never held.

## Rule ids

| Rule id | Decision | When |
|---|---|---|
| `replace.keep` | deny (a refusal) | `keep` is on, the file exists, is non-empty, has no `.git` above it, is not kept (above), and the trash can take it. The reason names `openmorals trash --copy <path>` (up to three paths) |
| `replace.ask` | ask (deny with `guards.delete.decision: deny`) | as above, but the trash cannot take a copy or openmorals cannot check |
| `replace.error` | ask | the guard failed; it fails closed |

## Settings

```yaml
guards:
  replace:
    steer: keep   # off (the default, also when the section is absent) or keep
```

| Setting | Values | Default | A project file |
|---|---|---|---|
| `guards.replace.steer` | `off`, `keep` | `off` (absent) | may set `keep`; its `off` under your `keep` is ignored and named (`loosenings()` reports it) |

The shape follows `guards.delete.steer`: a section per guard, and a ranked value a project may raise but never lower. The section is absent from the defaults, so a default setup's policy (and its digest in the audit log) is unchanged. An invalid value makes the file invalid: openmorals then uses the defaults, where this guard is off, and asks about every call until the file is fixed.

## The copy, restore and purge

- `openmorals trash --copy <file>...` copies each file into its own trash slot and logs it with `copy: true` and the sha256 of the copied bytes. A folder cannot be kept this way; a link is kept as the file it points to.
- `openmorals trash --list` marks it `(kept copy)`.
- `openmorals restore <id>` puts the copy back once the file is out of the way; while the file is there it refuses and says so (`... is still there (this item is a kept copy); put it aside first with openmorals trash <path>, then restore; nothing was overwritten`). Putting the current file aside with `openmorals trash` keeps that version too.
- `openmorals purge` deletes a kept copy for good like any trashed item, and only the person runs it.
- The line at your next message counts kept copies apart: `openmorals: 1 copy of file kept in this project's trash since this session began (photo.jpg); ...`, or `2 items moved to and 1 copy kept in ...`. With no copies its words are those of 0.22.0.

## Cost

Counted on the built hook (no live agent, no model): 20 Write replacements of 20 different files in a folder without git cost nothing by default; with `keep`, 40 extra calls (20 refusals and 20 copy commands), 5,400 characters of refusal text (270 each, with the host's prefix) and 3,240 characters of copy-command output, about 2,160 tokens at four characters a token (an estimate). 20 replacements of 4 files, 5 each (the agent rewriting its own output), cost 8 extra calls and 1,749 characters; on a host with no post-tool event, the same as 20 different files. Not counted: the model's own words for the extra calls.

## What it cannot see

- A file replaced by a program the agent runs (`python write.py`, `make`), by an image tool in place (`sips`, `mogrify`), `sort -o`, `curl -o`, `wget -O`, `dd of=`, PowerShell `Set-Content`/`Out-File`, or `tee` and `>` inside a script: only the forms above are read. The OS sandbox is the answer for programs ([sandbox](sandbox.md)).
- A redirect target built at run time (`> "$OUT"`) or after a change of folder openmorals cannot follow (`cd "$D" && echo x > f`).
- A file inside a git folder that git does not track or ignores (above).
- Whether a live agent runs the copy command or routes round the refusal (unmeasured).
- How often a daily-agent session replaces files whole (no such session measured), so the cost above is per replacement, not per day.

## Measured

- Case rows: [`cases/replace.cases.yaml`](../cases/replace.cases.yaml), 57 rows (29 ask or deny, 28 allow, 11 of them the caught rows again with the default: all silent); four boundary rows with `keep` on sit in the delete, document and secrets case files. `openmorals eval`: 29/29 caught, 0/28 false alarms. Every row of 0.23.0 decides as before (the 0.24.0 build scores the 0.23.0 rows at 819 rows, every row matched), and a test runs every row without `keep` with and without this guard and finds the same decision, rule and reason.
- Reason lengths in a run of the built hook (the whole reason the agent reads, with the 32-character `openmorals deny [replace.keep]: ` prefix): 263 for a Write over `data.csv`, 279 for a redirect over `photo.jpg`; an ask about a file outside the project 253.
- Each check was disabled once and its tests went red, then restored byte for byte (see the release notes).
