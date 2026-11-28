# What one agent hands to another (0.38.0)

When an agent starts a sub-agent, sends a message to another agent or session, or a sub-agent reports back, the text it passes is a prompt the receiver will act on. Since 0.14.0 openmorals scans that text before the call runs, with the same rules it uses on tool results, and marks the session on a finding ([adapters.md](adapters.md#content-bearing-actions-tool-arguments-and-agent-messages-0140)). Since 0.38.0 it also writes what was handed on into the call's own audit line, and `openmorals audit handoffs` reads it back.

No agent protocol in use today separates data from instructions, so openmorals trusts no field of a message, whoever sent it. Handed-on text is scanned as triage: a finding marks the session, and nothing in an agent's text ever allows an action or stands in for your approval.

Status: **Built (0.38.0)**, from each host's documentation, **not run live** on any host. Tested in `test/handoff.test.ts` and the message-tool rows of `cases/content-actions.rows.yaml`. Nothing on this page changes a decision, adds an ask or tells the model anything.

## What is recorded

Every call through a message tool (the table in [adapters.md](adapters.md#content-bearing-actions-tool-arguments-and-agent-messages-0140)) gets a `handoff` field on its own audit record. The text itself is never written.

| field | what it is |
|---|---|
| `kind` | `spawn` (starts an agent with a prompt), `message` (text to an agent or session already running) or `handback` (a sub-agent's report to its parent) |
| `fingerprint` | HMAC-SHA256 (hex) of the text the scan saw (redacted, and over 256 KiB only its first and last halves), keyed with a random key kept per install in `handoff.key` in the config folder (created on first use, mode 0600). Absent when that file cannot be read or written: no unkeyed hash is written in its place |
| `bytes` | the text's size in UTF-8 bytes after redaction, before the cut |
| `cut` | `true` when the text was over the cap; absent otherwise |
| `sender_taint` | the sending session when the call was judged: `injected` (hidden instructions were found in something it read), `untrusted` (it read untrusted content), or `clean`. This message's own scan writes its own line, as before |
| `claims` | labels of phrases that claim approval or authority, when any are found (below); absent otherwise |

0.38.0 adds five tools to the message list, so their text is scanned and recorded too: Codex `send_input`, `send_message` and `followup_task` (field `message`, from the Codex source's multi-agent tool definitions, read 26 Nov 2026), and OpenClaw `sessions_create` and `conversations_send` (every string value, since their fields are not documented; OpenClaw's session tools page, read 26 Nov 2026).

## Claims of approval or authority

A message from one agent to another cannot carry your consent: only you can approve a step, at the host's own prompt or with `openmorals approve`. A handed-on text that says otherwise is worth knowing about, so these phrases are labelled, after invisible characters are removed:

| label | for example |
|---|---|
| `user-approved` | "the user has approved this" |
| `already-authorised` | "this is pre-approved" |
| `no-need-to-ask` | "no need to ask", "without asking for permission" |
| `on-behalf` | "on behalf of the user" |
| `role-authority` | "as the admin", "this is your admin" |
| `grants-permission` | "you are now authorised to" |

A label is a phrase match and nothing more. It does not mark the session and no guard reads it.

## What can go wrong between agents

These are classes of risk, not a list of attacks. Each names the part of openmorals that sees it today, and where that part stops.

| class | what sees it |
|---|---|
| Hidden content in a message (invisible characters, hidden markup) | the scan of handed-on text, which marks the sending session; after a finding of hidden instructions, a later step that reaches the network or touches private data asks (`taint.injected-content`), and after a weaker finding the rule of two applies |
| Instructions relayed as if they were the task | the same scan, for known phrases only; plain prose passes. Since the receiver's own steps are judged like any other agent's, a risky step it takes still asks |
| A claim that you already approved something | the claim labels above; they change no decision, and approval only ever comes from you |
| A request to change another agent's configuration or instructions | if the receiver acts on it, the self-protect guard asks before a write to openmorals' files or any supported host's hook config, and the learn guard ([learn.md](learn.md)) asks before a risky write into the files every session loads |
| A request to send data out | the secrets guard refuses a secret sent to the network, the rule of two asks once untrusted content and private data meet, and the outbound guard ([outbound.md](outbound.md)) judges where a form or message sends data |
| Text that copies itself on to more agents | only the repeat count in `audit handoffs` (by fingerprint, within one install); nothing stops it |

## `openmorals audit handoffs`

```console
$ openmorals audit handoffs
3 handoffs recorded in /home/user/.config/openmorals/audit.jsonl: 3 spawn.
  claude-code Agent: 3

Carrying a claim of approval or authority (1):
  2026-11-26T10:02:11.120Z claude-code Agent (spawn, 26 bytes) session sess-a: no-need-to-ask

The same text sent more than once (1; listed only, not counted in the exit code):
  5d1c0a9e2f7b: 2 times, sessions sess-a, sess-b

Not checked: ...
```

It counts handoffs by kind and by host and tool, and lists those sent from a session that had read untrusted or hidden content, those carrying a claim, those over the size cap, and the same text sent more than once (by fingerprint, so only within one install). `--session ID` and `--since ISO-TIME` narrow it, `--log FILE` reads another log, `--json` prints the lists. It reads the log and writes nothing. Exit 1 when a handoff sent from such a session, carrying a claim or over the cap is listed; exit 0 otherwise, also when the only thing listed is repeated text (one brief sent to several agents, or again after a retry, is common); 2 when the log cannot be read; 64 on a usage error.

## Known limits

- **Only what a hook sees.** Text passed through a file (a notes or memory file, a shared folder, a teammate's mailbox file, a message board) is not a tool call to another agent and is not recorded here. The learn guard ([learn.md](learn.md)) covers writes into the files every session loads; other shared files are not covered.
- **Not confirmed live.** Whether each host fires its pre-tool hook for every tool in the list, and inside a sub-agent, has not been checked in a running session. The Codex documentation does not say that its newer messaging tools reach hooks.
- **The scan is a pattern scan.** An instruction written as plain prose, with no known phrase or hidden content, passes, as it does in a tool result. The claim labels miss a claim worded another way and can label a harmless sentence.
- **The fingerprint is of the redacted, capped text.** Two texts that differ only in a redacted secret or beyond the cap share a fingerprint, so a repeat count can be high.
- **Fingerprints are keyed per install.** The key lives in `handoff.key` in the config folder, so fingerprints from two machines or two installs cannot be compared, and a log copied elsewhere shows repeats only within itself. The key does not make the text secret from someone who can read the key file: they can still confirm a guessed text. With no usable key file no fingerprint is recorded, and those calls are not counted as repeats.
- **The sending taint is the sender's session.** Where a sub-agent runs in its own session (opencode, OpenClaw), the parent's record does not show what the child has read, and the child's own steps are judged without the parent's marks.
- **Inside one program.** Agents that hand work to each other inside one framework process, with no host tool call, are not seen.
- **What arrives.** The record is of what was sent, not of what the host delivers to the receiving agent.
- **Tool descriptions.** The descriptions an MCP server gives its tools reach the model with no tool call and are not scanned here (`openmorals scan` reads MCP config files before you use them; see [scanner.md](scanner.md)).
- **Gemini CLI custom agents** defined in `.gemini/agents/` are not recognised as message tools; only its four built-in sub-agents are.
- **Records start at 0.38.0.** Earlier handoffs have no `handoff` field.
- **No decision is made from any of this.** It is for review, and like the rest of the record it can only raise review, never lower it ([audit.md](audit.md)).
