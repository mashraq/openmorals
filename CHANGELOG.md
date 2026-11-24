# Changelog

All notable changes to openmorals. Versions follow [semantic versioning](https://semver.org/); while the version is 0.x, a minor release may change behaviour, and every API change is listed in [API.md](API.md#changes).

## 0.6.0 (unreleased)

### Security
- **A project `openmorals.yaml` can only tighten the user-level one** (requirement ENG-10, [ADR 0010](docs/adr/0010-the-user-file-is-a-floor.md)). Before, the nearest project file replaced the user file, so a cloned repository could set any guard to `allow`, raise or switch off the budget, add allowed delete targets, trusted or sandbox hosts, switch off audit or scanning, and point the reviewer at another model and key variable. Now the user-level file (or the defaults) is the floor; looser project settings are ignored, printed by `check` and `validate`, and noted in each decision's reason (`note bylaws.loosening-ignored`). The reviewer's provider, model, key variable, timeout and switch, and `guards.inbound.notify`, come from the user file only. An invalid project file fails closed on the user floor, not the looser defaults.

### Added
- **Reviewer protocols** (requirement RVS-08, [ADR 0011](docs/adr/0011-reviewer-protocols-not-sdks.md)): `reviewer.provider` takes `anthropic-messages` (the default; `anthropic` still works), `openai-chat` (OpenAI and compatible services, and local servers such as Ollama, LM Studio, vLLM and llama.cpp through `base_url`) and `gemini`. New `reviewer` keys `base_url` (https, or http to this machine only), `auth: none` (send no key) and `compat` (`token_param`, `system_role`, openai-chat only). Each protocol is a small client on the global `fetch`; no dependency was added. A named protocol without `api_key_env` reads its own variable (`OPENAI_API_KEY`, `GEMINI_API_KEY`). Every odd reply (refusal, filter, truncation, wrong shape, HTTP error, redirect) escalates and keeps the ask.

- **Opt-in inbound judge** (requirement INB-06, [ADR 0012](docs/adr/0012-silent-taint-and-an-opt-in-judge.md)): `guards.inbound.judge: true` in the user-level file sends the lines a weak finding flagged in a tool result (at most 1,000 characters, redacted, cached by hash in the config directory) to the reviewer's provider. Its escalate, or any failure, marks the session as injected, so later network and private-data steps ask; no-objection changes nothing. Off by default, so the default token cost stays zero. Claude Code hook only.

- **Token counting where the host reports it, and an optional cost limit** (GRD-10, GRD-11): Codex's `PostModelRequest` hook (installed by `init --agent codex`) adds each model request's `token_usage` to the session budget. `guards.budget.prices` (user-level only, empty by default) and `guards.budget.cost` (hundredths of that currency, off by default) turn tokens into spend. Claude Code, Gemini CLI and opencode report no session usage to hooks; there only tool calls are counted, as `docs/adapters.md` says.

### Fixed
- **opencode 2.x: the call id was never read.** opencode 2's tool hooks name the call id `id` (v2.4.1 types), not `callID`; the plugin (now format 3) reads `id`, so the loop detector matches outcomes to calls again. It also scans `result.content` (a string or text parts) as well as `result.output`. `docs/adapters.md` lists which V2 fields are verified and which inferred.
- **A soft token step reported between two calls never asked**: `countToolCall` reset the comparison point to the current count just before judging. The comparison point is now the count at the last judged call.

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
