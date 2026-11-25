# Requirements for the next pieces of work

25 Nov 2026. Three pieces of work come next. Each has requirements and the condition that makes each one met. Like everything Planned, these may change. [ROADMAP.md](../../ROADMAP.md) has the wider list.

## 1. The memory-file guard

**Built (0.35.0); not run live.** The table shows which requirements 0.35.0 meets and which remain. Some files are loaded into every later session: agent instructions such as `AGENTS.md` and `CLAUDE.md`, memory notes such as `MEMORY.md`, rules folders and skills. A line written into one of them keeps working after the session that wrote it ends. This guard stops a planted instruction, or a note written from untrusted content, from getting in. It does not manage memory. Background: [swarms-and-memory.md](../swarms-and-memory.md#memory-guard-what-gets-promoted).

| Requirement | Met when | In 0.35.0 |
|---|---|---|
| One list of always-loaded files for every host | The list in the guard's page covers the main hosts' instruction, memory, rules and skill files | Met. Where Claude Code writes its own memory is to be confirmed on a live run |
| A write from a session holding untrusted content asks and names the source; an unattended run denies | Case rows; holds across compaction and sub-agents | Met |
| Added text is scanned for hidden instructions, and for lines that send secrets out or download and run code, whether or not the session is tainted | A finding asks; a critical finding in a skill is refused | Met |
| A shell command that writes one of these files asks | Case rows | Met |
| A size limit for instruction files; a write that shrinks a file never asks | Case rows | Partly: one limit of 10,000 tokens. A memory-file limit matching the host's own is Planned |
| The audit records where each guarded line came from | `audit` lists each guarded write with its source | Planned |
| A clean note from a clean session is allowed | No false alarm on clean rows | Met: 0 of 17 on its own rows |
| A project file can only tighten it | It cannot be switched off or loosened from a project | Met |
| Its ask rate on real sessions is measured before it is called finished | Asks per active hour from a live run | Planned |

## 2. A first run on a live agent

**Planned.** No host has been run live yet, so every adapter is "built from documentation". The first run is on Claude Code. Its purpose is to turn that into "works on a real host" and to settle facts other requirements depend on.

| Requirement | Met when |
|---|---|
| Install on a clean machine the way a user would | Time from install to the first judged call is recorded |
| A scripted session tries each irreversible act the core guards cover, starts a sub-agent, reads an untrusted page, writes memory and instruction files, and goes through a compaction | For each step the audit shows the expected decision and rule, and the risky step never ran |
| Confirm on the real host: the hook fires for MCP tools and for messages between agents, deny and ask are honoured, and what a failed hook does | Each answer written down with the host version |
| Break the hook on purpose: remove the binary, crash it, time it out, make it print bad output | Each blocks or warns loudly; none lets the call run silently |
| Guard state across a real compaction and a sub-agent | A taint set before compaction still asks after; a sub-agent's fetch reaches the parent |
| Friction and speed | Asks per active hour, and hook time at p50 and p95 |
| Publish what was run | A run log with versions and the captured event payloads, with no personal data, kept as test fixtures. Claude Code's "not run live" note is removed only for what the log shows |

A fail-closed install (requirement 1.3 in [requirements.md](requirements.md)) should come first, so the run checks what users would actually install.

## 3. Token control

**Planned.** The aim is to make a budget real on the main host and to stop a runaway tree of agents. It uses the host's own settings first, with no gateway, no model call and no rewriting of the context. Background: [cost-control.md](../cost-control.md).

| Requirement | Met when |
|---|---|
| `init` writes the host's own limits from the bylaws: how deep and how many sub-agents, a cheaper sub-agent model where you name one, a spending cap for headless runs | The written settings match the bylaws; a rerun changes nothing; an agent's edit to them asks |
| A lean-setup report: loaded MCP servers and their token cost, oversized agent files, settings that waste tokens. It changes nothing unless you ask | The report names each item; no file changes without a flag |
| Cached and uncached input, output and reasoning counted apart | Recorded usage totals match the host's own figure |
| Counters per agent, with no lock slowing every call | Parallel sub-agents' counts add up exactly |
| A spawn limit per run. A refused spawn says not to retry, and a third repeat is denied outright. The host's own limits are never loosened | A replayed spawn storm stops at the limit |
| `openmorals stop <run>`, which only you can run, stops every agent of the run from its next tool call and keeps finished work | After `stop`, the next call in the main agent and in a sub-agent is denied |
| Real token counts on Claude Code, read from the session's own usage records. This needs a design decision first, since openmorals does not read transcripts today | Counts match the host's own figure on a recorded session; if the records cannot be read, the budget falls back to counting tool calls and says so |
| No saving is claimed until measured | The same tasks are run with openmorals off, partly on and fully on, three times each, and solve rate, cost and tokens per finished task are reported |

With hooks alone a budget can be overshot by a turn or two of each live agent. It is never exact, and these pages will not say it is.
