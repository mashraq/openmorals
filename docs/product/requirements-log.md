# Requirements log

Append-only. Each entry records, with its date, what was asked, what was decided and what is built. Do not edit past entries; add a new entry that corrects or supersedes one, and say which. The current requirements are in [requirements.md](requirements.md).

Status words: **Built (version)**, **Planned**, **Rejected**.

---

## 2026-11-23: start the project

- **Asked:** the maintainer asked for a whole open-source application under the working name openmorals, licensed Apache-2.0, for personal use, published as a public repository. Alongside it, a separate private package for teams that depends on the public one, to be sold later. For now it is only a code base on GitHub.
- **Decided:** TypeScript on Node, one runtime dependency, works on Windows, macOS and Linux with no bash-only scripts. Two repositories. Version 0.1 is a tested core only: engine, bylaws, guards with case files, the Claude Code hook, `check`, `init`, `audit`. Everything else goes in the roadmap, not described as built. See [ADR 0002](../adr/0002-typescript-on-node-as-the-one-engine.md) and [ADR 0003](../adr/0003-apache-2-core-and-a-separate-team-package.md).
- **Built:** 0.1.0 (commits `4d16730`, `ceb6628`).

## 2026-11-23: the safety asks

- **Asked:** do not use too many tokens or resources; always look for security holes and patch them; protect private information very carefully; do not delete folders or information online; check whether an action really makes sense or was a mistake, and otherwise ask the user again. The maintainer framed deletes as "ask first", not "never".
- **Decided:** ask is the default for risky actions; deny by default only for sending a secret over the network and the hard budget limit ([ADR 0006](../adr/0006-ask-by-default-not-forbid.md)). Fail closed on every error ([ADR 0005](../adr/0005-fail-closed-ask-on-error.md)). Every guard ships with a case table of at least 15 cases including evasions, and a test proves each guard is load-bearing. Secret values are never written to the audit log.
- **Built:** 0.1.0.

## 2026-11-23: do not leave the big pieces for later

- **Asked:** the maintainer asked not to leave the sandbox, the reviewer model, the skill scanner, and support for Codex, Gemini CLI and opencode for a future version, and to build them now in the same repository.
- **Decided:** four tracks, each owning its own folders. Where a host has no blocking pre-tool hook, ship the nearest real mechanism and say so. The reviewer can never turn ask or deny into allow ([ADR 0007](../adr/0007-reviewer-can-only-escalate.md)). The sandbox refuses to run when the sandbox tool is absent.
- **Built:** scanner 0.2.0 (`71a87ba`); reviewer and sandbox 0.3.0 (`e4dbc32`, `0134826`, `5069218`); Codex CLI, Gemini CLI and opencode adapters 0.3.0 (`f3cad4d`, `60709a3`). Not run against the live tools; the reviewer has not called a real API; the Windows sandbox is a plan only.

## 2026-11-23: more capabilities to guide agents

- **Asked:** the maintainer asked for further extensions that would help guide agents, including ones he had not named.
- **Decided (by the implementer, from the safety asks):** trash and undo instead of delete; a guidance writer for `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`; a loop detector; a taint tracker (Rule of Two); ready-made policy packs.
- **Built:** 0.2.0 (`795093b`, wired in `134f643`, `665de9f`).

## 2026-11-24: Windows let `rm -rf` through on three hosts

- **Found:** CI on Windows showed the Codex, Gemini CLI and opencode adapters allowing `rm -rf build` and similar, because they read every Windows command as PowerShell.
- **Decided:** read each command as PowerShell, POSIX and cmd and keep the strictest ([ADR 0008](../adr/0008-windows-three-dialects-keep-the-strictest.md)).
- **Built:** 0.3.1 (`1839940`).

## 2026-11-24: why this shape, why this language

- **Asked:** the maintainer asked why this is not an agent factory, an agent standard or an agent platform; how users can still use what other projects in those spaces offer; and why TypeScript and npm, and whether bash or Python scripts are more widely available.
- **Decided:** a guard layer that works with existing hosts and standards ([ADR 0001](../adr/0001-a-guard-layer-not-a-factory-platform-or-standard.md)); one TypeScript engine ([ADR 0002](../adr/0002-typescript-on-node-as-the-one-engine.md)).
- **Built:** no code change; recorded here.

