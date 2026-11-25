# Deferred asks: hold a deletion, let the agent carry on, approve it later

Status: **Built (0.19.0)**, on Claude Code only. Not run against a live agent: every result below is from the hook run on recorded event shapes and from unit tests.

When nobody is there to answer the host's permission prompt, a deletion or a large removal from a document is held instead: the action does not run, it is queued for you, the agent is told to carry on with other work, and later you approve that exact action, once. Nothing runs because of a hold, and nothing is ever run by openmorals itself: the agent has to ask again, and the call is let through only if it is the call you approved.

## When an action is held

An action is held when all of these are true:

1. The host is Claude Code (`openmorals hook claude-code`), the call has a session id, and the bylaws are valid.
2. Its verdict is `ask`, and every objection to it is one of these rule ids:
   - `destructive.*` (recursive, forced and wildcard deletes, `git clean`, `git reset --hard`, `truncate`, `shred` and the rest of the destructive guard);
   - `online-delete.*` (deleting a repository, a bucket, cloud resources, an HTTP DELETE, `terraform destroy`, `npm unpublish`);
   - `adapter.mcp-delete` (an MCP tool whose name says it deletes);
   - `document.delete`, `document.empty`, `document.shrink`, `document.heading`, `document.unknown` (the document guard, 0.18.0);
   - `delete.ask` (0.21.0: a plain delete of a file the project trash cannot take; since 0.22.0 also a move into a temp folder and `mv`/`cp` onto an existing file, and every one of them under `steer: ask`; `delete.trash` and `delete.blind` are refusals, never held, see [delete.md](delete.md)). For a move or copy into a folder the approval is bound to the file it would replace there, not to the folder (0.22.0).
   - `replace.ask` (0.24.0, only with `guards.replace.steer: keep`): a whole-file replacement of a file the project trash cannot keep a copy of (outside the project, another volume) or that openmorals cannot check. `replace.keep` is a refusal and is never held.

   Not `document.unreadable` (with the file unreadable there is no file state to bind an approval to), and never a call that also draws another objection: self-protect, secrets, taint, the loop detector, the budget, a parser ask, a rule of your own, an invalid bylaws file. Those keep their normal verdict.
3. Either the run is unattended (`--unattended` or `OPENMORALS_UNATTENDED=1`), where such an ask is a deny already, or your bylaws say `defer: true`.

A `deny` is never held and never approved: a guard set to `deny`, or a rule of yours that denies, stays a deny whatever you approved.

Without `defer: true`, an attended session is unchanged: you are asked in the host's own prompt as before.

## What each side sees

**The agent** gets a deny whose reason it reads (199 characters measured for a document delete, about 50 tokens at 4 characters a token):

```text
openmorals deny [document.delete]: not run; queued as D-8038 for the user's approval. Carry on with other work; do not retry it or get the same result another way. You will be told if it is approved.
```

`D-8038` is the request's id. A retry of the same call while it waits is held again under the same id, with no new request.

