# Roadmap

Everything here is **not in a release yet**. The README describes only what exists and is tested; [CHANGELOG.md](CHANGELOG.md) lists what each release added.

## Next
- **Run the adapters against the live tools.** Codex, Gemini CLI and opencode are built from their documentation and recorded event shapes; they still need a run in each real tool.
- **Post-tool events on the other hosts**, so the loop detector also catches a command that keeps failing the same way under Codex, Gemini CLI and opencode (today only Claude Code reports outcomes).
- **The reviewer on the other hosts**, and a first call against the real API with a published transcript.
- **Host allow-lists in the sandbox** by driving Anthropic's `srt` (today the built-in runners keep the network off), a run of the bubblewrap plan on Linux, and an enforced plan on Windows.
- **Token and cost budgets for Claude Code.** Read usage from a source Claude Code documents (the hook input has none today), then price it per model so budgets can be set in money as well as tokens.
- **A hash-chained audit log**, so a missing or edited line can be detected.
- **MCP tool classification.** Let the bylaws mark each MCP tool as read-only or destructive, and ask for unknown ones.
- **Scanner flags on the CLI:** `--max-file-bytes`, `--max-files`, `--disable <rule-id>` (the library already takes them).
- **Loop detector limits in the bylaws** (the thresholds are fixed defaults today).

## Later
- **A single-binary build** per OS, so no Node install is needed.

## Not planned
- Approving actions on the user's behalf. openmorals can make an agent ask or stop, but it never grants permission the host would not.
