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

---

## Known defects

Open defects, with the date found. When one is fixed, add a dated line under it saying which version fixed it; do not delete it.

### D-1: `--help` after a subcommand runs the subcommand (found 2026-11-24)

- `openmorals guidance --help` does not print help; it writes an `AGENTS.md` with the openmorals block into the current folder.
- `openmorals init --help` does not print help; it writes `openmorals.yaml` and installs the Claude Code hook in `.claude/settings.json` in the current folder.
- `packs --help`, `audit --help` and `validate --help` run their command (harmless). `trash --help` and `scan --help` print a usage line and exit 64.
- Cause: the command dispatcher in `src/cli.ts` checks `--help` only when no subcommand is given.
- Measured on 0.3.1 in empty temporary folders. Requirement EXT-07. Status: open.

### D-2: guidance wording (found 2026-11-23)

- The guidance block says openmorals "asks" about loops and Rule-of-Two cases even when the bylaws set those to deny.
- Its self-protect line names `.claude/settings.json` but not the Codex, Gemini CLI or opencode hook files, which the guard does protect.
- Cosmetic: the hook enforces the real decision. Status: open.

### D-3: `packs.loosenings` compares lists differently from the engine (found 2026-11-23)

- It compares `allow_targets` lower-cased and without the engine's normalisation, so `./dist/` against `dist` is reported as a loosening and `DIST` against `dist` is not. It does not report a change of budget `step`.
- Affects reports only, not decisions. Status: open.
