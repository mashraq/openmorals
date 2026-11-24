# Roadmap

Everything here is **not in a release yet**. The README describes only what exists and is tested; [CHANGELOG.md](CHANGELOG.md) lists what each release added.

## Next
- **Run the adapters against the live tools.** Codex, Gemini CLI and opencode are built from their documentation and recorded event shapes; they still need a run in each real tool.
- **Antigravity CLI.** Google stopped serving Gemini CLI to Google AI Pro and Ultra users and free Gemini Code Assist individual users on 18 June 2026 and points them to Antigravity CLI. Its hooks (`.agents/hooks.json`, `PreToolUse` with `toolCall`, a `decision` of allow, ask, deny and more) differ from Gemini CLI's, so it needs its own adapter (see docs/adapters.md).
- **Measure the inbound judge** (built in 0.6.0, off by default) on a corpus against the pattern scan alone; and a lighter post-tool entry point, since post-tool hooks start a second process per call.
- **An external-command reviewer protocol** for providers that need request signing or a cloud login (Bedrock, Vertex) or a subscription login, with the same fail-closed mapping.
- **The reviewer and the inbound judge on the other hosts**, and a first call against each real API with a published transcript.
- **Host allow-lists in the sandbox** by driving Anthropic's `srt` (today the built-in runners keep the network off), a run of the bubblewrap plan on Linux, and an enforced plan on Windows.
- **Token budgets on Claude Code, Gemini CLI and opencode.** Codex and OpenClaw report usage to hooks (0.6.0); these three do not (Gemini CLI only per streamed chunk). Count them when a host documents a session-level source.
- **`openmorals eval`**: score every guard on the case files: catch rate, false alarms and time per decision, with no model call.
- **A hash-chained audit log** with a sequence number per session, a digest of the bylaws in force and `openmorals audit verify`, so a missing, edited or truncated record can be detected ([ADR 0013](docs/adr/0013-a-merge-verdict-decided-in-ci-the-record-can-only-raise-review.md)). It does not stop a program running as the user from rewriting the log; an OS sandbox does.
- **`openmorals diff-class`**: a merge verdict computed in CI from the diff. The review-free class is off by default and limited to tighten-only changes and diffs a pinned tool reproduces byte for byte (ADR 0013). On this repository's own history it would have covered none of 43 commits, so expect shorter, better-aimed review, not no review.
- **Rule matching on written content and network targets**, then packs built on it: information security, outward actions, privacy, health data, regulated software. Each pack lists what it enforces and what is advice only. None is a compliance claim.
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
