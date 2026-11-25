# openmorals extras: undo, guidance, loop detector, taint tracker, policy packs

These five modules sit beside the core engine. Each exports plain functions from `src/<module>/index.ts`, keeps its pure logic apart from any file system code, and has its own case table under `test/extras/`. All five are wired in 0.2.0; the list below says where.

## Wiring (done in 0.2.0)

1. **CLI.** `openmorals trash <path>...`, `trash --list [--all] [--json]`, `restore <id>`, `purge --older-than <days> [--yes]` and `purge <id>... [--yes]` (0.21.0: it lists what it will delete, asks in a terminal, and needs `--yes` where nobody can be asked), `guidance [--file AGENTS.md|CLAUDE.md|GEMINI.md] [--remove]`, `packs` and `init --pack <name>`. The project root is the folder holding the nearest `openmorals.yaml`, else the current folder; `--root` overrides it. Without `--yes` and without a terminal, purge deletes nothing; it deletes exactly the items it listed.
2. **Package entry point.** `undo`, `guidance`, `loop`, `taint` and `packs` are exported as namespaces (`import { undo } from 'openmorals'`), because their names are generic.
3. **`package.json`** ships `packs/`.
4. **Self-protect** asks before a write, redirect or command touches `.openmorals/`, and before `openmorals init` or `openmorals purge`. The first trash also writes `.openmorals/.gitignore` (`*`), so a trashed `.env` is never committed by a later `git add .`.
5. **Loop and taint in the hook.** The session file keeps the last 20 actions (redacted) and the `TaintState`. Before each call the hook combines `decide()` with `detectLoop` and `judge` by `strictest()`; `guards.loop.decision` and `guards.taint.decision` in the bylaws switch each one (allow = off) and `guards.taint.trusted_hosts` lists trusted hosts. A denied action does not taint the session. Outcomes come from the `PostToolUse` and `PostToolUseFailure` hooks, which `init` installs, so repeated-failure detection works. The guidance writer describes loop and taint as enforced only when the bylaws leave them on.
6. **Parser.** In cmd and PowerShell, `timeout /t 5` is now the Windows sleep command, not a wrapper.
7. **One network list.** `reachesNetwork` and `NETWORK_COMMANDS` live in `src/network.ts`; the secrets guard and the taint tracker both use them.
8. **Unattended mode.** `--unattended` on `check`, `scan` and `hook claude-code` (or `OPENMORALS_UNATTENDED=1`) turns every ask, including the engine's fail-closed ask, into deny. Use it with the `ci-unattended` pack.

## Platforms

All tests were run on macOS with Node 25. Windows and Linux path handling is written and unit-tested as pure logic (`path.win32` cases in the undo and taint tables), but none of it was run on those systems.

## 1. Undo: trash and undo log (`src/undo/`)

Instead of deleting, `trash(path, { root })` moves a file or folder to `<root>/.openmorals/trash/<id>/<name>` and appends a line to `<root>/.openmorals/undo.jsonl`. The line records the id, the time, the original path, the trash path, the kind, the size and the session. Paths in the log are relative to the root, so the log holds no absolute paths.

- `restore(id, { root })` moves the item back. It recreates missing parent folders and never overwrites: if something now exists at the original path, it refuses with `occupied`.
- `list({ root, all? })` shows the items still in the trash, or every item with `all`.
- `purge({ root, olderThanDays, confirm, ids? })` is the only real delete. It deletes nothing unless `confirm` is exactly `true`, and it removes only trash slots older than the cut-off (and, with `ids`, only those, 0.21.0). `purgePreview({ root, olderThanDays, ids? })` (0.21.0) returns what it would delete and deletes nothing.
- `planTrash`, `planRestore` and `planPurge` are pure. They take facts gathered by the shell (real paths and file kinds) and return a plan or a typed refusal. No function throws.

**Refusals** (each has cases in `test/extras/undo.cases.ts` and `undo.test.ts`):
- A target outside the root, whether lexically or through a symlinked parent folder.
- The root itself, the filesystem root or the home folder used as a root.
- The `.openmorals` folder, its trash and its log, matched case-insensitively.
- A state folder or trash folder that is a symlink.
- Log entries that point outside the root or outside their own trash slot (a tampered log).
- Malformed ids, and paths that are empty or contain NUL.

