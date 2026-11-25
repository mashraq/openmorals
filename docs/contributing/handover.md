# Contributor handover

Everything a new contributor, human or agent, needs to pick up any part of openmorals: where things live, how to build and test, the conventions, and the known limits of each area. What to work on next, in order, is in [roadmap.md](roadmap.md). The short version of the rules is in [CONTRIBUTING.md](../../CONTRIBUTING.md).

## First hour

1. Read the [README](../../README.md) (what openmorals does and the 60-second demo) and the newest [CHANGELOG](../../CHANGELOG.md) entries.
2. Build and run the tests (below). Expect only the machine-dependent tests listed below to fail, if any.
3. Run `openmorals eval` once and read its output: it is the scoreboard every change is measured against.
4. Find your area under [Areas](#areas). Each lists the next planned work for it.
5. Before writing code, write the failing rows.

## Build and test

TypeScript on Node, ES modules, strict (no `any`, `noUncheckedIndexedAccess`). One runtime dependency: `yaml`.

```sh
npm install
npm run build            # compiles src/ and test/ into dist/
npm test                 # node --test "dist/test/**/*.test.js"; runs every case row too
node dist/src/cli.js eval                    # catch rate, false alarms, time per decision
node dist/src/cli.js eval --guard sessions   # the multi-step session rows only
```

- **Node:** 20 or later; CI is written for Node 22 and 24 on Linux, macOS and Windows.
- **Your own config stays safe:** set `OPENMORALS_HOME` to a temporary folder whenever you run the CLI by hand. `OPENMORALS_UNATTENDED=1` turns every ask into a refusal, as an unattended run would.
- **Python wrapper:** `OPENMORALS_TEST_BINARY=build/openmorals python3 -m unittest discover -s python/tests -v` (tests that need the binary skip when the variable is unset).
- **Single-file binary:** `npm run build:binary && npm run test:binary` (needs an official Node 25.5 or later build).
- **CI:** `.github/workflows/ci.yml` builds and tests on the matrix above, runs the Linux sandbox under bubblewrap, and builds the binary and Python package. `release.yml` is a dry run when started by hand and publishes only on a `v*` tag.

### Tests that depend on the machine

A few tests have been seen failing for reasons of platform or Node version rather than a bug. Making them pass everywhere, or skip with a stated condition, is the first item in the [roadmap](roadmap.md#1-now-groundwork).

| Test | What it expects |
|---|---|
| `test/sandbox/sandbox.test.ts`, `test/sandbox/protected.test.ts` | macOS folding `/tmp` into `/private/tmp`, and a write into a protected folder refused inside the sandbox |
| `test/tests-failfirst/cli.test.ts`, "end to end on a fixture repository (node --test, junit)" | the junit output of `node --test`, whose recorded fixture came from a newer Node than 22 |
| `test/order/hook.test.ts`, "order approve through the hook asks" | a command path that includes where the repository is checked out |

Any other failure is a real one.

## Conventions

These are the project's decisions; each has an ADR in [docs/adr/](../adr/).

- **Outside the model.** Enforcement is deterministic code at action time (ADR 0004). `decide()` and the guards do no I/O; files, the clock and the environment belong to the adapters and the CLI.
- **Fail closed.** When openmorals cannot judge, it asks (ADR 0005). Ask is the default for risky actions, not refuse (ADR 0006).
- **Never "allow".** openmorals never grants a host permission it would not grant itself; it stays silent instead (ADR 0009). It can only refuse, ask or report; no model lowers a decision, and approvals come only from the person (ADR 0014).
- **Floors.** The user-level `openmorals.yaml` is a floor that a project file can only tighten (ADR 0010).
- **Models only escalate.** The optional reviewer and inbound judge can raise a decision, never lower it (ADR 0007, 0012).
- **Windows.** Every command is read in three shell dialects and the strictest answer wins (ADR 0008).
- **A changed decision gets a new ADR** that supersedes the old one; ADR numbers are never reused.
- **Case rows:** each guard has at least 15 rows; every new rule comes with a row it catches and a harmless row it lets through; a pack records how often it asks on other files' harmless rows.
- **No real secrets or personal data** anywhere: use `ghp_FAKE…` and `example.test`.
- **Sign off** every commit (`git commit -s`, Developer Certificate of Origin).

### Docs

- Status words: **Built (version)**, **Planned**, **Rejected**. Every figure says whether it was measured (how and when) or is an estimate.
- When a feature ships, the same change updates [features.md](../product/features.md), [requirements.md](../product/requirements.md), the feature's own page and the [CHANGELOG](../../CHANGELOG.md).
- Changelog entries use the sections Added, Changed or Fixed, Unchanged (earlier rows decide the same), Measured, and Not claimed.
- Do not copy case counts into prose; point to the recount command in [guards.md](../architecture/guards.md).
- Nothing is claimed for a host until a run on that host is recorded.

### Adding or changing a guard, step by step

1. Write rows in `cases/<guard>.cases.yaml`: catches, harmless twins, and the evasion you have in mind. Run `eval` and see them fail.
2. Change the guard in `src/guards/` (or the engine, a detector, a pack). Keep it pure.
3. If the behaviour spans calls (taint, counts, compaction, sub-agents), add session rows to `cases/multi-step.sessions.yaml`.
4. Undo your key line and check which rows go red; say so in the pull request.
5. Check that every existing row still decides the same (`eval` and `npm test`).
6. Update the guard's docs page, [guards.md](../architecture/guards.md), features, requirements and the changelog.

## Where things live

| Path | What it is |
|---|---|
| `src/engine.ts`, `types.ts`, `bylaws.ts`, `shell.ts` | the pure core: `decide()`, the bylaws schema and merge, the posix, PowerShell and cmd parser |
| `src/guards/` | one file per guard: budget, delete, destructive, document, folders, learn, moves, online-delete, packages, reach, replace, secrets, self-protect |
| `src/rules/` | detectors (card numbers, IBAN, national identifiers, tokens) and the content pattern compiler |
| `src/adapters/` | the hook entries for Claude Code, Codex, Gemini CLI, opencode and OpenClaw; `install.ts` writes them |
| `src/session.ts`, `state.ts`, `taint/`, `loop/`, `inbound/` | per-session state (locked and merged on write), taint, the loop detector, inbound scanning and the opt-in judge |
| `src/outbound/`, `defer/`, `undo/` | where data is sent, held asks with approval codes, trash and restore |
| `src/diffclass/`, `review/`, `reviewer/`, `tests/` | the review layer: merge verdict from a diff, review map and notes, the optional second-model reviewer, test report checks |
| `src/eval/` | `openmorals eval`: case and session rows, rescoring |
| `src/order/`, `office/` | work orders, the release hold, office before-after checks (CLI only, never loaded by a hook) |
| `src/sandbox/`, `scanner/`, `guidance/`, `packs/`, `audit*.ts` | OS sandbox plans, the install scanner, the instructions block and daily guidance, pack loading and comparison, the hash-chained audit log |
| `cases/` | the case and session rows |
| `packs/`, `skills/` | ready-made bylaws, and the three daily skills |
| `python/`, `scripts/` | the Python wrapper, binary build and data refresh scripts |
| `test/` | `node:test` suites; each area has a `cases.ts` table and a `*.test.ts` |

## Areas

Each area: where it lives, its docs, its known limits, and what is planned next.

**Engine, bylaws and packs.** Docs: [API.md](../../API.md), [guards.md](../architecture/guards.md), [extras.md](../extras.md), [packs/](../packs/). Limits: detectors see shapes, not meaning; anything encoded, split or built at run time passes; network rules know whether an action reaches the network, not which host. Next: MCP tool classes; more detectors with measured false-alarm rates.

**Hook adapters.** Docs: [adapters.md](../adapters.md), [integrations.md](../integrations.md), [enforcement-model.md](../architecture/enforcement-model.md). Limits: none run live yet; most hosts fail open when a hook crashes; other agents already send their own payloads to the Claude Code hook; scripts and postinstall hooks are outside any hook. Next: the live run, fail-closed install, adapter hardening.

**State, taint and many agents.** Docs: [multi-agent-guards.md](../architecture/multi-agent-guards.md), [swarms-and-memory.md](../swarms-and-memory.md). Limits: taint is kept per session, not across a tree of agents; overlapping calls can share an audit sequence number. Next: the guard-state note after compaction, the spawn check, one record per task.

**Learn (memory, instructions, skills).** Docs: [learn.md](../learn.md), [daily.md](../daily.md). Limits: a harmless-looking wrong note passes unless the session read untrusted content; where each line came from is not recorded; a clean-up pass that rewrites memory is not reviewed. Next: per-write records, the host's own memory folder.

**Tokens and cost.** Docs: [cost-control.md](../cost-control.md). Limits: a hook stops the next tool call, not a model call; tokens are counted only where a host reports them (Codex, OpenClaw). Next: section 2 of the roadmap.

**Review.** Docs: [merge-verdict.md](../merge-verdict.md), [test-integrity.md](../test-integrity.md), [review-map.md](../review-map.md), [reviewer.md](../reviewer.md), the `tests-*.md` pages. Limits: the map reads paths and lines, not meaning; a passing test can still check nothing. Next: the claim check read inside `diff-class`; trying the verdict on real agent pull requests.

**Score.** Docs: [eval.md](../eval.md), [evaluation-plan.md](../evaluation-plan.md). Limits: every row so far was written alongside the guards it tests; session rows run one host, one process, with no real compaction. Next: harmless twins, rows on every adapter, an outside corpus.

**Orders, hold and office checks.** Docs: [order.md](../order.md). Limits: measured on synthetic files only; column insertions and most formulas are not checked. Next: a run on real files from several programs; deploys under the hold.

**Outbound, delete, documents, held asks.** Docs: [outbound.md](../outbound.md), [delete.md](../delete.md), [replace.md](../replace.md), [deferred-asks.md](../deferred-asks.md), [daily-risks.md](../daily-risks.md). Limits: built from documentation and repository histories; no live browsing, mail or form session measured. Next: counting recipients, payment rules.

**Sandbox and scanner.** Docs: [sandbox.md](../sandbox.md), [scanner.md](../scanner.md). Limits: Windows is a written plan only; protected paths are enforced by pattern on macOS only. Next: host sandbox settings written at install.

**Distribution.** Docs: [distribution.md](../distribution.md). Limits: nothing published yet. Next: the release section of the roadmap.

## Limits that hold everywhere

- Nothing has been run against a live agent yet.
- Hooks see tool calls, not model calls. A script, a postinstall hook or a compiled program runs outside any hook; only the sandbox or network controls reach it.
- On a host whose hooks fail open, a crashed or missing hook can be recorded, not prevented.
- State, budgets and the audit log sit on the same disk as the agent. They stop accidents and careless agents, not a determined process running as the same user; that needs the OS sandbox or a separate process.
- Cloud agents with no hooks or plugins cannot be reached at all.

## When you finish

1. `npm run build`, `npm test` and `eval` pass (apart from the machine-dependent tests above).
2. The changelog, features, requirements and the area's page are updated in the same change.
3. The pull request says which rows fail without the change, what was measured, and what is not claimed.
4. Every commit is signed off.
