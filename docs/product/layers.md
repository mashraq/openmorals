# Learn, guard, review, score

Status labels: **Built (version)**, **Planned**, **Rejected**. Planned items may change or be dropped; [ROADMAP.md](../../ROADMAP.md) lists what is next.

A useful way to look at an agent harness is as four layers around the model loop:

- **Learn**: what the agent is told before it acts (an agents file, skills, plans on disk).
- **Guard**: deterministic checks the model cannot argue with or edit.
- **Review**: a second look, by a person or an independent checker, before work is accepted.
- **Score**: measuring the harness itself, and measuring it again whenever anything in it changes.

openmorals is a guard layer ([ADR 0001](../adr/0001-a-guard-layer-not-a-factory-platform-or-standard.md)). It reaches into the other three layers only where a check can run outside the model, and there, as everywhere, a model can only make an answer stricter ([ADR 0007](../adr/0007-reviewer-can-only-escalate.md), [ADR 0013](../adr/0013-a-merge-verdict-decided-in-ci-the-record-can-only-raise-review.md)). This page says what it does at each layer today and what is planned.

## At a glance

| Layer | The question | openmorals today | Planned |
|---|---|---|---|
| Learn | Does the agent know the rules before it acts? | `guidance` writes the rules into `AGENTS.md`, `CLAUDE.md` or `GEMINI.md`; daily guidance; `scan` before install; work orders; the `learn` guard on writes into instructions, memory and skill files, with a size budget | guard state kept through compaction |
| Guard | Is this action safe to run now? | the guards, packs, taint judge, loop detector, sandbox, self-protect, audit log; who wrote each test; installs of unlisted packages; a hook that fails closed on Claude Code; token counts, sub-agent limits and `stop` on Claude Code | hooks that fail closed on other hosts that allow it; approvals tied to the exact action; a budget across a tree of agents in separate processes |
| Review | Can this change be accepted without a person reading it? | `diff-class`, test-integrity reasons, `tests compare`, `tests fail-first`, `tests claim`, the escalate-only reviewer, `audit sample`, the review map and split suggestion, notes that can only add review | a diff reviewer that never sees the agent's own transcript |
| Score | Do the guards still do what they say, after every change? | `openmorals eval` with per-guard and per-pack scores; `order check`; session rows across steps, turns, compaction events and sub-agents; rescoring with `--save` and `--since` | repeat runs for model-backed judges; a run on each real host; an actual compaction in a session row |

## Learn

**Built.**

- `openmorals guidance` (0.2.0) writes a short block into `AGENTS.md`, `CLAUDE.md` or `GEMINI.md` that says what is blocked and what asks, taken from your bylaws, so the agent knows the rules before it meets them.
- Daily guidance (0.29.0): a short always-on block, three skills and a risk list for documents, online forms, email and links. It is advice only and says so.
- `openmorals scan` (0.2.0) reads a skill, plugin, MCP config or package before you install it and reports hidden instructions, exfiltration, download-and-execute and over-broad permissions.
- Work orders (0.27.0): you write down what "done" means before the work starts, and `openmorals order check` checks the result against it with no model call.
- The `learn` guard (0.35.0) checks what an agent writes into the files that teach later sessions: instructions files such as `CLAUDE.md` and `AGENTS.md`, memory notes and skills. It scans what is added, asks when an instructions file grows past a size budget, asks about shell writes it cannot see into, and asks about any such write in a session that has read untrusted content ([learn.md](../learn.md)).

**Planned.**

- Guard state kept through compaction: snapshot it before the host compacts the context and give it back after, so a compaction never drops a taint, a budget or a pending ask. State already lives on disk, outside the context; the plan is to prove it holds on each host.

## Guard

**Built.** The guards (destructive, online-delete, secrets, self-protect, budget, document, delete, replace, outbound), your own rules with content and detector matching, policy packs (information security, outward actions, test-lock, privacy, health data, regulated software), the taint judge, the loop detector, inbound scanning of pages and tool results, deferred asks, the OS sandbox for one command and a hash-chained audit log. The full list, with versions and known evasions, is in [features.md](features.md) and [guards.md](../architecture/guards.md).

Three questions every coding harness should be able to answer already have built answers:

- **"Did the agent change old tests to get green?"** The `test-lock` pack (0.9.0) asks before an agent edits the tests that judge it, the sandbox can make them read-only (0.17.0) and `tests compare` (0.10.0) lists tests that passed before and now fail, vanish or are skipped.
- **"Were these tests there before, and do they test anything?"** `tests fail-first` (0.17.0) runs a change's new tests against the old code and says which fail for the right reason.
- **"Can the agent switch the checks off?"** The self-protect guard (0.1.0) and the user file as a floor ([ADR 0010](../adr/0010-the-user-file-is-a-floor.md)) keep the hook, the bylaws and the host settings out of the agent's reach.

Also built at 0.32.0: which test files the agent wrote (`tests provenance`), a check of the agent's claim that tests pass against your own clean run (`tests claim`), the `packages` guard on installs the project does not list, git hook files under self-protect, and `diff-class` reasons for secrets and unlocked dependencies in a diff.

