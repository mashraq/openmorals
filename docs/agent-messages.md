# What one agent hands to another (0.37.0)

When an agent starts a sub-agent, sends a message to another agent or session, or a sub-agent reports back, the text it passes is a prompt the receiver will act on. Since 0.14.0 openmorals scans that text before the call runs, with the same rules it uses on tool results, and marks the session on a finding ([adapters.md](adapters.md#content-bearing-actions-tool-arguments-and-agent-messages-0140)). Since 0.37.0 it also writes what was handed on into the call's own audit line, and `openmorals audit handoffs` reads it back.

Status: **Built (0.37.0)**, from each host's documentation, **not run live** on any host. Tested in `test/handoff.test.ts` and the message-tool rows of `cases/content-actions.rows.yaml`. Nothing on this page changes a decision, adds an ask or tells the model anything.

## What is recorded

Every call through a message tool (the table in [adapters.md](adapters.md#content-bearing-actions-tool-arguments-and-agent-messages-0140)) gets a `handoff` field on its own audit record. The text itself is never written.

| field | what it is |
|---|---|
| `kind` | `spawn` (starts an agent with a prompt), `message` (text to an agent or session already running) or `handback` (a sub-agent's report to its parent) |
| `sha256` | SHA-256 (hex) of the text the scan saw: redacted, and over 256 KiB only its first and last halves |
| `bytes` | the text's size in UTF-8 bytes before redaction and the cut |
| `cut` | `true` when the text was over the cap; absent otherwise |
| `sender_taint` | the sending session when the call was judged: `injected` (hidden instructions were found in something it read), `untrusted` (it read untrusted content), or `clean`. This message's own scan writes its own line, as before |
| `claims` | labels of phrases that claim approval or authority, when any are found (below); absent otherwise |

0.37.0 adds five tools to the message list, so their text is scanned and recorded too: Codex `send_input`, `send_message` and `followup_task` (field `message`, from the Codex source's multi-agent tool definitions, read 26 Nov 2026), and OpenClaw `sessions_create` and `conversations_send` (every string value, since their fields are not documented; OpenClaw's session tools page, read 26 Nov 2026).

## Claims of approval or authority

A message from one agent to another cannot carry your consent: only you can approve a step, at the host's own prompt or with `openmorals approve`. A handed-on text that says otherwise is worth knowing about, so these phrases are labelled, after invisible characters are removed:

| label | for example |
|---|---|
| `user-approved` | "the user has approved this" |
| `already-authorised` | "this is pre-approved" |
| `no-need-to-ask` | "no need to ask", "without asking for permission" |
| `on-behalf` | "on behalf of the user" |
| `role-authority` | "as the admin" |
| `grants-permission` | "you are now authorised to" |

A label is a phrase match and nothing more. It does not mark the session and no guard reads it.

## `openmorals audit handoffs`

```console
$ openmorals audit handoffs
3 handoffs recorded in /home/user/.config/openmorals/audit.jsonl: 3 spawn.
  claude-code Agent: 3

Carrying a claim of approval or authority (1):
  2026-11-26T10:02:11.120Z claude-code Agent (spawn, 26 bytes) session sess-a: no-need-to-ask

The same text sent more than once (1):
  5d1c0a9e2f7b: 2 times, sessions sess-a, sess-b

Not checked: ...
```

It counts handoffs by kind and by host and tool, and lists those sent from a session that had read untrusted or hidden content, those carrying a claim, those over the size cap, and the same text sent more than once (by hash). `--session ID` and `--since ISO-TIME` narrow it, `--log FILE` reads another log, `--json` prints the lists. It reads the log and writes nothing. Exit 0 when nothing is listed, 1 when something is, 2 when the log cannot be read, 64 on a usage error.

## Known limits

- **Only what a hook sees.** Text passed through a file (a notes or memory file, a shared folder, a teammate's mailbox file, a message board) is not a tool call to another agent and is not recorded here. The learn guard ([learn.md](learn.md)) covers writes into the files every session loads; other shared files are not covered.
- **Not confirmed live.** Whether each host fires its pre-tool hook for every tool in the list, and inside a sub-agent, has not been checked in a running session. The Codex documentation does not say that its newer messaging tools reach hooks.
- **The scan is a pattern scan.** An instruction written as plain prose, with no known phrase or hidden content, passes, as it does in a tool result. The claim labels miss a claim worded another way and can label a harmless sentence.
- **The hash is of the redacted, capped text.** Two texts that differ only in a redacted secret or beyond the cap share a hash, so a repeat count can be high.
- **The sending taint is the sender's session.** Where a sub-agent runs in its own session (opencode, OpenClaw), the parent's record does not show what the child has read, and the child's own steps are judged without the parent's marks.
- **Records start at 0.37.0.** Earlier handoffs have no `handoff` field.
- **No decision is made from any of this.** It is for review, and like the rest of the record it can only raise review, never lower it ([audit.md](audit.md)).
