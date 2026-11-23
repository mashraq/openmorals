# openmorals extras: undo, guidance, loop detector, taint tracker, policy packs

These five modules sit beside the core engine. Each exports plain functions from `src/<module>/index.ts`, keeps its pure logic apart from any file system code, and has its own case table under `test/extras/`. None of them is wired into the CLI or the Claude Code hook yet; the list below says what that takes.

## Wiring needed

1. **CLI subcommands** (the CLI belongs to the core):
   - `openmorals trash <path>...`: call `undo.trash(path, { root, cwd, session })` once per path. `root` is the project root: the folder that holds `openmorals.yaml`, or the current folder.
   - `openmorals restore <id>`: call `undo.restore(id, { root })`.
   - `openmorals trash --list [--all]`: call `undo.list({ root, all })`.
   - `openmorals purge --older-than <days> --yes`: call `undo.purge({ root, olderThanDays, confirm: true })`. Without `--yes`, pass `confirm: false`; the function then refuses and deletes nothing.
   - `openmorals guidance [--file AGENTS.md|CLAUDE.md|GEMINI.md] [--remove]`: call `guidance.writeGuidance(file, bylaws, { trashCommand: 'openmorals trash', restoreCommand: 'openmorals restore' })`, or `clearGuidance(file)` for `--remove`. Pass the two commands only after `trash` and `restore` exist.
   - `openmorals packs`: call `packs.listPacks()`. `openmorals init --pack <name>` writes `packs.readPackText(name).text` as `openmorals.yaml`.
2. **Package entry point.** These modules export generic names (`trash`, `list`, `judge`), so namespaced exports from `src/index.ts` are suggested: `export * as undo from './undo/index.js'`, and the same for `guidance`, `loop`, `taint` and `packs`.
3. **`package.json`.** Add `"packs"` to `files`, so the YAML packs ship with the package. `loadPack` finds them by walking up from its own module (it finds `dist/src/packs/../../../packs` and `src/packs/../../packs`). The test glob `dist/test/**/*.test.js` already picks up `test/extras`. No new dependency is needed.
4. **Self-protect.** Add `(^|/)\.openmorals(/|$)` to `PROTECTED` in `src/guards/self-protect.ts`. Without it, an agent can edit `.openmorals/undo.jsonl` or empty the trash with a plain write. `restore` re-checks every logged path, so a forged log entry cannot move files across the project boundary, but it can still hide items from `list`. `init` could also add `.openmorals/` to the project's `.gitignore`.
5. **Loop and taint in the hook.** Both need session memory that `SessionState` does not have. One option: extend the stored session in `src/state.ts` with `history` (the last 20 `HistoryEntry` items, with command text passed through the core's `redact()`) and `taint` (a `TaintState`). In the hook, combine with `strictest(decide(...).decision, detectLoop(history, action).decision, judge(action, taint, { projectRoot: cwd }).decision)`. After an allowed action, apply `reduceTaint(taint, { type: 'action', action })`. Repeated-failure detection needs the outcome of each call, so it needs a `PostToolUse` hook. With PreToolUse alone, only the repeat, polling and near-repeat checks work. Once this is wired, pass `loopEnforced: true` and `taintEnforced: true` to the guidance writer; until then it describes those habits as advice and claims no enforcement.
6. **Core parser (found while testing).** In `cmd`, `timeout /t 5` is parsed as the wrapper `timeout` around a command named `5` (`parseCommand('timeout /t 5', 'cmd')`, MEASURED). In cmd.exe, `timeout` is a sleep, not a wrapper. The loop detector works around this.
7. **One network list.** The secrets guard's `isNetwork` is private, so the taint tracker keeps its own list of network commands. Exporting one shared `reachesNetwork(command: SimpleCommand)` from the core would stop the two lists drifting apart.
8. **CI adapters.** The engine answers `ask` when it fails closed (`parser.opaque`, `bylaws.invalid`, `*.error`), and no pack can switch that off. An unattended adapter using `ci-unattended` must treat `ask` as `deny`.

Types: every module uses the core's `Action`, `Decision`, `Bylaws`, `Limit` and `Rule` from `src/types.ts`, as described in API.md, and the core's `parseCommand`, `sensitiveLabel`, `parseBylaws` and `decide`. No mismatch with API.md was found.

## Platforms

All tests were run on macOS with Node 25. Windows and Linux path handling is written and unit-tested as pure logic (`path.win32` cases in the undo and taint tables), but none of it was run on those systems.

## 1. Undo: trash and undo log (`src/undo/`)

Instead of deleting, `trash(path, { root })` moves a file or folder to `<root>/.openmorals/trash/<id>/<name>` and appends a line to `<root>/.openmorals/undo.jsonl`. The line records the id, the time, the original path, the trash path, the kind, the size and the session. Paths in the log are relative to the root, so the log holds no absolute paths.

- `restore(id, { root })` moves the item back. It recreates missing parent folders and never overwrites: if something now exists at the original path, it refuses with `occupied`.
- `list({ root, all? })` shows the items still in the trash, or every item with `all`.
- `purge({ root, olderThanDays, confirm })` is the only real delete. It deletes nothing unless `confirm` is exactly `true`, and it removes only trash slots older than the cut-off.
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
- It describes the loop and taint checks as advice unless told they are wired (see Wiring needed, item 5).

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
- It is not wired into the hook yet.

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
- It is not wired into the hook yet.

Tests: 40 (35 judge cases and 4 reducer tests, plus 1 case-count check).

## 5. Policy packs (`packs/*.yaml`, `src/packs/`)

| pack | for | in short |
|---|---|---|
| `solo-dev` | one person, own machine | core defaults; deletes of `dist`, `build`, `coverage`, `node_modules` and `.cache` are allowed |
| `strict` | when nothing irreversible should happen | destructive, online-delete, secrets and self-protect set to deny; asks before push, install and sudo; refuses `curl \| sh`; lower budget |
| `ci-unattended` | CI and runs nobody watches | every guard set to deny; soft budget limits off and hard limits on; push, publish, sudo and `curl \| sh` refused |
| `production-ops` | repos that can reach live systems | online deletes refused; asks before Terraform apply, kubectl and helm changes, database shells, push, and anything naming prod |
| `beginner` | people new to coding agents | asks before deletes, push, installs, admin commands and recursive chmod/chown; short budget |

Every pack is validated by the core's `parseBylaws`. `listPacks()`, `loadPack(name)` and `readPackText(name)` read them. Pack names must match `^[a-z0-9][a-z0-9-]*$`, so a name cannot leave the packs folder, and a pack must be a regular file under 64 KB. `loosenings(candidate, baseline)` lists every field where the candidate is looser than the baseline, using the ordering in API.md (a limit set to 0 counts as looser than any limit).

The tests check that:
- every pack parses and holds no machine-specific text;
- `loosenings(strict, solo-dev)` is empty;
- on a shared list of 31 actions run through the core's `decide`, `strict` is never looser than `solo-dev`;
- each pack does what its table row says.

**Limits:**
- Packs are starting points, not audited policy.
- `ci-unattended` cannot stop the engine's fail-closed `ask` (see Wiring needed, item 8).

Tests: 56.

## Running the tests on their own

```
tsc -p <a tsconfig that extends tsconfig.json and includes src/{undo,guidance,loop,taint,packs} and test/extras>
node --test "<outDir>/test/extras/*.test.js"
```

Last run: 235 tests, 235 passing, strict type-check clean (macOS, Node 25.9, TypeScript 5.9.3).
