# Software factories

Status labels: **Built (version)**, **Planned**, **Rejected**. This page describes 0.35.0. Planned items may change or be dropped.

Some people now run a "software factory": a standing team of named agents, each with its own role and notes, working on one product for months, sometimes taking requests straight from the product's users. People who run them report the same problems: the agents' notes grow into an append-only pile nobody cleans; agents quietly rewrite their own rules or role in private notes after a passing remark; new sessions are handed a long trail of predecessors' notes and "doctrine" so the model trusts the setting faster; every extra agent costs tokens; and work stalls where nobody is looking. This page says what a guard should do in that setting, and what openmorals already does.

## What agents teach themselves

The [learn guard](learn.md) (0.35.0) checks what an agent writes into files later sessions load: instructions files, memory notes and skills. It already keeps clean-up cheap: a write that keeps a file the same size or shrinks it is never held to the size budget, only added text is scanned, and a plain delete of the file is refused with the [project trash](delete.md) command named, so a pruned note can be got back. In a session that has read untrusted content, any edit to these files asks, one that only removes lines included, since deleting a rule is as much a change as adding one.

**Planned:**

- **A list of what changed.** `openmorals audit learn` lists every write to these files, newest first: which agent, which run, whether the session had read untrusted content, and the lines added and removed. An agent rewriting its own working rules after a remark is not an attack and is not refused, but you should be able to see it.
- **Your own paths.** A setting to add a factory's own ledgers, wikis or journals to the guarded files. A project file can add paths, never remove the built-in ones.
- **Pinned rulings.** Files you name, such as a root `AGENTS.md` or a role file per agent, whose existing lines change only with an ask, in any session. Agents' own notes stay free to prune; your rulings stay as you wrote them.
- **Where each line came from.** `openmorals learn verify` compares each guarded file with the record of the writes openmorals saw, and lists lines no recorded write explains (they came from your editor, a `git pull`, a clone, a shared folder or a script) and lines written by a session that had read untrusted content. A trail of predecessors' notes is trusted text by design, which is what makes a forged one worth writing; this says where each line came from, not whether it is true.

openmorals itself never writes "you can trust this setting" text, never summarises or prunes memory, and an approval still counts only through the host's own prompt or your own [`approve`](deferred-asks.md) code or command, whatever a note says a predecessor decided.

## Tokens for a standing team

[Token control](cost-control.md) counts per agent, and since 0.37.0 the [run budget](runs.md) gives every worker a factory starts for one task one budget across processes and restarts, counting each restart or re-dispatch as a session, with one stop for all of them (Claude Code). A factory adds named seats that live across many sessions.

**Planned:**

- **A seat name** on every count and audit record (set by the launcher, or taken from the host's name for a named sub-agent), so you can see which seat spends what over a day or a week.
- **Park a seat.** `openmorals park <seat>`, run by you, stops that seat's next tool call in any session until you lift it.
- **The cost of always-loaded files.** The planned report on token overhead lists memory folders and your listed stores with their size, since every line in them is paid for on every request.

## Work the guard stopped

With nobody watching, every ask becomes a refusal or a [held action](deferred-asks.md), and the agent moves on. **Planned:** `openmorals audit stalled` lists held actions still waiting, refusals that never later went through, repeated loop findings, budget limits hit and parked seats, by seat and run. Plain code over the audit log; no model, no token cost.

## A factory inside a live product

For a continuous agent loop on a product that already has users, [brownfield.md](brownfield.md) sets one up with what is built: promises as a work-order template that only grows, the judging tests and held-out scenarios behind asks and the sandbox, unattended runs with deletions held for you, one budget and one stop per pass, the merge verdict as the ship gate, and the run card and `audit touched` afterwards.


When users and admins ask the factory for features over chat, their messages reach agents as untrusted content. The [taint check](architecture/guards.md) already asks before such a session sends anything out once it has also touched private data, and the [learn guard](learn.md) asks before it writes to the files later sessions load. Keeping the seats that talk to the public apart from the seats that deploy is the factory's design; **planned:** the deploy rule in [Shipping with agents](shipping-with-agents.md) can also count deploys per day and ask past a number you set, for when people ask you to slow down.

## Rebuilding

Factories report rebuilding large parts of a product as each model generation outgrows the last one's code. Treat a rebuild as a migration: take a [work order](order.md) baseline and the test floor first, rebuild beside the old code, land the new one only when it keeps every test the old one passed, and remove the old tree with `openmorals trash`, not `rm -rf`.

**Rejected:** running or orchestrating agents, writing or curating memory, scaffolding meant to make a model smarter, predicting when a codebase is too large for a model, judging content or style, and watching agents' notes for mood. openmorals guards and reports; the factory is yours.

None of the planned items is built yet. [ROADMAP.md](../ROADMAP.md) lists what is next.