## 2026-11-24: distribution, not a rewrite

- **Asked:** the maintainer decided on a single-file binary per OS, and a thin Python package that only calls that binary, rather than rewriting the engine.
- **Decided:** [ADR 0002](../adr/0002-typescript-on-node-as-the-one-engine.md).
- **Built:** 0.4.0 (`478c860`, `7525280`, `f71128c`, `d68b898`, `e4a56bb`): the binary build, the comparison against the Node CLI, the Python package and the release workflow. Nothing is published yet, and no binary was built on the development machine: a Node linked to a shared library cannot make a single executable, so release binaries come from official Node builds in the release workflow.

## 2026-11-24: documentation, and how enforcement works

- **Asked:** the maintainer asked for the vision, PRD, features, requirements, guards and similar to be documented in the folder that is the usual standard for a git repository. He also asked how openmorals checks hazardous prompts and bad responses or actions: whether it runs checks on a separate guarded agent or loads all the guards into the agent's context and hopes for the best; whether loading them into the context uses more tokens; and what the best ways are and which to use here.
- **Decided:** a `docs/` tree with an index, product documents, architecture documents and numbered decision records. The enforcement question is answered in [enforcement-model.md](../architecture/enforcement-model.md): enforcement is deterministic and outside the model; the guidance block in the context is opt-in advice (481 words in the default form, measured); a model reviewer is optional and escalate-only; prompt and inbound-content scanning is the next thing to build.
- **Built:** this documentation. Inbound-content and prompt scanning: Planned (INB-01, INB-02).

## 2026-11-24: fix the known defects, and scan what comes in

- **Asked:** the maintainer asked how openmorals checks hazardous prompts and bad responses or actions: whether it runs a separate guarded check or loads the guards into the agent's context, and whether that costs tokens (the entry above). The orchestrator ruled: deterministic checks first, no model call, ask rather than forbid, fail closed; fix D-1, D-2 and D-3; build inbound-content and prompt scanning (INB-01, INB-02) on whatever post-tool and prompt events each host really has, checked against its current documentation; add post-tool hooks on the non-Claude hosts so the loop detector sees repeated failures there.
- **Decided:** reuse the install scanner's hidden-instruction rules as a pure function with context rules for everyday content; hidden characters, HTML comments and encoded payloads are strong signals, visible phrases weak; never block reading; on a prompt never block the user's visible words. Each host's post-tool and prompt events were read on 24 Nov 2026 ([docs/adapters.md](../adapters.md#post-tool-and-prompt-events-050)); on Codex and Gemini CLI a post-tool block replaces or hides the result, so it is never used.
- **Built:** 0.5.0. D-1 `fc42387`; D-2 and D-3 `2e74b8e`; inbound and prompt scanning, post-tool hooks on Codex, Gemini CLI and opencode, `guards.inbound` `2ed2249`. Not run against live Codex, Gemini CLI or opencode.

## 2026-11-24: keep the token cost of the add-ons to a minimum

