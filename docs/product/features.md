# Features

Every feature with its status. **Built (version)** means released and tested in that version. **Planned** means not built. **Rejected** means considered and turned down, with the reason in the linked decision.

## Judging actions

| Feature | How to use it | Status | Details |
|---|---|---|---|
| Policy engine: allow, ask or deny with rule and reason | `decide()` in the library | Built (0.1.0) | [API.md](../../API.md#engine) |
| Command parser that sees through quotes, wrappers, `bash -c`, `$(...)`, variables, multi-line commands | automatic | Built (0.1.0) | [overview.md](../architecture/overview.md) |
| Destructive guard | automatic; `guards.destructive` | Built (0.1.0) | [guards.md](../architecture/guards.md#destructive) |
| Online-delete guard | automatic; `guards.online-delete` | Built (0.1.0) | [guards.md](../architecture/guards.md#online-delete) |
| Secrets guard (read, write, send) | automatic; `guards.secrets` | Built (0.1.0) | [guards.md](../architecture/guards.md#secrets) |
| Self-protect guard | automatic; `guards.self-protect` | Built (0.1.0; other hosts' files 0.3.0) | [guards.md](../architecture/guards.md#self-protect) |
| Budget guard: tool calls per session | automatic; `guards.budget.tool_calls` | Built (0.1.0) | [guards.md](../architecture/guards.md#budget) |
| Budget guard: tokens per session | `guards.budget.tokens` | Built (0.1.0) where the host reports tokens; **Planned** for Claude Code (its hook input has no token counts) | |
| Budgets in money (priced per model) | | Planned | [ROADMAP.md](../../ROADMAP.md) |
| Your own rules (`rules[]`), ask or deny only | `openmorals.yaml` | Built (0.1.0) | [API.md](../../API.md#openmoralsyaml-schema-version-1) |
| Rules on what is written (`match.content`): a pattern over a write's content, a call's arguments and an agent message, failing closed over 256 KB | `openmorals.yaml` | Built (0.15.0) on all five hosts from documentation; not run live | [docs/adapters.md](../adapters.md#content-rules-what-content-carries-on-each-host-0150) |
| Detector rules (`match.detector`): nine built-in detectors (vendor tokens, card numbers with Luhn, IBAN mod-97, US SSN, NHS number mod 11, email, phone, HL7 header, FHIR Patient) over what is written, command lines, URLs and a tool's raw input; likely patterns only, not a compliance control | `openmorals.yaml` | Built (0.16.0) from documentation; not run live | [docs/architecture/guards.md](../architecture/guards.md#detectors-and-network-0160) |
| Rules that apply only on the network (`match.network: true`), by the taint guard's own computation | `openmorals.yaml` | Built (0.16.0) | [docs/architecture/guards.md](../architecture/guards.md#detectors-and-network-0160) |
| Declared private files for the taint guard (`guards.taint.private_paths`) | `openmorals.yaml` | Built (0.16.0) | [docs/architecture/guards.md](../architecture/guards.md#guardstaintprivate_paths-0160) |
| Document guard: ask before a document is deleted, a file emptied, more than 25% of a document cut or a heading removed, and when it cannot tell | automatic; `guards.document` | Built (0.18.0) on all five hosts from documentation; not run live; asks in the host's prompt; held for later approval on Claude Code since 0.19.0 (below) | [guards.md](../architecture/guards.md#document-0180), [docs/adapters.md](../adapters.md#document-guard-what-each-hosts-write-tools-give-it-0180) |
| Delete guard: a plain delete of any existing file refused with the trash command named where the project trash can take it, asked where it cannot, refused for a path built at run time; since 0.22.0 also a move into a temp folder, `mv`/`cp` onto an existing file and documents inside the project; one line at your next message counts what went to the trash and names the newest three | automatic; `guards.delete.decision`, `guards.delete.steer` | Built (0.21.0) on all hosts; the line on Claude Code, Codex and Gemini CLI; not run live | [docs/delete.md](../delete.md) |
| Outbound guard: where a form, a message or a link sends data; a password or code into a look-alike of your site or a relayed one-time code is denied, every other signal asks once per site and field | automatic; `guards.outbound`, `sites`, `data_classes` (user-level), `protect` (0.23.0; user-level and project) | Built (0.20.0) on all five hosts from documentation; not run live; once-per-site-and-field on Claude Code only | [docs/outbound.md](../outbound.md), [guards.md](../architecture/guards.md#outbound-0200) |
| Loop detector (repeats, polling, near-repeats, repeated failures) | automatic in hooks; `guards.loop` | Built (0.2.0); repeated failures only on Claude Code | [docs/extras.md](../extras.md) |
| Loop thresholds set in the bylaws | | Planned | |
| Taint judge (Rule of Two) | automatic in hooks; `guards.taint` | Built (0.2.0) | [docs/extras.md](../extras.md) |
| Fail closed on every error | automatic | Built (0.1.0) | [ADR 0005](../adr/0005-fail-closed-ask-on-error.md) |
| Unattended mode: ask becomes deny | `--unattended` or `OPENMORALS_UNATTENDED=1` | Built (0.2.0) | |
| Deferred ask: a deletion or document ask is held (denied with a reason telling the agent to carry on, queued), and the exact call may run once after the person approves it with a code the agent never sees | automatic under `--unattended`; `defer: true` for attended sessions | Built (0.19.0) on Claude Code only, from documentation; not run live; other hosts unchanged | [docs/deferred-asks.md](../deferred-asks.md) |
| Windows: read each command in three dialects | automatic on Codex, Gemini CLI, opencode | Built (0.3.1) | [ADR 0008](../adr/0008-windows-three-dialects-keep-the-strictest.md) |
| MCP tool classification in the bylaws | | Planned (today: a name heuristic in every adapter, Claude Code since 0.8.1) | |
| Answering "allow" to a host to skip its prompts | | Rejected | [ADR 0009](../adr/0009-never-grant-permission-the-host-would-not.md) |

## Hosts

| Feature | How to use it | Status | Details |
|---|---|---|---|
| Claude Code hook (`PreToolUse`; `PostToolUse` and `PostToolUseFailure` for outcomes) | `openmorals init` | Built (0.1.0; post events 0.2.0) | [README](../../README.md#use-it-with-claude-code) |
| Codex CLI hook (`PreToolUse`; ask sent as a block) | `openmorals init --agent codex` | Built (0.3.0); not run against live Codex | [docs/adapters.md](../adapters.md) |
| Gemini CLI hook (`BeforeTool`) | `openmorals init --agent gemini-cli` | Built (0.3.0); not run against live Gemini CLI | [docs/adapters.md](../adapters.md) |
| opencode plugin | `openmorals init --agent opencode` | Built (0.3.0); not run against live opencode | [docs/adapters.md](../adapters.md) |
| Post-tool events on Codex, Gemini CLI, opencode (outcomes for the loop detector, inbound scanning) | `guards.loop`, `guards.inbound` | Built (0.5.0); opencode V1 reports no failures | [docs/adapters.md](../adapters.md#post-tool-and-prompt-events-050) |
| Antigravity CLI | | Planned: hook format not checked | [docs/adapters.md](../adapters.md#post-tool-and-prompt-events-050) |
| Other hosts (for example Cursor) | | Planned, not started | |

## Commands a person runs

| Feature | Command | Status | Details |
|---|---|---|---|
| Judge a command line | `openmorals check "<command>"` (`--json`, `--shell`, `--bylaws`, `--review`) | Built (0.1.0; `--review` 0.3.0) | [README](../../README.md#60-second-demo) |
| Set up a project | `openmorals init [--agent ...] [--pack ...]` | Built (0.1.0) | |
| Validate the bylaws | `openmorals validate` | Built (0.1.0) | |
| Read the audit log | `openmorals audit` | Built (0.1.0) | |
| Verify the audit log | `openmorals audit verify [--run ID]` | Built (0.8.0) | [docs/audit.md](../audit.md) |
| Summarise a run | `openmorals audit --run ID [--json]` | Built (0.8.0) | [docs/audit.md](../audit.md) |
| Draw finished runs (or sessions) at random for a close read; record clean or escape; count escapes | `openmorals audit sample` (`--record`, `--change`, `--tally`, `--json`) | Built (0.11.0); 1 in N from a user-level file, a seed from the OS random source, every form that writes asked about when an agent runs it; no model call; a sample finds what a reader notices, not everything | [docs/audit.md](../audit.md#openmorals-audit-sample) |
| Score the guards on the case rows, or on your own rows: catch rate, false alarms, time per decision | `openmorals eval` (`--json`, `--cases`, `--guard`, `--bylaws`) | Built (0.7.0); no model call | [docs/eval.md](../eval.md) |
| Scan a skill, plugin, MCP config or package before install | `openmorals scan <path>` | Built (0.2.0) | [docs/scanner.md](../scanner.md) |
| Scanner limits on the command line (`--max-file-bytes` and others) | | Planned (the library takes them) | |
| Trash, restore, purge | `openmorals trash`, `restore`, `purge --older-than N --yes` | Built (0.2.0) | [docs/extras.md](../extras.md) |
| Write the rules into `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` | `openmorals guidance` | Built (0.2.0); says "blocks" or "asks" from the bylaws and names every host's hook file since 0.5.0 (D-2) | [requirements-log.md](requirements-log.md#known-defects) |
| Ready-made bylaws | `openmorals packs`, `init --pack` | Built (0.2.0) | [docs/extras.md](../extras.md) |
| Ask before an agent edits the tests that judge it (declared judging tests, runner config, snapshot updates, `--passWithNoTests`, `--no-verify`) | the `test-lock` pack; `openmorals packs test-lock` prints it | Built (0.9.0): add-on, off unless added; rules only, no model call; recorded event shapes, not a live host | [docs/extras.md](../extras.md#the-test-lock-pack-090) |
| Compare two test runs by test name: tests that now pass, and tests that passed and now fail, are gone or are skipped; exit 1 on an unapproved loss | `openmorals tests compare <before> <after>` (`--json`) | Built (0.10.0); reads JUnit XML, Jest/Vitest JSON, `go test -json`, `flutter test --machine`; runs no tests, no model call; cannot tell which tests the agent could edit | [docs/tests-compare.md](../tests-compare.md) |
| Run a change's new and changed tests on the base commit: per test, fails by assertion, red for the wrong reason, or passes on base; exit 1 only for named acceptance tests | `openmorals tests fail-first --base REV --expect-red TEST` (`--json`, `--reports DIR`); test command in `tests.yaml` in the config directory | Built (0.17.0); run only on fixture repositories; executes project code, so for a gate machine or a sandbox; not on Windows | [docs/tests-fail-first.md](../tests-fail-first.md) |
| Say whether a diff may merge without being read, or needs review, with the facts behind it | `openmorals diff-class <diff> [--base DIR] [--reproduced FILE] [--run ID] [--summary FILE] [--json]` | Built (0.12.0); nothing review-free unless the user-level file switches a class on (tighten-only, reproduced); anything not fully understood needs review; the run record only adds review; no model call, writes nothing; 0 of this repository's 60 commits review-free | [docs/merge-verdict.md](../merge-verdict.md) |
| Point at changes that may weaken their own tests (assertions lost, skips, snapshots, runner config, scripts, exit calls, changed expected values, equality overrides, suppressions, new dependencies, files outside declared paths, size, boundary paths without a decision record) | `openmorals diff-class` (`--paths`, `--max-lines`, `--max-files`, `merge.boundary_paths`) | Built (0.13.0); reason lines only, can only add review, no ask, no block, no score; 13 of this repository's 62 commits fire, all honest; nuisance rate on real sessions not measured | [docs/test-integrity.md](../test-integrity.md) |
| Plan an OS sandbox from the bylaws | `openmorals sandbox plan` | Built (0.3.0) | [docs/sandbox.md](../sandbox.md) |
| Run one command in the sandbox | `openmorals sandbox run -- <cmd>` | Built (0.3.0): macOS and Linux; Windows refuses | [docs/sandbox.md](../sandbox.md) |
| Keep the tests that judge the work read-only in the sandbox | `sandbox.write.protected_paths: [test-lock]` in the user-level file | Built (0.17.0): enforced on macOS (measured); Linux only the paths found now, not run; Windows plan only | [docs/sandbox.md](../sandbox.md#protected-paths-sandboxwriteprotected_paths-0170) |
| Allowed hosts in the sandbox (via Anthropic's `srt`) | | Planned | |
| Enforced Windows sandbox | | Planned | |
| Wrap a whole agent in the sandbox | | Planned | |
| List, approve or refuse held actions | `openmorals pending [--all] [--json]`, `openmorals approve <code>` (or `<id>` in a terminal), `openmorals refuse <id>`; or type `approve <code>` in the Claude Code chat | Built (0.19.0); `approve` run by an agent is a self-protect ask | [docs/deferred-asks.md](../deferred-asks.md) |
| Help for each subcommand | `openmorals <command> --help`, `-h`, `openmorals help <command>` | Built (0.5.0): prints usage and does nothing else (D-1 fixed); unknown options are usage errors | [requirements-log.md](requirements-log.md#known-defects) |

## Second opinion

| Feature | How | Status | Details |
|---|---|---|---|
| Reviewer model on asks, escalate-only | `reviewer.enabled: true` | Built (0.3.0), Claude Code and `check --review` only; never called a real API | [ADR 0007](../adr/0007-reviewer-can-only-escalate.md), [docs/reviewer.md](../reviewer.md) |
| Reviewer on the other hosts | | Planned | |
| Reviewer that can approve | | Rejected | [ADR 0007](../adr/0007-reviewer-can-only-escalate.md) |

## Inbound content and prompts

| Feature | Status | Details |
|---|---|---|
| Scan fetched pages and tool results for hidden instructions as they arrive; taint the session silently, never block reading | Built (0.5.0) on Claude Code, Codex, Gemini CLI and opencode; not run against the live tools | [docs/scanner.md](../scanner.md#inbound-scanning-050) |
| Scan the user's prompt on submit: hidden characters warn or block, secret-shaped values are held back, phrases only mark the session | Built (0.5.0); opencode cannot block or warn the user | same |
| Scan what one agent hands to another (a child agent's prompt, a subagent's report, a message to another agent) before the call; record and mark the session silently | Built (0.14.0) on all five hosts from documentation; not run live; the mark reaches the receiver only where it runs in the same session | [docs/adapters.md](../adapters.md#content-bearing-actions-tool-arguments-and-agent-messages-0140) |
| Carry a call's arguments (redacted, capped) for content checks | Built (0.14.0); read by content rules since 0.15.0 (after redaction); a raw copy, never stored, read by detectors since 0.16.0 | [API.md](../../API.md) |
| A notice to the model for each finding | Built (0.5.0), off by default (`guards.inbound.notify`), because it costs tokens on every later call | [enforcement-model.md](../architecture/enforcement-model.md#what-to-build-next) |
| Optional model screening of prompts or tool results, escalate-only | Planned, only if the deterministic scan proves too weak | same |
| All rules loaded into the agent's context as the main defence | Rejected | [ADR 0004](../adr/0004-enforcement-outside-the-model.md) |

## Records

| Feature | Status | Details |
|---|---|---|
| Audit log, one redacted JSON line per decision | Built (0.1.0) | [API.md](../../API.md#audit-log) |
| Hash-chained audit log: one chain per session, version, bylaws digest, host event, run id, agent id, ask outcomes | Built (0.8.0) | [docs/audit.md](../audit.md); a program running as the user can still rewrite it |
| Session memory: counter, last 20 actions, taint | Built (0.2.0) | |

## Distribution

| Feature | Status | Details |
|---|---|---|
| Build from a clone, `npm link` | Built | [README](../../README.md) |
| `npx openmorals` from npm | Built as a package; not yet published | [docs/distribution.md](../distribution.md) |
| Single-file binary per OS (Linux x64/arm64, macOS arm64/x64, Windows x64), with `SHA256SUMS` | Built (0.4.0) by the release workflow; no release made yet; binaries not signed | [docs/distribution.md](../distribution.md) |
| Binary checked to give the same answers as the Node CLI, case by case | Built (0.4.0) | [docs/distribution.md](../distribution.md) |
| Thin Python package that runs the binary (`pip install openmorals`, `openmorals.check()`) | Built (0.4.0); not on PyPI yet | [docs/distribution.md](../distribution.md) |
| Signed binaries and signed checksums | Planned | [ROADMAP.md](../../ROADMAP.md) |
| More binary targets (Linux musl, Windows on Arm) | Planned | [ROADMAP.md](../../ROADMAP.md) |
| A bash or Python rewrite of the engine | Rejected | [ADR 0002](../adr/0002-typescript-on-node-as-the-one-engine.md) |
| Library API for other tools | Built | [API.md](../../API.md) |
| Decision service over JSON stdin/stdout for any action kind, and as an MCP server | Planned (today: `check --json` for command lines) | [ADR 0001](../adr/0001-a-guard-layer-not-a-factory-platform-or-standard.md) |
