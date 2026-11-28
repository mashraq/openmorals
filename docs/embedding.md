# Calling the check from your own program (Preview, 0.44.1)

**Built (0.44.1), docs only.** Examples of where a program that runs an agent can call openmorals before a tool runs: in a loop you wrote yourself, and in two agent frameworks. The check itself is [`guardCall`](../API.md#guardcall-preview-0430) (TypeScript), [`openmorals guard --json`](../API.md#openmorals-guard---json-and-python-guard-preview-0431) (any language) and Python `openmorals.guard()`, all Preview.

## Read this first: what this is, and what it is not

- **It is a check your program chooses to call and chooses to obey.** A program that does not call it, calls it for some tools only, or ignores the answer is not checked. Nothing on this page stops a program, or the agent inside it, that never asks.
- **A framework decides when its callback runs.** It may skip your callback, for some tools, on a path its documentation does not describe, or after a change in a new version. It may also swallow an error your callback raises and run the tool anyway. Neither framework entry below has been run by us.
- **Tool results are not scanned on this path.** The check judges the call before the tool runs. Nothing reads what the tool returns.
- **It is not the Claude Code hook.** Claude Code starts the hook for every tool call and waits for its answer. The hook also has what this path does not: deferred asks, the optional reviewer, the token budget and the run budget, a scan of each tool result for hidden instructions, a wait for the post-tool event so that a declined ask leaves no mark on the session, counts per sub-agent, and Claude Code's own list of tool names. On this path a declined ask still marks the session. The full list is in [API.md](../API.md#guardcall-preview-0430).
- **An ask needs a person.** Show the reason to a person and run the call only if they say yes. When nobody is there to answer, pass unattended (`{ unattended: true }`, `--unattended`, `unattended=True`, or `OPENMORALS_UNATTENDED=1`), so an ask becomes a deny. Never treat ask as allow.
- **Preview.** The shape of these calls can change in a 0.x minor release, each change with a line in the changelog.
- **Not on npm or PyPI today.** A TypeScript program gets `guardCall` from a clone of this repository: `npm install && npm run build`, then `npm pack` makes `openmorals-0.45.0.tgz`, which your program can depend on by its path. `npm link` in the clone puts the `openmorals` command on your PATH for `guard --json`. No Python wheel is published. A clone can build the binary (`node scripts/build-binary.mjs`, which needs an official Node.js build) and a wheel around it (`python/build_wheel.py`), as [docs/distribution.md](distribution.md) says. `python/tests/` runs `openmorals.guard()` with a stand-in for the binary.

## Where to call it

Each entry below says where in the program's tool-call path the check goes (before the tool runs), what to do with allow, ask and deny, and when its shape was checked. There are three on purpose: each one is a claim about someone else's code that can go out of date.

### 1. A loop you wrote yourself (TypeScript)

Where: in your loop, after the model asks for a tool call and before your code runs the tool. Call `callTool` for every tool call, not only the ones that look risky.

<!-- fixture: test/fixtures/embedding/own-loop.ts -->
```ts
import { guardCall, type GuardCallAction } from "openmorals";

export type ToolCall = { name: string; input: Record<string, unknown> };

// Your own tools whose input shows everything they do. Any other name asks.
const ownTools: Record<string, GuardCallAction[]> = { run_shell: [] };
const session = `my-agent-${process.pid}`;

export async function callTool(
  call: ToolCall,
  run: (call: ToolCall) => Promise<string>,
  askPerson?: (reason: string) => Promise<boolean>,
): Promise<string> {
  const actions = ownTools[call.name];
  const v = guardCall(
    { session, cwd: process.cwd(), tool: call.name, input: call.input, ...(actions && { actions }) },
    { unattended: askPerson === undefined },
  );
  if (v.decision === "allow") return run(call);
  if (v.decision === "ask" && askPerson !== undefined && (await askPerson(v.reason))) return run(call);
  return `not run (openmorals ${v.decision}, ${v.rule}): ${v.reason}`;
}
```

- allow: run the tool.
- ask: show the reason to a person (`askPerson`) and run the tool only if they say yes. With no `askPerson`, the call is unattended and an ask comes back as a deny.
- deny: do not run it. Give the reason back to the model as the tool's result, as above.
- `ownTools` lists your own tools whose input shows everything they do. A tool name openmorals does not know, with no entry there, asks every time ([why](../API.md#a-tool-openmorals-does-not-know)). A command under `command` or `cmd` is read as a shell command either way.

A program in another language can do the same with `openmorals guard --json`: write the request on its standard input, read the one line it prints, and treat a missing line or an exit code other than 0, 1 or 2 as ask, or as deny when unattended ([API.md](../API.md#openmorals-guard---json-and-python-guard-preview-0431)).

Checked: 28 Nov 2026, against openmorals 0.44.1. `test/embedding-page.test.ts` compiles this code against the package's own types and runs it in a temporary config folder: `ls` is allowed, and `rm -rf ~` is not run. Not run live by us in a real agent.

### 2. Claude Agent SDK: let it load the hook (TypeScript)

Where: nothing to call. Per the SDK's documentation, a program that loads its project settings gets the hooks in `.claude/settings.json` of the folder it passes as `cwd`, which is where `openmorals init` writes the hook. So this is the hook path, not `guardCall`, and the hook's own checks apply. Run `openmorals init` in that folder and `openmorals doctor` there to check the hook. `doctor` also counts a hook in `.claude/settings.local.json` or in your user settings, and `settingSources: ["project"]` loads neither, so a green `doctor` can still mean no hook under this example. The hook `init` writes is in `.claude/settings.json`, which it loads.

<!-- fixture: test/fixtures/embedding/claude-agent-sdk.ts -->
```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

// The folder where you ran `openmorals init`. Its .claude/settings.json holds the hook.
const project = "/path/to/project";

for await (const message of query({
  prompt: "Fix the failing test",
  options: { cwd: project, settingSources: ["project"] },
})) {
  if (message.type === "result") console.log(message);
}
```

- The documentation says that with no `settingSources` the SDK loads user, project and local settings, and that `settingSources: []` loads none of them. If you set `settingSources`, keep `"project"` in it.
- It says project settings load from `<cwd>/.claude/`, with no look in parent folders. Run `init` in the folder you pass as `cwd`, not in a parent.
- allow, ask and deny are the hook's answers to Claude Code. What the SDK does with an ask depends on your program's permission settings, and we have not checked it. With nobody there to answer, install the hook as `openmorals init --hook-command "openmorals hook claude-code --unattended"`, so the hook itself turns an ask into a deny.
- A hook that cannot start, fails or times out: "Hooks reference" (read 28 Nov 2026) says the call then goes ahead, unless the hook sets `"onFailure": "block"`, which `init` writes and which "Requires Claude Code v2.1.295 or later". The SDK reference says the SDK bundles its own Claude Code binary. `openmorals doctor` does not see that one, and we have not checked which SDK release carries which Claude Code. The reference also says an `env` option replaces the environment instead of adding to it, so `openmorals` may not be on the PATH the hook gets. What you can do: install the hook with the full path to the binary (`openmorals init --hook-command "/full/path/to/openmorals hook claude-code"`), and run that hook command once by hand, with a tool call on its standard input as in the [README](../README.md#how-the-hook-works), to see it answer.

Checked: 28 Nov 2026. Documentation read: "Use Claude Code features in the SDK" (https://code.claude.com/docs/en/agent-sdk/claude-code-features) and "Agent SDK reference - TypeScript" (https://code.claude.com/docs/en/agent-sdk/typescript), options `settingSources` and `env`, and the bundled binary; "Hooks reference" (https://code.claude.com/docs/en/hooks), field `onFailure`. `test/embedding-page.test.ts` type-checks this code against a stand-in for the SDK's types (`test/fixtures/embedding/claude-agent-sdk.stand-in.d.ts`), not the SDK. Shape checked against the documentation; not run live by us.

### 3. Google ADK: `before_tool_callback` (Python)

Where: per ADK's documentation, the agent calls `before_tool_callback` with `tool`, `args` and `tool_context` before a tool runs. Returning `None` lets the tool run. Returning a dictionary skips the tool, and the dictionary is used as the tool's result. ADK passes these by keyword, so keep the names.

<!-- fixture: test/fixtures/embedding/adk_before_tool.py -->
```python
import uuid

import openmorals
from google.adk.agents import LlmAgent

MODEL = "your-model-name"
SESSION = "adk-" + uuid.uuid4().hex
# True: an ask is refused. Set False only when a person is at this program's own terminal to answer.
UNATTENDED = True
OWN_TOOLS = {"run_shell": []}  # your tools whose arguments show everything they do


def run_shell(command: str) -> dict:
    """Your own tool."""
    ...


def before_tool(tool, args, tool_context):
    d = openmorals.guard(tool.name, args, session=SESSION, actions=OWN_TOOLS.get(tool.name), unattended=UNATTENDED)
    if d.decision == "allow":
        return None
    if d.decision == "ask" and input(f"{tool.name}: {d.reason}\nRun it? [y/N] ").strip() == "y":
        return None
    return {"status": "not run", "reason": f"openmorals {d.decision}: {d.reason}"}


root_agent = LlmAgent(name="helper", model=MODEL, tools=[run_shell], before_tool_callback=before_tool)
```

- allow: return `None`, and the tool runs.
- ask: as written, `UNATTENDED` is true, so an ask is refused (it comes back as a deny). Set it to `False` only when a person is at this program's own terminal to answer, never under a web or API server. Then the callback asks them and returns `None` only if they type `y`.
- The callback as written waits while the check runs (it starts a process) and while it waits for an answer. An async program should run it off the event loop, for example with `asyncio.to_thread`.
- deny: return a dictionary, so the tool is skipped and the model reads the reason.
- `OWN_TOOLS` works as `ownTools` does in the first entry.

Checked: 28 Nov 2026. Documentation read: "Types of callbacks", Agent Development Kit (https://adk.dev/callbacks/types-of-callbacks/), callback `before_tool_callback`; "Python Quickstart for ADK" (https://adk.dev/get-started/python/), which says `agent.py` holds a `root_agent` definition. `python/tests/test_embedding_page.py` parses this code and runs `before_tool` with stand-ins for ADK's classes and for the openmorals binary (a script that starts the built command), not with ADK. Shape checked against the documentation; not run live by us.

## Not covered

- None of the three entries has been run by us in a live agent. The two framework entries are read from their documentation only.
- A framework may skip its callback or swallow an error from it, and the tool then runs.
- The limits at the top of this page: a program that does not call the check, or ignores it, is not checked; tool results are not scanned on this path; the hook's deferred asks, reviewer, budgets and result scan do not apply to `guardCall`.
- Only these three. A fourth entry is added only when someone outside the project asks for it.