A symlink inside the project is moved as a link; its target is never touched.

**Limits:**
- It protects only deletes that go through `trash`. It does not intercept `rm`; the destructive guard asks about that.
- The checks run just before each move, but they are not atomic. A process racing to swap in a symlink between the check and the rename is not fully excluded.
- A move across volumes (`EXDEV`) is refused rather than copied.
- Folder sizes stop counting after 100,000 entries (`sizeComplete: false`).
- The trash sits inside the project and uses disk space until it is purged.
- On case-insensitive file systems, a path given in a different case from the root may be refused. This fails safe.

Tests: 68 (35 trash-plan cases, 13 restore-plan cases, 9 purge and log-replay tests, 9 file system round trips in fresh temp folders, and 2 checks: the case count and portable log paths).

## 2. Guidance writer (`src/guidance/`)

`renderGuidance(bylaws, options)` turns the bylaws into plain-language instructions for the agent, inside a `<!-- openmorals:begin -->` ... `<!-- openmorals:end -->` block. It covers:
- what each guard does, given the configured decision;
- what to do instead (move files aside or use the trash command, ask before online deletes, never print a secret, stop near the budget);
- the budget numbers;
- the project's own rules;
- habits that save tokens.

`mergeGuidance(existing, block)` adds the block or replaces it without touching any text outside it. It keeps CRLF line endings, and running it twice gives the same file. It refuses to edit a file whose markers are malformed (two blocks, or an unmatched or reversed marker). `writeGuidance(file, bylaws)` writes through a temp file and a rename, never through a symlink. `clearGuidance(file)` removes the block.

Rule ids, reasons and patterns come from the bylaws file. They are flattened to one line before they enter the block, with markers, backticks, control characters and bidi/zero-width characters removed.

**Limits:**
- The block is advice to the model; it enforces nothing.
- It describes the loop and taint checks as enforced only when the bylaws leave them on (the CLI passes `loopEnforced`/`taintEnforced` from `guards.loop` and `guards.taint`).

Tests: 29 (15 merge cases, each merged a second time to check idempotence; render tests; and file tests in temp folders).

## 3. Loop detector (`src/loop/`)

`detectLoop(history, next, options?)` returns `allow` or `ask` with a rule, a reason and a count. It checks, in this order:
- `loop.repeated-failure`: the same command failed 3 times with the same error (numbers and ids ignored) within the last 20 steps, even with edits in between.
- `loop.repeat`: the same command, read or fetch is about to run for the 4th time with no file written in between.
- `loop.polling`: 6 polling steps (`sleep`, `tail`, `ps | grep`, `Start-Sleep`, cmd `timeout /t`, `gh run view`, `kubectl get` and similar) with no write in between.
- `loop.near-repeat`: 5 steps that differ only in numbers, hashes or quoted text.

Writes count as progress and reset the repeat, polling and near-repeat counts. Every limit can be changed; nonsense values fall back to the defaults. The detector never returns `deny`.

**Limits:**
- These are heuristics over command text.
- `other` tool calls carry no input in `Action`, so they are not tracked.
- Failure detection needs outcomes from the caller.
- In the Claude Code hook since 0.2.0 (see Wiring, item 5), and in the Codex, Gemini CLI and opencode hooks since 0.3.0 (see docs/adapters.md for what those hosts cannot do).

Tests: 42 (29 detector cases and 11 `isPolling` cases, plus 2 checks: the case count and that it never returns deny).

## 4. Taint tracker, Rule of Two (`src/taint/`)

`reduceTaint(state, event, ctx)` is a pure reducer. Untrusted content enters the session through:
- a web fetch to a host not in `trustedHosts`;
- a web search;
- an `mcp__*` tool's output;
- a network command's output;
- a Read of a file outside the project and outside `trustedPaths`;
- an explicit `untrusted` event.

Private data is marked by:
- a read of a path the core's `sensitiveLabel` flags;
- an environment dump;
- a secret variable, or a keychain, password-manager or cloud-token command;
- an explicit `private` event.