**You** get a line the model does not read (Claude Code's `systemMessage`), with the code that approves it:

```text
openmorals: held for your approval, not run: rm ~/Documents/notes.md [document.delete: rm deletes the document '/home/you/Documents/notes.md' (2,340 bytes); ...]. To let it run once in this session, type: approve D-8038-V7VBDG (or run openmorals pending in a terminal). It lapses in 24 h; D-8038 is the agent's name for it.
```

The six characters after the id are the part the agent never sees. They are random, shown only on that line, and stored only as a SHA-256 hash.

On your next message in that session, one more line tells you what still waits (once per request): `openmorals: 1 request waits for your approval: D-8038 (rm ~/Documents/notes.md). ...`. (A document outside the project; since 0.22.0 a document inside it is refused toward the trash, not held, unless `guards.delete.steer` is `ask`.) No desktop notification is sent and nothing goes over the network.

## Approving, refusing, listing

| How | What it does | Exit |
|---|---|---|
| type `approve D-8038-V7VBDG` in the chat | the `UserPromptSubmit` hook records the approval; the agent gets one line: `openmorals: the user approved D-8038; you may retry that exact call once, unchanged.` (85 characters) | (hook) |
| `openmorals approve D-8038-V7VBDG` | the same, from any terminal | 0 approved, 1 not (wrong code, not waiting, lapsed), 64 usage |
| `openmorals approve D-8038` | without the code: only in a terminal (standard input and output both a terminal). It shows the action and asks you to type the id again | 0, 1, 64 |
| `openmorals refuse D-8038` | no: the request never grants anything | 0 refused, 1 no such waiting or approved request |
| `openmorals pending [--all] [--json]` | lists what waits and what is approved but unused: id, the action as the audit record keeps it, the rule and why, the session, the folder, when it lapses; `--all` adds used, refused, void and lapsed ones. Never a code | 0, 1 when the folder cannot be read |

After an approval nothing runs until the agent makes the call again. When it does, the hook lets it through once if all of these still hold; otherwise the call gets its normal verdict (held again, asked, or denied), never "allow":

| Bound to | Checked how |
|---|---|
| the session | the same session id as the held call |
| the project folder | the same working folder, resolved |
| the tool | the same tool name |
| the exact arguments | a salted SHA-256 of every argument, keys in a fixed order (for Bash and PowerShell, `description` is left out: it is a note and does not change what runs) |
| the files | for every path the call names that exists: its kind, size and modified time, unchanged. A word with a wildcard binds its folder's modified time instead |
| time | the request lapses 24 hours after it was held, approved or not |
| one use | the approval is used by an exclusive create of a marker file, so two calls cannot both use it |

A changed file voids the approval (`D-4N98 was approved, but a file it names changed since, so that approval is void`), and the call is held again as a new request. A changed command, another file, another session or another folder is simply a different call. A call that names more than 256 words or more than 64 existing files is not held (its normal verdict stands).

When it runs, you see `openmorals: D-8038 runs now, as you approved; that approval is used.` openmorals still answers nothing to the host for it (ADR 0009): the host's own permission rules still apply.

## Where it is kept, and what protects it

The queue is the folder `deferred/` in the openmorals config directory: one `D-XXXX.json` per request, written once, and small marker files beside it (`.approved`, `.used`, `.refused`, `.void`, `.reminded`), each created once. A request file holds the session id, the folder, the tool, the action as the audit record keeps it (redacted, at most 300 characters), the rule and its reason, the salted hash of the arguments, the file states and the times. It never holds file content, a write's text, a secret or the code. Files of requests that lapsed more than 7 days earlier are removed when a new request is held.

- **The agent's own tools:** writing anywhere in the config directory with a write tool, a redirect or a command is a `self-protect.write` ask (deny when unattended). `openmorals approve`, `release` and `accept`, run directly, through `npx`/`npm exec`/`bun x`, `python -m`, or `node .../openmorals/dist/src/cli.js`, are `self-protect.write` asks with the reason "grants what only the person may grant; an agent cannot approve its own request". `pending` and `refuse` are not asked about: listing shows no code and refusing can only stop an action.
- **A program the agent writes and runs is not stopped.** It runs as you, so it can write the queue files directly and approve anything, exactly as it could edit your bylaws. The hook does not see it. The answer is an OS sandbox around the agent's commands that keeps the openmorals config directory read-only (for one command, `openmorals sandbox run` allows writes only in the project and temporary folders; see [sandbox.md](sandbox.md)). There is no secret key and no signature on these files: a key on the same machine, readable by the same user, would stop nothing a program could not also read.
- **The code** stops one thing: the agent cannot approve its own request through a prompt (for example by starting a child session whose prompt is `approve D-8038`), because it never sees the suffix. It does not stop a program that writes the files.

## Failure: it fails closed

| What goes wrong | What happens |
|---|---|
| the bylaws file is invalid | nothing is held and no approval is used; the normal verdict (ask, or deny unattended) with the bylaws error |
| a request file is unreadable, not JSON, or tampered (an id that does not match its name, a malformed field, a lifetime over 24 hours) | it grants nothing; the verdict carries `1 deferred-request file could not be read and grant nothing (openmorals pending lists them)`; `pending` names the file |
| an approval marker is malformed | the approval is not used; named as above |
| the `deferred/` folder cannot be read (a file in its place, no permission) | no approval is used and nothing is queued; the normal verdict with `the deferred-request folder ... could not be read (ENOTDIR), so no approval is used` |
| the request cannot be written | the normal verdict (ask, or deny unattended) with `it could not be queued for approval (...)` |
| the call has no session id | not held; the normal verdict |

The loop detector still counts held calls: an agent that retries the same command four times with nothing written in between draws `loop.repeat`, and then the call is neither held nor let through by an approval (a plain ask, or deny when unattended).

## What is guaranteed and what is not

- **Guaranteed, on a host whose hook runs before each tool call and obeys the answer** (Claude Code's `PreToolUse`, from its documentation; not run live): a held call does not run; a call runs on an approval only if it matches the approval's session, folder, tool, arguments and files, within 24 hours, once; no approval lowers a deny.
- **Not guaranteed:** anything a program the agent runs does (see above); a host with no check point; any host other than Claude Code (Codex, Gemini CLI, opencode and OpenClaw keep their 0.18.0 verdicts: an ask, or a deny when unattended); that `systemMessage` is shown to you and not to the model (from the hooks reference; not checked live); an approval by someone who has your terminal or your chat.

## Settings

| Setting | Values | Default | Where |
|---|---|---|---|
| `defer` (top level) | `true` / `false` | absent (off) | user-level or project file; a project file can switch it on, never off ([ADR 0010](adr/0010-the-user-file-is-a-floor.md)) |

Under `--unattended` deletion and document asks are held whatever `defer` says. The lifetime (24 h), the prune age (7 days) and the caps are fixed in this version.

## How it fits "the checker can only refuse, ask or report"

[ADR 0014](adr/0014-the-checker-can-only-refuse-ask-or-report.md) addendum (0.19.0): a hold is a refusal with a reason; an approval is the person answering the same ask later, on a channel the agent cannot type into; openmorals never runs the action, and the call that follows still has to pass every other check.
