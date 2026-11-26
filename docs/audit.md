# The audit record (0.8.0)

Every decision openmorals makes is appended to `audit.jsonl` in the config directory, one JSON line per record. Since 0.8.0 each line is numbered within its session and carries the hash of the line before it, so `openmorals audit verify` can tell when a line was edited, deleted or cut off, or when a session's saved state was reset. This page says what a record holds, what verification shows, and what it cannot show.

Status: **Built (0.8.0)**. Tested in `test/audit-chain.test.ts`. `audit sample`, a draw of finished runs for a close read: **Built (0.11.0)**, [below](#openmorals-audit-sample).

## What this proves and what it does not

Read this first.

- **It shows careless or partial tampering and loss.** A line that was changed, a line that was removed from the middle or the end, a log cut off mid-line, a session whose state file was deleted or replaced with an older copy, a removed log whose session files are still there, and a declared run that left no record.
- **It does not stop a program running as you from rewriting the record.** The log and the session files belong to the same user as the agent. A program the agent starts (a script it wrote, an `npm test` whose script it edited) can rewrite `audit.jsonl`, recompute every hash, and update the session files to match; `audit verify` then passes. Deleting the log and every session file together also leaves nothing to compare, unless a run id was declared. Only an OS sandbox around the agent's commands ([sandbox.md](sandbox.md)), or a copy of each session's chain head held somewhere the agent cannot write, stops that. Holding those copies is planned for a separate team package; it is not in this repository.
- **It only covers what the hook saw.** What runs inside a script, a test runner or a build step never reaches a hook ([ADR 0004](adr/0004-enforcement-outside-the-model.md)). If the host cannot start the hook, the call runs and nothing is recorded, so a clean record is also what a run with no hook at all looks like.
- **So a record can only raise review, never lower it** ([ADR 0013](adr/0013-a-merge-verdict-decided-in-ci-the-record-can-only-raise-review.md)). A deny, an approved ask, a taint mark, an ignored loosening, a break in the chain or a missing record are reasons to look. A clean, verified record is not a reason to look less.

## Record format

Version 2 lines (0.8.0 and later) hold the version 1 fields (`ts`, `source`, `session`, `tool`, `action`, `decision`, `rule`, `reason`, `cwd`, `budget`; see [API.md](../API.md#audit-log)) plus:

| field | always | what it is |
|---|---|---|
| `v` | yes | `2` |
| `seq` | yes | the record's number within its session, from 1 |
| `prev` | yes | SHA-256 (hex) of the previous line of the same session exactly as written, without its newline; 64 zeros for the first |
| `ov` | yes | the openmorals version that wrote the line |
| `bylaws` | when read | SHA-256 (hex) of the bylaws in force, as JSON with sorted keys: two records with the same value were decided under the same settings |
| `event` | when known | the host's event name (`PreToolUse`, `AfterTool`, `before_tool_call`, ...) |
| `run` | when set | the value of `OPENMORALS_RUN` in the hook's own environment |
| `agent` | when the host sends one | the host's agent id (see the table below) |
| `disclaimers` | once per session (0.25.0) | the `disclaimer:` texts of the bylaws in force, on the first record of a session that runs under them, and again only when they change (the session file keeps their SHA-256 in `chain`) |
| `handoff` | when the call hands text to another agent (0.38.0) | kind (`spawn`, `message`, `handback`), a fingerprint keyed per install (HMAC-SHA256) and the size of the text after redaction, the sending session's taint, and labels of claims of approval or authority; never the text. Read back by `openmorals audit handoffs` ([agent-messages.md](agent-messages.md)) |

A field openmorals does not know is left out, never guessed. A session is identified by its session file (`safeSessionId` of the host's session id, `unknown` when the host sends none), so the `check` command and an event that could not be read are chained under `unknown`.

The session file keeps the newest `seq` and line hash as `chain: { seq, head }`. It is saved with the same write-then-rename as the budget and taint, in the same write, before the line is appended. If the save fails, the line is still written and the next record repeats its number; if the append fails, the session file is ahead of the log and `verify` says so. In both cases the call itself was already turned into an ask (or a deny when unattended), as before 0.8.0.

## The outcome of an ask

When a call that openmorals asked about runs, the host's post-tool event finds the call in the session history (by the host's call id, else by the action) and writes one more line: `decision: allow`, `rule: ask.approved`, the original rule in the reason. A refused ask runs nothing and sends no post-tool event, so it has no outcome line. An ask with no `ask.approved` line was refused, is still waiting, or ran on a host or install without a post-tool hook.

| host | events written | approved asks recorded | agent id |
|---|---|---|---|
| Claude Code | `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `UserPromptSubmit` | yes. Both post events fire only for a call that started running; a permission denial fires neither (hooks reference, https://code.claude.com/docs/en/hooks, read 24 Nov 2026). Needs the post-tool hooks `init` installs since 0.5.0 | `agent_id`, sent for a subagent or in-process teammate; none in the main conversation, so the field is left out there |
| Codex CLI | `PreToolUse`, `PostToolUse`, `UserPromptSubmit` | no: Codex hooks cannot ask, so an ask is sent as a block and never runs | none: the hook input has no agent field ([adapters.md](adapters.md#codex-cli)) |
| Gemini CLI | `BeforeTool`, `AfterTool`, `BeforeAgent` | yes, from `AfterTool`. INFERRED that `AfterTool` fires only for a call that ran. Gemini CLI sends no call id, so the call is matched by its action | none |
| opencode | `tool.execute.before`, `permission.evaluate`, `tool.execute.after`, `prompt` | V1: no, it has no ask. V2: an ask decided in `tool.execute.before` is matched to `tool.execute.after`; an ask raised only by the permission hook is not linked to its call, so its outcome is not recorded | none. The V2 event carries `agent`, an agent name rather than an id; it is not recorded |
| OpenClaw | `before_tool_call`, `after_tool_call` | yes, from `after_tool_call` (matched by `toolCallId`) | `ctx.agentId`, sent by the plugin `openmorals init --agent openclaw` writes from 0.8.0; a plugin written earlier sends none until it is written again |
| `openmorals check` | none | not applicable | none |

## `openmorals audit verify`

```console
$ openmorals audit verify
verified: /home/user/.config/openmorals/audit.jsonl: 212 lines (212 chained, 0 version 1) in 9 sessions
This shows lost, cut or edited lines and reset sessions. It cannot show a log that a program running as you rewrote with every hash recomputed.
```

It reads the log and the session files beside it (`sessions/` next to `--file`), writes nothing, and exits 0 when verified, 1 when anything below is found, 64 on a usage error.

| problem | what it means |
|---|---|
| `edited` | a record does not link to the one before it in its session: that line (named by number), or this link, was changed. Also when the session file's newest hash is not in the log |
| `gap` | numbers are missing in a session: lines were deleted |
| `truncated` | the file does not end with a newline: the last line was cut off or edited |
| `tail-missing` | the session file says the session reached a number the log does not hold: lines were removed from the end, or the log was removed |
| `restart` | a session's numbering went back: its state file was deleted or replaced with an older copy while the session went on |
| `unreadable-line` | a line that is not a record (not JSON, an unknown version, a missing or mistyped field) |
| `unchained` | a version 1 line after the first version 2 line |
| `missing-log` | `--run` was given and there is no log |
| `run-missing` | `--run` was given and no record carries that run id |
| `unreadable-log` | the log exists and could not be read |

Notes do not fail verification:

| note | what it means |
|---|---|
| `legacy` | version 1 lines (from before 0.8.0) before the chain began. They carry no chain and cannot be checked |
| `fork` | two records with the same number linking to the same record. Two calls of one session were judged at once: a host can start several hooks in parallel and the session file has no lock |
| `behind` | the session file is behind its newest record (saved by the slower of two concurrent calls) |
| `session-unreadable` | a session file or its chain head could not be read, so the end of that session cannot be checked |
| `no-log` | there is no log and no run was declared |

**A log that mixes version 1 and version 2 lines.** Lines from before 0.8.0 at the top of the file are counted as `legacy` and pass. A version 1 line after the chain began fails as `unchained`: openmorals 0.8.0 never writes one, so either an older openmorals install still writes to the same config directory (upgrade every install that uses it) or a line was inserted.

**Known gaps.** A session whose state file was reset after exactly one record looks like two concurrent first calls (a `fork` note, not a `restart`). A record whose `reason` is longer than 2000 characters is truncated before it is written, so a loosening note at its end can be cut. Deleting the log and every session file together looks like a machine where nothing ran, unless `--run` is given.

## `openmorals audit --run <id>`

Start each agent of a run with `OPENMORALS_RUN=<id>` in the environment the hook inherits, then summarise the run:

```console
$ openmorals audit --run nightly-42
run nightly-42: 57 records in 3 sessions; 1 denied, 2 asked, 1 approved asks, 1 taint marks, 0 loosening notes; record verified
```

`--json` prints `{ file, run, status, records, sessions, denies, asks, approved_asks, taint_marks, loosening_notes, record: { ok, problems } }`; each list item has the line number, time, session, tool, decision, rule and the first 200 characters of the action. `taint_marks` are the inbound findings (content the session read was marked untrusted, injected or private); `loosening_notes` are records whose reason says a project file tried to loosen the user's floor. `record.problems` are the `verify` problems for the sessions the run touched plus those about the whole file. The exit code is 0 when the run has records and they verify, and 1 otherwise; denies and asks do not change it.

A session started without `OPENMORALS_RUN` has no `run` field and is not part of any run. Records of your own acts (`openmorals stop` from 0.39.0, `order`) carry no `run` either.

## `openmorals stop` records and `openmorals audit oversight` (0.39.0)

`openmorals stop <session>`, `stop --all`, `stop --run <id>`, `stop --clear [<session>]` and `stop --clear --run <id>` each write one chained record: `source: "openmorals"`, `session: "stop"`, `decision: "allow"`, rule `stop.set` or `stop.clear`, action `stop <session>`, `stop --all`, `stop --run <id>`, `stop --clear <session>`, `stop --clear --run <id>` or `stop --clear`, and a reason that says what was stopped or cleared and whether it ran from a terminal. `audit sample` and `audit oversight` leave them out of the agent's calls. A failed write is reported on stderr; the stop has already taken effect.

`openmorals audit oversight [--since TIME] [--until TIME] [--json] [--file FILE]` summarises the log as a record of your oversight: calls, asks, approved asks, asks with no outcome, approval rate per rule, asks per 100 calls, denies, calls refused as stopped, stops set and cleared, and whether the record verifies, with reasons to look and never a pass. It exits 0 when the record verifies and 1 otherwise (64 on a usage error). What it can and cannot be evidence for: [oversight.md](oversight.md).

## `openmorals audit sample`

Added in 0.11.0. Tested in `test/audit-sample/`. Read one finished piece of work in N closely, chosen by a draw the agent cannot predict or steer, and count what the checks missed. Plain code: no model call, no token cost. It reads the audit record and writes only its own records into it.

**Read this first.** A sample finds what a reader notices, not everything. It covers only sessions on hosts that call openmorals: work done where the hook did not run left no record and is never drawn. The record names actions, not the quality of the work: the summary helps you find the work; you read the work itself. A clean read lowers no other check: every ask and deny stands. Read-only tests stop an agent editing them; they do not stop code written to pass those exact tests. You still read a sample.

### Draw

```console
$ openmorals audit sample
audit sample: picked 1 of 12 finished runs at 1 in 10 (seed 5f0c9a1e2b3d…, recorded in /home/user/.config/openmorals/audit.jsonl); record verified
picks:
  run:nightly-41  57 records in 3 sessions, 2026-11-20T10:00:00.000Z to 2026-11-20T11:12:00.000Z; 1 denied, 2 asked, 1 approved asks, 0 taint marks, 0 loosening notes
    in: /srv/app
    denied: line 812  git.force-push  Bash  git push --force origin main
    asked: line 790  destructive.rm  Bash  rm -rf build
    named: npm test | src/parse.ts | git commit -m "parse dates"
    more: openmorals audit --run nightly-41
Record each read: openmorals audit sample --record run:<id> clean|escape "<one line why>"
A sample finds what a reader notices, not everything.
It covers only sessions on hosts that call openmorals: work done where the hook did not run left no record and is never drawn.
The record names actions, not the quality of the work: read the work itself.
A clean read lowers no other check: every ask and deny stands.
```

- **The unit** is a run: the records written with `OPENMORALS_RUN=<id>` in the hook's environment (see [`audit --run`](#openmorals-audit---run-id)). If you never set a run id, draw sessions with `--by session` (or `by: session` in the settings file). Records with no run id are counted and named in a run draw, never silently dropped.
- **Each unit is considered once**, by the first draw after it finished, and is picked with a chance of 1 in N. Over many draws about 1 in N units are read, however often you draw. A draw with no pick is still recorded: its units were considered.
- **Finished** means no record in the last `settle_minutes` (default 30). A unit with a newer record (or one dated in the future) waits for a later draw and is listed by id.
- **A unit whose record does not verify** (an edited, deleted or cut line in one of its sessions, as `audit verify` reports) is picked whatever the draw says, and its problems are printed. Problems that belong to no unit are printed too, and the exit code is 1.
- **After an escape, or a change you declare** (`--change "new model"`, for a model, pack or host change), the draws that consider the next `read_all_next` units (default 5) read everything; then sampling goes back to 1 in N.
- `--json` prints one object: `drawn_at`, `by`, `rate`, `read_all`, `seed`, `method`, `population`, `drawn`, `forced`, `picks` (each with what the record holds: times, counts of denies, asks, approved asks, taint marks and loosening notes, sessions, folders, the first commands and files named, and any record problems), `active`, `earlier`, `record`, `limits`.

### How the draw is made, and what an agent can and cannot change

When you run the command, it takes 32 bytes from the operating system's random source (`crypto.randomBytes`) as the seed. A unit is picked when the first 48 bits of HMAC-SHA256(seed, unit id), read as a fraction, are below 1/N. The draw record holds the seed, the method, N, the whole population and the picks, so anyone can recompute it later; `--tally` does, for every draw.

- **The agent cannot choose which unit is picked.** The seed does not exist when any record is written, so no run id, session id, order, timing, tool, command or other field changes a unit's chance. The same population drawn with the same seed gives the same picks in any order.
- **The agent cannot re-draw or undo a draw through the plain command.** Every form that writes (`audit sample`, `--record`, `--change`) is on the self-protect list: run by an agent, it is asked about (denied when unattended). `--tally` and `--help` only read. A unit is considered once, so drawing again does not give a second chance.
- **The agent cannot set N.** N comes from the settings file in your config directory, which self-protect covers; there is no command-line N.
- **What it can still do.** Delay a unit by staying active (the unit is listed as waiting, and is considered later). Stop the hook from running, so its work leaves no record (then nothing is drawn). Start openmorals in a way self-protect does not recognise; the package's own entry, a checkout by any path, `npx`, `bunx`, `pnpx`, `npm`/`pnpm`/`yarn`/`bun` `exec`/`x`/`dlx` and `python -m openmorals` are recognised. Anything it writes that way is a line in the record like any other, and `--tally` lists every draw and verdict. A program it runs as you can rewrite the record and recompute the chain, as [What this proves](#what-this-proves-and-what-it-does-not) says; a draw record rewritten that way would recompute too.

### Verdicts and the tally

```console
$ openmorals audit sample --record run:nightly-41 escape "a skipped test hid a broken date parser"
recorded: escape for run:nightly-41
The draws that consider the next 5 units read everything, then sampling goes back to 1 in 10. Turn the escape into a test or a rule.

$ openmorals audit sample --tally
audit sample tally: /home/user/.config/openmorals/audit.jsonl
draws: 3 (3 by run, 0 by session); units considered: 31; picked: 3
verdicts: 2 of 3 picks (67%): 1 clean, 1 escape
escapes: 1 of 2 verdicts (50%)
picks with no verdict yet: 1
  run:nightly-47  drawn 2026-11-24T09:00:00.000Z  no verdict yet
verdicts recorded:
  run:nightly-33  drawn 2026-11-17T09:00:00.000Z  clean (2026-11-17T10:30:00.000Z): read the diff; the tests named the change
  run:nightly-41  drawn 2026-11-21T09:00:00.000Z  escape (2026-11-24T10:02:11.000Z): a skipped test hid a broken date parser
next draw: reads everything (5 more units after the escape recorded for run:nightly-41 at 2026-11-24T10:02:11.000Z), then 1 in 10
record: verified
A sample finds what a reader notices, not everything.
It covers only sessions on hosts that call openmorals: work done where the hook did not run left no record and is never drawn.
The record names actions, not the quality of the work: read the work itself.
A clean read lowers no other check: every ask and deny stands.
```

- **A verdict** is `clean` or `escape` (something your checks missed that you found by reading), with one line saying why. Only a drawn unit takes a verdict, so the tally stays a sample. A later verdict on the same pick replaces it in the tally; both stay in the log. `run:` or `session:` can be left off when only one pick has that id.
- **The tally** counts draws, units considered, picks, verdicts, clean and escape, the share of picks that got a verdict, and escapes per verdict. It lists the picks still waiting for a verdict and recomputes every draw from its seed; a draw that does not recompute, or a verdict for a unit no draw picked, is reported and the exit code is 1. There is no score per agent, no chart, and no rate at which work passes. A low share of picks with a verdict means the reading is not happening.

### Settings

`audit-sample.yaml` in the config directory (`$OPENMORALS_HOME`, else `~/.config/openmorals`), all optional:

```yaml
rate: 10            # read 1 in N finished units (1 reads everything; up to 1000)
read_all_next: 5    # after an escape or a declared change, read the next K units in full (0 turns it off)
by: run             # run or session
settle_minutes: 30  # a unit with a newer record waits for a later draw
```

An unknown key or a value out of range makes the file invalid: the command exits 2 and does nothing. It is a separate file, not part of `openmorals.yaml`, so a project file cannot change it.

### Records and exit codes

Draws, verdicts and changes are chained version 2 lines under the session `audit-sample`, with rule `audit.sample.draw`, `audit.sample.verdict` or `audit.sample.change` and a `sample` object holding the draw or the verdict (the verdict's note is the `reason`, redacted like every reason). `audit verify` checks them like any other line; they are never part of a run or of a draw's population.

| command | 0 | 1 | 2 | 3 | 64 |
|---|---|---|---|---|---|
| `audit sample` | drawn and recorded | drawn and recorded; the record does not verify | the log, a session file or the settings file cannot be read, or the draw could not be recorded: nothing drawn | nothing to draw from (no log, or no finished unit an earlier draw has not considered): nothing written | usage |
| `--record` | recorded | not a pick: nothing recorded | unreadable, or could not be written | | usage, or an id two picks share |
| `--change` | recorded | | unreadable, or could not be written | | usage |
| `--tally` | counted | the record does not verify, or a sample record is wrong | unreadable | | usage |

## Cost

One SHA-256 of the line, plus one of the bylaws: about 0.008 ms per record on an Apple M3 Pro with Node 25.9 (measured 24 Nov 2026, 20,000 records after a warm-up). The in-process hook took 0.30 ms per call at the median before and after the change; the difference was inside run-to-run noise. No model is called and no token is spent.
