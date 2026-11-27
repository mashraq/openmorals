# A promise-keeping loop on an existing product

**Status: a recipe over what is built up to 0.40.0. Not run live.** Each snippet below was checked by hand with the `openmorals` command in a temporary config folder; no loop has run with this setup for a day yet. Change the folder names to yours.

Some teams point a continuous agent loop at a product that already has users: agents pick up small changes, run unattended for hours, and ship what passes. The product already makes promises: its tests, its security rules, its public interfaces, the scenarios that judge the work. The loop must keep them. openmorals does not run the loop or choose its work. It judges each act of each agent, holds what needs you, and keeps a record you can check afterwards. This page puts the pieces together.

## 1. Write the promises down, in a list that only grows

A [work order](order.md) template is a user-level file of conditions. Every order that names it carries them, an order cannot drop one, and once an order using it is approved, a template that lost a condition fails every check.

```yaml
# order-templates/promises.yaml in your config folder
version: 1
conditions:
  - exists: { file: SECURITY.md }
  - no_placeholders: { file: src/api/routes.ts }
```

Each change the loop makes gets an order that names the template and adds its own conditions:

```yaml
# order.yaml in the project
version: 1
kind: code
title: One change from the loop
template: promises
conditions:
  - exists: { file: CHANGELOG.md }
```

You approve it (`openmorals order approve order.yaml`; an agent running that is asked first, and refused when unattended), and the loop's gate runs `openmorals order check order.yaml --run "$OPENMORALS_RUN"`. "Every test that passed before still passes" is not an order condition yet; run [`openmorals tests compare`](tests-compare.md) in the same gate for that.

## 2. Keep the judging tests and the held-out scenarios away from the agent

Put the scenarios that judge the loop, and your acceptance tests, where the agent's tools are asked about, and where a sandboxed command cannot read or write them:

```yaml
# openmorals.yaml in your config folder (the user-level file: a project file cannot loosen it)
version: 1
rules:
  - id: loop.holdout-read
    match:
      tool: "^(Read|Grep|Glob|LS|NotebookRead|read_file|read_many_files|grep_search|search_file_content|glob|list_directory|read|grep|list)$"
      path: "(^|[\\\\/])holdout([\\\\/]|$)"
    decision: ask
    reason: This reads the held-out scenarios that judge the loop's work.
  - id: loop.holdout-command
    match:
      command: "(^|[\\s/'\"=])holdout([\\\\/]|\\s|$)"
    decision: ask
    reason: This command names the held-out scenarios.
  - id: loop.judging-write
    match:
      tool: "^(Write|Edit|MultiEdit|NotebookEdit|write_file|replace|apply_patch|patch)$"
      path: "(^|[\\\\/])(holdout|tests[\\\\/]acceptance)[\\\\/]"
    decision: ask
    reason: This edits a test or scenario that judges the loop's work.
sandbox:
  read:
    deny: [holdout]
  write:
    protected_paths: [holdout, tests/acceptance]
```

The last rule is the first rule of the [test-lock pack](extras.md) with its path pointed at your folders; `openmorals packs test-lock` prints the whole pack, which also asks before snapshot updates and `--no-verify`. Run the loop's commands that should not see the scenarios under `openmorals sandbox run -- <command>` ([sandbox.md](sandbox.md)): there `holdout` cannot be read at all, by the agent or by a script it starts. The hook alone cannot see a script that opens the files itself; the sandbox, or keeping the scenarios off the machine the loop runs on, is the only real holdout.

## 3. Run unattended, and let deletions wait for you

Nobody answers a question at 3 a.m. Start the loop's agents with `OPENMORALS_UNATTENDED=1` (or `openmorals hook claude-code --unattended`):

```sh
# in the loop's launcher
export OPENMORALS_UNATTENDED=1
```

Every ask becomes a refusal the agent reads and works around. A deletion is held instead ([deferred asks](deferred-asks.md), Claude Code): it does not run, and you approve that exact action later with `openmorals pending` and `openmorals approve`. For runs that should refuse everything and hold nothing, use the `ci-unattended` pack as your user-level file (`openmorals packs ci-unattended`); it lets `dist`, `build` and `coverage` be deleted and refuses push and publish.

## 4. One budget and one stop for each loop

```sh
eval "$(openmorals budget start --tool-calls 300:1000 --tokens 2000000 --sessions 20)"
# start every agent of this pass from here: they share OPENMORALS_RUN
openmorals stop --run "$OPENMORALS_RUN"   # your kill switch, for every agent of the pass
```

A [run budget](runs.md) counts every agent of the pass across processes and restarts (Claude Code); a hard limit refuses every later call of the run.

## 5. Ship only what the diff says may ship

```sh
git diff origin/main...HEAD | openmorals diff-class - --run "$OPENMORALS_RUN"
```

Exit 0 is a change in a class you switched on as review-free; exit 1 (class B) or 2 goes back to a person. The run's record can only add review ([merge-verdict.md](merge-verdict.md)).

## 6. Your checkpoint, and the record on a timer

```sh
openmorals audit sample                         # draws a finished pass for you to read closely, 1 in N
openmorals audit --run "$OPENMORALS_RUN"        # the run card: counts, writes, commits, checks
openmorals audit touched 'holdout/**' --run "$OPENMORALS_RUN"   # exit 1 when a record names it or searched its folder
openmorals audit oversight --since 2026-11-01   # how often you were asked, and what you approved
```

The run card says what the pass used and whether anything checked it: a "no check recorded" line means the pass wrote files and its records hold no order check, test run or diff-class command. It is a line to read, never a failure. `audit sample` draws only passes that have been quiet for 30 minutes (its `settle_minutes`), so run it after the pass, not during it. `audit touched` lists the records that named a path under the glob or the folder itself, wrote a test file there, or searched a folder that holds or may hold it (a search tool, or `rg`, `grep -r`, `git grep`, `ag`, `ack` in a command), and exits 2 when it cannot tell (no log, nothing readable, a log that does not verify). It does not see a script or test runner that opens the files itself, work where no hook ran, names built at run time, or other shell searches; the full list is in [audit.md](audit.md#openmorals-audit-touched-glob-0400). Run these from cron or the loop's own scheduler after each pass, and read them; openmorals sends nothing anywhere.

## What openmorals does not do here

- **Pick the work, or run the loop.** It guards acts; the loop and its scheduler are yours.
- **Judge quality.** No score of the agents' work, and no model is called to judge it. A passing order and a class A diff say the listed conditions held, not that the change is good.
- **Roll back.** Undo for files is the [project trash](delete.md); a bad release is rolled back by git and your deploy tool.
- **Read feedback.** Tickets, usage data and chat are the loop's input. Content an agent reads from them is marked untrusted, so its later risky acts ask ([guards](architecture/guards.md)).
- **See what no hook saw**: a host without openmorals, a CI job, a script that reads a file itself.
