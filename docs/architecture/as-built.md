# Architecture as built

This page describes the code at **0.35.0**, read from the source on 25 Nov 2026. It replaces [overview.md](overview.md), which describes 0.5.0. Status words: **Built (version)**, **Planned**, **Not built**.

## In one sentence

openmorals is a local program that a coding agent's host starts once per hook event. It reads the event as JSON, judges it with deterministic code against your bylaws and the session's state on disk, prints the answer in that host's format and exits. There is no daemon, server, proxy or MCP server. The only network call it can make is to a model API, and only if you turn on the reviewer or the inbound judge.

## What runs where

```
 your machine (or a CI runner)
 ┌──────────────────────────────────────────────────────────────────────────────────┐
 │ host: Claude Code │ Codex │ Gemini CLI │ opencode (plugin) │ OpenClaw (plugin)   │
 │   │  hook config written by `openmorals init --agent <host>`                      │
 │   ▼  one process per event: stdin JSON -> stdout answer, exit 0                   │
 │ openmorals hook <host>                                                            │
 │   ├─ adapter: host event -> actions {exec | read | write | fetch | other}         │
 │   ├─ bylaws: your user file (the floor) + nearest project file (tighten only)     │
 │   ├─ session state         <config>/sessions/<id>.json (locked, merged)           │
 │   ├─ engine: command parser -> built-in guards -> your rules, strictest wins      │
 │   ├─ session checks: loop detector, taint judge                                   │
 │   ├─ deferred ask (Claude Code)                                                   │
 │   ├─ reviewer (Claude Code, opt-in, can only escalate) ─────────► model API       │
 │   ├─ outbound scan of text handed to other agents                                 │
 │   └─ audit line, hash-chained per session        <config>/audit.jsonl             │
 │                                                                                   │
 │ commands you or CI run: check, scan, init, validate, guidance, packs,             │
 │ trash/restore/purge, sandbox, audit, pending/approve/refuse, eval, tests,          │
 │ diff-class, order                                                                 │
 └──────────────────────────────────────────────────────────────────────────────────┘
```

## Host adapters

| Host | Judged before the call | Also read | How an ask comes back | Source |
|---|---|---|---|---|
| Claude Code | PreToolUse | PostToolUse, PostToolUseFailure (outcome, result scan); UserPromptSubmit (prompt scan, deferred-ask approvals) | a real ask | [`claude-code.ts`](../../src/adapters/claude-code.ts) |
| Codex | PreToolUse | PostToolUse, UserPromptSubmit (scan); PostModelRequest (token counts) | Codex cannot ask, so an ask is a deny that tells the user why | [`codex/`](../../src/adapters/codex/) |
| Gemini CLI | BeforeTool | AfterTool, BeforeAgent (scan) | a real ask, or deny if `OPENMORALS_GEMINI_ASK=deny` | [`gemini-cli/`](../../src/adapters/gemini-cli/) |
| opencode | `tool.execute.before`, `permission.evaluate` (2.x) | `tool.execute.after`, prompt | 1.x blocks; 2.x asks through its permission hook | [`opencode/`](../../src/adapters/opencode/) |
| OpenClaw | `before_tool_call` | `after_tool_call` (scan), `llm_output` (token counts) | approval request; an unknown event fails closed | [`openclaw/`](../../src/adapters/openclaw/) |

Other events (SessionStart, PreCompact, SubagentStart and SubagentStop, Stop) are answered with allow and change nothing.

Built-in tools map to actions (shell → exec, read and search tools → read, edit tools → write with the new content, web fetch → fetch). Any other tool, MCP tools and sub-agent tools included, is judged on its argument text, and path- or URL-shaped arguments are judged as reads, writes or fetches. On Windows a command is read as PowerShell, POSIX and cmd and the strictest answer is kept (ADR 0008).

Only the Claude Code adapter has deferred asks, the reviewer, the inbound model judge and first-activity guidance.

## Order of judgement for one call

1. Resolve the bylaws: your user file, or the defaults, is the floor; the nearest project file can only tighten it.
2. Load the session and count the call.
3. The engine ([`engine.ts`](../../src/engine.ts)) parses the command (an unreadable command asks), then runs the built-in guards in order: **destructive, online-delete, secrets, self-protect, budget, document, outbound, delete, replace, packages, learn, hold**. Then your rules, content patterns and detectors. Deny beats ask beats allow, so an allow rule of yours cannot undo a guard's ask. A guard error asks; invalid bylaws ask; any exception asks.
4. Session checks ([`session.ts`](../../src/session.ts)): the loop detector, and the taint judge (Rule of Two, and an ask before network or private-data steps once hidden instructions were seen).
5. Claude Code: a deferrable ask becomes a held step when unattended or when `defer: true` ([deferred-asks.md](../deferred-asks.md)).
6. Unattended (`--unattended` or `OPENMORALS_UNATTENDED`): ask becomes deny.
7. Claude Code, if turned on: the reviewer may keep or tighten an ask, never loosen it (ADR 0007).
8. Text handed to another agent is scanned; a finding taints the session but does not change this decision.
9. Save the session, then append the audit line. If either fails, the call asks.