`judge(action, state, ctx)` returns `ask` (rule `taint.rule-of-two`) when all three are true at once: the session is tainted, private data has been touched (earlier in the session or by this action), and this action reaches the network. Otherwise it returns `allow`. It never returns `deny`. A `reset` event clears the state. The state keeps at most 8 marks per kind and stores only the host of a fetched URL, never its query.

**Limits:**
- It works at the level of the whole session, and the taint does not fade over time.
- It cannot follow data through a script.
- Network detection works from a list of command names.
- A file read through a shell command (`cat /tmp/x`) does not taint; only Read tool paths are checked.
- On a tainted session that has touched secrets, every network step asks, including harmless ones.
- In the Claude Code hook since 0.2.0 (see Wiring, item 5), and in the Codex, Gemini CLI and opencode hooks since 0.3.0 (see docs/adapters.md for what those hosts cannot do).

Tests: 40 (35 judge cases and 4 reducer tests, plus 1 case-count check).

## 5. Policy packs (`packs/*.yaml`, `src/packs/`)

| pack | for | in short |
|---|---|---|
| `solo-dev` | one person, own machine | core defaults; deletes of `dist`, `build`, `coverage`, `node_modules` and `.cache` are allowed |
| `strict` | when nothing irreversible should happen | destructive, online-delete, secrets and self-protect set to deny; asks before push, install and sudo; refuses `curl \| sh`; lower budget |
| `ci-unattended` | CI and runs nobody watches | every guard set to deny; soft budget limits off and hard limits on; push, publish, sudo and `curl \| sh` refused |
| `production-ops` | repos that can reach live systems | online deletes refused; asks before Terraform apply, kubectl and helm changes, database shells, push, and anything naming prod |
| `beginner` | people new to coding agents | asks before deletes, push, installs, admin commands and recursive chmod/chown; short budget |
| `test-lock` | an add-on, off unless you add it | asks before an agent edits the tests you declare as judging its work or the test-runner config, and before snapshot updates, `--passWithNoTests` and `--no-verify` (0.9.0; see below) |

### The `test-lock` pack (0.9.0)

An agent that can edit the tests judging its work can change them until they pass. This pack makes that edit a question to you. It holds rules only (no guard settings, so your user-level file or the defaults set the guards), spends no model tokens, and every rule asks; none denies.

| rule | asks when |
|---|---|
| `test-lock.judging-tests` | a file-edit tool writes a path matching the judging-test expression (`&judging`) |
| `test-lock.runner-config` | a file-edit tool writes `vitest.config.*`, `jest.config.*`, `pytest.ini` or `dart_test.yaml` |
| `test-lock.remove-judging-tests` | `rm`, `mv`, `unlink`, `del`, `erase`, `Remove-Item` or `Move-Item` (so `git rm`, `git mv`) has a judging-test path as an argument |
| `test-lock.remove-runner-config` | the same commands name a runner-config file |
| `test-lock.snapshot-update` | `--updateSnapshot`, `--update-snapshots`, `--snapshot-update`, `--update-goldens`; `-u` or `--update` after `jest`, `vitest` or `npm`/`pnpm`/`yarn`/`bun` `test` |
| `test-lock.pass-with-no-tests` | `--passWithNoTests` (or `--pass-with-no-tests`) |
| `test-lock.no-verify` | `--no-verify`, or `git commit -n` |

File-edit tools: Claude Code `Write`, `Edit`, `MultiEdit`, `NotebookEdit`; Codex `apply_patch`, `Edit`, `Write`; Gemini CLI `write_file`, `replace`; opencode `write`, `edit`, `multiedit`, `apply_patch`, `patch`; OpenClaw `write`, `edit`, `apply_patch`; an MCP tool with `write`, `edit`, `create`, `patch`, `move`, `rename`, `delete`, `remove`, `replace`, `append` or `save` in its name. Reading or running the judging tests is never asked about.

**Default judging tests:** `test/acceptance/` and `tests/acceptance/`, `test(s)/contract/` and `test(s)/contracts/`, any `__snapshots__/` folder, any `*.snap` file, any `conftest.py`. A `contracts/` folder outside `test/` or `tests/` is not matched (in some languages it is source code).

