# Roadmap

Everything here is **planned, not built**. The README describes only what exists and is tested.

## Next
- **More hosts.** Adapters for Codex `PreToolUse`, Gemini CLI `BeforeTool` and opencode permissions, all calling the same `decide()`, so one policy and one audit log cover every agent.
- **Token and cost budgets for Claude Code.** Read usage from a source Claude Code documents (the hook input has none today), then price it per model so budgets can be set in money as well as tokens.
- **Undo instead of ask.** Turn deletes into moves to a trash folder, keep an undo journal, and add `openmorals undo`. That removes most delete prompts while still letting you recover.
- **A hash-chained audit log**, so a missing or edited line can be detected.
- **MCP tool classification.** Let the bylaws mark each MCP tool as read-only or destructive, and ask for unknown ones.
- **Rule of Two / taint.** After untrusted content (web pages, issue bodies, unknown repos) enters a session, step up state-changing and network actions from allow to ask.

## Later
- **Sandbox runner.** `openmorals run <agent>` would start the agent under an OS sandbox (Seatbelt on macOS, bubblewrap on Linux, a restricted user on Windows) with a network allow-list, and refuse to start if the sandbox cannot be set up.
- **Independent reviewer.** When a cheap tripwire fires, a small model with no tools would review the action. It can only escalate to you and never approves anything itself.
- **Skill, plugin and MCP install scanner.**
- **A single-binary build** per OS, so no Node install is needed.

## Not planned
- Approving actions on the user's behalf. openmorals can make an agent ask or stop, but it never grants permission the host would not.