- **Asked:** the maintainer: "these are add o on features as I suspect these will increase token usage, is there any smart way to do this with keeping token usage to a minimum?"
- **Decided (orchestrator, from research on how hooks feed the host's context):** the real token cost is text a hook sends back into the host's context, because it is re-sent on every later call. So by default a finding in a tool result is recorded silently (taint and audit, 0 tokens) and the model is told only when a later action is actually stopped, in that one-line reason. A per-finding notice is opt-in (`guards.inbound.notify: false`). In a prompt, hidden Unicode and secret-shaped strings act; phrases in the user's own words only mark the session. No model call anywhere.
- **Built:** 0.5.0 (`2ed2249`). Measured: 0 bytes printed on a finding by default; the later stopped step's reason is 215 characters; the scan takes about 1 ms per 16 KB and at most about 20 ms per result.

## 2026-11-24: Windows-only CI failures at 0.4.0

- **Found:** on windows-latest the release-workflow test failed on correctly pinned `uses:` lines (CRLF checkout), and the binary comparison on windows-x64 differed in 2 of 298 answers only by the temporary folder's name (JSON-escaped, 8.3 short form).
- **Decided:** read workflow files whatever the line ending, keep checkouts LF (`.gitattributes`), normalise every spelling of a folder in the comparison; the CLI's output is unchanged.
- **Built:** `7c85054`.

## 2026-11-24: Gemini CLI's replacement (open item)

- **Found:** Google stopped serving Gemini CLI to Google AI Pro, Ultra and free individual users on 18 June 2026 (enterprise licences and paid API keys keep it) and points them to Antigravity CLI, which keeps hooks ([announcement, 19 May 2026](https://developers.googleblog.com/en/an-important-update-transitioning-gemini-cli-to-antigravity-cli/), read 24 Nov 2026).
- **Decided:** keep the Gemini CLI adapter; an Antigravity CLI adapter needs its hook schema checked first (HST-10).
- **Built:** nothing. Status: Planned.

---

## Known defects

Open defects, with the date found. When one is fixed, add a dated line under it saying which version fixed it; do not delete it.

### D-1: `--help` after a subcommand runs the subcommand (found 2026-11-24)

- `openmorals guidance --help` does not print help; it writes an `AGENTS.md` with the openmorals block into the current folder.
- `openmorals init --help` does not print help; it writes `openmorals.yaml` and installs the Claude Code hook in `.claude/settings.json` in the current folder.
- `packs --help`, `audit --help` and `validate --help` run their command (harmless). `trash --help` and `scan --help` print a usage line and exit 64.
- Cause: the command dispatcher in `src/cli.ts` checks `--help` only when no subcommand is given.
- Measured on 0.3.1 in empty temporary folders. Requirement EXT-07. Status: open.
- 2026-11-24: fixed in 0.5.0 (`fc42387`). Every subcommand prints its usage for `--help` or `-h` (and `help <command>`) and exits 0 before any file is opened; an unknown option on a command other than `hook` is a usage error. `test/cli-help.test.ts` walks every subcommand in an empty folder.

### D-2: guidance wording (found 2026-11-23)

- The guidance block says openmorals "asks" about loops and Rule-of-Two cases even when the bylaws set those to deny.
- Its self-protect line names `.claude/settings.json` but not the Codex, Gemini CLI or opencode hook files, which the guard does protect.
- Cosmetic: the hook enforces the real decision. Status: open.
- 2026-11-24: fixed in 0.5.0 (`2e74b8e`). The loop and taint lines say "blocks" for deny; the self-protect line names `.codex/hooks.json`, `.gemini/settings.json` and `.opencode/plugins/`.

### D-3: `packs.loosenings` compares lists differently from the engine (found 2026-11-23)

- It compares `allow_targets` lower-cased and without the engine's normalisation, so `./dist/` against `dist` is reported as a loosening and `DIST` against `dist` is not. It does not report a change of budget `step`.
- Affects reports only, not decisions. Status: open.
- 2026-11-24: fixed in 0.5.0 (`2e74b8e`). `allow_targets` are compared with the engine's own matcher, and a budget `step` that asks less often is reported.

## 2026-11-24: many models, and token use kept to a minimum

- **Asked:** the maintainer asked how opencode and OpenClaw support many different models and whether openmorals can do the same, and whether the add-on features can keep token use to a minimum. His earlier asks still apply: find and patch security holes, protect private information, ask the user by default.
- **Found:** a project `openmorals.yaml` replaced the user-level file, so a cloned repository could loosen every guard and choose the reviewer's endpoint and key variable.
- **Decided:** the user-level file (else the defaults) is a floor a project file can only tighten; looser settings are ignored and reported, never a crash; endpoint, key, model and other data- or cost-bearing settings are user-level only ([ADR 0010](../adr/0010-the-user-file-is-a-floor.md)). The reviewer speaks three wire protocols through small hand-written clients, with no new dependency ([ADR 0011](../adr/0011-reviewer-protocols-not-sdks.md)). Inbound findings stay silent; a model judge is opt-in, sees only the flagged lines and can only raise a decision ([ADR 0012](../adr/0012-silent-taint-and-an-opt-in-judge.md)). Tokens are counted only where a host reports them; prices are the user's own, none shipped. The Antigravity CLI hook format was read on Google's page and differs from Gemini CLI's; its adapter stays open (HST-10).
- **Built:** 0.6.0 (`d14653a` floor, `a59c1f7` ENG-07 test, `2cb2695` reviewer protocols, `cbcc991` inbound judge, `bd60630` token and cost budgets, `1371d18` opencode 2.x fields, `17ccee1` OpenClaw adapter, `4aefae9` HST-10 record). Requirements ENG-10, RVS-08, INB-06, GRD-10, GRD-11, HST-11, HST-12. Not run against the live tools; no real model API called.

## 2026-11-24: holes found by the team package (0.6.1)

- **Found:** while bringing the team package up to 0.6.0, three things in this package: `reviewer.api_key_env` accepted a mixed-case key as a variable name; a project rule sharing an id with a user rule was reported as "tried to loosen" when nothing was loosened; the generated OpenClaw plugin holds this machine's project path.
- **Decided:** a variable name is 1-64 letters, digits and underscores, all upper case or all lower case, no run over 24 characters between underscores, and nothing the redactors take for a key; the error never repeats the value. Refusing mixed case refuses CamelCase names too; that was preferred to letting mixed-case keys through, since on Windows the upper-case form finds the same variable. The same-id rule note says what happened. The OpenClaw path stays as documented; the docs now say not to commit the folder.
- **Built:** 0.6.1 (`32f127e` key variable name, `b259f17` same-id rule note). Not run against the live tools; no real model API called.

## 2026-11-24: how the guard protects itself (0.6.2)

- **Found:** a review of the self-protect guard and the session state, by reading and then by running each case first: the guard matched only literal folder names, so a config directory under `OPENMORALS_HOME` with another name, a move of the directory or a folder above it, an interpreter one-liner naming the log, and a write through a symbolic link were all allowed; a session file that could not be read (permission, a folder in its place) reset taint and budget to clean; a missing audit log read the same as an empty one.
- **Decided:** self-protect stays `ask`, never `deny` ([ADR 0006](../adr/0006-ask-by-default-not-forbid.md)); it matches the config directory from `configDir()`, the folders above it for commands that move, remove, link, extract onto or copy onto them, paths inside any argument, and paths resolved through links. A program the agent writes and runs, or a `package.json` script run through `npm test`, stays out of a hook's view; the threat model names the OS sandbox as the answer. Only a missing session file starts clean; anything else unreadable reads as tainted and asks once. A missing log is reported as missing.
- **Built:** 0.6.2 (`c8e692c` self-protect, `9e1f2d4` session state and audit log). Requirements GRD-08, REC-06, REC-07. Each fix has a test that fails without it.

## 2026-11-24: score the guards (0.7.0)

- **Asked:** the maintainer asked how to add evals and CI gates to openmorals, and, of add-on features, whether they can be done with token use kept to a minimum.
- **Decided:** an eval over the case rows that already exist, calling no model and spending no tokens: `openmorals eval` scores each guard's catch rate, false-alarm rate, rule mismatches and time per decision, lists every wrong row, and fails closed (exit 2) on rows it cannot read. It scores the guards, not agents; the product is still not an evaluation system for agents ([vision](vision.md)). The shipped rows were written with the guards, so their 100% says the guards match their tables; rows a user writes with `--cases` are how a miss rate on new cases gets measured. No separate CI step: `npm test` already fails on any wrong row and `test/eval.test.ts` asserts the scorer's numbers; the binary job compares `eval --json` between the binary and the Node CLI.
- **Built:** 0.7.0 (`e347d0e` scorer, command and test). Requirement EXT-08. The test that asserts the real catch rate was checked to fail with a guard set that allows everything. Not measured on Linux or Windows; the binary's copy of the rows is proved only by the CI comparison (no binary can be built on the machine where this was written).