**Adding it.** In a new project: `openmorals init --pack test-lock`. With an existing `openmorals.yaml` (yours or the project's): `openmorals packs test-lock` prints the file; copy its `rules:` entries into your `rules:` list. A project file may add these rules over your user-level file, because an added ask only tightens ([ADR 0010](adr/0010-the-user-file-is-a-floor.md)). The self-protect guard already asks when an agent edits `openmorals.yaml`, so the agent cannot quietly narrow the list.

**Declaring your own judging tests.** The judging paths are one regular expression, written once with the YAML anchor `&judging` and reused (`*judging`) by both judging rules. Edit that one string, for example to `"(^|[\\\\/])spec[\\\\/]golden[\\\\/]|(^|[\\\\/])tests[\\\\/]acceptance[\\\\/]"`. Matching ignores case; `[\\\\/]` (as written inside the quotes) stands for either path separator, because shell arguments keep the separator they were typed with. Keep it narrow: tests you wrote or approved before the work started. On this repository's own history (54 commits at 0.8.1, replayed with `git log --name-only`), the default paths would have asked on 0 commits; a lock on every file under `test/` or `tests/`, every `*.test.ts` and `package.json` would have asked on 48. A lock that asks on most honest work gets approved without reading.

**What it does not see:**
- a write made by a script or program the agent runs (`python fix.py`, a build step, a test that writes its own fixtures), a shell redirect (`> tests/acceptance/x`) or `sed -i`. On a host without the OS sandbox (`openmorals sandbox`), nothing else stops that write. From 0.17.0, `sandbox.write.protected_paths: [test-lock]` in your user-level file makes the same paths read-only inside `openmorals sandbox run` on macOS (measured); on Linux only the paths found when the plan is made, and on Windows not at all ([sandbox.md](sandbox.md#protected-paths-sandboxwriteprotected_paths-0170));
- code written to pass exactly the tests you locked. Read-only tests stop an agent editing them; they do not stop code written to pass those exact tests (special-casing, overloading). You still read a sample of the work;
- other ways to skip commit hooks (an environment variable, `-c core.hooksPath=...`), and `package.json` `scripts` (a path rule would ask on every version bump; this waits for rule matching on written content);
- a command whose text merely mentions a locked path or flag (inside a commit message, for example) still asks: the rules read the command line, not its meaning.

The case rows (`cases/test-lock.cases.yaml`, 51 rows) are judged under the shipped pack file itself and under the defaults (pack off: every row allows). They use recorded event shapes, not a live agent host; how often the pack asks in real sessions is not measured yet.

Every pack is validated by the core's `parseBylaws`. `listPacks()`, `loadPack(name)` and `readPackText(name)` read them. Pack names must match `^[a-z0-9][a-z0-9-]*$`, so a name cannot leave the packs folder, and a pack must be a regular file under 64 KB. `loosenings(candidate, baseline)` lists every field where the candidate is looser than the baseline, using the ordering in API.md (a limit set to 0 counts as looser than any limit).

The tests check that:
- every pack parses and holds no machine-specific text;
- `loosenings(strict, solo-dev)` is empty;
- on a shared list of 31 actions run through the core's `decide`, `strict` is never looser than `solo-dev`;
- each pack does what its table row says;
- `test-lock` has the default guards, is no looser than the defaults, asks (never denies) with every rule, asks on each host's file-edit tools and not on reads, moves every judging rule when the one `&judging` expression is edited, and works from a project file over a user file.

**Limits:**
- Packs are starting points, not audited policy.
- Since 0.6.0 a project file can only tighten the user-level file ([ADR 0010](adr/0010-the-user-file-is-a-floor.md)). `solo-dev` (its delete exemptions) and `ci-unattended` (its exemptions and switched-off soft limits) are looser than the defaults in those settings, so written into a project with `init --pack` those settings are ignored, and `init` says so. To use them, copy the pack into the user-level `openmorals.yaml` in the config directory.
- `ci-unattended` cannot stop the engine's fail-closed `ask` by itself; run the hook or `check` with `--unattended` (see Wiring, item 8).

Tests: 65.

## Running the tests on their own

```
tsc -p <a tsconfig that extends tsconfig.json and includes src/{undo,guidance,loop,taint,packs} and test/extras>
node --test "<outDir>/test/extras/*.test.js"
```

Last run: 235 tests, 235 passing, strict type-check clean (macOS, Node 25.9, TypeScript 5.9.3).