## State

| What | Where |
|---|---|
| Config directory | `$OPENMORALS_HOME`, else `%APPDATA%\openmorals`, else `$XDG_CONFIG_HOME/openmorals` or `~/.config/openmorals` |
| Bylaws | `<config>/openmorals.yaml` (floor), nearest project `openmorals.yaml` (tighten only) |
| Session files | `<config>/sessions/<id>.json`, mode 0600 |
| Audit log | `<config>/audit.jsonl`, append-only, mode 0600 |
| Trash and undo | `<project>/.openmorals/` |

A session file holds a revision number, the call, token and cost counters, the last 20 actions (redacted), the taint marks, the audit chain head, and small sets of written-file hashes and guidance already given. A session file that cannot be read makes the next call ask.

**Parallel calls (Built 0.32.1).** Saving takes a short exclusive lock on the session file. If another call saved in between, the two are merged, and the merge only adds: counters add, history keeps both, taint marks are the union. A call that cannot get the lock in time asks. Before 0.32.1, parallel sub-agents could overwrite each other's taint marks.

**Audit log** ([audit.md](../audit.md)). One redacted line per decision, chained per session by hash. `audit verify` reports edits, gaps, truncation and missing records. Two calls of one session judged at the same moment can share a sequence number; verify shows this as a note, not a failure. A log rewritten with every hash recomputed is not detected.

## Sub-agents and compaction

- State is keyed by the host's session id. On Claude Code a sub-agent sends its parent's session id, so it shares the parent's taint, budget and history. The agent id is recorded in the audit log but is not a key.
- On hosts that give child agents their own session id, a parent's taint does not reach the child.
- Text handed to another agent (sub-agent prompts, messages between agents) is scanned like any content.
- State lives on disk, so it survives compaction. Nothing is added back into the context after compaction or when a sub-agent starts.
- Not built: limits on spawn depth or count, narrowing a child's tools to its parent's, per-agent counters, one record for a whole tree of agents. See [multi-agent-guards.md](multi-agent-guards.md).

## MCP, proxies and SDKs

MCP tool calls go through every guard and your rules by their arguments; a delete word in an MCP tool's name asks; MCP results count as untrusted input for the taint judge. `openmorals scan` checks MCP config files before you use them.

There is no MCP gateway, model API proxy or SDK adapter in the code today. See [integrations.md](../integrations.md) for the direction.

## Tokens and budget

The budget guard counts tool calls on every host, and tokens and cost where the host reports them: today **Codex** and **OpenClaw**. On Claude Code, Gemini CLI and opencode only tool calls are counted, because those hosts do not pass token counts to hooks and openmorals does not read transcript files. See [cost-control.md](../cost-control.md).

## The four layers

| Layer | Built |
|---|---|
| Guard | the guards, rules, session checks, inbound and outbound scans, deferred asks, release hold, parallel-call fix (0.32.1) |
| Review | merge verdict `diff-class` (0.12.0); riskiest-first review map, split suggestion, review notes that can only add review (0.33.0) |
| Score | `eval` over case rows and whole sessions sent through the real hook, compaction and sub-agent steps included; `eval --save` and `--since` flag any change when rules, packs, skills or the model change (0.34.0) |
| Learn | 0.35.0: a guard on writes into instructions files (AGENTS.md, CLAUDE.md, GEMINI.md, MEMORY.md), memory notes, skills, agents and commands: the added text is scanned, growth past a token budget asks, a shell write asks, and a write from a session that read untrusted content asks |

A separate team package (ADR 0003) adds shared bylaws that members cannot loosen and CI checks; it uses only this package's public API.

## Integration status

| Surface | Status |
|---|---|
| Claude Code hook | Built; tested with the documented event shape and by hand; a live session run is not recorded |
| Codex, Gemini CLI, opencode, OpenClaw | Built; not run against the live tools |
| Other hosts that use the Claude Code hook format | Not built as a supported adapter |
| MCP gateway, model API guard, SDK adapters | Not built |
| CI | Built: `diff-class`, `tests`, `eval`, `audit sample` |
| OS sandbox | Built on macOS and Linux; Windows plan only |

## Known limits

- On Claude Code a hook that crashes or times out does not block the call unless the hook entry has `"onFailure": "block"`; `init` does not write it yet. See [deployment.md](deployment.md#claude-code).
- Steps that do not pass through a host's hooks (for example an agent program started outside the host) are not seen; the OS sandbox and CI are the backstop.
- Sub-agent and compaction behaviour is checked with simulated sessions, not live runs.
- Token budgets do nothing on hosts that do not report tokens.

## Pages that are behind the code

[overview.md](overview.md) (0.5.0), [enforcement-model.md](enforcement-model.md) (nine guards; the inbound judge shown as planned), [multi-agent-guards.md](multi-agent-guards.md) (0.31.0 header), and the product pages that still list 0.32.0 to 0.34.0 work as planned. The Python wrapper's version is behind the package version.
