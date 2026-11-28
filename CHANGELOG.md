# Changelog

All notable changes to openmorals. Versions follow [semantic versioning](https://semver.org/); while the version is 0.x, a minor release may change behaviour, and every API change is listed in [API.md](API.md#changes).

## 0.42.0 (2026-11-27)

The npm package is ready to publish, and is not published. Nothing in the engine changed: every case row decides as in 0.41.3.

### Added
- **A stability tier for every export.** [API.md](API.md#stability-0420) puts each of the 468 exports of the entry point in one tier. Stable (8): `decide`, `resolveBylaws` and the types `Action`, `Bylaws`, `BylawsLoad`, `Decision`, `SessionState`, `Verdict`; also the command names and exit codes, the hook's answer to each host and the `openmorals.yaml` schema version 1. Preview: none yet. Internal: the other 460, which may change in any release. No export was removed. `test/api-tiers.test.ts` reads the export list from the built entry point and fails on an export with no tier, a listed name that is not exported, or a change to the Stable list. [ADR 0020](docs/adr/0020-what-is-stable-before-1-0.md) says why Stable is this small.
- **A test of what npm would pack.** `test/pack-list.test.ts` reads npm's own dry-run file list, with scripts off, offline and with an empty npm config, so it needs no network and no account. It fails if the tarball would lack the bin, an export target, a `.d.ts`, a pack, a case file, a skill, the README, LICENSE, NOTICE, CHANGELOG or API.md, or would hold compiled tests, TypeScript sources, source maps, dotfiles, key files or a built file with no source. The tarball holds 410 files, about 0.94 MB packed, 3.3 MB unpacked.
- **`package.json`:** `repository`, `homepage` and `bugs`; a `prepack` script (`npm run clean && npm run build`), so `npm pack` and `npm publish` always empty `dist/` and build again; the `skills/` folder now ships, as `init` already told users of other hosts to copy it from the package.
- **A by-hand release list** in [docs/distribution.md](docs/distribution.md#publishing-to-npm-by-hand): build, test, pack, install the tarball in a temp folder, run `--version`, `check`, `init` and `doctor`, then publish from the maintainer's own account.

### Changed
- **The install pages say plainly that nothing is published.** The README says the clone is the only route that works today; the npm line names an exact version and is under "once it is published"; there is no package-runner line. The Python README no longer opens with `pip install openmorals` and no longer says wheels exist. The Python wrapper's message on a platform with no binary no longer suggests a package runner.

### Not covered
- CommonJS `require()`: the package is ES modules only.
- Windows and Linux: no version since 0.7.0 has been run there.
- No wheel and no binary exist yet; both need the release workflow, which is switched off.

## 0.41.3 (2026-11-27)

Two causes of needless asks, one a fix and one a behaviour change. Rules only: no model call, no network call.

### Fixed
- **On Codex and opencode V1 an asked call no longer marks the session.** Until now the traits of an asked call were recorded when it was asked, so a refused `cat .env` counted as private data read, and later harmless network calls asked under `taint.rule-of-two`. Claude Code was fixed in 0.36.2. Codex and opencode V1 cannot ask, so an ask is sent as a block and the call does not run: it now leaves no mark, and nothing waits for a post-tool event. The same holds for Gemini CLI with `OPENMORALS_GEMINI_ASK=deny`. What each host lets openmorals know:
  - opencode V2 (which asks through its permission hook) and OpenClaw (which asks with an approval request): an asked call still marks the session at once, as before. The only sign that the person declined would be a missing post-tool event, and a post-tool event that fails to reach openmorals for a call that ran looks the same. Waiting for it could lose the mark of a call that ran, which is worse than an ask too many. Neither host's post-tool events have been seen in a live run.
  - Gemini CLI in ask mode sends no call id, so its post-tool event cannot be tied to the asked call. An asked call marks at once, as before.
  - The hosts still pass the call id, so a post-tool event's outcome is tied to the call it belongs to.
- A call that was allowed still marks the session at once, before it runs. A denied call never marks it.
- **The OpenClaw plugin reads the call id the same way before and after a call.** `after_tool_call` read it only from the event, `before_tool_call` from the event or the hook context. It now reads both places on both sides. The plugin file is now format 4; run `openmorals init --agent openclaw` again to update it.

### Changed
- **`rm -f` of files named one by one is judged as `rm` of the same files.** Agents use `rm -f` for clean-up, and it asked (`destructive.recursive-delete`) where `rm` of the same file is steered to `openmorals trash` with no ask (`delete.trash`), or allowed when nothing is there. Without a terminal `rm` does not prompt, not even for a write-protected file, so `-f` deletes nothing `rm` would not; it only hides "no such file". This applies when the only options are `-f` or `--force` (with `--` allowed) and every operand is a plain name in the working folder: no wildcard, no `..`, no `~`, no variable, no absolute path, no operand starting with `-`. These still ask as forced deletes, exactly as before: `rm -rf`, `rm -r`, `rm -f` beside any other option (`-fv`, `-if`, `-r` after the names), wildcards, paths built at run time, absolute and home paths, paths with `..`, and `xargs rm -f`. This is a choice, not a bug fix: fewer asks by design. If you set `guards.destructive.decision` stricter than the delete guard, a named `rm -f` now gets the delete guard's answer. A name listed in `guards.destructive.allow_targets` no longer lets a named `rm -f` of it through: it gets what `rm` of that file gets, which is the refusal toward `openmorals trash` (`delete.trash`) for a file the trash can take. Before, `rm -f build.log` with `build.log` listed was allowed while `rm build.log` was refused toward the trash. `allow_targets` still covers `rm -rf` and the other forced forms.
- Case rows: `rm -f notes.txt` (nothing there) now allows; `rm -f src/a.js` (a file the trash can take) is refused toward `openmorals trash` (`delete.trash`); the document row `rm -f docs/guide.md` runs with the delete guard off and asks with `document.delete`, as `rm` does. New rows on both sides: 17 in all (two for a name in `allow_targets`, with `rm -f` and with `rm`), 1445 rows, every row matched.

### Not changed
- **A `git push` to a local path still counts as network output.** It was a suspected cause of needless asks. git rewrites a local path through `url.<base>.insteadOf` and `pushInsteadOf` like any URL (checked with git: both sent `git push ../x.git` to another repository), so a config line written in an earlier call can send such a push to a server. Telling a really local push apart would need every git config file the push reads. `test/network.test.ts` now holds that it counts.

### Not covered
- A declined ask on opencode V2, OpenClaw and Gemini CLI in ask mode still marks the session. It needs a signal from the host that the person declined.
- On Codex and opencode V1, if the host ever ran a call it was told to block, its post-tool event would not add the call's mark. Both document the block, so this is inferred not to happen.

## 0.41.2 (2026-11-27)

One fix: `init` refuses to install a hook it cannot find. Rules only: no model call, no network call.

### Fixed
- **`init` no longer writes a hook command that will not start.** Before it writes anything, for every host, it looks up the hook command's program the way a non-interactive shell does: on PATH, or by its full path (and, for `node <script>`, that the script exists). If the program is not found, `init` writes nothing (no rules file, no settings), leaves existing settings as they were, exits 1, and prints what to do: put openmorals on PATH and check with `openmorals doctor`, or pass the full-path `--hook-command` it prints for this install. Why it matters: `init` sets the Claude Code tool and prompt hooks to block when they fail (0.36.0), so on current Claude Code a hook that cannot start blocks every prompt and every tool call; on versions older than that setting, every call runs unchecked.
- **A package runner does not count.** PATH folders that `npx`, `npm exec`, `pnpm dlx`, `bunx` or `yarn dlx` add for one run (any `node_modules/.bin` folder) are not used for the lookup, because the agent will not have them later. A hook command that runs through a package runner is refused: the runner adds start-up time to every call and may need its cache or the network. When the project has its own `node_modules/.bin/openmorals`, the refusal names that full path. The full path printed is never one inside a runner's cache.
- **It reads the command the way a shell splits it.** A quoted part joined to the text beside it is one word, so `"/opt/my tools"/openmorals hook claude-code` is checked as one program.
- **A program found on PATH is named.** When `init` accepts a program it found on this terminal's PATH, it prints the full path it found and says that an agent started outside this terminal (from a desktop launcher or an editor) may not have the same PATH; if its hook does not start, run `init` again with `--hook-command` and the full path.
- **The refusal also offers `--no-hook`**, which writes the rules file and no hook, as before.

### Not covered
- A hook command whose words depend on the shell cannot be checked without running it: `&&`, `;`, a variable or backtick (also inside double quotes, such as `"$CLAUDE_PROJECT_DIR"/node_modules/.bin/openmorals`), `~`, an escape. `init` writes it and prints a warning that says what happens if it does not start (on Claude Code, every prompt and tool call is blocked). It is never refused.
- An agent started from a desktop launcher may see a different PATH from the terminal that ran `init`. The full-path form works for both. `openmorals doctor` checks the PATH it is run with, and, unlike `init`, still counts a package runner's folders.
- The library functions `initProject` and `installAgentHook` do not check that the hook command starts.
- Windows: not run there. On Windows the full-path command `init` prints double-quotes each path, so `init` can check it when it is given back; the printed value is shown alone, to be quoted as your shell needs.

### Unchanged
- Every decision and every hook output: every 0.41.1 case row decides the same decision, rule and reason. An `init` whose hook command is found writes the same files as before.

## 0.41.1 (2026-11-27)

A test for a promise that had none, and pages that say what a library check does not cover. No behaviour change. Rules only: no model call, no network call.

### Added
- **A test fails the build if any openmorals source file outside the optional reviewer makes a network call, or if a new file starts other programs** (`test/no-network.test.ts`). It reads every file under `src/` and the Python files the pip package ships. In `src/` it looks for `fetch(` and ways to reach `fetch` under another name (`globalThis.fetch`, `fetch.call`, `const f = fetch`), a load of `http`, `https`, `http2`, `net`, `tls`, `dgram`, `dns`, `undici` or `ws` (by `import`, `require`, a dynamic `import()` or `process.getBuiltinModule`), `createRequire`, the browser network APIs, a load of `child_process`, and a module load it cannot read, such as one built from a template. In the Python files it looks for a network module, `__import__`, `importlib`, `subprocess` and `os.system`-style calls. Comments are not read, so a match there is not a failure; strings are read, so a module name in a string fails until the allow-list says why. Each allow-list entry is one file, one exact line and a reason: the reviewer's one `fetch`, an address check that imports `isIP` and opens no socket, a pattern the diff scanner uses to find network calls in code, and the seven files that start other programs (the two plugins, the doctor's self-test, `sandbox run`, `tests fail-first`, which runs git with its network protocols off, and the two Python files that start the openmorals program). It was shown to fail with `import 'node:https'` added to a real source file, and each form it looks for is planted in a test file and caught. ADR 0014 and ADR 0016 said this test was owed; they now name it.
- API.md: a section "What a library check is not". A library call is advice to the program that makes it: that program decides whether to call and whether to obey. `decide` uses the policy it is given and reads no file, so your user-level file applies only to a load from `resolveBylaws`; with an empty guards list and no rules it allows every command it can read, while a command it cannot read, or invalid bylaws, still asks; it keeps no session.

### Changed
- `openmorals check --help`, API.md and the Python README say that `--bylaws FILE` (Python `bylaws=`) judges against that file alone; your user-level file is not applied.
- The Python README opens with what `check()` judges: one shell command line, on its own, with no session. It no longer opens with the whole product sentence, which the hooks deliver and `check()` does not.
- README.md no longer says the binary and the Python package are "checked case by case on every platform in CI" as if it were running now. The CI job that does it last ran on 0.7.0 and is switched off for now.

### Not covered by the new test
- The code of the one dependency (`yaml`).
- What a program started from one of the seven pinned files does. `sandbox run` runs the command you give it, and `tests fail-first` runs your test command; a new program started inside a pinned file shows only in that file's diff, not as a test failure.
- A call built so that no source line names it (a property name put together from pieces, for example).

### Unchanged
- Every decision and every hook output: every 0.41.0 case row decides the same decision, rule and reason.

## 0.41.0 (2026-11-27)

A behaviour change you will see: openmorals now asks about a tool it does not know. Rules only: no model call, no network call.

### What you will see
- **On Claude Code, Codex CLI and Gemini CLI, a tool name openmorals does not know now asks before it runs.** A name that is not one of the host's documented built-in tools and not an MCP tool gets rule `adapter.unknown-tool`, with a reason that names the tool, says openmorals cannot tell what the call does, and says how to allow it. Approve a call of it once and that name is not asked about again in the session. Until 0.40.1 such a call was judged only by its arguments, so a new write or shell tool a host shipped passed with rule `none`.
- **Only the call you were asked about counts.** The name is remembered when the host's post-tool event matches a call of it that openmorals asked about: by the host's call id on Claude Code, and by the tool name on Gemini CLI, which sends no call id. A post-tool event with no asked call before it remembers nothing, and each asked call is used once. It is kept per session id, so a sub-agent whose calls carry the same session id shares it. A name longer than 128 characters asks every time.
- **When another ask wins, you are still told the tool is unknown.** If the same call also asks for another reason (a secrets path, say) and that reason is the one shown, it ends with a sentence naming the unknown tool and saying that approving the call means openmorals will not ask about that tool again in this session.
- **An agent that runs `openmorals hook` itself is asked about** (rule `self-protect.write`). The host runs the hook; an event an agent pipes into it could change what openmorals remembers about the session.
- **On Codex the call is blocked each time**, because Codex hooks cannot ask and a blocked call never runs. Nothing is remembered there, and the reason says the call is blocked each time until it is allowed. Gemini CLI with `OPENMORALS_GEMINI_ASK=deny` and any `--unattended` run do the same.
- **Claude Code's `Monitor` tool is judged by its command**, like `Bash`: Claude Code runs it under Bash's permission rules. It was judged only by its arguments. A WebSocket watch (`ws`, no `command`) is judged as before.
- **A tool call under a hook event the host does not document is now judged** like the pre-tool event, on the same three hosts. It was allowed as `hook.other-event`. Documented events openmorals does not judge (`SessionStart`, `PreCompact`, `PermissionRequest`, ...) are unchanged.
- **To allow a tool for good**, list it in your user-level `openmorals.yaml`:
  ```yaml
  guards:
    unknown-tools:
      allow: [my_tool]
  ```
  `decision: allow` switches the check off and `decision: deny` blocks every unknown name. A project file can only make it stricter: names it lists that your user-level file does not are dropped and named in the loosening note.

### Unchanged
- MCP tools (`mcp__...` on Claude Code and Codex, `mcp_<server>_<tool>` on Gemini CLI, the shape its hooks page gives): judged on their arguments and by name, as before. A Gemini CLI name in that shape is taken as MCP even when it is a sub-agent you defined.
- opencode and OpenClaw: there an MCP or plugin tool can have any name, so a new built-in tool cannot be told from one, and a tool they do not map is still judged only by its arguments. Both already blocked an event they do not know.
- Every other check still runs on an unknown tool's call, and a deny from it still wins. Every case row of 0.40.1 decides the same decision and rule. The ordinary-work rows were also judged with the Claude Code list applied to every row: 0 of 521 changed.

### Changed tests
- Two pinned rows that were named "unknown tool is allowed" used tools the hosts document (`write_todos` on Gemini CLI, `update_plan` on Codex). They keep `allow` and are renamed to say so; new rows with names the hosts do not document expect `ask`.

### Added
- `src/adapters/known-tools.ts`: each host's documented tools and hook events, with the pages and the day they were read (27 Nov 2026; Codex also from its published source). [docs/adapters.md](docs/adapters.md#tools-and-events-openmorals-does-not-know-0410) says where each list came from and what is not covered.
- `cases/unknown-tools.cases.yaml` (37 rows; rows may now name a `host`), a session row showing the ask once per session, 9 rows in `cases/self-protect.cases.yaml` (an agent running `openmorals hook` asks; text that only names it does not), and `test/unknown-tools.test.ts`.
- An addendum to [ADR 0005](docs/adr/0005-fail-closed-ask-on-error.md); API changes in [API.md](API.md#changes).

### Not claimed
- That any of this was run in a live Claude Code, Codex or Gemini CLI. Whether a host reads an answer to an event openmorals does not know is not known. How often the ask fires in a working hour is not measured yet.

## 0.40.1 (2026-11-27)

One fix on OpenClaw, and the documents brought up to the code. Rules only: no model call, no network call.

### Fixed
- **OpenClaw no longer drops a failed result scan or token count in silence.** `after_tool_call` and `llm_output` only observe, so when the plugin could not reach openmorals there (the command missing, a non-zero exit, a timeout, an answer that is not JSON, or an error inside openmorals), the call's result went unscanned and left no taint mark, and the turn's tokens went uncounted, with nothing to say so. The plugin now keeps each such miss in memory for that session and sends it with the session's next `before_tool_call`. That call asks: `inbound.error` for a result that was not scanned, which also marks the session as if it held hidden instructions, and `budget.unmeasured` for turns whose tokens were not counted. Unattended, it is blocked. The plugin removes a miss only when openmorals answers that it took it, which it does only after the session's mark is saved: if openmorals cannot answer, fails closed, or cannot save the session, the miss stays and the next call asks again. Two calls of one session in flight at once cannot drop a miss that arrives meanwhile. A result that was scanned but whose mark could not be saved now counts as a miss too, rather than as delivered. The plugin file is now format 3; run `openmorals init --agent openclaw` again to update it.

### Added
- [docs/what-reaches-the-model.md](docs/what-reaches-the-model.md): each way content reaches an agent's model, what a hook can see and change there on each host, what openmorals does with it today, the Claude Code events `init` does not install, and what the scans can honestly claim.
- In [docs/agent-messages.md](docs/agent-messages.md): why no field of a message is trusted, the classes of risk between agents with the part of openmorals that sees each, and four more known limits.

### Changed
- ROADMAP.md lists only what is not in a release: five "Next" items described work shipped between 0.32.0 and 0.37.0, and the open items from 0.38.0 to 0.40.0 are added.
- docs/product/features.md and requirements.md carry 0.32.0 to 0.40.1 (they stopped at 0.31.0). New requirement ids GRD-20 to GRD-25, HST-15 to HST-17, REC-11 to REC-17, EXT-21 to EXT-24, INB-08 and NFR-12.
- docs/architecture/as-built.md, integrations.md, deployment.md and prerequisites.md: Claude Code tokens are counted from its session log since 0.36.0 (two pages said they were not), the sub-agent counts and the run budget are built on Claude Code, one live run is recorded, and `openmorals doctor` is the check after `init`.
- README.md, docs/product/vision.md, docs/product/direction.md and ROADMAP.md say plainly what openmorals is and is not: a check outside the model that stops mistakes (an agent set on getting round a rule is stopped only with an OS sandbox on as well), not a judge of morals, and not covering agents that call no hook on your machine; five local hosts, one run live; the child-agent hook call not yet confirmed live; README's version paragraph no longer reads as the latest release; Publish moves up next to the live runs in ROADMAP.md, and a skill marketplace, a pack registry or a policy standard of its own is listed as not planned.
- docs/runs.md names a known limit: a session's file under the run is written without a lock, so two of its calls at the same moment can leave the smaller count there until its next call.

### Unchanged
- Every decision on every host except OpenClaw after a missed event: every 0.40.0 case row decides the same decision, rule and reason. The hook's output is the same for the same input, except on OpenClaw: an `after_tool_call` or `llm_output` that openmorals could not record now answers rule `hook.observe-error`, and a `before_tool_call` that took a miss carries `missedTaken`.

### Not claimed
- That the OpenClaw fix was run in a live OpenClaw, or that OpenClaw runs two `before_tool_call` hooks of one session at once (not checked; the plugin is safe either way). The miss is kept in the plugin's memory, so it is lost if the Gateway restarts before the next call, and the plugin keeps at most 64 misses for each of 256 sessions: past that, the oldest session's misses are dropped.

## 0.40.0 (2026-11-26)

What a run cost and whether anything checked it, which records touched a folder, and a recipe for an agent loop on an existing product. Rules only: no model call, no network call. Reports over records that already exist, and one recording fix.

### Added
- **The run card.** `openmorals audit --run <id>` (text and `--json`) adds the run's counts from its run folder, read only (tool calls, tokens, sub-agent runs, sessions, whether it has limits, whether it is stopped), the number of file writes, the test files written, the `git commit` commands seen, and the checks recorded (order checks, and test-run, `diff-class` and `tests fail-first` commands by a published list of patterns). When the run wrote files and holds no check it prints a "no check recorded" line: a line to read, never an exit code and never an ask. A run with no limits file and no session counts says "no counts for this run", never zero; a run folder that cannot be read says so, and a log read with `--file` with no `runs` folder beside it says "no counts for this log". Quoted text is not read as a check or a commit. See [docs/audit.md](docs/audit.md#the-run-card-0400).
- **`openmorals audit touched <GLOB> [--run ID] [--session ID] [--file FILE] [--json]`.** Lists the audit records that name a path under the glob or a folder holding it (a path a tool read or wrote, a word of a command, a search's folder or pattern), or wrote a test file under it, and the searches (a search tool, or `rg`, `grep -r`, `git grep`, `ag`, `ack` in a command) over a folder that holds or may hold it, grouped by run and session, with each item's log line and a fixed list of what the hook cannot see (reads by a script or interpreter, records from before the hook, work where no hook ran, handoff text, names built at run time, paths outside the working folder, other shell searches). Exit 1 when anything is listed; 0 when nothing is and the log's hash chain verifies; 2 when it cannot tell (no log, no readable record, a log that does not verify). A report: it never asks.
- [docs/brownfield.md](docs/brownfield.md): a recipe for a promise-keeping agent loop on an existing product with what is built: promises as a work-order template that only grows, judging tests and held-out scenarios behind asks and the sandbox, unattended runs with deletions held for you, one budget and one stop per pass, the merge verdict as the ship gate, the run card and `audit touched` afterwards, and what openmorals does not do there. Not run live: each snippet was checked by hand with the CLI.

### Changed
- **A content search records what it looked for.** The audit action of Claude Code `Grep`, Gemini CLI `grep_search` and `search_file_content`, and opencode `grep` ends with `[search "<pattern>"]`, or `[search "<pattern>" in the working folder]` when the call named no folder. Before, a search with no folder was recorded as the tool name alone. File-name searches (`Glob`, `glob`) already recorded their folder and pattern.

### Unchanged
- Every decision: every 0.39.0 case row decides the same decision, rule and reason, and the hook's output is byte-identical for the same input (only the search's audit text changed). The exit code of `audit --run` is unchanged; `diff-class --run` reads the same facts as before.

### Not claimed
- That a clean `audit touched` report means the folder was never read: a script or test runner that opens it itself is invisible to the hook. Use `sandbox.read.deny` or keep it off the machine.
- That "no check recorded" is complete: a check under another name (`make ci`, a script), or one run outside the run, is not seen, and a check that ran says nothing about whether it passed.

## 0.39.0 (2026-11-26)

Your stops in the audit log, and a read-out of your oversight from it. Rules only: no model call, no network call.

### Added
- **`openmorals stop` is recorded.** `stop <session>`, `stop --all`, `stop --run <id>`, `stop --clear [<session>]` and `stop --clear --run <id>` each write one chained record (session `stop`, rule `stop.set` or `stop.clear`, decision `allow`), saying what was stopped or cleared and whether it ran from a terminal. Before, a stop and its clear left no trace in the log, only the refused calls did. If the record cannot be written, the stop still takes effect and the command says so on stderr.
- **`openmorals audit oversight [--since TIME] [--until TIME] [--json] [--file FILE]`.** What your log shows of your oversight: agent calls, asks, asks whose call then ran, asks with no outcome line, approval rate per rule, asks per 100 calls, denies, calls refused as stopped, stops set and cleared, and whether the record verifies. It prints reasons to look (a rule approved 95% of the time or more over at least 20 asks, more than 1 ask per 100 calls over at least 100, asks with no outcome, a session still stopped, refusals as stopped with no stop recorded, a record that does not verify), never a pass. Read only; exit 0 when the record verifies, 1 otherwise.
- [ADR 0019](docs/adr/0019-approval-rates-suggest-never-change-a-rule.md): an approval rate only suggests. A rule approved 95% of the time or more is shown as a candidate for an allow and changes only when you change it; a high approval rate never makes a rule a refusal.
- [docs/oversight.md](docs/oversight.md): what the log can be evidence for, the public frameworks people ask about (EU AI Act Art. 12, 14 and 26, NIST AI RMF MANAGE 2.4, ISO/IEC 42001 Annex A, OWASP Top 10 for Agentic Applications) with what the log cannot show for each, and the known limits.

### Unchanged
- Every decision: every 0.38.0 case row decides the same decision, rule and reason. An agent that runs `openmorals stop` or `stop --clear` is still asked first.
- `audit --run` counts are the same: stop records carry no run id. `audit sample` no longer counts the `stop` session as a unit to draw.

### Measured
- `audit oversight` over 100,000 records: about 0.75 s, of which about 0.44 s is the chain check `audit verify` already does (Node 22, one Xeon core at 2.1 GHz, 26 Nov 2026).

### Not claimed
- That any law or standard is met. The log is evidence of what the hook saw, not compliance. A stop is per session or per run, refuses later calls and undoes nothing; who answered an ask is not recorded.

## 0.38.0 (2026-11-26)

A record of what agents hand to each other, and `openmorals doctor`, a read-only check that the guard is really live. Rules only: no model call, no network call. The handoff record is built from each host's documentation and not run live; doctor was measured on Claude Code.

### Added
- **The `handoff` field on the audit line.** A call that starts a sub-agent, sends a message to another agent or session, or carries a sub-agent's report back now records what kind of handoff it was, a fingerprint of the text the scan saw (HMAC-SHA256 under a random key kept per install, so repeats show within one install and fingerprints cannot be compared across machines) and its size after redaction, whether the sending session had read untrusted or hidden content, and labels for phrases that claim approval or authority ("the user has approved this", "no need to ask"). Never the text. [docs/agent-messages.md](docs/agent-messages.md).
- **`openmorals audit handoffs`** counts handoffs by kind and by host and tool, and lists those sent from a session that had read untrusted or hidden content, those carrying a claim, those over the size cap, and the same text sent more than once (`--session`, `--since`, `--log`, `--json`). It only reads the log. Exit 1 when a handoff from such a session, with a claim or over the cap is listed, else 0; repeats are listed but do not set exit 1.
- **Five more message tools are scanned.** Codex `send_input`, `send_message` and `followup_task`, and OpenClaw `sessions_create` and `conversations_send`, now have their text scanned before the call runs, like the other message tools since 0.14.0, so a finding there is recorded and marks the session. Case rows for each.
- **`openmorals doctor`: is the guard really live here?** Claude Code: full checks and a self-test. It checks that the hook is installed for every event, that one `PreToolUse` hook entry both covers every tool and blocks the call when it fails, that its command can be found and that it is this openmorals. It then runs its own openmorals hook (never a command from the project) on three made-up events (a harmless call, a risky one and a prompt), unattended and with no network call, and times each; a risky call that comes back allowed is a problem. Codex, Gemini CLI, opencode, OpenClaw: the hook or plugin is there, how the agent treats a failed hook, and (Codex, Gemini CLI) `openmorals` on PATH. It notes when Claude Code's own sandbox is off. Secrets in a hook command are masked when printed. `--json` for scripts, `--no-run` to skip the self-test. Exit 0 when nothing needs fixing, 1 when something does. Details: [docs/host-settings.md](docs/host-settings.md).
- **docs/host-settings.md**: how openmorals' answers meet an agent's own permission modes, allow rules, sandbox and undo, and what was seen in testing.

### Measured
- On Claude Code 2.1.332 with 0.36.2: an ask held under the `default`, `acceptEdits` and `auto` modes and over Claude Code's own allow rule for the same command; a missing hook command blocked every prompt with exit 127; the rule of two asked after a private read, and a declined ask left nothing behind.

### Not claimed
- A claim label is a phrase match: it changes no decision, adds no ask and does not mark the session. A message from one agent can never stand in for your approval.
- Text passed through files (notes, shared folders, mailbox files, message boards) is not a tool call and is not recorded. Whether each host fires its pre-tool hook for every listed tool, and inside a sub-agent, has not been checked live.
- That a passing `doctor` means the project is safe: it checks that the guard is installed and answering, not what the rules miss.
- Anything about Claude Code's `bypassPermissions` mode, which was not tested.

## 0.37.0 (2026-11-26)

One budget for a whole task of agents, on Claude Code. Rules only: no model call, no network call. Guide: [docs/runs.md](docs/runs.md).

### Added
- **`openmorals budget start`** sets a run's limits once (`--tool-calls`, `--tokens`, `--spawns`, `--sessions`, each `N` or `SOFT:HARD`; `--id`) and prints `export OPENMORALS_RUN=<id>`. Starting an id that exists is refused, so a run cannot be refilled. An agent that runs it is asked about first.
- **The run budget on Claude Code.** Every session with `OPENMORALS_RUN` in its environment writes its counts (tool calls, tokens from the session log, sub-agent runs) under `<config>/runs/<id>/`, and each call sums the run. A hard limit refuses every later call of every session of the run (`budget.run.<unit>.hard`); a soft limit asks once for the whole run (`budget.run.<unit>.soft`); `--sessions` counts each new, resumed or re-dispatched session, and refuses one past the limit at join without counting it (`budget.run.sessions.hard`). The first time a session sees the run at 90% of a hard limit, the agent gets one line beside an allowed call. A limits file or session file that cannot be read asks (`budget.run.unreadable`).
- **`openmorals stop --run <id>`** stops every session of a run in every process (`budget.stopped`, the turn ends); `stop --clear --run <id>` lifts it. Person-only, as for `stop`.
- **`openmorals budget status [ID] [--json]`**: each run's use against its limits, and whether it is stopped.

### Not changed
- Sessions without `OPENMORALS_RUN` decide as before, and the per-session budget still applies inside a run. Every 0.36.2 case row decides the same decision, rule and reason. Other hosts: not yet.

## 0.36.2 (2026-11-26)

Two fixes found by the first live run on Claude Code (Claude Code 2.1.332). Rules only: no model call, no network call.

### Fixed
- **Clearing a stop asks from any install path.** Self-protect now also counts a script as openmorals when the nearest `package.json` above it names `openmorals`, and `stop --clear` asks on any script, whatever it is called. The other person-only steps (`init`, `purge`, `approve`, `release`, `accept`, `stop`, `order approve`, `audit sample`) follow the same recognition.
- **A declined ask marked the session.** On Claude Code the taint of a call that asked was added before the call ran, so a `cat .env` the person said no to still counted as having read a secret, and later harmless network steps asked with `taint.rule-of-two`. The mark is now held until Claude Code's `PostToolUse` or `PostToolUseFailure` says the call ran (an interrupted call counts as run). A mark is held only once the session has had a post-tool event, so a setup without the post-tool hooks marks at once as before; held marks are kept apart from the session history, so later calls cannot push one out, and past 64 held at once a mark is added at once. An allowed call still marks the session at once, and the other hosts are unchanged.

## 0.36.1 (2026-11-25)

A fix in the outbound guard. Rules only: no model call, no network call.

### Fixed
- **A protected name no longer turns a refusal into an ask.** With `guards.outbound.credential: deny` and `lookalike_credential: ask`, a password typed into an unlisted look-alike of a name in `protect` asked, where the same password with no `protect` entry was refused: adding a name, which should only tighten, loosened the verdict. The same held for `code_relay: ask` and a remembered one-time code, also on a listed site whose page was opened from untrusted output. The sites check now still applies when it is the stricter of the two. With the default settings nothing changes. Found by the team package's property test against 0.36.0.

## 0.36.0 (2026-11-25)

Token control on Claude Code, and a hook that fails closed. Rules only: no model call, no network call.

### Added
- **Real token counts on Claude Code.** The budget guard reads the usage numbers from Claude Code's own session log, the main one and each sub-agent's, and holds them to `guards.budget.tokens`. Each reply counts once; cache reads are kept apart. Only the numbers are read, never the conversation ([ADR 0015](docs/adr/0015-claude-code-token-counts-from-its-session-log.md)). `guards.budget.transcript: false` in your user file turns it off; a project file cannot.
- **Per-agent counts.** Tool calls are counted per sub-agent, with its kind when Claude Code passes one; `guards.budget.agent_tool_calls` limits them (off by default).
- **Sub-agent runs and fan-out.** Every start of a sub-agent is counted. Sub-agents started together, with no other tool call between them, are one run, so a planned fan-out of parallel variants uses one run. `guards.budget.spawns` asks at 25 runs and every 25 after (no hard limit by default); `guards.budget.fanout` asks when one batch starts more than 10.
- **`openmorals stop <session>` and `openmorals stop --all`.** Every later tool call of that session, in the main conversation and every sub-agent, is refused and the agent's turn ends. Work already done is kept. Only you can lift it with `openmorals stop --clear`; an agent that runs that is asked about first.
- **`openmorals sessions`** lists recent sessions with tool calls, tokens, cache reads, sub-agent runs, the busiest sub-agents and whether each is stopped (`--json`).
- Rules `budget.agent_tool_calls.*`, `budget.spawns.*`, `budget.fanout`, `budget.stopped`; four session rows in `cases/multi-step.sessions.yaml`, four self-protect rows, and a test that the Python wrapper's version matches the package.

### Fixed
- **The Claude Code hook failed open.** If the hook crashed or timed out, Claude Code ran the tool call anyway. `openmorals init` now installs the `PreToolUse` and `UserPromptSubmit` hooks with `onFailure: "block"` (Claude Code 2.1.295 or later), and running it again adds the setting to a hook installed by an older version. The post-tool hooks only record and scan, so they keep the default.
- **Gemini CLI MCP tools and web search did not mark a session.** Gemini CLI names MCP tools `mcp_<server>_<tool>` and its search `google_web_search`; the taint judge knew only `mcp__` and `web_search`, so their output never counted as untrusted content there. A name starting `mcp_` now counts as an MCP tool on every host, and `google_web_search` as a web search. A local tool whose name starts `mcp_` is now treated as MCP too, which can only add asks.
- **The Python wrapper's version.** It was left at 0.31.0, so building its wheel against the current package failed; it now follows the package version.

### Changed
- On Claude Code a long session can now reach the token limit (soft 2,000,000, hard 5,000,000), which 0.35.0 never checked there. Every 0.35.0 case row decides the same decision, rule and reason.

### Not claimed
- A hook stops the next tool call, not a reply already being written, so a limit can be passed by the turns in flight, and by more for sub-agents running in the background. The session log's format is not documented; when it changes, the token count can stop (the tool-call budget still holds). There is no limit across processes, no depth limit of its own (use the host's), and no separate allowance for monitoring loops: a poll is a model turn and counts like one.

## 0.35.0 (2026-11-25)

The learn layer: a new `learn` guard for what an agent writes into the files that teach later sessions. A line written there keeps working after the session that wrote it ends, so a wrong note or a planted instruction reaches every session after it. Rules only: no model call, no network call.

### Added
- **The `learn` guard, on by default with decision `ask`.** It covers instructions files every session loads (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `MEMORY.md`, `.github/copilot-instructions.md`, the `.claude/rules/`, `.claude/output-styles/`, `.cursor/rules/`, `.windsurf/rules/`, `.github/instructions/`, `.github/prompts/` and `.clinerules/` folders and others, compared in lower case on a normalised path), notes in a `.claude` memory or agent-memory folder, and skills, sub-agents and commands. [docs/learn.md](docs/learn.md).
- **`learn.scan`: a skill is scanned whenever it is written.** What a write adds is run through the install scanner: every rule for a skill (a critical finding is refused); for instructions and memory files, the hidden-instruction rules and, asked about rather than refused, the rules for a line that sends secrets out or downloads and runs code.
- **`learn.budget`: a token budget for instructions files.** A write that grows one past `tokens` (10,000 by default, about four bytes each) is asked about. A write that does not grow the file is never held to it.
- **`learn.shell-write`:** a shell command that writes one of these files (a redirect, `tee`, the destination of `cp` or `rsync`, `curl -o`, `tar -C`, `sed -i`, `perl -i`, `awk -i inplace`, a path in `python -c` code, `git clone` into a skills folder and others, read from the folder an earlier `cd` moved to) is asked about, since what goes in cannot be seen. Copying one of these files elsewhere is not a write to it.
- **`learn.tainted-write`:** in a session that has read untrusted content (a web page or search, an MCP tool's output, a file from outside the project), a write into one of these files is asked about, because the next session starts clean and would load it. It counts across compactions and sub-agents, like the taint check.
- `guards.learn: { decision, tokens }` in the bylaws, absent by default (read as `ask`, 10,000). A project file can only make it stricter: it cannot switch it off, raise the budget or set `tokens: 0`.
- `cases/learn.cases.yaml` (49 rows) and five session rows in `cases/multi-step.sessions.yaml`.

### Changed
- A write into one of these files that 0.34.0 let through can now be asked about, and a skill with a critical scanner finding is refused. Every other 0.34.0 case row decides the same decision, rule and reason.

### Measured
- Case table: 32 of 32 caught, 0 of 17 false alarms; session rows: 20 of 20 steps caught across the shipped sessions, 0 of 35 false alarms. On this repository's 77 Markdown files, the rules used for instructions files flag 15 (5 hidden-instruction, all documents that quote attack phrases on purpose; 14 send-out or download-and-run, documents that quote such commands), which is why those ask rather than refuse.

### Not claimed
- A wrong note that looks harmless trips no scanner rule and goes through outside a session with untrusted content. It does not record where each line came from, keep a history of notes, or review a clean-up pass that rewrites memory. Shared databases and document stores an agent reads from are not treated as untrusted. How often it asks in real sessions is not measured.

## 0.34.0 (2026-11-25)

The score layer: `openmorals eval` now also checks decisions that depend on what came before in a session, and says when a score has gone stale because a pack, a skill or the model changed. Rules only: no model call, no network call.

### Added
- **Session rows (`cases/*.sessions.yaml`).** A session row sends several hook events in order to the Claude Code hook (without the optional reviewer and inbound judge, which call a model), in a temporary home and project that are removed afterwards, and checks the decision at each step that names one. A guard row judges one call against a state written by hand; a session row checks that the state is really kept and read between calls. Steps can be tool calls, their results and failures (`of:` answers an earlier step), the person's messages, compactions (`PreCompact`, `SessionStart` with `source: compact`), sub-agent events and calls made in a sub-agent (`agent:`), and calls in a second conversation (`session:`); a row can run unattended and carry its own bylaws, project bylaws and files. Scored apart from the total, as a `sessions` line; `--guard sessions` runs only these. [docs/eval.md](docs/eval.md#session-rows-sessionsyaml-0340).
- **15 shipped sessions, 40 checked steps:** a leak after a web fetch (and a fetch after a reachable leak), the fetch still counting after the compaction events, a sub-agent's fetch reaching the main agent and another sub-agent, a second conversation that does not inherit it, the fourth identical command, a file write resetting the count, the third identical failure (and interrupted calls not counting), an unattended run turning asks into denials, a project file unable to switch the loop check off while the person's own file can, the tool-call budget counting sub-agents' calls, and a scanned tool result that does not loosen the next call.
- **Rescoring: `eval --save FILE` and `eval --since FILE`.** `--save` keeps every row's outcome with a fingerprint: the openmorals version, a digest of the rows, of the bylaws, of each shipped pack and of each agent skill (`.claude/skills` here and in your home), and the model (`--model`, else `ANTHROPIC_MODEL`). `--since` scores again and lists what moved: the fingerprint parts that changed and every row decided differently, looser first, then stricter, then same decision by another rule, then new and gone rows, with the catch and false-alarm counts before and after. Anything that moved makes the exit code 1, so a gate cannot pass on a score taken before a pack, skill or model change. A saved score that cannot be read, or was taken with another `--guard`, is exit 2. When `--save` and `--since` name the same file and something moved, the score is not saved. Office rows are not in a saved score; they are checked on every run.
- A session step that gets a hook error rule (the hook failing closed) is wrong unless it names that rule, so a broken hook cannot pass as a catch; `files` cannot replace the bylaws or the config folder.

### Unchanged
- Every guard, inbound and diff-class row decides the same decision, rule and reason as in 0.33.0, and the guard table and total are the same; session rows are not added to the total. No hook decision changes.

### Measured
- On this repository's test machine: the 40 session steps take p50 1.3 ms and p95 3.6 ms each; `eval --guard sessions` takes about 1 s in all, including Node start-up. With `--since`, the full shipped score (1,525 rows with the session steps) compared to itself reports nothing moved.

### Not claimed
- Session rows run the Claude Code hook only, in one process, one step after another: they do not show what other agents' hooks do, what a host's real compaction does (the compaction events reach the hook, but the conversation is not actually compacted), what happens when sub-agents' calls overlap in time (covered by the 0.32.1 tests instead), or what a live agent tries. A skill or model in the fingerprint is a reason to look again, not a measurement of what the new skill or model does; skills outside `.claude/skills` are not seen.

## 0.33.0 (2026-11-25)

The review layer: help for the person who reads an agent's change. Three additions to `openmorals diff-class`, none of which can make a change review-free. Rules only: no model call, no network call.

### Added
- **`--map`: a review map.** After the verdict, every file riskiest first, with its line counts and the rule ids behind its place. A token added, weakened tests, CI, build and agent instruction files and what the diff reader does not fully understand are high risk; source, dependencies and files outside the declared paths are medium; the rest is low. Built only from the reasons `diff-class` already found; a low place never means safe. `--json` gains `map`. [docs/review-map.md](docs/review-map.md).
- **A split suggestion for an oversized change.** With `--map`, a change over the size line (`--max-lines` and `--max-files`, else 400 changed lines or 25 files) gets one suggested way to split it: dependencies first, each test with the source file of the same name, code by area, then tests with no source in the change, then tooling and CI, then docs. A group still over the line says so. `--json` gains `split` (null within the line).
- **`--note FILE`: a review bot's comment or an AI summary can only add review.** A `review: <path> <why>` line, or a line with a concern word (security, secret, unsafe, regression, untested, bug, "do not merge" and others), adds a reason (`note.review`, `note.concern`) and so needs review. An approval or all-clear line (LGTM, approved, safe to merge, ship it) changes nothing, and the verdict notes how many were ignored. Concern words are checked first, so a line with both adds review. Up to 20 notes of 256 KB each. An unreadable note gives exit 2.
- A note that is not UTF-8 text (UTF-16, binary, invalid bytes) is unreadable: exit 2, needs review. One note gives at most 50 reasons plus one that counts the rest. Control and format characters in a note are not printed. In the text output the tool's own findings come before what a note raised.

### Unchanged
- Without `--note` the verdict, reasons and exit code are the same as in 0.32.1, and `--map` never changes them. Every 0.32.1 case row decides the same decision, rule and reason.

### Measured
- On this repository's last 50 commits: a file rated high risk in 38, a split suggested for 25 (its version commits are large), 7.8 groups on average when split.

### Not claimed
- The map and the split read paths and diff lines, not meaning: a one-line change in a low-rated file can matter most, and the split cannot see dependencies between files beyond a shared name. A note's concern written without one of the listed words, or in another language, is not seen. How useful the map is to reviewers is not measured.

## 0.32.1 (2026-11-25)

A fix: hook calls of one session that run at the same time (sub-agents working in parallel) no longer erase each other's session state.

### Fixed
- **Taint marks, history and counts lost under parallel calls.** Each hook call reads the session file, judges, and writes the file back. Two calls that overlapped each wrote their own copy, so the later write erased what the earlier one recorded, including the mark that the session had read untrusted content. Measured on 0.32.0: twelve hook processes of one session started together kept 4 to 6 of 12 calls and 1 to 3 of 6 untrusted-content marks over three runs. Now each write takes a short lock on the session file (`<file>.lock`, made with an exclusive create; held only for the read and write, never while judging), and a writer that finds the file changed since it read it merges instead of overwriting. Calls and token counts add up, taint marks and history entries of both writers are kept, and the other fields keep the newer change. A merge only ever adds, so the next judgement can only get stricter. A lock left by a process that died is moved aside and removed after 10 seconds, by one waiter only. Every retry checks the 2-second deadline, even when a stale lock cannot be removed, so a wait never runs past it: if the lock cannot be taken within 2 seconds, the save fails, and as before a failed save turns the call into an ask. A call releases only the lock it made. A command a writer ran again is kept in the history even when the same command was already there.
- The session file gains `rev` (its save count).

### Measured
- Twelve, 32 and 64 hook processes of one session started together keep every call and every mark (12/12, 32/32, 64/64 calls; 6/6, 16/16, 32/32 marks). The 64 finish in about 3.2 seconds on the test machine, and no lock wait ran out.
- Every 0.32.0 case row decides the same decision, rule and reason.

### Not claimed
- Calls that run at the same time can still give the same audit sequence number to two records, which `audit verify` reports as a fork, as before. Taint is still kept per session, not across a tree of agents that run under different session ids. How often parallel sub-agents run in real sessions is not measured.

## 0.32.0 (2026-11-25)

Checks on what an agent says about its tests, and on what it installs and commits. Rules only: no model call, no network call.

### Added
- **`openmorals tests provenance [PATH...]`**: which test files the agent wrote, read from the audit log. Each audit record now carries `tests`, the test files that call writes (the Write and Edit tools; in a shell command a redirect target and the files `tee`, `cp`, `mv`, `install`, `ln`, `rsync` and `sed -i` write). Exit 1 when a listed test file was written by the agent. [docs/tests-guard.md](docs/tests-guard.md).
- **`openmorals tests claim <clean-report> [--claimed FILE]`**: checks "the tests pass" against your own clean run. The claim is every test, the passing tests of the agent's own report, or a list of names. Exit 1 when a claimed test fails, is skipped or did not run; a name that matches more than one test is listed as ambiguous.
- **Held tests**: `tests-quarantine.txt` in the config directory (one id per line, `# why` optional). A held test's loss does not block `tests compare` and is listed as on hold; a held test never counts as a gain or as proof; a held named acceptance test fails `tests fail-first` (`held`). The config directory is already one the self-protect guard keeps the agent from writing.
- **`openmorals tests coverage <before> <after>`**: lcov or Cobertura; each file whose covered share fell by `--min-drop` points or more (default 1), files gone from the report, and new uncovered files, worst first. Totals are printed and decide nothing.
- **The `packages` guard**, on by default with decision `ask`: an install by name (npm, pnpm, yarn, bun, pip, uv, poetry, pdm, cargo, go, gem, bundle, composer) of a package the project's own manifest and lockfile do not list. A project with no list file, a bare install from the manifest and an install from a path, URL or git are not judged. `guards.packages.decision` sets it; the `ci-unattended` pack sets `deny`. [docs/packages.md](docs/packages.md).
- **Two `diff-class` rules** that add review: `integrity.lockfile` (a manifest adds a dependency with no lockfile change in its folder or above, or an added lockfile line resolves from git, plain http, `file:` or `link:`) and `integrity.secret-added` (an added line holds a known vendor token shape, the same detector the `secret-token` rules use). [docs/test-integrity.md](docs/test-integrity.md).
- **Git hook files are protected**: the self-protect guard asks before an agent changes `.git/hooks/`, `.husky/`, `.githooks/`, pre-commit, lefthook, simple-git-hooks or overcommit files, or sets `core.hooksPath` with `git config` or `git -c`, since a hook runs on the person's next commit.
- **The failure on the handoff**: when the `loop` guard asks about the same failure repeated, its reason now ends with the last error text (at most 300 characters), so whoever reads the ask sees what failed.

### Unchanged
- Every 0.31.0 case row (1,206 rows) decides the same decision, rule and reason on this build. The defaults digest is unchanged: the `packages` section is absent from the defaults and read as `ask`.

### Measured
- `openmorals eval`: every row matched. packages (45 rows): 22 of 22 caught, 0 of 23 false alarms. self-protect (159 rows): 102 of 102, 0 of 57. diff-class (157 rows): 150 of 150 held for review, 0 of 7 review-free rows wrongly held.
- On this repository's 49 commits the new diff rules fire on: `integrity.lockfile` 0; `integrity.secret-added` 6 (12%), all fake tokens in test and case files.
- What the new guard costs packs that lay rules over other case files: information-security now asks on 4 of 440 benign rows and regulated-software on 25 of 454 (each row named in the pack's page).

### Not claimed
- `tests provenance` misses a test written by a script, a code generator or an interpreter one-liner, and has no records before 0.32.0; no record does not prove the agent did not write a file. `tests claim` and `tests coverage` read reports you made: a report from the agent's own shell is its claim, and a passing or covered test can still check nothing. The `packages` guard does not look a name up in a registry and misses `npx`-style runs and names written into a manifest by hand. `integrity.secret-added` misses passwords, private keys, JWTs and any token split, encoded or built at run time. How often any of this fires in real sessions is not measured. Nothing run against a live agent.

## 0.31.0 (2026-11-25)

Three packs, off unless you choose them: `privacy`, `health-data` and `regulated-software`. Each is built from rules and guards that already exist (detectors, `match.network`, content rules, `guards.taint.private_paths`, `merge.always_review`), names what checks each of its principles, says which are advice only, and says what it is not.

### Added
- **`packs/privacy.yaml`**: refuses to send a card number, IBAN, US social security number or NHS number over the network; asks before an email address or phone number is sent, before one of the four identifiers is written into a file, before a database dump (`pg_dump`, `mysqldump`, `mongoexport` and others), before a data file (`.csv`, `.sql`, `.sqlite` and others) is added to git, before a paste or file-sharing site, and before a write that logs a personal field (`ssn`, `dob`, `diagnosis` and others). [docs/packs/privacy.md](docs/packs/privacy.md).
- **`packs/health-data.yaml`**: its first line and its disclaimer are a fixed text, word for word, and a test compares them: "Not compliance and not medical safety. ..." It refuses to send a US social security number or NHS number over the network; asks before an HL7 message or FHIR Patient resource is sent, before either identifier or such a record is written into a file, and before a clinical file (HL7, DICOM, C-CDA, `*.fhir.json`, and the folders you declare; the example is `clinical-data/`) is written, copied, committed or sent, and before a DICOM network tool runs. Reading a clinical file is never asked about: it marks the session as holding private data, so the taint guard asks before a later network step once untrusted content has entered. No medical advice: for a health question it says to talk to a licensed clinician and act on their advice. [docs/packs/health-data.md](docs/packs/health-data.md).
- **`packs/regulated-software.yaml`**: asks before changes under paths you declare as regulated (the example is `regulated/`), to risk and hazard files, to lockfiles and dependency manifests, and before a package is added, updated or removed; its `merge.always_review` sends every change under the declared paths to review in `openmorals diff-class`. It never guesses which code is regulated. [docs/packs/regulated-software.md](docs/packs/regulated-software.md).
- Case tables `cases/privacy.cases.yaml` (63 rows), `cases/health-data.cases.yaml` (63) and `cases/regulated-software.cases.yaml` (43): rows only each rule catches, benign rows for each rule, and rows with the pack off.

### Unchanged
- **Nothing changes for anyone who has not chosen one of these packs**: the 0.30.0 case rows (1,037 guard rows) decide the same decision, rule and reason on this build, and every 0.30.0 line of `openmorals eval` is the same. The defaults hold no rule, no `private_paths` and no `merge` settings. No guard or engine code changed.

### Measured
- `openmorals eval`: 1,258 rows, every row matched; privacy 34/34 caught, 0/22 false alarms; health-data 31/31, 0/24; regulated-software 22/22, 0/16.
- Removal test: deleting any one of the 20 rules makes exactly its own catching rows fail (3 to 7 per rule); changing one character of the health-data disclaimer or first line fails the fixed-text test; emptying `merge.always_review` turns a reproduced change under `regulated/` review-free again.
- What each pack costs: laid over the benign rows of every other case file as a project file, privacy asks or refuses on 6 of 413, health-data on 3 of 410 and regulated-software on 9 of 421 (each row listed in the pack's page); all are new asks or refusals from the packs' own rules.

### Not claimed
- No pack is a certification, an audit or legal advice, and none shows that software or data meets any law or standard. They see what detectors and path and command patterns can see: names, addresses, dates, free text, images and anything encoded pass them, and so does what a script the agent runs writes or sends. health-data claims only its fixed text. How often the packs ask in real sessions is not measured. Nothing run against a live agent.

## 0.30.0 (2026-11-25)

Office before-after checks: the person takes a baseline of the work order's workbooks and Word documents at its start, and `order check` fails on what the work lost against it. Command line only, never in a hook; no new dependency.

### Added
- **`openmorals order baseline <order.yaml>`** (person-only; [docs/order.md](docs/order.md#office-before-after-checks-0300)): a copy of each `.xlsx` and `.docx` the order names, kept in the config directory under its own SHA-256, with an index line and a chained `order.baseline` audit record. A file that does not read as its kind refuses the baseline. A copy changed afterwards fails every check that reads it.
- **The condition `before_after`** (`file`, `before`, `inputs`, `redline`). Workbooks: sheets, defined names and data validations lost; formula cells turned into constants or emptied (rows aligned by their text labels, so inserted and appended rows pass); new error values; cells of declared input ranges changed; `SUM` and `COUNT` recomputed from the cached values; **not computed** (no cached values, or `fullCalcOnLoad`) printed as such and never a pass. Documents: headings lost (a slightly reworded heading is shown, not failed), tables lost, defined terms lost, and with `redline` any change that is not tracked (the document with every tracked change rejected must read as the baseline did).
- **Readers built on Node's own `zlib`**, treating every file as hostile: at most 10,000 entries, a 48 MiB part, 256 MiB inflated per file, 500,000 cells; each entry must inflate to exactly its declared size with a matching CRC-32; an absolute, climbing (`..`), backslash or duplicate entry name refuses the file; no DOCTYPE, so no entity is defined or fetched. A file that does not read gives "could not read" and a failed check, never a pass or a crash.
- **`openmorals eval` builds a seeded office corpus** (99 rows: 46 clean pairs, 30 damaged, 3 not recalculated, 20 malformed or hostile) in memory and reports its false-alarm rate against a threshold of 5% set before measuring; `--guard office` runs it alone; `--json` gains `office`.

### Changed
- The zip and Word readers of 0.27.0's conditions moved to `src/office/` (the same functions, now hardened as above); the CLI loads the `order` command and the office readers only for `order` and `eval`, so no hook process loads them (a test walks the hook's import graph and records what a hook process loads).

### Unchanged
- Every 0.29.0 case row decides the same decision, rule and reason on this build (1,037 guard rows). An order without `before_after` checks, prints and records as in 0.29.0. A check adds nothing to and removes nothing from any hook decision; the release hold reads a failed office check like any failed check.

### Measured
- `eval` office rows: 0 of 46 clean pairs failed (0.0%; threshold 5%), 30 of 30 damaged pairs caught on the expected check, 3 of 3 "not computed", 20 of 20 "could not read", no crash; about 1 ms per pair (p50). The corpus and the checks share an author; the rate is about this corpus, not about files from many programs.
- Removal tests: dropping the formula check turns 6 eval rows and 7 tests red; dropping each other check turns its own rows and tests red; importing the readers into the hook's graph turns both hook-graph tests red; dropping the CRC, name or size rules, the baseline copy's re-hash, or the "not computed" failure turns their tests red.
- A two-condition office order prints 2,366 characters when it passes, 1,964 to 2,261 with one condition failing.

### Not claimed
- Real workbooks and documents from many programs (no real files were used); column insertions in a workbook; formulas other than SUM and COUNT recomputed; headers, footers, comments and formatting in documents; a reviewer's tracked insertion rejected silently under `redline`.

## 0.29.0 (2026-11-25)

Daily guidance for documents, online forms, email and links, in tiers, all off by default: a short always-on block and three skills written only when you choose the `daily` pack, and a once-per-activity note from the hook only when you switch it on in your own file. It is advice only, not checked; it adds no check and changes no decision.

### Added
- **The `daily` pack** ([docs/daily.md](docs/daily.md)): 25 principles, each with one guidance line for the agent. 13 are also checked by an existing guard (`delete`, `document`, `outbound`, `inbound`, `secrets`); 12 are advice only. No rules of its own; its guards are listed at the defaults, so on the defaults it decides exactly as the defaults do. `openmorals packs show daily` lists what checks each line, or that it is advice only.
- **Principles may carry a guidance line** (`guidance:`, at most 300 characters) and say where it goes (`activities:` `always`, `documents`, `forms`, `email-and-links`); both or neither.
- **Tier 0, the `daily` form of the guidance block**: the `always` lines, rendered from the pack, at most 900 characters with its markers. `openmorals init --pack daily` writes it into `CLAUDE.md` (`AGENTS.md`, or `GEMINI.md` for Gemini CLI); `openmorals guidance --daily` writes or refreshes it; `openmorals guidance --remove` takes it out.
- **Three skills**, `openmorals-documents`, `openmorals-forms` and `openmorals-email-and-links`, rendered from the pack into [`skills/`](skills/) and, by `init --pack daily` for Claude Code, into `.claude/skills/`. Each description is at most 160 characters. Each skill's `README.md` is for people: advice only, not checked, and which guard checks which line. A skill folder openmorals did not write is never replaced.
- **The risk catalogue** ([docs/daily-risks.md](docs/daily-risks.md)): 29 information security risks for everyday agent work, with what this release checks for each and by which guard; the same list, as signs to watch for, is the forms and email skills' reference file.
- **First-activity guidance from the Claude Code hook** (`guidance: { first_activity: true }`, user-level file only, off by default): on the first call of an activity in a session that the hook allows, the activity's guidance is added as `additionalContext`; never again in that session, never on an asked or refused call, never when the option is off.

### Unchanged
- **Nothing is written or sent unless you choose it.** A plain `init`, and `init` with any other pack, writes no guidance and no skill. With the option off or absent, the hook's output is byte for byte the 0.28.0 output (16 hook events compared). Every 0.28.0 case row (1,037 guard rows) decides the same decision, rule and reason on this build.

### Measured
- Characters, and tokens estimated as characters / 4: tier 0 779 (about 195 per model call; the design estimate was about 210); descriptions 139 to 150 (about 35 to 38 each; estimate about 40); skill bodies 898 to 1,093 (about 225 to 274, when used); first-activity messages 814 to 1,009 (about 204 to 253, once per activity per session); the risk list 4,114 (about 1,029, only when opened).
- Removal tests: a principle naming a deleted rule is rendered (the rendering test fails); the option on by default (four tests fail); the once-per-session memory, the allowed-only gate, the user-level-only rule, the 900-character bound, the guard against replacing a foreign skill and the pack gate on `init` each fail their own test when removed; a generated file edited by hand fails the staleness test.

### Not claimed
- That an agent follows the guidance; that a host loads the skills or passes `additionalContext` on an allowed call to the model (taken from the hosts' documentation; no live run). Skills and the first-activity note are Claude Code only.

## 0.28.0 (2026-11-25)

The release hold: with a work order named, a file it names does not go out, and an original is not replaced, while the order's last check failed, is missing or is stale. A passing check adds nothing and removes nothing.

### Added
- **The release hold** (guard `hold`, [docs/order.md](docs/order.md#the-release-hold-0280)). With `OPENMORALS_ORDER` set in the hook's own environment, an outward step on a file the order names is asked about (refused unattended; refused and queued for your approval under `defer: true` or unattended on Claude Code) while the order's last check failed (`hold.failed`, naming what failed), there is no check of the order as approved now (`hold.missing`), or the file changed since the last passing check (`hold.changed`). Outward steps are the other guards' own recognition: the outbound guard's send and form tools, its browser tools, the network commands it judges (with `git push` and package publishes read as sending their folder), and the replace and move guards' whole overwrites, which count only for the order's inputs (the originals). Writing an output is never held, so a failed check can be fixed.
- **Failing toward the hold once an order is named**: a named order that is missing, unreadable, invalid or not approved, or an approval store that cannot be read, holds every outward step (`hold.order`); an order edited after approval holds every step on a file either version names; an audit log that cannot be read, or a line naming a check that does not read, counts as no check.
- **`order check` records each named file's SHA-256** (`order_check.items`): inputs, outputs and every file a condition reads. A pass recorded by 0.27.0 has none and counts as stale.
- **A deferred approval of a held send is bound to the file it sends**: it lapses when the file changes, even when the tool names the file only in its arguments.
- Case rows take an `order` key; `cases/hold.cases.yaml` (34 rows: 23 caught, 11 benign).

### Unchanged
- **Nothing changes for anyone who names no order**: the guard returns before reading anything, and `makeWhere` never reads the variable from the process. The 0.27.0 case rows (1003 guard rows) decide the same decision, rule and reason on this build.
- **A pass lowers nothing** (ADR 0013, ADR 0014): with a passing, fresh check every call gets exactly what it gets with no order named, including other guards' asks and refusals; a hold never turns a refusal into an ask.

### Measured
- `openmorals eval`: every row matched; the hold 23/23 caught, 0/11 false alarms.
- Removal tests: dropping the staleness comparison lets a changed file be sent after an old pass (its test and eval row fail); dropping the missing-check, failed-check or unusable-order branch, or the overwrite of inputs, fails their own tests and rows; dropping the deferred approval's file binding fails its test.
- What the agent reads when a call is held: 235 to 276 characters for a failed, missing or changed check, 240 for a missing order, 327 for an invalid one; 195 when it is queued (the deferred ask's own text). The hold calls no model and prints nothing when it does not hold.

### Not claimed
- A step that carries a named file's content without naming the file, an upload by a tool whose name does not say it sends or drives a browser, a push from another folder, or a check older than the last 16 MiB of the audit log (held as missing). The ask counter that would show whether it asks too often is not built; no live agent run.

## 0.27.0 (2026-11-25)

Work orders: say what "done" means before the work, approve it yourself, and check the work against it with code. And two redactor fixes.

### Added
- **`openmorals order new | approve | check`** ([docs/order.md](docs/order.md)). A work order is a YAML file: `kind`, inputs with their SHA-256, outputs, and conditions from a fixed list of 13: `exists` (and file type), `headings` (Markdown, Word), `no_placeholders`, `recipients` and `attachments` (a `.eml` draft; attachments by decoded content hash), `rows` (rows in = kept + dropped, each dropped row with a named reason, optionally each key once), `unique`, `not_null`, `accepted_values`, `relationships`, `freshness` and `total` (a CSV column against a stated control total or a source column, within a tolerance, summed exactly), and `tests` (named acceptance tests that failed before and pass after, read by `tests compare`). Any other key or condition is refused with the allowed list; a file type a reader is not built for is refused by name.
- **`order approve` is yours.** It shows the conditions, refuses an input that does not match its stated hash, asks you to type `yes` (or takes `--yes` outside a terminal) and stores the order's hash and text in `orders/approvals.jsonl` in the config directory. An agent running it is asked by the hook, and refused unattended; the approvals and the templates folder are protected like the rest of the config directory.
- **`order check`** exits 1 on any failure: a missing, invalid or unapproved order, an edit after approval (shown condition by condition as a loosening, a tightening or a change), an input whose content changed, a missing output, a failed condition. It writes one chained record to the audit log with the run id (`--run` or `OPENMORALS_RUN`) and prints, beside every pass, what that pass does not show. Exit 2 when the result could not be recorded.
- **Templates** in `order-templates/<name>.yaml` in the config directory (never from a project): an order naming one carries its conditions and can only add; a template's conditions only grow once an order using it is approved.
- **`tests fail-first --order FILE`** takes the acceptance tests from the `tests` conditions of an order you approved; any other order judges nothing (exit 2).
- **`OPENMORALS_ORDER`** in the hook's environment is written on each audit record as `order`. No decision reads it. `audit --run ID` lists a run's order checks and the orders its records name.

### Fixed
- **Redactor flag pattern**: it had no left boundary, so prose such as "the secret-token detector" was redacted as a `-token` flag. A flag now starts the text or follows whitespace or a shell separator.
- **`password=value` with nothing before the key word** was not redacted (`DB_PASSWORD=` and `--password` were). A key word standing alone before `=` (`password`, `passwd`, `secret`, `token`, `api_key`, `apikey`, `access_key`, `private_key`, `client_secret`) is now redacted, including `token=` in a query string. The colon form (`password: value`) is not, so prose stays readable.

### Unchanged
- **Nothing changes for anyone who writes no order**: the 0.26.0 case rows (989 guard rows) decide the same decision, rule and reason on this build. The new self-protect rows (`order approve`, `order baseline`, the order folders) are the only rows the 0.26.0 build decides differently.

### Measured
- `openmorals eval`: 1055 rows, every row matched; self-protect 134 rows (87/87 caught, 0/47 false alarms).
- Removal tests: dropping the hash comparison lets an order edited after approval check clean (3 tests fail); dropping the input hash check, the template growth check, or any one of the 13 conditions fails its own test.
- What reaches the agent when it runs `order check` itself: 1,419 characters for the worked code order passing (3 conditions), 1,194 with one failing; 3,960 for a 13-condition office order passing, 3,512 with three failing.

### Not claimed
- A pass does not show the work is right: only the listed conditions were checked. No reader yet for headings in PDF or slides, or columns in a workbook; no hold on sending while a check fails; no live agent run.

## 0.26.0 (2026-11-25)

Two packs, off unless you choose them: `information-security` and `outward-actions`. Each asks before a few command and file-edit shapes, names the guards that check its other principles, says which principles are advice only, and says it is not a certification, an audit or legal advice.

### Added
- **`packs/information-security.yaml`**: asks before switching off certificate checks (`curl -k`, `wget --no-check-certificate`, `http.sslVerify false`, `NODE_TLS_REJECT_UNAUTHORIZED=0` and others), world-writable modes (`chmod 777`, `o+w`), another package registry (`--registry`, `--index-url`, `--trusted-host`, `npm config set registry`), installing from a URL or repository, a download run straight in a shell (`| bash -s`, `sh -c "$(curl ...)"`, `bash <(curl ...)`), and edits, deletes or moves of CI pipeline files. 7 rules, all ask. 10 principles checked (5 by its rules, 5 by the `secrets`, `self-protect`, `taint`, `inbound` and `outbound` guards), 8 advice only (injection flaws, access control, design, secrets or certificate checks inside code, unpinned actions, logging, error handling). Details: [docs/packs/information-security.md](docs/packs/information-security.md).
- **`packs/outward-actions.yaml`**: asks before publishing (`npm publish`, `cargo publish`, `twine upload`, `docker push`, `gh release create` and others; not `--dry-run`), messaging people (`mail`, `sendmail`, `git send-email`, `gh pr create`/`comment`/`merge`, chat and SMS webhooks), starting paid cloud machines or moving money (`aws ec2 run-instances`, `gcloud compute instances create`, `az vm create`, `stripe refunds create` and others), stopping services or the machine (`kill -9 -1`, `killall`, `pkill`, `systemctl stop`, `launchctl bootout`, `crontab -r`, `shutdown`), and making history rewrites permanent (`bfg`, `git reflog expire --expire=now`, `git gc --prune=now`). 5 rules, all ask. 7 principles checked (by its rules and the `destructive`, `online-delete` and `outbound` guards), 5 advice only. There is no pack called "do no harm". Details: [docs/packs/outward-actions.md](docs/packs/outward-actions.md).
- **Per-pack scores in `openmorals eval`**: one line per shipped pack (rows judged under it, caught, false alarms, wrong rule, times) after the table, and `packs` in `--json`. The rows are the same ones counted in the guard lines; the total is unchanged.
- Case tables `cases/information-security.cases.yaml` (79 rows) and `cases/outward-actions.cases.yaml` (72 rows): rows only each rule catches, benign rows for each rule, rows showing the mapped guards still deciding, and rows with the pack off.

### Unchanged
- **Nothing changes for anyone who has not chosen one of these packs**: the 0.25.0 case rows (838 guard rows) decide the same decision, rule and reason on this build, the defaults hold no rule, and an empty config folder resolves to no pack rule. The guards each pack lists are at the built-in defaults.

### Measured
- `openmorals eval`: 1041 rows, every row matched; information-security 44/44 caught, 0/28 false alarms; outward-actions 40/40, 0/27.
- Removal test: deleting any one of the 12 rules makes exactly its own catching rows fail (3 to 10 per rule).
- What each pack costs: laid over the benign rows of every other case file as a project file, information-security asks on 2 of 308 and outward-actions on 3 of 311; with the default user settings only `npm publish` (outward-actions) is a new ask among them. The others are rows whose own user file switched a guard to allow, which the pack, as a project file, raises back to the default.

### Not claimed
- Neither pack is a certification, an audit or legal advice, or shows conformity with OWASP, the NIST SSDF or any standard or law. They read command lines and paths: what code does, what is inside a written file, and actions done by a script the agent runs are not seen. How often they ask in real sessions is not measured. Nothing run against a live agent.

## 0.25.0 (2026-11-25)

Packs may say which of their principles the engine checks and which are advice only, and carry a disclaimer. And under `guards.replace.steer: keep`, a stricter document setting no longer gives a weaker answer to emptying a file.

### Added
- **`principles:`** in a pack (or any bylaws file): a list of `{ id, source, checked_by: [...] }` or `{ id, source, advisory: "..." }`. `checked_by` names rules of the same file, or guards listed under its `guards:` (and not switched off there), that check the principle. `advisory` is text for you: **an advice-only principle is not checked, and the agent is not held to it.** `source` (an http or https address) is optional.
- **`disclaimer:`**: one text for you (at most 2000 characters, no control characters), for what the pack does not do. The disclaimer texts of the files in force are written into the audit log once per session (field `disclaimers` on the first record) and again only when they change.
- **The loader refuses**, at every load (`validate`, `init --pack`, `packs show`, the hook, `eval` rows): a principle with neither `checked_by` nor `advisory`; one with both (split it); a `checked_by` id that is not a rule of the file or a guard listed under its `guards:`; a guard the file switches off (decision `allow`, `inbound` disabled, budget limits 0, `replace` not `keep`); an empty `checked_by`, an unknown key, a duplicate id, a `source` that is not a web address; a `disclaimer` that is not text, is empty, is over 2000 characters or holds control characters. Each error names the principle and the setting.
- **`openmorals packs show NAME`** and **`packs show --file FILE`**: checks a pack the way the hook reads it and prints the checked principles with the rules or guards that check them, the principles that are "advice only, not checked", and the disclaimer. An invalid pack exits 1 with the reasons.

### Changed
- **Emptying under `guards.replace.steer: keep`.** In 0.24.0 an emptying write (`: > f`, `sort f > f`, a Write with empty content) was refused toward `openmorals trash --copy` when `guards.document.decision` was `allow`, but only asked (`document.empty`) under `ask`, the default: the stricter setting gave the weaker answer. Now the replace guard leaves an emptying to the document guard only when that guard refuses it (`deny`); under `allow` and `ask` it is refused until a copy is kept, and then the document setting decides as with `keep` off (allow passes, ask asks, deny refuses). With `guards.replace` absent or `off` nothing changes.
- **A file whose only fault is its principles or disclaimer** is invalid (every call asks, `bylaws.invalid`, and `validate` says so), but its other settings stay in force, held at least as strict as the defaults or the user-level file it is read over; the reason says "enforcing its other settings and asking". Any other fault still falls back as before ("using the defaults and asking").
- `openmorals init --pack NAME` refuses a pack that does not load. `stringifyBylaws` writes the resolved disclaimers as one `disclaimer` key, so a written policy reads back.

### Unchanged
- **Principles change no decision and reach no agent**: every case row decides the same (decision, rule and reason) with principles and a disclaimer added to its file, and the hook's answer and the `guidance` block are byte for byte the same. No shipped pack gains principles or a disclaimer; each loads as before.
- The 0.24.0 case rows score the same on this build except the three that pinned the emptying inversion (`ask document.empty`, now `deny replace.keep`); 4 new rows in `replace.cases.yaml`, 5 in `document.cases.yaml`.

### Not claimed
- A checked principle is checked only as far as its rules and guards reach: what they cannot see (a script the agent runs, text the agent writes to a person) is not checked. That a person reads the "advice only" list is not measured. Nothing run against a live agent.

## 0.24.0 (2026-11-25)

A setting, off by default, that keeps a copy before a file is replaced whole in a folder without git.

### Added
- **`guards.replace.steer: keep`** (off by default; the section is absent from the defaults). With it, a call that would replace the whole content of an existing, non-empty file with no `.git` folder or file above it is refused once (`replace.keep`), naming `openmorals trash --copy <path>`: a copy goes to the project trash and the file stays. The same call then passes. Judged: the Write tool (any host's whole-file write), a `>`/`>|` redirect from a command with output, `tee` without `-a`, `sed -i` and `perl -i` without a backup suffix. Never judged: the Edit tool, patches' updates, appends, new and empty files. Emptying stays the document guard's, a secret file the secrets guard's, `mv`/`cp` onto a file the delete guard's.
- **Off by default, and why**: it costs one refused call and one extra command for each file replaced whole in a folder without git (counted: 20 different files, 40 extra calls and about 8,600 characters the agent reads), and no rate of such replacements in a real session exists. Your user-level file or a project file may switch it on; a project file may not switch it off (named as a loosening).
- **When a copy counts**: the file's sha256 equals a live kept copy in the project's undo log (still in its slot), or content the session itself wrote whole (noted after a Write, redirect or `tee` that ran; never after an Edit or `sed -i`). A copy of an older version does not count: change the file by hand and the next replacement is refused again. Both records are under openmorals' own folders, which the agent cannot write without an ask.
- **`replace.ask`** where the trash cannot take a copy (outside the project, another volume, openmorals' folders, a project at home, a link out of the project), the file is over 64 MiB to hash or unreadable, or the undo log cannot be read; deferrable like `delete.ask`; deny when `guards.delete.decision` is deny.
- **`openmorals trash --copy <file>...`**: copies each file into the trash and leaves it; `restore` puts the copy back once the file is out of the way (it refuses, naming `openmorals trash <path>`, while the file is there); `purge` deletes it for good like any item; `trash --list` marks `(kept copy)`; the line at your next message counts kept copies apart.
- `cases/replace.cases.yaml`: 57 rows (29 caught, 28 that must pass, 11 of them the caught rows with the default). Four boundary rows with `keep` on in the delete, document and secrets case files.

### Unchanged
- With the default, every decision is as in 0.23.0: the 0.23.0 rows score the same on this build (every row matched), and a test finds the same decision, rule and reason for every row without `keep` with and without the new guard. Two content-carry tests (0.14.0, 0.15.0) now leave out the replace rows, as they leave out the document rows: both guards read a Write's content by design.

### Not claimed
- Nothing run against a live agent. A file inside a git folder that git does not track or ignores passes (no git is run). Programs, image tools in place, `sort -o`, `curl -o` and targets built at run time are not seen. On a host with no post-tool event, the session's own output is not noted, so each rewrite of it is refused once more.

## 0.23.0 (2026-11-25)

A second list, `protect`, names sites whose look-alikes are refused without letting anything through to the site itself. `sites` keeps its meaning.

### Added
- **`protect`** (top level): sites whose look-alikes are judged exactly as look-alikes of a `sites` entry are: opening one asks (`outbound.lookalike`), typing a password or code into one is refused (`outbound.credential-lookalike`, which your user-level file can make ask). It lets nothing through: a password typed into a `protect` site itself still asks, and a message to an address there is judged as to any other. Same host names as `sites`, at most 200 per file, and not a public suffix (`co.uk`). Empty by default.
- **Longer is tighter.** Your user-level file and a project file may both add names; the list in force is the union. A project cannot remove a name, and adding one is not a loosening, so it is never reported as one. A team that commits `protect: [its-portal.example]` gives every member the refusal on look-alikes of its own portal.
- **Your own word wins over a project's list.** A site in your `sites` or your own `protect`, a name under one, or another name under the same registrable domain, is never judged a look-alike of a name a project added. Each name a project adds is judged on its own, so listing a look-alike's own name cannot hide it from your list or from another added name.
- **Reasons name the list** ("looks like mybank.example from your protect list", "from the project file's protect list"); the wording for `sites` is unchanged. `openmorals validate` prints a `protected from look-alikes:` line naming each site and the file it came from, when `protect` is used.
- Case rows may carry a `project` block (a project file read over the row's own bylaws, merged by the same code as a real folder). 15 new outbound rows (8 caught, 7 that must pass).

### Unchanged
- `sites` is still the user-level exemption: a password, code or recipient there goes without an ask; a project file's `sites` is still ignored and named in the reason. Everything in `sites` is still protected. Every earlier `eval` row decides as in 0.22.0.

### Not claimed
- Nothing run against a live agent. A project can make a site you have not listed a "look-alike" of a name it chose, turning an ask into a refusal (it could already refuse more with `guards.outbound.credential: deny` or its own rules); list the site in your own `protect` to stop that. No fire rate on real browsing is measured.

## 0.22.0 (2026-11-25)

Moves and overwrites that lose a file are now deletes, and documents go to the trash like every other file.

### Added
- **A move into a temp folder is a delete of what is moved** (`mv`, `move`, `Move-Item`), for every file and folder, under the existing `guards.delete` settings: refused with `openmorals trash <path>` named where the trash can take it, asked where it cannot or under `steer: ask`, refused when the path is built at run time. Temp folders: macOS `/tmp`, `/var/tmp`, `/var/folders` (also under `/private`); Linux `/tmp`, `/var/tmp`, `/dev/shm`; Windows `\Windows\Temp` and `\AppData\Local\Temp`; destinations written with `$TMPDIR`, `$TMP`, `$TEMP`, `%TEMP%`, `%TMP%`, `$env:TEMP`, `$env:TMP`; each only when outside the project folder. A copy into a temp folder, and a move of a file already in one, are not deletes.
- **`mv` or `cp` onto an existing file is a delete of the file it replaces** (also `copy`, `Copy-Item`, `install`, `ditto`, `Move-Item -Force`, `git mv -f`; the destination, or the file of the same name in a destination folder). The refusal names `openmorals trash <old file>` first, then the same move. `-n`/`--no-clobber`/`--update=none` (the last of `-f`, `-i`, `-n` decides), a kept backup (`-b`, `--backup`, `-S`), `Move-Item` without `-Force`, `git mv` without `-f` and renames stay silent.
- **A command that empties its own input is an emptying** (`document.empty`, for every file): `sort f > f`, `cat f > f`, `grep x f > f`, `jq . f > f`, `cat f | sort > f`, `cmd < f > f`. The shell empties `f` before the command reads it. `sort f > g` and `sort f -o f` stay silent. Covered: a known filter (cat, sort, uniq, grep, sed, awk, jq, head, tail, cut, wc and others) naming the file, in the same command or earlier in the same pipeline, and any command reading it as standard input.
- **The trash line at your next message names the newest three items**, then "and N more"; still one line, still only for the person.

### Changed (by design; earlier behaviour and rows)
- **A document inside the project is steered to the trash like any file.** `rm notes.md`, `unlink`, `git rm`, `Remove-Item`, a patch's `Delete File` and an MCP delete of a document the trash can take are refused with `openmorals trash <path>` named (`delete.trash`); since 0.18.0 they asked (`document.delete`). A document the trash cannot take (outside the project, another volume, a secret name) and every document delete under `steer: ask` keep the `document.delete` ask. This removes an inversion: document decision `allow` / `ask` / `deny` used to give refuse / ask / refuse, so the stricter `ask` gave the weaker outcome; it now gives refuse / refuse / refuse, and a test checks that for every pair of document and delete settings the stricter one never gives a lower-ranked decision. A document delete or temp move asked about takes the stricter of `guards.document.decision` and `guards.delete.decision`.
- **With the delete guard on, a document replaced by `mv`/`cp` or moved into a temp folder is the delete guard's** (refused toward the trash, or `delete.ask`); it was `document.unknown` / `document.delete`. A document moved out of the project anywhere else keeps its `document.delete` ask; a non-document moved there stays silent (the file is kept).
- **`sort notes.txt > notes.txt` is `document.empty`**, not `document.unknown`.
- **A held move or copy is bound to the file it would replace** inside the destination folder, not to the folder: a new file elsewhere in a temp folder no longer voids an approval, and a change to the file to be replaced still does.
- **Eight earlier case rows** in `cases/document.cases.yaml` now set `guards.delete.decision: allow`, so they keep testing the document guard's own ask; their decision, rule and reason are unchanged: `rm docs/guide.md`, `unlink notes.txt`, `git rm -q docs/guide.md`, `mv docs/guide.md /tmp/old-guide.md`, `mv draft.md docs/guide.md`, `Remove-Item notes.md`, `cd docs && rm guide.md`, `cd docs; unlink guide.md`. With the defaults the same eight are refused toward the trash; those rows are in `cases/delete.cases.yaml`. Tests that held `rm notes.md` as their example ask (`test/defer.test.ts`) now set `steer: ask`.
- 78 new case rows (56 delete, 22 document).

### Not claimed
- Nothing run against a live agent. Still not seen: a file replaced whole by the Write tool or by `> file` with content, in-place rewriters (`sed -i`), deletes inside programs the agent runs, `cp -r` over files inside an existing folder, a destination openmorals cannot resolve (including CI variables such as `$RUNNER_TEMP`), a command that empties its own input when it is not a known filter. The rate of moves and overwrites in a live session is unmeasured.

## 0.21.1 (2026-11-25)

### Fixed
- **A delete after a change of folder in the same call was not seen.** `cd sub && rm c.py`, `(cd sub && rm c.py)`, `pushd sub && rm c.py`, `Set-Location sub; Remove-Item c.py`, `cd sub & del c.py`, `git -C sub rm c.py` and `bash -c 'cd sub && rm c.py'` were allowed when no `c.py` was in the working folder: the path was read from the working folder. Now the target is read from the folder the call moves to (the folders before the `cd` stay candidates, since a `cd` may sit in a subshell), and the trash command names `sub/c.py`. After a folder openmorals cannot know (`cd "$D"`, `cd -`, `cd $(...)`, a `popd` with nothing pushed), a relative delete is refused (`delete.blind`). The document guard had the same gap (`cd docs && rm notes.md` was allowed) and follows the same folders; after an unknown folder it asks about a relative document delete (`document.unknown`).
- **`git rm -r <folder>`** was not seen by any guard; the delete guard now judges the folder (refused with `openmorals trash <folder> && git rm -r -q --cached <folder>` named, or asked where the trash cannot take it).
- **A held delete after a `cd` is bound to the file it deletes.** The deferred ask bound such a call to its exact arguments but read its file words from the working folder only, so a change to `docs/notes.md` after approving `cd docs && rm notes.md` did not void the approval. The binding now also reads the words from the folder the call moves to.
- 30 new case rows (28 delete, 2 document); every earlier row decides as in 0.21.0.

### Not claimed
- Nothing run against a live agent. A file the same call creates before deleting it, and a non-document moved out of the project, are still not asked about.

## 0.21.0 (2026-11-25)

A new built-in guard, `delete`, covers a plain delete of any existing file, not only documents. Where the project trash can take the file, the call is refused and the reason names `openmorals trash <path>`, so the agent can carry on at once and nothing is gone; where it cannot, the call asks, and is held for later approval when nobody can answer. A path built at run time is refused. `openmorals purge`, the only real delete, now lists what it deletes and asks. This is a refusal with the trash command named: whether a live agent then uses the trash has not been observed.

### Added
- **The `delete` guard** (`src/guards/delete.ts`). `delete.trash` (deny): every file a plain `rm`, `unlink`, `del`, `erase`, `Remove-Item`, `git rm` (not `--cached`), patch `Delete File` or MCP delete names exists, is inside the project folder (the folder of the nearest `openmorals.yaml`, else the working folder), on its volume, not in openmorals' own folders and not a secret file, and the project folder is not the home folder or above: the reason names the trash command (for `git rm`, with `git rm -q --cached` after it). `delete.ask` (ask): a file the trash cannot take (outside the project, another volume, openmorals' own folders, a project rooted at home, unreadable, a secret file such as `.env`, which the trash would keep on disk); held under deferred ask. `delete.blind` (deny): a target built at run time (`$f`, `` `...` ``, `$(...)`, `%VAR%`, `$env:VAR`). No extension, folder or "made in this session" is exempt. `rm -r`, `rm -f` and wildcards stay with the destructive guard; documents keep the document guard's ask.
- **Settings**: `guards.delete.decision` (allow/ask/deny, default ask; allow switches the guard off) and `guards.delete.steer` (trash/ask, default trash; ask asks about every delete). A project file may only tighten (`trash` over `ask`, a higher decision).
- **A line at your next message**: on Claude Code, Codex and Gemini CLI, the prompt hook adds a line only the person sees when items went into the project trash since the session began, once per new count. Not shown on opencode or OpenClaw (no such field).
- **`openmorals purge <id>...`**: delete one named trashed item for good, for example a trashed `.env`.
- Case rows `cases/delete.cases.yaml` (57: 42 ask or deny, 15 allow); `test/delete.test.ts`; a row's `files` may give a `volume`.

### Changed
- **`openmorals purge` lists what it deletes and asks.** It prints every item (id, time, size, path) first; in a terminal it asks you to type `yes`; with no terminal it deletes nothing without `--yes`; it deletes exactly the items it listed. Before, it printed only a count and never asked.
- One earlier case row, `rm server.log` in `cases/document.cases.yaml` ("not a document"), now sets `guards.delete.decision: allow` so it still tests the document guard alone; its decision, rule and reason are unchanged. With the defaults the same delete is refused (`delete.trash`), the change this release makes. Every other earlier row decides exactly as in 0.20.0 (a test runs each with and without the new guard).

### Not claimed
- That a live agent runs the trash command after the refusal, rather than deleting the file another way; that the line at the next message reaches the person (both unobserved: nothing here has been run against a live agent).
- Deletes inside a program the agent runs, `cd dir && rm file`, `git rm -r` of a folder, and every host with no check point.
- A fire rate: neither repository history available here has a deleted file.

## 0.20.0 (2026-11-25)

A new built-in guard, `outbound`, checks where an agent's action sends data: the site a browser form is on, the recipients of a message, the target of a link, and names that look like phishing. It decides from the action itself and, inside a hook, from hashes of what the session has already seen. No network call, no DNS lookup, no model. Nothing is published.

### Added
- **The `outbound` guard** (`src/outbound/`). Two combinations **deny**: a password, passcode or one-time code typed into a site that looks like one in your `sites` list (`outbound.credential-lookalike`: the same UTS #39 skeleton, or one or two characters off by the name's length), and a one-time code seen in a tool's output in the last `code_minutes` typed into a site that message did not name (`outbound.code-relay`). Both reasons say openmorals stops only the agent and you can type it yourself. Everything else **asks**: `outbound.credential` (a password or code on a site not in `sites`, an unknown page, or one of your sites on a page opened from a link in untrusted output; a password or token in a URL), `outbound.private-data` (a card number, IBAN, national ID or health record to a site not listed for its class, in a form, a URL or a message), `outbound.lookalike` (look-alikes of your sites, mixed-script names, names posing as ASCII in other letters, `name@host` URLs), `outbound.ip-host` (a public IP as the host; loopback never asks), `outbound.dangerous-target` (`javascript:`, `data:`, `vbscript:` URLs, `file:` in a browser tool, executable and macro-document downloads, the link-local metadata address, a private address from untrusted output), `outbound.link-mismatch` (a link whose shown text named another site), `outbound.recipient` (a blind copy, a new outside recipient on a reply or forward, an address seen only inside untrusted output). Guide: [docs/outbound.md](docs/outbound.md).
- **Once per site and field.** On Claude Code an ask is not repeated for the same rule, site and field in a session after you approved it in the host's own dialog (the call ran after the ask). Text in the conversation never counts as an approval; a deny is never remembered.
- **Settings**: `guards.outbound.credential`, `lookalike`, `ip_host`, `dangerous_target`, `link_mismatch`, `recipient` (allow/ask/deny), `lookalike_credential` and `code_relay` (ask or deny; `allow` is refused), `code_minutes` (1 to 60, default 10); top-level `sites` and `data_classes` (user-level file only). A project file may only tighten; its `sites` and `data_classes` are ignored and named ([ADR 0010](docs/adr/0010-the-user-file-is-a-floor.md)).
- **What the session keeps** for it, in the session file: salted SHA-256 hashes (16 hex characters) of hosts, addresses and codes seen in untrusted results or typed by you, approved keys, and the host of the page a browser tool is on. Codes are dropped after `code_minutes`. Never page text, form values or secrets. The post-tool hook every adapter calls records them; the prompt hook records what you typed (not a prompt with hidden instructions).
- **Bundled data**: the Public Suffix List (VERSION 2026-11-24_18-53-27_UTC, 10,477 rules, MPL-2.0) and the 1,814 Unicode confusables whose look-alike is ASCII (`confusables.txt` of 2026-08-06, Unicode License v3); `NOTICE` carries both. `scripts/update-outbound-data.mjs` regenerates them from local copies. Package: about 83 KB more packed, 262 KB unpacked (the data is 145 KB of it).
- `other` actions carry `leaves` (each input value with the keys leading to it), in memory only; `Where.outbound` carries the session memory to the guards. 72 rows in `cases/outbound.cases.yaml` (42 ask or deny, 30 ordinary actions that must pass), 26 tests in `test/outbound.test.ts`.

### Changed
- `decide` asks on the outbound signals for fetches, browser and form tools, send tools and URLs in network commands; every earlier `eval` row decides exactly as before (decision, rule and reason, tested with and without the guard).
- The `init` template carries the `guards.outbound` section and the `sites` and `data_classes` settings as comments.

### What it cannot tell you
- **The page behind a link**, a redirect (until a browser tool reports the page it landed on), what a name resolves to, free-text private facts with no checksum shape, and a form a program the agent writes posts.
- **Field labels written by the model.** A browser tool call's field description is the model's; the browser's own snapshot is read when there is one, else only the value's shape (a token, a recent code).
- **No brand list ships.** With no `sites`, look-alikes are caught only when a name mixes scripts or poses as ASCII in other letters.
- **An invalid user-level file** falls back to the defaults and asks: your `sites` list is not read then, so a password typed into a look-alike asks instead of being denied (never allowed).
- Once-per-site-and-field is kept on Claude Code only; the other four hosts read the same session memory but ask every time (Codex denies). The browser tools' result shapes (`Page URL:` line, snapshot lines) come from documentation; nothing here has been run against a live agent.
- Measured over every distinct URL in this repository's history (189 URLs, 567 actions): 21 fires, all fixtures written to be caught, 0 false alarms; the rate on an agent's daily browsing, mail and forms is not measured.

## 0.19.0 (2026-11-25)

On Claude Code, a deletion or a large removal from a document can now be held for you instead of only refused: the action does not run, it is queued, the agent is told to carry on with other work, and you approve that exact action later, once. It happens when nobody can answer (`--unattended`, where these asks were denies already) and, in sessions you watch, only when you set `defer: true`. With neither, nothing is decided differently. No model is called. Nothing is published.

### Added
- **Deferred asks** (`src/defer/`). A call whose verdict is `ask` and whose every objection is `destructive.*`, `online-delete.*`, `adapter.mcp-delete` or `document.delete|empty|shrink|heading|unknown` is denied with a short reason (199 characters measured for a document delete: "not run; queued as D-XXXX for the user's approval. Carry on with other work; do not retry it or get the same result another way. You will be told if it is approved.") and queued in `deferred/` in the config directory. A retry of the same call is held under the same id. A call with any other objection, a `deny`, an invalid bylaws file or a call with no session id is never held. Guide: [docs/deferred-asks.md](docs/deferred-asks.md).
- **The approval code** (`D-XXXX-XXXXXX`) is shown only in Claude Code's `systemMessage` (the line for the person) and stored only as a SHA-256 hash. Approve by typing `approve <code>` in the chat (the `UserPromptSubmit` hook, which then tells the agent in one line that it may retry), with `openmorals approve <code>` anywhere, or with `openmorals approve <id>` in a terminal after typing the id again. `openmorals refuse <id>` says no; `openmorals pending [--all] [--json]` lists what is held, never a code. On your next message in the session, one line says what still waits.
- **What an approval is bound to**: the session, the project folder, the tool, a salted SHA-256 of the exact arguments (Bash and PowerShell `description` left out) and the kind, size and modified time of every existing file the call names (a wildcard binds its folder). Used once (an exclusive file create), lapses 24 hours after the hold; a changed file voids it. Anything else falls back to the normal verdict, never to allow, and openmorals still prints no allow decision (ADR 0009). The call let through is recorded as `defer.granted`.
- **Setting** `defer` (top level, boolean, absent by default). A project file can switch it on, never off ([ADR 0010](docs/adr/0010-the-user-file-is-a-floor.md)).
- 25 tests in `test/defer.test.ts`; 15 rows in `cases/self-protect.cases.yaml`.

### Changed
- **Self-protect** asks when the agent runs `openmorals approve`, `release` or `accept` ("grants what only the person may grant; an agent cannot approve its own request"), and now recognises any openmorals subcommand started through `node`, `bun`, `deno`, `tsx` or `ts-node` with the package's built entry (`.../openmorals/dist/src/cli.js`) or `node_modules/.bin/openmorals`; before, `node .../cli.js init` was not asked about. More asks only.
- Under `--unattended`, a held call is still a deny with the guard's rule id, but its reason is the short held line above instead of the guard's reason with "[unattended: ...]"; the guard's reason is in the request file and `pending`. Unattended runs now write request files under the config directory.
- The `init` template carries the `defer` setting as a comment. ADR 0014 gains an addendum: statement 3 (approvals only through channels the agent cannot type into) is now held by tests.

### What it cannot tell you
- **A program the agent writes and runs can approve anything**: it runs as you and can write the queue files, as it can edit your bylaws. There is no signature on them; a key on the same machine would be readable too. An OS sandbox that keeps the config directory read-only is the answer.
- Claude Code only. Codex, Gemini CLI, opencode and OpenClaw keep the 0.18.0 verdicts (ask, or deny unattended).
- That Claude Code shows `systemMessage` on `PreToolUse` to you and not to the model is from its hooks reference, not checked in a live session. Nothing here has been run against a live agent.
- The loop detector still counts held calls: a fourth identical retry with nothing written in between draws `loop.repeat`, and then the call is neither held nor let through on an approval.
- No desktop notification and no network call: the only notices are the line in the session and `pending`.

## 0.18.0 (2026-11-25)

A new built-in guard, `document`, asks you before an agent deletes a document, empties a file, cuts a large share of a document or removes one of its headings, and asks when it cannot tell. It is on by default at `ask`: you decide in the host's own prompt. No model is called. Nothing is published.

### Added
- **The `document` guard** (`src/guards/document.ts`). A document is a file whose extension is in `guards.document.extensions` (prose and office formats: `md`, `txt`, `rst`, `adoc`, `org`, `tex`, `docx`, `odt`, `pdf`, `xlsx`, `pptx` and the rest) and that no `guards.document.exclude` glob covers (`node_modules`, `vendor`, `dist`, `build`, `target`, `coverage`, `.git`, `.venv`). Rule ids: `document.delete` (`rm`, `unlink`, `del`, `Remove-Item`, `git rm`, a patch's Delete File, a move out of the project folder), `document.empty` (any existing file left empty, by a write, an edit, `> file`, `cp /dev/null`, `Clear-Content`), `document.shrink` (more than `shrink_percent`, default 25, of a document's size removed, and at least `min_removed_bytes`, default 512), `document.heading` (fewer headings after the write: Markdown outside code fences and front matter, reStructuredText, AsciiDoc, Org, LaTeX), `document.unknown` (a write onto an existing document it cannot judge: no new content, the text replaced not given, text over 256 KB, a shell redirect, heredoc, `cp` or `mv` over it) and `document.unreadable` (the file cannot be read). Appends and new files are never asked about. When it stops a delete, the reason names `openmorals trash`. Guide: [docs/architecture/guards.md](docs/architecture/guards.md#document-0180).
- **Settings** `guards.document.decision`, `shrink_percent`, `min_removed_bytes`, `extensions`, `exclude`, in the defaults and the `init` template. A project file may raise the decision, lower the share and the byte floor, add extensions and drop exclusions; anything looser is ignored and noted ([ADR 0010](docs/adr/0010-the-user-file-is-a-floor.md)).
- **Writes carry `change`**: whether the content is the whole new file, which text each edit replaces (and whether every occurrence), a patch's removed lines, or a delete, from the fields each host documents (Claude Code `Write`/`Edit`/`MultiEdit`, Gemini CLI `write_file`/`replace` with `allow_multiple`, opencode `write`/`edit` with `replaceAll`, OpenClaw `write`, every host's `apply_patch`). It stays in memory: the session history and the audit line keep the tool and path only. The table per host: [docs/adapters.md](docs/adapters.md#document-guard-what-each-hosts-write-tools-give-it-0180).
- `Where.readFile` (default `probeFile`: one `stat`, and the text only when asked, at most the limit) so callers and case rows give the files on disk; case rows take a `files` key, and a row never reads the machine's disk. `countHeadings`, `defaultDocumentBylaws`, `destructiveCommandHit` and the rest in [API.md](API.md).
- 50 rows in `cases/document.cases.yaml`, scored by `openmorals eval` (31 ask, 19 allow); the other four hosts' write tools and the over-cap cases in `test/document.test.ts`.

### Changed
- `decide` reads the file system for a write and for the paths a delete, move, copy or redirect names (a `stat` each; the text of a document, at most 256 KB, only where headings or a replace-all count need it). It never writes.
- `> file`, `cp /dev/null file` and `mv file /tmp/` were listed as known evasions of the destructive guard; on an existing file (a document, for the move) the document guard now asks.
- A delete the destructive guard already asks about (`rm -f`, `rm -r`, wildcards, `find -delete`, `git clean`, `truncate`, `shred`) is left to it, so you are asked once. With `destructive: allow` the document guard still asks on a document delete.
- The digest of the default bylaws in the audit log changes, because the defaults now hold `guards.document`.

### What it cannot tell you
- It judges the tool calls the host sends it. A document changed by a program the agent runs (a script, `sed -i`, `perl -i`, a build step), a path built at run time, `git rm -r` of a folder and files outside the extension list are not seen; on a host with no check point nothing is.
- Where a host's tool names only the file (OpenClaw `edit`, opencode V2 `permission.evaluate`, a patch's Move to target, an MCP tool's path argument), an existing document asks whatever the edit. On opencode V2 that is every edit of an existing document.
- From a patch it counts headings on the removed and added lines alone, so a `#` line inside a code block counts there.
- Its ask rate was measured only by replaying commit histories (this repository: 75 commits, 1 fire, a real heading removal), not on agent sessions. Holding the change while the agent carries on with other work is not built yet ([ROADMAP.md](ROADMAP.md)).
- Nothing here has been run against a live agent.

## 0.17.0 (2026-11-25)

Two pieces for your own gate and your own sandbox. `openmorals tests fail-first` runs a change's new and changed tests against the code before the change and says, per test, whether it fails there and why. `sandbox.write.protected_paths` keeps the tests that judge the work read-only inside `openmorals sandbox run`. Both are off until you set them in your user-level files; with neither set nothing is decided differently. No model is called. Nothing is published.

### Added
- **`openmorals tests fail-first --base REV [--head REV] [--expect-red TEST]...`**: in temporary shared local clones it runs the base commit with the change's added and changed test files on top, then the head, then the base as it was (to learn which tests are new), with your test command, and reports per test: fails on base by assertion, red for the wrong reason (an error such as a missing function or module, or a file that did not load), cannot tell, or passes on base. Only tests you name with `--expect-red` can fail the check (exit 1: passes or is skipped on base, did not run there, not found, or not passing at head); every other new test that passes on base is a pointer line, because refactor and characterisation tests pass on base by design. Exit 2 when nothing was judged, 3 when no test command is set, 64 on a usage error, 128 + n on a signal. Guide: [docs/tests-fail-first.md](docs/tests-fail-first.md).
- **The test command comes from `tests.yaml` in your config directory only** (`fail_first: { command, timeout_s }`), never from the project, its package scripts or the change. The change's test files reach it as `"$@"` (never pasted into the command text) and the report path as `$OPENMORALS_REPORT`. The config directory is under the self-protect guard.
- **Safety of running**: each run is bounded (`--timeout`, else `timeout_s`, else 300 s) and runs in its own process group, which is killed on a timeout or signal and after every run; the temporary folder is removed on every exit a process can catch (pass, failure, error, timeout, SIGINT, SIGTERM, SIGHUP); nothing is written into your working tree, index or `.git`; git runs with no hooks, no fsmonitor and no network transport; credential-named, `GIT_*` and `NODE_TEST_CONTEXT` variables are not passed to your command. It executes project code: run it on a gate machine or in a sandbox, never from a hook. Not on Windows yet (exit 2).
- **`sandbox.write.protected_paths`** in the user-level bylaws: path globs from the project root, or `test-lock` for the paths that pack protects by rule, kept read-only inside `openmorals sandbox run`. On macOS each pattern becomes a Seatbelt regex, and each folder between the root and a path found now cannot be renamed or removed (measured with a smoke test: new files, overwrites, a `python3` write, `rm -rf`, a new snapshot and a parent rename denied; other writes allowed). On Linux only the paths found when the plan is made are bound read-only (not run on Linux); the srt settings carry the found paths; on Windows it is plan text only. The plan's notes say which, and list protected files with another hard link. Guide: [docs/sandbox.md](docs/sandbox.md#protected-paths-sandboxwriteprotected_paths-0170).
- Report readers: a failing test may carry `failure` (`assertion`, `error` or `unknown`, with the evidence) and a report may list `loadErrors` (files or packages that failed as a whole). `ASSERTION_MARKERS`, `ERROR_MARKERS`, `classifyFailureText`, `judgeFailFirst`, `failFirstCommand`, `findProtectedPaths`, `expandProtectedPaths`, `globToSeatbeltRegex`, `TEST_LOCK_PROTECTED_GLOBS` and the rest in the package API ([API.md](API.md)).

### Changed
- The XML reader keeps each element's text (at most 16,384 characters), so a JUnit failure's body can be read. `tests compare` decides exactly as before: a report holding only files that did not load is still unreadable there.
- A project file's `sandbox.write.protected_paths` is replaced by the user-level value and reported as a loosening note (user-level only, [ADR 0010](docs/adr/0010-the-user-file-is-a-floor.md)); a pack or team file that lists fewer entries than its baseline is reported as looser.
- The `test-lock` pack's comment names the new setting; its rules are unchanged.
- **`sandbox plan` and `sandbox run` fail closed on an invalid or unreadable bylaws file** (user-level or project): no plan is made from the defaults any more. `sandbox plan` exits 1 (and `--json` carries the error in `plan.error`); `sandbox run` exits 125 and starts nothing; both name the file and its first error and point at `openmorals validate`. Up to 0.16.0 an invalid file gave a plan from the defaults, which since `protected_paths` could say "enforced" while a protection the file asked for was missing. With no bylaws file at all nothing changes. `planSandbox` returns `{ ok: false }` for a load that is not ok, so `runSandboxed` refuses it for any caller.

### What it cannot tell you
- `fail-first` is evidence only when your own gate runs it, outside the agent's session, with your test command; an agent saying it saw a test fail first is not evidence. A test that fails on base shows the change is needed for it to pass, not that it checks the right thing.
- "Red for the wrong reason" is read from the report's error class, element or result field; only Node's junit shapes were seen from a real run, the pytest, Jest, Vitest, Go and Dart readings follow their documented formats. Where a runner shows nothing, it says "cannot tell".
- `fail-first` has run only on fixture repositories made by its tests; its wall time on real projects is not measured.
- Protected paths: a hard link to a protected file made before the run lets a write through the other name change it (measured on macOS); a test suite that writes into a protected folder fails inside the sandbox; Linux and Windows are not enforced as on macOS and were not run.
- Nothing here has been run against a live agent.

## 0.16.0 (2026-11-25)

Your own rules can name built-in detectors (card numbers, IBANs, US SSNs, NHS numbers, email addresses, phone numbers, HL7 and FHIR patient messages, vendor tokens) and can require that the action reaches the network. Files can be declared as holding private data for the taint guard. Without a rule that names a detector, nothing is decided differently and nothing stored changes. No model is called. Nothing is published.

### Added
- **`match.detector`**: one detector name or a list (any one firing matches): `secret-token`, `card-number`, `iban`, `us-ssn`, `nhs-number`, `email`, `phone-e164`, `hl7-msh`, `fhir-patient`. Each is a shape plus a checksum or validity rule (Luhn and a list of published test card numbers that do not fire; IBAN country lengths and mod-97; the SSA area, group and serial rules; NHS modulus 11; RFC 2606/6761 reserved names; fictional phone ranges). They find likely patterns, not proof that a value is real or anyone's data. What each fires on, does not fire on and misses: [docs/architecture/guards.md](docs/architecture/guards.md#detectors-and-network-0160).
- **`match.network: true`**: the rule matches only an action that reaches the network, by the taint guard's own computation (`actionReachesNetwork`, now shared with it). Example: `{ id: no-card-numbers-out, match: { detector: card-number, network: true }, decision: deny }`.
- **Detectors read the raw input of a call**: write content, the command line, the URL, and for any other tool every key, string and number of its input, not redacted (the redactor removes exactly the token shapes `secret-token` looks for). It stays in memory; the reason names the detector and a count, never the value.
- **`guards.taint.private_paths`**: globs of files that hold private data. Reading one, or a command that names one, marks the session like reading a credentials file, so a later network step after untrusted content asks (`taint.rule-of-two`). Absent by default; a project file can add entries, never drop the user's.
- **A total bound per decision**: all content patterns of one decision share one step budget (four times the per-rule one); past it the rest fail closed. Each detector scans a text once per decision, however many rules name it.
- `ruleCheck`, `detectorTexts`, `newRuleMeter`, `hitNote`, `maskAction`, `detectCount`, `maskDetected`, `namedDetectors`, the check functions (`luhnValid`, `ibanValid`, `ssnValid`, `nhsValid`) and `actionReachesNetwork` in the package API ([API.md](API.md)).
- `cases/detectors.cases.yaml` (32 rows, scored by `openmorals eval` as `detectors`, apart from the existing 470) and `test/detectors.test.ts`.

### Changed
- When the bylaws name any detector, the hits of those detectors are replaced by `[<detector>]` in the audit line, the session history and the text the reviewer is sent, so a value a rule looks for is not copied into openmorals' own records. With no detector named (the default), stored text is unchanged.
- A project or team file that changes a user rule's `detector` or drops its `network` is reported as a loosening and the user's rule is kept; a project file that lists fewer `private_paths` than the user's file gets the user's back ([ADR 0010](docs/adr/0010-the-user-file-is-a-floor.md)).
- `RuleMatch` gains `detector` and `network`; the `other` action gains `raw`; `describeAction`, `recordAction`, `findCallEntry` and `recordOutcome` (and the internal `storedAction`) take an optional list of detectors to mask; `ContentPattern.search` takes an optional step meter.

### What it cannot tell you
- Whether a value is real, issued or personal: a made-up number with a valid checksum fires, and so do placeholders such as 123-45-6789. This is not a compliance control.
- Names, addresses, free-text notes, and anything encoded, compressed, split across fields or written in another format pass every detector. Bare SSNs and NHS numbers fire only with a label before them.
- `match.content` still reads arguments and messages after redaction (0.14.0); only detectors read the raw input.
- Whether each host sends these fields in a live session: built from documentation, not run against any live agent.

## 0.15.0 (2026-11-25)

Your own rules can look at what an agent writes. A rule's `match` takes `content`, a pattern over what a write puts in a file and over the arguments and agent messages carried since 0.14.0. Without a content rule nothing is decided differently. No model is called. Nothing is published.

### Added
- **`content` on write actions**, filled on every host from the field the host documents: Claude Code `Write` (`content`), `Edit` (`new_string`), `NotebookEdit` (`new_source`) and `MultiEdit` (no longer documented: every string of its `edits`); Codex and opencode `apply_patch` (each file's added lines); Gemini CLI `write_file` (`content`) and `replace` (`new_string`); opencode `write` (`content`), `edit` (`newString`), `multiedit` (every string of its `edits`); OpenClaw `write` (`content`), `edit` (every string of its `edits`: the item fields are not documented) and `apply_patch`. Write content is capped at 256 KB like arguments and messages, and is not redacted, so a rule can see a key being written. It is never written to the audit log or the session history. Per-host table: [docs/adapters.md](docs/adapters.md#content-rules-what-content-carries-on-each-host-0150).
- **`match.content`** in `rules[]`: a regular expression (case-insensitive, `^` and `$` at line ends), alone or with `tool`, `command` or `path`. It reads a write's content, a call's arguments and an agent message; never a command line, a read or a fetch (`command` and `path` do that). Example: `{ id: no-private-keys-in-files, match: { content: "-----BEGIN [A-Z ]*PRIVATE KEY-----" }, decision: deny }`.
- **A linear-time matcher for content patterns** (`src/rules/pattern.ts`). The native engine takes about 0.3 s for `a.*b` on 16 KB of `a` and grows with the square of the text; content patterns run in time proportional to the text instead (measured: 1-2 ms for ordinary patterns on 256 KB). A step budget stops a pattern that would still be slow on text chosen against it (measured: about 0.2 s, then it gives up).
- **Fail closed when the content cannot be checked whole.** Over 256 KB, or when the search runs out of steps, a deny rule takes the content as matched and an ask rule asks; the reason says the content was cut (or too costly to search).
- Patterns the matcher cannot run in linear time are refused when the bylaws load, with the reason: backreferences, lookahead and lookbehind, `\p{...}`, repeat counts over 1,000, patterns over 1,024 characters.
- `ruleOutcome`, `actionTexts`, `compileContentPattern` and the content limits in the package API ([API.md](API.md)).
- `cases/content-rules.cases.yaml` (20 rows, scored by `openmorals eval` as `content-rules`, apart from the existing 450) and `cases/content-rules.rows.yaml` (46 rows for the other four hosts and every over-cap branch).

### Changed
- A project file may add content rules (it can only add asks and denies); a project or team file that changes the pattern of a user rule with the same id is reported as a loosening and the user's rule is kept, as for the other `match` fields ([ADR 0010](docs/adr/0010-the-user-file-is-a-floor.md)).
- `parsePatchFiles` is unchanged; `parsePatchContent` also returns each file's added lines.

### What it cannot tell you
- Whether each host sends these fields in a live session: built from documentation, not run against any live agent.
- Arguments and messages are matched after redaction (0.14.0), so a content rule cannot see a token or password in an MCP argument; write content is matched as written.
- A file written by a shell command (`echo ... > file`, a heredoc, a script) carries no content: use `match.command`. An opencode V2 permission event names the file only, so it carries none either.
- A pattern only finds what it describes. Detectors with checksums (cards, IBANs) are a later step.

## 0.14.0 (2026-11-25)

Tool arguments and agent-to-agent messages are carried on the call, and the text one agent hands to another is scanned for hidden instructions. Only records and session marks are added; no call that was asked about is now allowed. Nothing is published.

### Added
- **`args` on every call without its own mapping** (MCP tools, plugin tools, built-ins without a mapping), on all five hosts: the arguments as compact JSON, every value through `redact()` and a value under a secret-named key replaced whole, capped at 256 KB (over the cap the first and last halves are kept and the call says it was cut). Never written to the audit log or the session history; no guard reads it yet.
- **`message` for tools that hand text to another agent**: Claude Code `Agent`/`Task` (`prompt`), `SubagentHandback` (`message`), `SendMessage` (every string value: its body field is not documented); Codex `spawn_agent` and the Gemini CLI built-in subagent tools (every string value: their fields are not documented); opencode `task` and `subagent` (`prompt`); OpenClaw `sessions_spawn` (`task`) and `sessions_send` (`message`). Sources per host in [docs/adapters.md](docs/adapters.md#content-bearing-actions-tool-arguments-and-agent-messages-0140).
- **The outbound leg is scanned** with the inbound rules before the call. A finding writes an audit line (rule, kinds, lines, never the text) and marks the session: hidden content as injected, a visible phrase as untrusted. The call itself is decided as before; nothing is said to the model.
- **`diffClass.diffClassVerdictWith` and `diffClass.formatDiffClass`**: the command's input handling returning the verdict object, so a caller can add its own reasons and print it the same way.
- **ADR 0014** records the checker's powers: no credential that can send, write, delete, merge or approve; refuse, ask or report; approvals only through channels the agent cannot type into; no model lowers a decision; each statement marked as held by a test or as a design rule.
- `cases/content-actions.rows.yaml`: 28 rows of what each adapter carries, the base for content rules over arguments later.

### Changed
- OpenClaw: a tool with a path or URL argument now also gets its `other` action (carrying the arguments) after the lifted actions; before, it was dropped. This can only add checks.
- `redact()`: the pattern that hides a password in a URL no longer slows down on long runs of letters (measured: 881 ms on 40,000 letters before). Its output is unchanged.

### What it cannot tell you
- Whether a host fires its hook for these tools, or inside a child agent: built from documentation, not run against any live agent.
- Where the receiver runs in another session (opencode and OpenClaw child sessions, Claude Code agent teams and your other sessions), the mark stays on the sender's session, and the receiver's own steps are judged without it.
- Instructions in plain prose with no known phrase pass, as they do in tool results.

## 0.13.0 (2026-11-25)

Test-integrity reason lines in the merge verdict. They can only add review. Nothing is published.

### Added
- **Thirteen `integrity.*` rules in `openmorals diff-class`**, each with a pattern published in [docs/test-integrity.md](docs/test-integrity.md) and case rows: a test file whose count of assertion-like lines fell (with the diff's removed, added and net counts), a skip, `only`, `todo` or expected-failure mark added, a snapshot or golden file changed, test-runner configuration changed, package `scripts` changed (base and head compared), an exit call added in test code, an expected literal changed in an assertion line, an equality override or custom matcher in test code, a lint, type-check or coverage suppression added, a new dependency in nine manifest formats, a file outside the declared paths, a change over a declared size line, a declared boundary path changed with no `docs/adr/` change.
- **Declared inputs:** `--paths GLOB` (repeatable; the interim source until work orders exist), `--max-lines N`, `--max-files N`, and `merge.boundary_paths` in the bylaws (a project file can add entries, never drop the user's). A rule without its input does not run, and `--json` lists it in `notChecked`.
- **`diffClass.diffClassCommandWith(argv, ctx, settings)`** runs the command with merge settings from the caller, and the `class.off` reason names the source the caller gave.
- **`cases/diff-class.cases.yaml`** grows from 96 to 150 rows of real `git diff` output, with `not_rule` near misses each rule must stay silent on. A test deletes each rule in turn and checks its rows then fail, and checks on every row that the verdict with the rules on is at least as strict as with them off.

### Changed
- Text output still prints at most three reason lines; test-integrity lines now come before the exclusion lines. A diff that met a switched-on review-free class can now need review because of one of these lines.

### What it cannot tell you
- Whether a change is good. Every firing read on this repository's history (13 of 62 commits) was honest work, so the history measures the nuisance side only. Real-session nuisance rates are not measured; the rules are not recommended as a default gate.
- Anything its patterns do not see. Each rule lists what it misses.
- The first version fired on 23 of 62 commits (37%), over the design's 25% line, so it was narrowed before release: assertion lines count only where a test file's own count fell, `skip: false` is not a skip, and there is no default size line.

## 0.12.0 (2026-11-25)

A merge verdict computed from a diff. Nothing is review-free by default. Nothing is published.

### Added
- **`openmorals diff-class <diff|-> [--base DIR] [--reproduced FILE] [--run ID] [--summary FILE] [--json]`** reads `git diff` output and exits 0 when the change may merge without being read, 1 when it needs review, 2 when an input cannot be read (read as review), 64 on a usage error. For review it names up to three facts; `--json` lists all of them, each with a rule id and a path. Plain code: no model call, no credential, nothing merged or written. Guide: [docs/merge-verdict.md](docs/merge-verdict.md).
- **Two classes, both off by default.** `tighten-only`: ask or deny rows added to an existing `cases/*.cases.yaml` table, or a root `openmorals.yaml` change that loosens nothing, changes no user-level-only setting and leaves the `merge` section alone; the file is rebuilt from the base folder and checked against the diff's git hashes, and the added lines must pass the scanner's hidden-instruction and obfuscation rules and `redact()`. `reproduced`: byte-equal to the diff a pinned tool produced (`--reproduced`).
- **Always review:** CI configuration, CODEOWNERS, lockfiles, manifests, build scripts, test files and runner configuration, executable source, agent instructions and host configuration, README, security, licence and notice files, secrets files, git configuration, the classifier itself, files self-protect guards, and the `always_review` globs. These override both classes.
- **Fails toward review.** Input that is not exactly what git writes exits 2. A rename, copy, delete, mode change, executable file, symbolic link, submodule, binary, carriage return or line separator inside a line, control character, quoted path, path with a space or a non-ASCII character, and a path that appears twice each make the file need review.
- **The run record can only add review:** a deny, any ask, an approved ask, a taint mark, a loosening note, a record that does not verify, or a declared run with no record.
- **`merge:` in the bylaws** (`review_free`, `always_review`). Only the user-level file can switch a class on; a project file can switch one off and add paths, through the same comparison as every other floor setting. Absent by default, so the bylaws digest of a setup without it is unchanged.
- **`cases/diff-class.cases.yaml`**: 96 rows of real `git diff` output. `openmorals eval` scores them on a line of their own, outside the guard table and its total.

### What it cannot tell you
- Where it ran. It prints, with every review-free verdict, that it cannot see whether CI computed it from the base branch, whether the result is a required check pinned to an identity the agent cannot use, whether CI ran the tests, whether merging publishes, or whether a reproduced diff came from a pinned tool.
- A local gate on the machine the agent uses is weaker than such a CI check: the agent works under the same user.
- On this repository's own 60 commits up to 0.11.0 it would have made none review-free. Expect better-aimed review, not less of it.

## 0.11.0 (2026-11-24)

A draw of finished runs for a close read, and a count of what the checks missed. Nothing is published.

### Added
- **`openmorals audit sample`** picks finished runs (records written with `OPENMORALS_RUN=<id>`; `--by session` draws sessions) for you to read closely. Each unit is considered once, by the first draw after it finished, and picked with a chance of 1 in N. Plain code: no model call, no token cost. Guide: [docs/audit.md](docs/audit.md#openmorals-audit-sample).
- **A draw the agent cannot steer.** The seed is 32 bytes from the operating system's random source at the moment you run the command; a unit is picked when the first 48 bits of HMAC-SHA256(seed, unit id) are below 1/N. The seed does not exist when any record is written, so no id, order, timing or field the agent wrote changes a unit's chance. The draw (seed, method, N, population, picks) is recorded as a chained line in the audit log, and `--tally` recomputes every draw from it.
- **What each pick shows:** times, counts of denies, asks, approved asks, taint marks and loosening notes, its sessions and folders, the first commands and files named, and `openmorals audit --run <id>` for more. `--json` prints one object.
- **Verdicts and the tally.** `--record <id> clean|escape "<one line why>"` takes your verdict on a drawn unit (only drawn units take one). `--tally` counts draws, units considered, picks, verdicts, clean and escape, the share of picks with a verdict and escapes per verdict, and lists the picks still waiting. No score per agent, no chart, no rate at which work passes.
- **Read everything after an escape or a change.** After an escape, or a change of model, pack or host you declare with `--change "<what>"`, the draws that consider the next K units (default 5) read everything; then sampling goes back to 1 in N.
- **Settings in your config directory only:** `audit-sample.yaml` (`rate`, default 10; `read_all_next`, default 5; `by`, default `run`; `settle_minutes`, default 30). There is no command-line N. An invalid file exits 2 and nothing is done.
- **Fails toward reading more.** A unit whose record does not verify is picked whatever the draw says, with its problems printed; problems that belong to no unit are printed and the exit code is 1. An unreadable log, session file or settings file exits 2, and nothing is drawn. Nothing to draw from exits 3, and nothing is written. A unit with a record in the last `settle_minutes` waits for a later draw and is listed by id.

### Changed
- **self-protect:** every form of `openmorals audit sample` that writes (a draw, `--record`, `--change`) is on its list, so an agent running one is asked (denied when unattended); `--tally` and `--help` are not. The list (`init`, `purge`, `audit sample`) now also applies when openmorals is started through `npx`, `bunx`, `pnpx`, `npm`/`pnpm`/`yarn`/`bun` `exec`/`x`/`dlx` or `python -m openmorals`: until now `npx openmorals init` was allowed without asking. Only more asks; nothing that asked before is allowed now.
- Audit records may carry a `sample` object (only the sample's own lines, under the session `audit-sample`); `parseAuditLine` keeps it and rejects one that is not an object.

### What it cannot tell you
- A sample finds what a reader notices, not everything.
- It covers only sessions on hosts that call openmorals: work done where the hook did not run left no record and is never drawn.
- The record names actions, not the quality of the work: the summary helps you find the work, and you read the work itself.
- A clean read lowers no other check: every ask and deny stands.
- Read-only tests stop an agent editing them; they do not stop code written to pass those exact tests. You still read a sample.
- The command started by its file path (`node <folder>/dist/src/cli.js`) is not recognised by self-protect; a program running as you can still rewrite the record, as [docs/audit.md](docs/audit.md#what-this-proves-and-what-it-does-not) says.

## 0.10.0 (2026-11-24)

A command that compares two test runs by test name. Nothing is published.

### Added
- **`openmorals tests compare <before> <after>`** reads two test reports, one from the code before a change and one from after, and prints two lists by test name: tests that failed, were skipped or were absent before and pass after; and tests that passed before and now fail, are gone or are skipped. Plain code: no model call, no token cost; it runs no tests and writes nothing. Guide: [docs/tests-compare.md](docs/tests-compare.md).
- **Exit codes a local gate can read.** 0: no test that passed before is failing, gone or skipped, except approved ones. 1: at least one is, without approval. 2: a report or the approval file cannot be read; nothing was compared, so read it as "needs review", never as "no damage". 64: usage error. The totals and the pass rate are printed for reference and never decide the exit code.
- **Approvals by name, in your config directory.** A line `fails|gone|skipped <test name>` in `tests-approved.txt` (in `$OPENMORALS_HOME`, else `~/.config/openmorals`) approves that one loss of that kind. On exit 1 the command prints the lines to add; lines that matched nothing are listed. The file is under the self-protect guard, so an agent writing it is asked about like any other edit to your openmorals settings. A line in any other form makes the file unreadable (exit 2).
- **Reports read:** JUnit XML (Node's `--test-reporter=junit`, pytest `--junitxml`, Maven, Gradle and most runners), Jest and Vitest JSON, `go test -json`, and `flutter test --machine` / `dart test --reporter json`. The format is recognised from the file, or set with `--format`. The XML reader is built in (no new dependency) and refuses a DOCTYPE and unknown entities. A report with no test results is unreadable.
- **Also shown:** likely renames (a test gone and a new one in the same file), flaky tests when you pass repeated runs (`--before-repeat`, `--after-repeat`), and failing tests that went away (not a loss, but worth a look). `--before-root` and `--after-root` strip each copy's folder from file paths, for reports made in two different folders. `--json` prints one object with every list.
- **Run on this repository** (two temporary copies at the same commit, a scratch change in one: an off-by-one in a helper, one test renamed, one skipped, one deleted, one added): both reports held 1833 tests, so the totals showed nothing, while the comparison listed 7 tests lost (4 failing, 2 gone, 1 skipped) and 2 new, and exited 1. Two runs of the unchanged copy compared clean (exit 0).

### What it cannot tell you
- Which of these tests the agent could edit. A test the agent wrote or changed can pass without showing anything; the output says so with every result. Read-only tests (the `test-lock` pack) stop an agent editing them; they do not stop code written to pass those exact tests.
- A renamed test shows as one gone and one new.
- The lists say nothing about tests that check little.
- A report is only as trustworthy as the run that made it: make both reports with your own gate, in clean copies, not from the agent's run.
- No test that passed before may fail, disappear or be skipped without your named approval, on repositories where your gate runs `tests compare`. That is all it supports.

## 0.9.0 (2026-11-24)

An add-on pack that asks before an agent edits the tests that judge its work. Nothing is published.

### Added
- **The `test-lock` pack** ([packs/test-lock.yaml](packs/test-lock.yaml)), off unless you add it. Rules only: no model call, no token cost, no change to the engine. Every rule asks; none refuses (with `--unattended`, as everywhere, an ask becomes a deny). It asks before:
  - an agent's file-edit tool (Claude Code `Write`, `Edit`, `MultiEdit`, `NotebookEdit`; Codex, opencode and OpenClaw `apply_patch`, `write`, `edit`; Gemini CLI `write_file`, `replace`; an MCP tool with a write word in its name) writes a test you declared as judging the work. By default: `test/acceptance/` or `tests/acceptance/`, `test(s)/contract(s)/`, `__snapshots__/`, `*.snap`, `conftest.py`;
  - such a tool writes the test-runner configuration: `vitest.config.*`, `jest.config.*`, `pytest.ini`, `dart_test.yaml`;
  - `rm`, `mv`, `unlink`, `del`, `erase`, `Remove-Item` or `Move-Item` (so `git rm` and `git mv` too) names one of those files;
  - a snapshot or golden update (`jest -u`, `vitest -u` or `--update`, `npm test -- -u`, `--updateSnapshot`, `--update-snapshots`, `--snapshot-update`, `--update-goldens`), `--passWithNoTests`, or `--no-verify` (and `git commit -n`).
- **Your own judging tests are one line.** The judging paths are a single regular expression in the pack, marked `&judging`, which every judging rule reuses; edit it in your `openmorals.yaml`. Keep it to tests written or approved before the work started: on this repository's own 54 commits, the defaults would have asked on none, while a lock on every test file plus `package.json` would have asked on 48.
- **`openmorals packs NAME`** prints one pack's file, so an add-on can be copied into an existing `openmorals.yaml` (`init --pack` writes a file only where none exists, and the single-file binary has no packs folder to copy from).
- **A case row may say `pack: <name>`** to be judged under a shipped pack's file; `cases/test-lock.cases.yaml` has 51 rows (30 asks and 14 allows with the pack on, 7 allows with it off).

### What it does not see
- A write made by a script or program the agent runs (`python fix.py`, a build step), a shell redirect, or `sed -i` into a judging test. Only the agent's own file-edit tools and the delete and move commands above are matched. On a host without the OS sandbox (`openmorals sandbox`), nothing else stops that write.
- Code written to pass exactly the tests you locked. It stops edits to those tests; it does not stop special-casing or overloading in the code under test. Read-only tests stop an agent editing them; they do not stop code written to pass those exact tests. You still read a sample of the work.
- Other ways to skip hooks (an environment variable, `core.hooksPath`), and `package.json` `scripts` (a path rule would ask on every version bump; that waits for rule matching on written content).
- **Not run against a live agent host.** The rows and tests use recorded event shapes. How often it asks in real sessions is not measured yet.

## 0.8.1 (2026-11-24)

A security fix for the Claude Code hook. Nothing is published.

### Security
- **Until 0.8.1, the arguments of MCP tools were not checked on Claude Code.** The Claude Code hook judged an MCP tool (`mcp__<server>__<tool>`), and any other tool without its own mapping, by its name only: a path or URL in its arguments reached no guard, no user rule and the taint judge only as "some MCP tool", and an MCP tool named like a delete was not asked about. The Codex, Gemini CLI, opencode and OpenClaw adapters already read those arguments. Now the Claude Code hook reads them the same way, with the same code (`argActions` and `mcpDeleteVerdict` in `src/adapters/codex/pipeline.ts`):
  - a top-level string or list of strings under a URL key (`url`, `uri`, `href`, `endpoint`) that starts with `http://` or `https://` is judged as a fetch, so a user rule on the URL (`match.path`) and the taint judge see it;
  - one under a path key (`path`, `paths`, `file_path`, `filePath`, `file`, `files`, `filename`, `dir`, `directory`, `target`, `destination`, `dest`, `source`, `uri`, ...) is judged as a read, or as a write when the tool name has a write word, so the secrets and self-protect guards see it, and a credential read marks the session for the taint judge;
  - an MCP tool whose name has a delete word (`delete`, `destroy`, `drop`, `purge`, `remove`, `wipe`, `truncate`, `terminate`, `unpublish`, `erase`, `rm`) takes the bylaws' `online-delete` decision as `adapter.mcp-delete` (ask by default).
  These checks can only add asks and denies; nothing that was asked before is allowed now.
- **Built-in tools are judged exactly as before.** A tool with its own mapping (`Bash`, `PowerShell`, `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookRead`, `NotebookEdit`, `Grep`, `Glob`, `LS`, `WebFetch`) is still one action; a test compares every built-in case row's verdict before and after.
- **Limits kept.** Only top-level values are read: a path inside a nested object is not seen. Only path and URL keys are read: a recipient, a message body, a query or a field value is not. At most 32 actions are lifted from one call. A delete is recognised by the tool's name only. Matching rules on argument values is a later change.
- **Not run against a live Claude Code.** The tests use event shapes recorded from the hooks reference (read 24 Nov 2026), not events captured from Claude Code.

### Changed
- The audit line for a call with lifted arguments names every action (`tool ; tool url ; ...`), and the session history records each one, as on the other hosts.
- `openmorals eval` and the case tests judge a `tool:` row the way the Claude Code hook judges the call (`decideCall`). 13 new rows: 7 in `cases/secrets.cases.yaml`, 6 in `cases/online-delete.cases.yaml`. On the shipped 399 rows every guard still scores a 100% catch rate and 0% false alarms, and the median decision time is unchanged (16 to 17 µs overall on the laptop in [docs/eval.md](docs/eval.md)).
- Package exports: `toActions`, `decideCall`, `adapterVerdicts` and `isMcpTool` from the Claude Code adapter; `Case` gains `actions` and `tool`.

## 0.8.0 (2026-11-24)

A hardened audit record. Nothing is published.

### Added
- **Each audit line is chained within its session.** Records are now version 2: `seq` numbers the records of a session from 1, `prev` holds the SHA-256 of the session's previous line as written, and each line carries `ov` (the openmorals version), and when known `bylaws` (a digest of the bylaws in force), `event` (the host event), `run` (from `OPENMORALS_RUN` in the hook's environment) and `agent` (the host's agent id: Claude Code `agent_id` in a subagent or teammate, OpenClaw `ctx.agentId`). The session file keeps the chain head, saved in the same write as the budget and taint. One chain per session, not one for the whole file, because several sessions append to one file with no lock.
- **`openmorals audit verify [--run ID] [--json] [--file FILE]`** reports an edited line, a deleted line, a cut-off tail, lines removed from the end, a session whose state was reset or replaced with an older copy, and, with `--run`, a missing log or a run with no record. Exit 0 when verified, 1 otherwise.
- **`openmorals audit --run ID [--json]`** summarises one run: denies, asks, approved asks, taint marks, loosening notes, and whether its record verifies.
- **The outcome of an ask is recorded.** When a call openmorals asked about runs, the post-tool event writes an `ask.approved` line naming the original rule. A refused ask runs nothing, so it leaves no outcome line. Codex and opencode V1 cannot ask, and an ask raised only by the opencode V2 permission hook is not linked to its call; see [docs/audit.md](docs/audit.md).
- [docs/audit.md](docs/audit.md): the record format, what `verify` reports, and what it cannot show.

### Security
- **What this does not do.** A program running as you can still rewrite the log, recompute every hash and update the session files to match, and `verify` then passes. The record finds careless loss, cut-offs and edits, and can only raise review (ADR 0013); the answer to a hostile agent is still the OS sandbox around its commands.

### Changed
- A file that mixes versions: version 1 lines before the first version 2 line are counted as history and pass; a version 1 line after it fails as `unchained` (an older openmorals still writing to the same folder, or an inserted line).
- `openmorals check` and a hook input that cannot be read are chained under the session `unknown`, so they now write that session file too.
- The OpenClaw plugin written by `init --agent openclaw` sends `agentId`; a plugin written earlier keeps working and records no agent id.
- Measured cost: about 0.008 ms per record on an Apple M3 Pro (one SHA-256 of the line, one of the bylaws); the in-process hook median stayed at 0.30 ms. `openmorals eval` timings are unchanged (it times decisions, not records).

## 0.7.0 (2026-11-24)

Score the guards on their case rows. Nothing is published.

### Added
- **`openmorals eval [--json] [--cases DIR] [--guard NAME] [--bylaws FILE]`.** Runs every `cases/*.cases.yaml` row through the engine and every `cases/inbound.table.yaml` row through the inbound scan, the way `npm test` does, and prints per guard: the catch rate (rows expecting ask or deny that got at least that), the false-alarm rate (rows expecting allow that got ask or deny), rows whose decision matched but whose rule did not, and the p50 and p95 time per decision (25 timed repetitions of every row in one process). Every wrong row is listed by file, index and line. Exit 0 when every row matches, 1 when any row is wrong, 2 when the rows or bylaws cannot be read (nothing is scored). It calls no model, spends no tokens, reads no bylaws but the built-in defaults or `--bylaws`, and writes nothing. On the shipped 386 rows every guard scores a 100% catch rate and 0% false alarms, and a decision takes 7 to 21 µs at the median on the laptop where it was measured ([docs/eval.md](docs/eval.md)).
- Your own rows: `--cases <dir>` scores any folder of `*.cases.yaml` and `*.table.yaml` files; the row format is documented in [docs/eval.md](docs/eval.md).
- The library exports the scorer as the `evals` namespace ([API.md](API.md#eval)).

### Changed
- The single-file binary carries the case files as assets, so `openmorals eval` works with no folder; `scripts/compare-binary.mjs` compares `eval --json` from the binary and the Node CLI (times aside).
- The case-file loader moved from `test/case-loader.ts` to `src/eval/cases.ts`; it returns an error instead of throwing, and reports the line of each row.

## 0.6.2 (2026-11-24)

Two security fixes to how openmorals protects itself. Nothing is published.

### Security
- **Self-protect covers the real config directory, the folders above it, links and arguments.** It matched only literal folder names, so with `OPENMORALS_HOME` set to a folder of another name a write to its audit log was allowed; `mv ~/.config /tmp/x` and `cp -r x ~/.config/openmorals` were allowed; `python3 -c "open('.../audit.jsonl','w')"` was allowed; and a write through a symbolic link into the directory was allowed. It now matches the directory from `configDir()`; asks when the directory or a folder above it is moved, removed, linked, has its permissions changed, is extracted or synced onto, or is copied onto so that something lands on it; looks inside every argument; and resolves write targets and arguments through links (a relative link target from the link's folder). The decision stays `ask`. Reading and listing stay allowed, and `cd`, `du`, `tree` and `find` without `-delete`/`-exec` were added to the read-only commands. New asks a user may notice: a protected file name inside a text argument (`gh pr create --title "Tighten openmorals.yaml"`), and code naming a folder above the config directory. Resolving links adds about 40 microseconds per decision where it was measured. Still open, by design of a hook: a program the agent writes and then runs, or a `package.json` script run through `npm test`; the answer is the OS sandbox ([threat model](docs/architecture/threat-model.md)).
- **An unreadable session file no longer resets taint and budget in silence.** Only a missing session file starts a clean session now. A file that cannot be read (permission, a folder in its place) or parsed reads as tainted, and the next judged call asks once (`budget.unmeasured`); the mark survives a usage report or post-tool scan saved in between. Deleting the file still starts a clean session.

### Changed
- **`openmorals audit` and `readAudit` tell a missing log from an empty one.** `readAudit` returns `status: 'missing' | 'empty' | 'ok' | 'unreadable'`; `openmorals audit` says "no audit log at <file>: nothing has been recorded there yet, or it was removed", and exits 1 when the log cannot be read.
- `decide()` takes an optional fifth argument, `where` (config directory, working directory and link resolver), and now reads the file system to resolve links. See [API.md](API.md#changes).

## 0.6.1 (2026-11-24)

Two fixes and a documentation note. Nothing is published.

### Security
- **`reviewer.api_key_env` refuses a value that looks like a key.** It accepted any run of letters, digits and underscores, so a mixed-case key (Google-style) or a long hex secret passed as a variable name. From a project file it was then printed on stderr by `check` and `validate`; from the user file it reached the reviewer's "no API key: ... is not set" reason, the hook's answer and the audit record, in clear when the redactors did not know its shape. A name must now be 1-64 letters, digits and underscores, not starting with a digit, all upper case or all lower case, with no run of more than 24 characters between underscores, and left unchanged by the redactors. The error names the setting, never the value. CamelCase names are refused too: write them in upper case (on Windows that finds the same variable). A short all-one-case random token with no known prefix still cannot be told from a name.

### Fixed
- **A project rule with the id of a user rule is no longer reported as a loosening.** It is kept beside the user's rule, which is unchanged, yet the note said the project file "tried to loosen rules.<id>". The note is now `note bylaws.rule-kept-beside: <project file> has its own rules.<id>, kept beside the user's rule of the same id; the user's rule in <user file> is unchanged`, and `check` and `validate` print a matching "kept" line.

### Documentation
- `docs/adapters.md` says not to commit the generated `.openclaw/plugins/openmorals/` folder, which holds this machine's project path.

## 0.6.0 (2026-11-24)

The user floor for bylaws (a security fix), reviewer protocols for many models, an opt-in inbound judge, token and cost budgets where the host reports usage, opencode 2.x field fixes and an OpenClaw adapter. Nothing is published.

### Security
- **A project `openmorals.yaml` can only tighten the user-level one** (requirement ENG-10, [ADR 0010](docs/adr/0010-the-user-file-is-a-floor.md)). Before, the nearest project file replaced the user file, so a cloned repository could set any guard to `allow`, raise or switch off the budget, add allowed delete targets, trusted or sandbox hosts, switch off audit or scanning, and point the reviewer at another model and key variable. Now the user-level file (or the defaults) is the floor; looser project settings are ignored, printed by `check` and `validate`, and noted in each decision's reason (`note bylaws.loosening-ignored`). The reviewer's provider, model, key variable, timeout and switch, and `guards.inbound.notify`, come from the user file only. An invalid project file fails closed on the user floor, not the looser defaults.

### Added
- **Reviewer protocols** (requirement RVS-08, [ADR 0011](docs/adr/0011-reviewer-protocols-not-sdks.md)): `reviewer.provider` takes `anthropic-messages` (the default; `anthropic` still works), `openai-chat` (OpenAI and compatible services, and local servers such as Ollama, LM Studio, vLLM and llama.cpp through `base_url`) and `gemini`. New `reviewer` keys `base_url` (https, or http to this machine only), `auth: none` (send no key) and `compat` (`token_param`, `system_role`, openai-chat only). Each protocol is a small client on the global `fetch`; no dependency was added. A named protocol without `api_key_env` reads its own variable (`OPENAI_API_KEY`, `GEMINI_API_KEY`). Every odd reply (refusal, filter, truncation, wrong shape, HTTP error, redirect) escalates and keeps the ask.

- **Opt-in inbound judge** (requirement INB-06, [ADR 0012](docs/adr/0012-silent-taint-and-an-opt-in-judge.md)): `guards.inbound.judge: true` in the user-level file sends the lines a weak finding flagged in a tool result (at most 1,000 characters, redacted, cached by hash in the config directory) to the reviewer's provider. Its escalate, or any failure, marks the session as injected, so later network and private-data steps ask; no-objection changes nothing. Off by default, so the default token cost stays zero. Claude Code hook only.

- **Token counting where the host reports it, and an optional cost limit** (GRD-10, GRD-11): Codex's `PostModelRequest` hook (installed by `init --agent codex`) adds each model request's `token_usage` to the session budget. `guards.budget.prices` (user-level only, empty by default) and `guards.budget.cost` (hundredths of that currency, off by default) turn tokens into spend. Claude Code, Gemini CLI and opencode report no session usage to hooks; there only tool calls are counted, as `docs/adapters.md` says.

### Fixed
- **opencode 2.x: the call id was never read.** opencode 2's tool hooks name the call id `id` (v2.4.1 types), not `callID`; the plugin (now format 3) reads `id`, so the loop detector matches outcomes to calls again. It also scans `result.content` (a string or text parts) as well as `result.output`. `docs/adapters.md` lists which V2 fields are verified and which inferred.
- **A soft token step reported between two calls never asked**: `countToolCall` reset the comparison point to the current count just before judging. The comparison point is now the count at the last judged call.

- **OpenClaw adapter** (requirement HST-12): `openmorals init --agent openclaw` writes a plugin folder (manifest, `package.json`, dependency-free `index.js`) to install with `openclaw plugins install`; `openmorals hook openclaw` answers it. `before_tool_call` gets nothing (allow), an approval request that offers only allow-once or deny (ask), or a block (deny, and any failure); `after_tool_call` records outcomes and scans results; `llm_output` counts tokens. The self-protect guard and the sandbox cover `.openclaw/plugins/`, `.openclaw/extensions/` and `openclaw.json`. Hook shapes checked against the OpenClaw docs and the v2026.11.7 source on 24 Nov 2026 (`docs/adapters.md`).

### Tests
- **ENG-07 has its own test** (`test/rules-never-allow.test.ts`): the validator refuses any rule decision but ask and deny, and every case in every case file keeps or raises its decision when rules matching everything are added, including an `allow` rule forced past the validator.

## 0.5.0 (2026-11-24)

Inbound content and prompt scanning (requirements INB-01 and INB-02), with no model call and, by default, no tokens.

### Added
- **Hidden-instruction scanning of tool results, fetched pages and prompts** (`src/inbound/`). A pure function reuses the install scanner's character sets and override phrases: Unicode tag characters, bidirectional controls outside balanced right-to-left text, runs of zero-width characters, stacked variation selectors, phrases broken up by hidden characters, HTML comments addressed to the agent, base64 that decodes to instructions or a download-and-run command, and (a weak signal) visible override phrases unless quoted or introduced as an example. It reads at most `guards.inbound.max_bytes` (default 262,144, the first and last halves) and never returns the text it read. Case table: `cases/inbound.table.yaml`, 52 cases, 28 of them benign look-alikes.
- **Silent by default.** A finding in a tool result marks the session as tainted and writes an audit line; nothing is sent to the model. The new taint rule `taint.injected-content` then asks before any later step that reaches the network or touches private data, and that one reason line is the only text the model sees. `guards.inbound.notify: true` sends a short fixed notice for each finding instead (it stays in the agent's context, so it costs tokens). A tool result is never blocked.
- **Prompts:** hidden characters take `guards.inbound.decision` (ask warns the user, deny blocks the message); a secret-shaped value (a vendor token or a private key block) takes `guards.secrets.send` (deny by default: the message is not sent); override phrases, HTML comments and encoded text in the user's own message only mark the session.
- **Hooks:** Claude Code `UserPromptSubmit` (and the result scan on `PostToolUse` and `PostToolUseFailure`); Codex `PostToolUse` and `UserPromptSubmit`; Gemini CLI `AfterTool` and `BeforeAgent`; the opencode plugin's `tool.execute.after` and `chat.message` (V1) and `execute.after` and the session `prompt` hook (V2). `init` installs them without replacing existing hooks; the self-protect guard covers the files.
- **Repeated failures on Codex, Gemini CLI and opencode:** their post-tool hooks now report each call's outcome, so the loop detector's "same failure three times" check works there too.
- `guards.inbound { enabled, decision, notify, max_bytes }` in the bylaws, validated; `packs.loosenings` reports it switched off, a softer decision or a smaller byte cap.
- `openmorals help <command>`.

### Fixed
- **D-1:** `--help` or `-h` after a subcommand ran the subcommand: `guidance --help` wrote `AGENTS.md`, `init --help` wrote `openmorals.yaml` and installed the hook. Now every subcommand prints its usage and exits 0 before any file is opened or written, and an unknown option on a command other than `hook` is a usage error (64) that does nothing.
- **D-2:** the guidance block said openmorals "asks" about loops and Rule-of-Two steps when the bylaws deny them; it now says "blocks". Its self-protect line names the Codex, Gemini CLI and opencode hook files too.
- **D-3:** `packs.loosenings` compares `allow_targets` the way the engine matches them (`./dist/` equals `dist`; `DIST` does not) and reports a budget `step` that asks less often.
- **CI on Windows:** the release-workflow test now reads CRLF checkouts, `.gitattributes` keeps checkouts LF, and `scripts/compare-binary.mjs` normalises the temporary folder in every spelling (JSON-escaped, 8.3 short name, any case), which were the only two differences on windows-x64.

### Not yet
- Not run against live Codex, Gemini CLI or opencode; the opencode V2 result and prompt shapes are inferred from the documentation.
- The middle of a result longer than `max_bytes` is not scanned; paraphrased or homoglyph instructions are not detected (the taint guard still covers what they could lead to).

## 0.4.0 (2026-11-24)

Distribution, not a rewrite: the TypeScript engine is still the only implementation.

### Added
- **A single-file binary per OS**, for people without Node: `scripts/build-binary.mjs` bundles the CLI with esbuild and builds it with Node's own `node --build-sea` (Node 25.5+; releases use Node 26.13.1). The bylaws packs are embedded as assets. Targets: linux-x64, linux-arm64, macos-arm64, macos-x64 (best-effort), windows-x64.
- **`scripts/compare-binary.mjs`**: runs every guard case (279), plus version, packs, sandbox plan, scan, validate and `init --pack`, through the Node CLI and a binary and fails on any difference.
- **A release workflow** (`.github/workflows/release.yml`): on a `v*` tag, builds, smoke-tests and compares the binary on all five targets, builds and tests the Python wheels, writes `SHA256SUMS` and attaches everything (with the Node.js and yaml licences) to a GitHub release; run by hand it is a dry run that only uploads artifacts. Read-only by default; only the publish job may write; actions pinned by commit SHA.
- **A Python package** (`python/`, `pip install openmorals`): platform wheels that carry the binary, an `openmorals` command, `python -m openmorals` and `openmorals.check(command) -> Decision`. No decision code and no dependencies; Python 3.9+. It checks the binary's SHA-256 before running it and fails closed: a plain command prints why and exits 69, a hook prints the host's ask (or block) answer, `check()` answers ask.
- `packs.embeddedPacks()` in the library (see API.md).
- CI builds the binary on Linux, macOS and Windows, compares it with the Node CLI and runs the Python tests against it (Python 3.9 and 3.13).
- [docs/distribution.md](docs/distribution.md): the three install routes, what is verified and how, unsigned binaries on macOS and Windows, and what has been run where.

### Not yet
- Nothing is published: no npm package, GitHub release or PyPI upload yet. No binary was built on the development machine (its Node.js cannot build single executables); real binaries, their size and start time come from the release workflow's dry run.

## 0.3.1 (2026-11-24)

### Fixed
- **Security: on Windows, the Codex, Gemini CLI and opencode adapters let `rm -rf` through.** They read every shell command on Windows as PowerShell, where `rm` is `Remove-Item` and `-rf` is no Remove-Item parameter, so `rm -rf build`, `sudo rm -rf /var/www`, `rm -fr` and `rm --recursive` were allowed; so were POSIX evasions such as `"rm" -rf` and `env ... rm -rf`. These hosts do not say which shell runs a command, and on Windows it may be PowerShell, cmd.exe, Git Bash or WSL, so a command is now read in all three dialects and the strictest verdict wins: a command is never judged more loosely on Windows than on macOS or Linux. When a reading other than PowerShell decides, the reason says which. The Claude Code adapter was not affected (its `Bash` and `PowerShell` tools name their shell).
- The destructive guard also reads a PowerShell `rm` as the POSIX `rm` (pwsh on macOS and Linux runs `/bin/rm`), so `rm -rf` under the `PowerShell` tool or `check --shell powershell` asks.

### Tests
- The adapter case tables, the session and unattended cases and the opencode plugin end-to-end tests run with the platform forced to `win32` as well as `darwin`, so the Windows branch runs on every machine; `test/windows-dialects.test.ts` checks that every POSIX command in the guard case files gets at least the macOS and Linux verdict on Windows, through all three adapters.
- The CLI test of `sandbox plan --json` plans for the machine's own platform family (a Linux plan of a Windows drive path is refused, now asserted on its own).

## 0.3.0 (2026-11-23)

### Added
- `openmorals hook codex`, `hook gemini-cli` and `hook opencode`, and `openmorals init --agent claude-code|codex|gemini-cli|opencode`: the same guards, loop detector, taint judge, budget and audit log for Codex CLI (`PreToolUse` hook), Gemini CLI (`BeforeTool` hook) and opencode (a plugin). An existing config file is merged and backed up first; one that cannot be parsed is left alone and the snippet is printed. Built from each tool's documentation and source; not yet run against the live tools.
- The independent reviewer: with `reviewer.enabled: true`, every ask in the Claude Code hook is first shown to a second model, which can add a note or (with `on_escalate: deny`) turn it into a deny, never an allow. Failures keep the ask. Off by default; `provider: fake` is a dry run. `openmorals check --review` runs it on demand.
- `openmorals sandbox plan [--json] [--platform ...]` and `openmorals sandbox run -- <cmd>`: run a command under macOS `sandbox-exec` or Linux `bwrap` with writes limited to the project and temp folders, credential files unreadable and the network off; exit code 125, running nothing, when the tool is missing or on Windows (plan only). Optional `sandbox` section in the bylaws.
- Library exports: the reviewer, the sandbox, the three adapters as namespaces (`codexAdapter`, `geminiCliAdapter`, `opencodeAdapter`), `installAgentHook`, the destructive guard's `normalizeAllowTarget`, `matchesAllowTarget` and `isSafeAllowTarget`, and `hasOpenMoralsHook(settings)`.

### Changed
- The self-protect guard also covers the Codex, Gemini CLI and opencode hook and plugin files (`.codex/hooks.json`, `.codex/config.toml`, `.gemini/settings.json`, `.opencode/plugins/`, `opencode.json` and their user-level forms), and the sandbox keeps them read-only.
- `packs.loosenings` also reports a reviewer switched off, a softer `reviewer.on_escalate`, and wider sandbox settings.

## 0.2.0 (2026-11-23)

### Added
- `openmorals scan <path> [--json]`: a static scanner for skills, Claude Code plugins, MCP configs and npm packages before you install them (hidden instructions, secret exfiltration, download-and-execute, persistence, over-broad permissions, unpinned remote servers, obfuscation). Exit code 0 allow, 1 ask, 2 deny.
- `openmorals trash <path>`, `trash --list`, `restore <id>` and `purge --older-than <days> --yes`: move files into a per-project trash with an undo log instead of deleting them. The first trash writes `.openmorals/.gitignore` so the trash is never committed.
- `openmorals guidance [--file AGENTS.md|CLAUDE.md|GEMINI.md] [--remove]`: writes the bylaws as plain instructions for the agent into a marked block, leaving the rest of the file alone.
- `openmorals packs` and `openmorals init --pack <name>`: five ready-made bylaws (`solo-dev`, `strict`, `beginner`, `production-ops`, `ci-unattended`).
- Loop detector and taint judge (Rule of Two) in the Claude Code hook, switchable with `guards.loop` and `guards.taint` in the bylaws (`taint.trusted_hosts` exempts trusted sites). The session file keeps the last 20 actions, redacted, and the taint state.
- `PostToolUse` and `PostToolUseFailure` handling: the hook records each call's outcome so a command that keeps failing the same way is caught. `openmorals init` installs these two events next to `PreToolUse`.
- `--unattended` on `check`, `scan` and `hook claude-code` (or `OPENMORALS_UNATTENDED=1`): every ask becomes deny, for CI.
- Library exports for the scanner (by name) and for `undo`, `guidance`, `loop`, `taint` and `packs` (as namespaces), plus `reachesNetwork`, `NETWORK_COMMANDS` and the session helpers. The package now ships `packs/`.

### Changed
- When the destructive guard stops an `rm`, `Remove-Item`, `del` or `rd`, its reason names `openmorals trash <path>` as the recoverable alternative.
- The self-protect guard also covers `.openmorals/` (the trash and undo log) and `openmorals init`/`purge` run by the agent.
- The secrets guard and the taint tracker share one network-command list, so the secrets guard now also counts `git push`, `npm publish`, `docker push` and cloud CLIs as reaching the network (for example, `git add -f .env && git push` is denied as a send).

### Fixed
- In cmd and PowerShell, `timeout /t 5` is the Windows sleep command; the parser had treated it as the POSIX `timeout` wrapper around a command named `5`.

## 0.1.0 (2026-11-23)

- First release: the policy engine (`decide`), the bylaws file and its validator, the destructive, online-delete, secrets, self-protect and budget guards with their case files, the Claude Code `PreToolUse` hook, and the `check`, `init`, `validate` and `audit` commands.
