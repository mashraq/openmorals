# Daily guidance: documents, forms, email and links (0.29.0)

openmorals checks actions in code, before they run, on hosts that call it. For everyday work (writing documents, filling in forms, handling email and links) it can also give the agent a few lines of guidance. That guidance is **advice only, not checked**: it is text for the agent, and openmorals does not check that the agent follows it. Where a line is also checked, a guard named in the pack checks it, and only as far as that guard reaches.

All of it is off by default. Nothing is written into an agent's instructions, and nothing is added to its context, unless you run `openmorals init --pack daily` (or `openmorals guidance --daily`), or set `guidance.first_activity: true` in your own user-level file.

Source: [`packs/daily.yaml`](../packs/daily.yaml) (every line), [`src/guidance/daily.ts`](../src/guidance/daily.ts), [`src/guidance/render.ts`](../src/guidance/render.ts) (`renderDailyGuidance`), [`src/guidance/risks.ts`](../src/guidance/risks.ts). Generated from them: [`skills/`](../skills/) and [daily-risks.md](daily-risks.md) (a test fails when either is stale; `npm run build && node scripts/render-daily.mjs` rewrites them). Tests: [`test/daily-guidance.test.ts`](../test/daily-guidance.test.ts).

## The three tiers

| Tier | What | When the agent gets it | Written or sent by |
|---|---|---|---|
| 0 | Six short lines in a marked block of `CLAUDE.md` (`AGENTS.md`, or `GEMINI.md` for Gemini CLI) | with every model call, as part of the instructions file | `openmorals init --pack daily`, or `openmorals guidance --daily` |
| 1 | Three skills: `openmorals-documents`, `openmorals-forms`, `openmorals-email-and-links` | the one-line description whenever the host lists skills; the body when the agent decides the task matches | `openmorals init --pack daily` (Claude Code: `.claude/skills/`); for another host, copy [`skills/`](../skills/) where it reads skills |
| 1b | The same body as the matching skill, added to the agent's context by the hook | once per activity per session, on the first call of that activity the hook allows | the Claude Code hook, only with `guidance: { first_activity: true }` in your user-level file |
| 2 | The risk list, `references/risks.md` in the forms and email skills | only when the skill tells the agent to open it ("if something looks wrong") | with the skills |

The hook's own reason line when it stops something stays as it was: it costs nothing unless something is stopped.

## What is checked and what is advice only

The pack has 25 principles, each with one guidance line. 13 are also checked by an existing guard: `delete` and `document` (deleting a file, large removals, removed headings, emptied files), `outbound` (look-alike sites, passwords and codes typed into unlisted sites or pages opened from a link in untrusted output, card, IBAN, ID and health-record shapes going to unlisted sites, link text that names another site, new recipients and BCC on replies), `inbound` (hidden-instruction patterns in what the agent reads) and `secrets` (credential files). 12 are advice only: nothing checks them. This unit adds no check: a line that would need one that does not exist is marked advice only and says so.

`openmorals packs show daily` lists every principle, what checks it, or that it is advice only. Each skill's `README.md` (for people; the agent reads `SKILL.md`) shows the same per line. The lines the agent reads neither claim nor deny that anything is checked, and give no medical, legal or financial advice.

The pack itself lists its guards at the built-in defaults and has no rules of its own, so on the defaults it decides exactly as the defaults do. Laid over a looser user-level file as a project file, it raises those settings back to the defaults, as every pack that lists guards does.

[daily-risks.md](daily-risks.md) is the catalogue of 29 information security risks for everyday agent work, with what openmorals checks for each in this release. The same list, without the status column, is the forms and email skills' reference file.

## What it costs

Measured on the shipped text. Tokens are estimated as characters / 4 (no tokenizer is run and no model is called; real counts differ by model). The bounds are in the tests.

| Text | Characters | About tokens | Bound (characters) | When it is paid |
|---|---|---|---|---|
| tier 0 block, markers included | 779 | 195 | 900 | every model call |
| `openmorals-documents` description | 150 | 38 | 160 | whenever skills are listed |
| `openmorals-forms` description | 139 | 35 | 160 | whenever skills are listed |
| `openmorals-email-and-links` description | 140 | 35 | 160 | whenever skills are listed |
| `openmorals-documents` body | 920 | 230 | 1,100 | when the skill is used |
| `openmorals-forms` body | 898 | 225 | 1,100 | when the skill is used |
| `openmorals-email-and-links` body | 1,093 | 274 | 1,100 | when the skill is used |
| first-activity message, documents | 920 | 230 | 1,100 | once per session, with `first_activity` on |
| first-activity message, forms | 814 | 204 | 1,100 | once per session, with `first_activity` on |
| first-activity message, email and links | 1,009 | 253 | 1,100 | once per session, with `first_activity` on |
| `references/risks.md` | 4,114 | 1,029 | 8,000 | only when the agent opens it |

The design estimate before building was about 210 tokens per call for tier 0 and about 40 per skill description; the measured figures are below both.

## Turning it on and off

- **On, for a project:** `openmorals init --pack daily` writes the pack as `openmorals.yaml`, the tier 0 block into `CLAUDE.md` (merged into a marked block; your own text is never touched), and the three skills into `.claude/skills/`. With `--agent codex`, `opencode` or `openclaw` the block goes into `AGENTS.md`, with `--agent gemini-cli` into `GEMINI.md`, and no skills are written. A skill folder of the same name that openmorals did not write is left alone and `init` says so. No other `init` writes any of this.
- **Tier 0 only:** `openmorals guidance --daily --file CLAUDE.md` writes or refreshes the block.
- **Off:** `openmorals guidance --file CLAUDE.md --remove` takes the block out; delete the `.claude/skills/openmorals-*` folders to remove the skills.
- **First-activity guidance:** in your user-level file (`$OPENMORALS_HOME/openmorals.yaml`, else your config folder):

  ```yaml
  guidance:
    first_activity: true   # off by default; false or absent sends nothing
  ```

  Only your own file can switch it on: it spends your tokens, so a project's `openmorals.yaml` that sets it is ignored and reported, as for `guards.inbound.notify`.

## How the hook tells which activity a call is

Only from what the PreToolUse hook already sees, and it decides nothing:

- **documents:** a write (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`, or a tool whose arguments name a path to write) to a file the document guard counts as a document: an extension in `guards.document.extensions`, not in an excluded folder such as `node_modules`.
- **forms:** a tool call the outbound guard reads as typing into or submitting a form (its name says type, fill, input, enter, submit, form or autofill, or its `action` is `type`).
- **email and links:** a tool call whose name says it sends, replies, forwards, shares or invites, opens a page in a browser, or works on mail or messages (mail, email, inbox, message...). Agent-to-agent message tools (`Agent`, `Task`, `SendMessage`) are none of these.

The session file remembers which activities were guided (`guided`). The guidance is added only to a call the hook allows, as `hookSpecificOutput.additionalContext` with no permission decision, so the host's own permission flow is unchanged; an asked or refused call carries only its reason, and the activity stays unguided until a later allowed call. A failure to read the pack sends nothing and changes no decision.

## What it does not do

- It does not make the agent follow the guidance. A capable model may ignore it, and text in a page or an email may argue against it.
- Skills are written for Claude Code only; the first-activity guidance is sent by the Claude Code hook only. Other hosts get the tier 0 block.
- Nothing here has been run against a live agent: that the host loads the skills, that `additionalContext` on an allowed PreToolUse call reaches the model, and how often an agent then acts on the guidance are taken from the hosts' documentation or not known.
- Consumer browser and office assistants that give outside code no point to check an action get none of the checks; the skills can be copied there as advice.
