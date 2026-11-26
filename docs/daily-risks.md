<!-- Generated from src/guidance/risks.ts by scripts/render-daily.mjs; a test fails when this file is stale. Edit the source, not this file. -->
# Information security risks for everyday agent work

What openmorals checks for each risk in this release, by which guard, and what it does not. "Checked" means code decides before the action runs, and only on a host that calls openmorals before each action; only some asks (destructive, secrets, taint and budget) have been seen on a live agent, in one short headless run ([live run](live-runs/2026-11-26-claude-code.md)). Everything else is advice only, not checked.

The same list, without the status column, is the reference file of the `openmorals-forms` and `openmorals-email-and-links` skills, where it tells the agent what to watch for. Its source is [`src/guidance/risks.ts`](../src/guidance/risks.ts). See [daily.md](daily.md).

29 risks: partly checked 15, checked 3, advice only 8, out of reach 1, detected after the fact 1, team package 1.

| # | Risk | Status | Checked by | What is and is not checked |
|---|---|---|---|---|
| 1 | Indirect prompt injection (OWASP LLM01, ASI01) | partly checked | `inbound`, `taint` | Tool results and fetched pages are scanned for hidden-instruction patterns; once untrusted content is in the session, network and private-data steps ask. Instructions in plain prose pass. |
| 2 | Credential theft (OWASP LLM02) | partly checked | `secrets`, `taint`, `outbound` | Sending a credential file is refused and reading one asks; a credential read followed by a network step asks; a password or token-shaped value in a URL asks. A script the agent writes and runs is not seen. |
| 3 | Personal data in forms, mail and documents (OWASP LLM02) | partly checked | `outbound` | Card numbers, IBANs, US SSNs, NHS numbers and HL7 or FHIR patient records typed into a form, put in a URL or sent in a message to a site not listed for them ask. Free-text facts (names, addresses, conditions) pass. |
| 4 | Phishing form or credential harvest (ASI09) | checked | `outbound` | A password or code typed into a look-alike of a site in your sites or protect list is refused; into any other unlisted site, or a page opened from a link in untrusted output, it asks. Judged from names and patterns, not from what the site is. |
| 5 | Risky link or download | partly checked | `outbound` | javascript: and data: links, IP-address hosts, program and macro-document downloads, link text that names another site, and private-network addresses first seen in untrusted output ask. Whether a page is malicious is not known. |
| 6 | Tool poisoning in MCP tool descriptions (OWASP LLM03, ASI04) | partly checked | - | Only at install time, by openmorals scan; a description is not checked when it is used. |
| 7 | Rug pull (a tool that changes after approval) (MCP security guidance) | advice only | - | Not checked; the scanner names it as not covered. |
| 8 | Tool shadowing and cross-server flows | partly checked | `taint` | Any MCP tool result marks the session as having read untrusted content, so later network and private-data steps ask. |
| 9 | Malicious server, skill or plugin (OWASP LLM03, ASI04) | partly checked | - | openmorals scan before install; nothing at run time. |
| 10 | Excessive agency through MCP tools (OWASP LLM06, ASI02) | partly checked | `online-delete` | An MCP tool whose name says it deletes asks (an adapter check at the online-delete decision); URLs and paths in its arguments are judged like any fetch or file step. Other MCP actions are judged only through their arguments. |
| 11 | Unexpected code execution (ASI05) | partly checked | - | Commands openmorals cannot read through (a download piped into a shell, eval) ask; a program the agent writes and then runs is not seen. The OS sandbox (openmorals sandbox) is the answer there. |
| 12 | Identity, privilege and confused deputy (ASI03, MCP specification) | advice only | - | Not checked: which identity a tool acts as is the host's and the server's job. |
| 13 | Private-network targets (MCP specification) | partly checked | `outbound` | IP-address hosts ask; the cloud metadata address, and private-network addresses first seen in untrusted output, ask. A name that resolves to a private address is not seen (no DNS lookup). |
| 14 | Memory and retrieval poisoning (ASI06, OWASP LLM04, LLM08) | partly checked | `inbound` | What a retrieval tool returns is scanned like any tool result; what was indexed beforehand is not. |
| 15 | Unsafe messages between agents (ASI07) | partly checked | `inbound` | On Claude Code the text one agent hands another is scanned for hidden instructions and a finding marks the receiver's session. Not run against a live agent; team mailboxes, files and branches are not seen. |
| 16 | Cascading failures (ASI08) | partly checked | `budget`, `loop` | Per-session tool-call and token budgets and repeat detection ask; a run across many agents has no shared budget. |
| 17 | Rogue agent (ASI10) | advice only | - | Not checked in this release: there is no quarantine. |
| 18 | An agent switching the checks off | checked | `self-protect` | Editing openmorals' settings, the hook settings or its log, and running openmorals init or purge, ask, through file tools and on the command line. A script the agent writes is not seen. |
| 19 | Unbounded consumption (OWASP LLM10) | checked | `budget`, `loop` | Tool calls and tokens per session ask at the soft limit and stop at the hard limit; the same command repeated asks. |
| 20 | Intrusion know-how passed on | advice only | - | Not checked: what the agent writes in prose is not judged. |
| 21 | System prompt leakage and misinformation (OWASP LLM07, LLM09) | out of reach | - | What the agent says never passes through openmorals. |
| 22 | Consent phishing (a sign-in that grants an app access) | advice only | - | Not recognised as such. A look-alike site, or a password typed into an unlisted site, still asks (outbound). |
| 23 | A message asking to change payment details | advice only | - | Not checked: wording is not judged. |
| 24 | Malicious attachment or QR code | partly checked | `outbound` | Downloads of programs and macro documents ask; an attachment opened through a mail tool, and QR codes, are not seen. |
| 25 | A mail forwarding rule or filter created | advice only | - | Not recognised by any guard. |
| 26 | A new outside recipient or a BCC on a reply | partly checked | `outbound` | A BCC, a reply or forward adding someone not on the messages read, or an address seen only in untrusted output, asks. A new message to an address the user typed does not. |
| 27 | The audit record rewritten by a program on the same account | detected after the fact | - | openmorals audit verify finds careless edits to the hash-chained log; a deliberate rewrite needs the chain's head kept where the agent cannot write (a separate team package). |
| 28 | A team's shared settings loosened without notice | team package | - | Checked in a separate team package, not in this one. |
| 29 | The optional checker model's key readable by the agent | advice only | - | Accepted risk: the optional checker model reads its key from the environment the agent's shell inherits. Off by default. |
