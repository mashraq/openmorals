# The audit record (0.8.0)

Every decision openmorals makes is appended to `audit.jsonl` in the config directory, one JSON line per record. Since 0.8.0 each line is numbered within its session and carries the hash of the line before it, so `openmorals audit verify` can tell when a line was edited, deleted or cut off, or when a session's saved state was reset. This page says what a record holds, what verification shows, and what it cannot show.

Status: **Built (0.8.0)**. Tested in `test/audit-chain.test.ts`.

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

A session started without `OPENMORALS_RUN` has no `run` field and is not part of any run.

## Cost

One SHA-256 of the line, plus one of the bylaws: about 0.008 ms per record on an Apple M3 Pro with Node 25.9 (measured 24 Nov 2026, 20,000 records after a warm-up). The in-process hook took 0.30 ms per call at the median before and after the change; the difference was inside run-to-run noise. No model is called and no token is spent.
