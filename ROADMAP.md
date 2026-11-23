# Roadmap

Everything here is **not in a release yet**. The README describes only what exists and is tested; [CHANGELOG.md](CHANGELOG.md) lists what each release added.

## In progress
These are being written now. Until they appear in the CHANGELOG, treat them as unavailable.
- **More hosts.** Adapters for Codex, Gemini CLI and opencode, all calling the same `decide()`, so one policy and one audit log cover every agent. Where a host has no blocking pre-tool hook, the adapter will say so and use the nearest real mechanism.
- **Independent reviewer.** When a guard answers `ask`, a second model with no tools reviews the action. It can only escalate to you, never approve anything itself.
- **Sandbox runner.** `openmorals sandbox` would run a command under an OS sandbox derived from the bylaws (Seatbelt on macOS, bubblewrap on Linux; a documented plan on Windows) and refuse to run if the sandbox tool is missing.

## Next
- **Token and cost budgets for Claude Code.** Read usage from a source Claude Code documents (the hook input has none today), then price it per model so budgets can be set in money as well as tokens.
- **A hash-chained audit log**, so a missing or edited line can be detected.
- **MCP tool classification.** Let the bylaws mark each MCP tool as read-only or destructive, and ask for unknown ones.
- **Scanner flags on the CLI:** `--max-file-bytes`, `--max-files`, `--disable <rule-id>` (the library already takes them).
- **Loop detector limits in the bylaws** (the thresholds are fixed defaults today).

## Later
- **A single-binary build** per OS, so no Node install is needed.

## Not planned
- Approving actions on the user's behalf. openmorals can make an agent ask or stop, but it never grants permission the host would not.
