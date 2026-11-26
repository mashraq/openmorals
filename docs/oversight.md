# Oversight: what your audit log can show (0.38.0)

OpenMorals asks you before some steps, refuses others, and lets you stop a session. Everything it decides goes into the chained audit log ([audit.md](audit.md)). This page says what that log can be evidence for, what it cannot show, and how to read it with `openmorals audit oversight`.

**Evidence, not compliance.** No tool makes a deployment compliant with a law or a standard, and OpenMorals does not claim to. The log is a tamper-evident record of what the hook saw; whether that is enough is for you, and anyone you answer to, to judge. Nothing here is legal advice.

## What is recorded

- **Every call the hook judges:** its tool, action, decision (allow, ask or deny), rule and reason.
- **The outcome of an ask:** when the host sends a post-tool event, an `ask.approved` line says the asked call then ran ([audit.md](audit.md#the-outcome-of-an-ask)). An ask with no outcome line was refused, is still waiting, or ran on a host or install without post-tool hooks; the log cannot tell which.
- **Your stops and clears (from 0.38.0):** `openmorals stop <session>`, `stop --all`, `stop --run <id>`, `stop --clear [<session>]` and `stop --clear --run <id>` each write one record under the session `stop`, with the rule `stop.set` or `stop.clear`, and say whether the command ran from a terminal. They are your acts, not an agent's calls, so they are recorded as `allow` and left out of the agent counts in `audit --run`, `audit sample` and `audit oversight`. If the record cannot be written, the stop still takes effect and the command says so on stderr.
- **Calls refused because the session was stopped**, under the rule `budget.stopped`.
- **The chain:** each line carries the hash of the one before it in its session, so `openmorals audit verify` finds an edited, deleted or cut-off line.

## `openmorals audit oversight`

```
openmorals audit oversight [--since TIME] [--until TIME] [--json] [--file FILE]
```

It reads the log and changes nothing. For the period (all of the log by default; `TIME` is a date such as `2026-11-01`, read as midnight UTC, or an ISO time; `--since` is inclusive, `--until` is not) it prints:

- agent calls, and how many were allowed, asked and denied, and how many were refused as stopped;
- asks whose call then ran, asks with no outcome line, the approval rate, and asks per 100 calls;
- the rules asked most, with how often each was approved;
- stops set and cleared, and whether a session was still stopped at the end;
- whether the record verifies.

It exits 0 when the record verifies, and 1 otherwise.

It never prints a pass. It prints **reasons to look**:

| Reason | What it means |
|---|---|
| `record-not-verified` | `audit verify` finds a problem in the chain |
| `unchained-records` | records from before 0.8.0, which cannot be checked |
| `asks-without-outcome` | asks with no outcome line (see above); it also counts sessions that recorded no post-tool event at all |
| `mostly-approved-rule` | a rule asked at least 20 times and approved 95% of the time or more: a candidate for an allow, only if you choose |
| `over-friction-mark` | more than 1 ask per 100 calls, over at least 100 calls |
| `still-stopped` | a stop that was not cleared by the end of the period |
| `stops-not-recorded` | calls refused as stopped with no stop in the period: set earlier, or by a version before 0.38.0 |
| `no-records` | nothing in the period |

### Why a rule that is almost always approved is a reason to look

Published studies of coding agents find that people approve the great majority of the prompts they are shown. An ask that is approved nearly every time is not giving you a decision; it is teaching you to click yes. So `audit oversight` shows such a rule as a candidate for an allow. What happens next is your choice ([ADR 0019](adr/0019-approval-rates-suggest-never-change-a-rule.md)):

- **Nothing changes on its own.** A rule becomes an allow only when you set it so in your own bylaws file.
- **A high approval rate never turns a rule into a refusal.** Being approved almost every time is evidence that the step is usually fine, which argues for allowing it, not for blocking it. Refusals stay where you set them, and where an ask would only be retried in a loop ([ADR 0017](adr/0017-refuse-only-where-an-ask-would-loop.md)).
- If an ask you keep approving is one you think should not be approved, the fix is yours to make: set the rule to deny in your own file.

The 95% mark and the 1-in-100 mark are starting points, not standards.

## Frameworks people ask about

The log is the kind of record these frameworks ask for. None of them certifies a tool, and each needs things the log cannot show.

| Framework | What the log can be evidence for | What it cannot show |
|---|---|---|
| EU AI Act, Art. 12 (record-keeping) and Art. 26 (deployers keep logs) | automatic, tamper-evident records of each judged call, kept as long as you keep the file | whether your use is high-risk; how long you keep the logs; anything the host did not route through the hook |
| EU AI Act, Art. 14 (human oversight) | that you were asked before a step, what ran after, that a session was stopped and when it was cleared | that the person asked understood the step, was competent to judge it, or was free to say no |
| NIST AI RMF, MANAGE 2.4 (mechanisms to supersede, disengage or deactivate) | per-session stops and their clears, and the calls refused while stopped | an organisation-wide procedure, or that anyone has practised it |
| ISO/IEC 42001, Annex A (event logging and recording) | the event log and its chain | your management system, roles, risk assessment and review |
| OWASP Top 10 for Agentic Applications | that tool misuse, privilege steps and runaway sessions were asked about, refused or stopped | threats outside the tool calls the hook sees |

Most uses of coding and personal agents are not high-risk under the AI Act. Where a system is, the high-risk duties apply from 2 December 2027 (Annex III) or 2 August 2028 (Annex I), as amended in 2026.

## Known limits

- It covers only the calls the host sends through the hook. A tool the host runs without calling the hook is not seen.
- A stop refuses the session's next calls. It does not interrupt a command already running, and it undoes nothing that ran.
- A stop is per session, per run ([runs.md](runs.md)) or every session under this configuration. It is not an organisation-wide stop.
- A program running as you can rewrite the whole log and recompute every hash, and `audit verify` cannot see that. If it matters, keep a copy of a session's last hash somewhere the agent cannot write.
- Who answered an ask is not recorded; the log shows that the call ran, not who allowed it.
- An ask with no outcome line could be a refusal or a host without post-tool hooks.
- Counts depend on what was logged: records from before 0.38.0 hold no stops.

## Wording

When you describe what OpenMorals gives you, say **evidence for**, **tamper-evident** and **per-session stop**. Do not say compliant, certified, tamper-proof or kill switch: it is none of those.