Built at 0.36.0, on Claude Code ([cost-control.md](../cost-control.md#built-in-0360-token-control-on-claude-code)):

- **The hook fails closed.** `openmorals init` sets `onFailure: "block"` on the tool and prompt hooks, so a crash or timeout of the hook stops the call instead of letting it run.
- **Real token counts.** The budget guard reads the usage numbers, never the text, from Claude Code's own session log and its sub-agents' logs ([ADR 0015](../adr/0015-claude-code-token-counts-from-its-session-log.md)).
- **Sub-agent limits.** Tool calls are counted per sub-agent, sub-agent runs are counted per session with a limit, and a batch that starts too many sub-agents at once asks.
- **Stop.** `openmorals stop <session>` (or `--all`), which only you can lift, refuses every later call of that session, in the main conversation and in every sub-agent, and keeps finished work.

None of these has been run on a live host yet.

**Planned.**

- **Hooks that fail closed on other hosts.** Built for Claude Code in 0.36.0. Where another host lets a hook say "block if I fail", `openmorals init` should set it there too.
- **A budget across a tree of agents.** One budget per task that agents in separate processes draw from, with depth limits and a stop for the whole tree ([cost-control.md](../cost-control.md#planned-controls)).
- **Approvals tied to the exact action.** An approval covers one action, once. If the action changes in any way (another file, another recipient, another order number), it needs a new approval.
- **More dependency checks:** package names that do not exist or look like a known one.

## Review

**Built.**

- `openmorals diff-class` (0.12.0) says whether a diff may merge without being read, and if not, names the facts that need a person, in one to three lines.
- Test-integrity reasons (0.13.0) point at changes that may weaken their own tests: assertions lost, skips, snapshot updates, runner config, changed expected values.
- The reviewer (0.3.0) is an optional model that looks at an ask and can only make it stricter. It can never approve.
- `openmorals audit sample` (0.11.0) draws finished runs at random for a close read and counts what slipped through.
- `diff-class --map` (0.33.0) lists the files riskiest first and suggests a split for a change too large to review well; `--note` reads a review bot's comment or an AI summary, which can only add review ([review-map.md](../review-map.md)).

**Planned.**

- **A diff reviewer in a fresh context.** It sees the diff and the work order, never the agent's own transcript, so it is not talked round by the agent's story. Like every model step here, it can add review reasons and can never make a change review-free.

**A rule for every review aid.** A review bot's approval, an AI-written summary or a walkthrough can only add review, never remove it, because a summary can leave out the one line that matters.

## Score

**Built.**

- `openmorals eval` (0.7.0) runs every case row through the same code the hook uses and reports, per guard and per pack, what was caught, what was flagged by mistake, whether the right rule decided it and how long a decision takes. It calls no model and needs no network. Rows run on a fake disk and a faked session view, so nothing real is deleted or sent. You can score your own rows with `--cases`.
- `npm test` fails when any shipped row does not match, so the shipped score says the guards still do what their tables say. ([eval.md](../eval.md) explains what that number does and does not mean.)
- Session rows (0.34.0) send several hook events in order through the Claude Code hook, so what one call leaves behind is judged at the next: steps, turns, compaction events, sub-agents and a second conversation. `eval --save` and `--since` keep a score with a fingerprint of the rows, bylaws, packs, skills and model, and fail when anything moved.

Agents are judged on more than single steps: which tool they picked, with which inputs, in which order; what they remember across turns; and what they hand to other agents. The same holds for a guard. **Planned:**

- **Rows across an actual compaction.** Session rows send the compaction events to the hook; a run on a real host would show the state survives what the host really does. An approval for one action must not carry over to a changed one, such as a corrected order number.
- **More rows across child agents:** a child's report carrying hidden instructions must mark the parent; a secret in a child's prompt must ask.
- **Repeat runs for model-backed judges.** The guards are deterministic, so one run is enough for them. The reviewer and the inbound judge are not: run each row several times and score the worst run.
- **A run on each real host.** The adapters are built from each host's documentation and recorded event shapes. A scripted run in a container, checked against the audit log, would show they work and catch a host update that changes its hook events.
- **Rescore on a host version change** too, beside the bylaws, packs, skills and model that the saved score already covers.
- **Eval rows are judging files too.** An agent must not be able to edit its way to a green score, so `test-lock` should cover eval rows and baselines.
- **Assertions over your own agent's audit log**, such as "this tool was never called" or "this check ran before that action". The audit log is already a full trace of every decision.

## Design rules this confirms

Looking at how agent tools in general handle approvals, checks and child agents confirmed a few rules openmorals keeps, and led to some of the planned items above:

- **A model never approves.** Deterministic code decides, a model can only raise, and an error asks ([ADR 0005](../adr/0005-fail-closed-ask-on-error.md), [ADR 0007](../adr/0007-reviewer-can-only-escalate.md)).
- **An approval belongs to one exact action.** An approval that is not tied to the exact call could be replayed, or carried over to a different tool that happens to share a name. Hence the planned binding above.
- **Checks must reach child agents.** A child agent should never escape the parent's checks because nobody passed them on. Hence the child-agent rows.
- **Compaction must not drop guard state.** A taint, a budget or a pending ask has to survive it. Hence the compaction item under Learn.
- **A model reports evidence, and code applies the threshold.** Typed outputs, and thresholds fitted offline on labelled rows, keep a model judge measurable. openmorals' judges already fail closed when their output cannot be read.
- **A cheap first stage should escalate, not refuse.** That is the order openmorals already uses: deterministic guards first, an optional model only on what they ask about, then the person.

## What stays out

- openmorals does not grade an agent's answers or orchestrate agents ([ADR 0001](../adr/0001-a-guard-layer-not-a-factory-platform-or-standard.md)).
- No model step lowers the level of review or approves on the person's behalf ([ADR 0007](../adr/0007-reviewer-can-only-escalate.md), [ADR 0009](../adr/0009-never-grant-permission-the-host-would-not.md), [ADR 0013](../adr/0013-a-merge-verdict-decided-in-ci-the-record-can-only-raise-review.md)).
- Walkthrough videos and audio summaries help people read code, but they guard nothing, so they are not planned here.
