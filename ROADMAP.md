# Roadmap

Everything here is **not in a release yet**. The README describes only what exists and is tested; [CHANGELOG.md](CHANGELOG.md) lists what each release added.

## Next
- **Run the adapters against the live tools.** Codex, Gemini CLI and opencode are built from their documentation and recorded event shapes; they still need a run in each real tool That run must also show whether each host's hook fires for its child-agent and message tools (0.14.0) and inside a child agent.
- **Antigravity CLI.** Google stopped serving Gemini CLI to Google AI Pro and Ultra users and free Gemini Code Assist individual users on 18 June 2026 and points them to Antigravity CLI. Its hooks (`.agents/hooks.json`, `PreToolUse` with `toolCall`, a `decision` of allow, ask, deny and more) differ from Gemini CLI's, so it needs its own adapter (see docs/adapters.md).
- **Measure the inbound judge** (built in 0.6.0, off by default) on a corpus against the pattern scan alone; and a lighter post-tool entry point, since post-tool hooks start a second process per call.
- **An external-command reviewer protocol** for providers that need request signing or a cloud login (Bedrock, Vertex) or a subscription login, with the same fail-closed mapping.
- **The reviewer and the inbound judge on the other hosts**, and a first call against each real API with a published transcript.
- **Host allow-lists in the sandbox** by driving Anthropic's `srt` (today the built-in runners keep the network off), a run of the bubblewrap plan on Linux (including `sandbox.write.protected_paths`, shipped in 0.17.0 and enforced by pattern on macOS only), and an enforced plan on Windows.
- **Token budgets on Claude Code, Gemini CLI and opencode.** Codex and OpenClaw report usage to hooks (0.6.0); these three do not (Gemini CLI only per streamed chunk). Count them when a host documents a session-level source.
- **`openmorals tests fail-first` on real projects** (shipped in 0.17.0, run only on fixture repositories): its wall time under concurrency 1 on the owner's repositories, the share of pointer lines judged real "tests nothing" cases (the kill criterion), a real run of the pytest, Jest, Vitest, Go and Flutter report readings, and Windows (it needs `/bin/sh` today).
- **Work orders for `openmorals diff-class`** (the command shipped in 0.12.0, test-integrity reasons in 0.13.0): an approved list of the paths a task may touch, so the gate reads `--paths` from the order rather than from its own script, and `tests fail-first` reads the acceptance tests (today `--expect-red`) from it, and the nuisance rate of the reason lines measured on real sessions before any of them is suggested as a default. Then a docs tier, opt-in and only after the scanner's miss rate on a seeded corpus of docs with hidden instructions is measured, and a run of the verdict as a CI check pinned to an app identity.
- **Packs built on rule matching** (content rules over writes, call arguments and agent messages shipped in 0.15.0; detectors, `match.network: true` and `guards.taint.private_paths` shipped in 0.16.0, all failing closed when the text was cut): information security, outward actions, privacy, health data, regulated software. Each pack lists what it enforces and what is advice only. None is a compliance claim.
- **Rule matching on network targets** (which host a command or call sends to): `match.network` says only whether an action reaches the network, because the taint computation does not extract hosts from commands.
- **Content rules where 0.15.0 sees no content:** files written by a shell command (`echo ... > file`, a heredoc). Since 0.16.0 detectors read raw argument values in memory; `match.content` still reads them after redaction, so a content pattern cannot match a token in an MCP argument.
- **More detectors**: labelled-context identifiers (medical record and health-plan numbers, national tax ids with their check digits), public IPv4 addresses, private-key blocks; and a measured false-alarm rate for each detector on a corpus of ordinary code.
- **Deferred asks beyond Claude Code** (shipped for Claude Code in 0.19.0, not run live): the other four hosts need a channel only the person reads for the approval code (each host's user-only message, or OpenClaw's native approval), and a live run that shows Claude Code shows `systemMessage` to the person and not to the model. A desktop notification is not built.
- **The document guard where it sees only a file name**: opencode V2 edits (every edit of an existing document asks there), OpenClaw `edit`, in-place edits by a program (`sed -i`, `perl -i`), `git rm -r` of a folder; and its ask rate measured on agent sessions (0.18.0 measured it only by replaying commit histories).
- **The outbound guard on live hosts and daily work** (shipped in 0.20.0, built from documentation): a live run that captures a browser tool's real result shape (the page URL and snapshot lines it reads), once-per-site-and-field on the four other hosts, and its ask rate measured on real browsing, mail and form sessions (0.20.0 measured it only over URLs in repository histories). Then: mail headers in more result shapes, a Reply-To that differs from From named in the reason, and a team-managed list of an organisation's own sites.
- **The delete guard on a live agent** (shipped in 0.21.0, not run live): whether an agent runs `openmorals trash` after the refusal or routes round it; whether the line at the next message reaches the person on each host; the ask rate of `delete.ask` in daily sessions; how many `rm -f` calls name a single file the trash could take; whether moving a non-document out of the project should ask (a move is not in the delete guard's list today).
- **A budget across a tree of agents**, keyed by a run id.
- **MCP tool classification.** Let the bylaws mark each MCP tool as read-only or destructive, and ask for unknown ones.
- **Scanner flags on the CLI:** `--max-file-bytes`, `--max-files`, `--disable <rule-id>` (the library already takes them).
- **Loop detector limits in the bylaws** (the thresholds are fixed defaults today).

- **Publish**: the npm package, the first GitHub release of the binaries (the release workflow exists and has a dry-run mode) and the wheels on PyPI.
- **Measure the binary on every target**: size and start time per OS from the release dry run, written into docs/distribution.md.

## Later
- **Signed binaries**: a Developer ID signature and notarisation on macOS and Authenticode on Windows, so Gatekeeper and SmartScreen stop warning; and signed checksums (for example Sigstore), so a download can be tied to this repository's workflow.
- **More binary targets**: Linux musl (Alpine), Windows on Arm.

## Not planned
- Merging changes, orchestrating agents, or a model step that lowers the level of review (ADR 0001, ADR 0013). The host's own auto-merge can consume a required check; openmorals holds no credential that can merge.
- Approving actions on the user's behalf. openmorals can make an agent ask or stop, but it never grants permission the host would not.
