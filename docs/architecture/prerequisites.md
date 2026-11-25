# Prerequisites

For 0.34.0, written 25 Nov 2026.

## Required

- **Node.js 20 or later** to install from source or npm (CI tests 22 and 24). The single-file binary, once released, needs no Node.
- **A supported host** with hooks or plugins turned on: Claude Code, Codex, Gemini CLI, opencode (1.x or 2.x) or OpenClaw.
- **A writable config directory** (see [deployment.md](deployment.md#configure)) on a local filesystem; session files use an exclusive lock and atomic rename.

## Platforms

| Platform | Engine | Binary (when released) | Sandbox |
|---|---|---|---|
| Linux x64, arm64 | yes | glibc 2.28+ | bubblewrap (`bwrap`) |
| macOS arm64, x64 | yes | macOS 13.5+ | `sandbox-exec` |
| Windows x64 | yes; commands read as PowerShell, POSIX and cmd | Windows 10+ | a written plan only |
| Others | from source on Node | no | no |

## Optional

| For | Need |
|---|---|
| Reviewer or inbound judge | network access to the model API you choose and its key in an environment variable, or a local compatible server |
| Sandbox | `sandbox-exec` (macOS) or `bwrap` (Linux) |
| `tests fail-first` | git |
| `diff-class` | a diff file; it does not run git itself |
| Python launcher | Python 3.9 or later |
| Building the binary | Node 25.5 or later with single-executable support |

## Network

The hook and every command make no network call, except the reviewer and inbound judge when you turn them on.

## Environment variables

| Variable | Effect |
|---|---|
| `OPENMORALS_HOME` | config directory |
| `OPENMORALS_UNATTENDED` | every ask becomes deny |
| `OPENMORALS_RUN` | a run id written into each audit line |
| `OPENMORALS_ORDER` | the work order a call belongs to |
| `OPENMORALS_GEMINI_ASK` | `deny` turns Gemini CLI asks into denies |
| the reviewer key, by the name you set | model API key |

## Host settings

- **Claude Code:** hooks enabled; add `"onFailure": "block"` to the openmorals hooks.
- **Codex:** trust the hook in `/hooks`.
- **Gemini CLI:** accept the hook fingerprint.
- **opencode:** restart after `init`.
- **OpenClaw:** install the plugin folder `init` writes.
