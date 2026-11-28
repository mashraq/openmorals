# 0002. TypeScript on Node as the one engine; a binary and a Python wrapper are distribution, not rewrites

- Status: Accepted (engine: built since 0.1.0; binary and Python package: built in 0.4.0, not yet published)
- Date: 2026-11-23 (engine); 2026-11-24 (distribution)

## Context

openmorals must run on Windows, macOS and Linux, on every tool call, from whatever shell the host agent uses. The maintainer asked why TypeScript and npm, and whether bash scripts or Python scripts would be more widely available. He then decided on "distribution, not a rewrite": a single-file binary per OS, and a thin Python package that only calls that binary.

Facts (from public sources read 23 to 24 Nov 2026):

- Claude Code, Gemini CLI and opencode are written in TypeScript. Codex CLI moved to Rust and ships a native binary with an npm wrapper.
- On native Windows, Claude Code falls back to PowerShell when Git Bash is absent, so a bash hook breaks on a stock Windows machine.
- Python runs well on Windows once installed, but a user has to install it and pick a version first; Python-based agent tools lean on a separate installer to hide this.
- Node can build a single executable application (SEA) from a bundled script; the official Node binaries are needed for that.

## Decision

1. **One engine, in TypeScript, run on Node 20 or later.** Built (0.1.0). Strict compiler settings, no `any`. One runtime dependency (`yaml`).
2. **No bash or Python version of the engine.** A second implementation would drift from the first, and a security rule that behaves differently by language is a hole.
3. **No shell scripts in the product.** Paths go through `node:path`; the engine never shells out to judge. Commands the agent runs are parsed, never executed, by openmorals. Built.
4. **Distribution channels, all running the same engine:** Built (0.4.0), none published yet. Details: [docs/distribution.md](../distribution.md).
   - a single-file binary per OS, built with Node's own single-executable support from the bundled CLI, so no Node install is needed; a script checks that it gives the same answer as the Node CLI for every guard case;
   - a thin Python package that only runs that binary, after checking its SHA-256, for people who live in Python;
   - npm (`npx openmorals ...`).

## Alternatives and why they lost

- **Bash scripts.** Not available on stock Windows; quoting and path rules differ by shell; hard to test with case tables.
- **Python as the engine.** Fine as a language, but the user must install a Python first, and version pins and install paths differ on Windows. The Python wrapper gives Python users the same convenience without a second engine.
- **Rust or Go.** Best single-binary story and smallest memory, but slower to change for a small team, and the agent tools and their plugin authors are mostly in TypeScript. A small native helper for sandboxing may still be worth it later.
- **Bun as the runtime.** Considered in the research for its compiler. Rejected for now: Node is what users already have and what CI tests; the code avoids runtime-specific APIs so this can be revisited.

## Consequences

- Each hook call starts a Node process: about 0.09 s per call on one Apple-silicon laptop, about half of it Node's own start (measured 24 Nov 2026). Not measured on Linux or Windows.
- Until a release is published, a user needs Node. With any route, the hook needs `openmorals` on the PATH the host sees; if it is not found, the host runs the tool unguarded ([threat-model.md](../architecture/threat-model.md)).
- The binary build refuses a Node that links its core as a shared library, because the result would not be a single file. (Found while building: such a Node cannot make a single executable at all.)
- The binaries are not signed by a developer certificate yet, so macOS and Windows warn on first run. Signing is Planned.

## Addendum, 0.42.0: the npm route

Point 4's npm route is no longer `npx openmorals ...`. The hook needs the same program every time, and `init` refuses a hook command that runs through a package runner, so the route is an exact version installed globally: `npm install -g openmorals@<version>`, once it is published ([docs/distribution.md](../distribution.md)). A package runner is fine for a one-off check. Point 4's "Built (0.4.0)" means the code to build each route exists; none is published, and no release has made a binary or a wheel. The decision itself is unchanged.
