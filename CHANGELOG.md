# Changelog

All notable changes to openmorals. Versions follow [semantic versioning](https://semver.org/); while the version is 0.x, a minor release may change behaviour, and every API change is listed in [API.md](API.md#changes).

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
