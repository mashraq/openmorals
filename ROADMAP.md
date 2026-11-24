# Roadmap

Everything here is **not in a release yet**. The README describes only what exists and is tested; [CHANGELOG.md](CHANGELOG.md) lists what each release added.

## Next
- **Run the adapters against the live tools.** Codex, Gemini CLI and opencode are built from their documentation and recorded event shapes; they still need a run in each real tool.
- **Antigravity CLI.** Google stopped serving Gemini CLI to Google AI Pro, Ultra and free individual users on 18 June 2026 and points them to Antigravity CLI, which keeps hooks; whether its hook format matches Gemini CLI's is not checked yet.
- **Optional model screening of flagged content** (off by default, escalate-only, the reviewer's frame and caps), only if the deterministic inbound scan proves too weak on a measured corpus; and a lighter post-tool entry point, since post-tool hooks now start a second process per call.
- **The reviewer on the other hosts**, and a first call against the real API with a published transcript.
- **Host allow-lists in the sandbox** by driving Anthropic's `srt` (today the built-in runners keep the network off), a run of the bubblewrap plan on Linux, and an enforced plan on Windows.
- **Token budgets on Claude Code, Gemini CLI and opencode.** Codex and OpenClaw report usage to hooks (0.6.0); these three do not (Gemini CLI only per streamed chunk). Count them when a host documents a session-level source.
- **A hash-chained audit log**, so a missing or edited line can be detected.
- **MCP tool classification.** Let the bylaws mark each MCP tool as read-only or destructive, and ask for unknown ones.
- **Scanner flags on the CLI:** `--max-file-bytes`, `--max-files`, `--disable <rule-id>` (the library already takes them).
- **Loop detector limits in the bylaws** (the thresholds are fixed defaults today).

- **Publish**: the npm package, the first GitHub release of the binaries (the release workflow exists and has a dry-run mode) and the wheels on PyPI.
- **Measure the binary on every target**: size and start time per OS from the release dry run, written into docs/distribution.md.

## Later
- **Signed binaries**: a Developer ID signature and notarisation on macOS and Authenticode on Windows, so Gatekeeper and SmartScreen stop warning; and signed checksums (for example Sigstore), so a download can be tied to this repository's workflow.
- **More binary targets**: Linux musl (Alpine), Windows on Arm.

## Not planned
- Approving actions on the user's behalf. openmorals can make an agent ask or stop, but it never grants permission the host would not.
