# Planned features, by promise

What already exists is marked **Built (version)**; the rest is **Planned**. Full current list: [../product/features.md](../product/features.md).

## 1. Safe through the whole session

| Feature | Status | Why it helps |
|---|---|---|
| Guard state on disk, outside the model's context: taint, budget, loop history, pending asks | Built (0.2.0 onwards) | a summary of the conversation can't drop a mark the guard keeps |
| Scanning what one agent hands to another, and what comes back | Built (0.14.0) | instructions hidden in a hand-off are caught |
| Fail-closed hook install where the host supports it | Planned | closes the gap where a hook that can't start lets the call through |
| Guard state carried through compaction and resets, with evaluation rows proving it | Planned | users can shorten their context safely |
| Children of an agent never gain power and inherit the parent's marks | Planned | a sub-agent can't be used to step around a guard |
| Approvals bound to the exact act and used once | Planned (an exact call may already run once after a deferred ask, Built 0.19.0) | "yes" covers only what was shown |
| Memory written after untrusted input marked untrusted; memory never holds rules | Planned | a poisoned page can't become a standing instruction |
| Tool descriptions pinned, scanned and namespaced through a local MCP proxy | Planned (`openmorals scan` reads MCP configs before install, Built 0.2.0) | a tool that changes after approval stops working until approved again |

## 2. Affordable by default

| Feature | Status | Why it helps |
|---|---|---|
| Tool-call budget per session | Built (0.1.0) | a hard stop on runaway sessions |
| Token budget where the host reports tokens | Built (0.1.0; Codex and OpenClaw report them) | the same, in tokens |
| Loop detector: repeats, polling, near-repeats, repeated failures | Built (0.2.0) | stops the cheapest kind of waste |
| Context budget with a warning line and an opt-in hard limit; every record names where its count came from | Planned | long sessions get shortened before they degrade |
| Large or flagged tool results replaced by a short reference where the host allows | Planned | less text carried turn after turn, mark kept |
| Stall ladder: step-back note, fresh start from a hand-off note, pause | Planned | fewer hours spent stuck on one subtask |
| One budget and depth and fan-out limits across an agent tree | Planned | swarms and hierarchies have one owner of the count |
| A cap on active tools and skills, chosen by the task's pack | Planned (daily guidance already loads a short block always and the rest on demand, Built 0.29.0) | fewer tokens and less confusion between tools |

## 3. Verifiable without reading every line

| Feature | Status | Why it helps |
|---|---|---|
| `openmorals diff-class`: may this diff merge unread, with the facts | Built (0.12.0) | review time goes where it is needed |
| Test-lock pack, test-integrity reasons, `tests compare`, `tests fail-first` | Built (0.9.0, 0.13.0, 0.10.0, 0.17.0) | an agent can't quietly weaken the tests that judge it |
| Work orders and `order check` | Built (0.27.0) | "done" is written down before the work starts |
| `openmorals audit sample` | Built (0.11.0) | unread merges are sampled, and escapes counted |
| Which tests a session wrote or changed, in the audit | Planned | answers "who wrote this test?" |
| Claim check: rerun the tests an agent says pass, on a clean checkout | Planned | "all tests pass" becomes a fact |
| A diff reviewer that never sees the agent's transcript, and can only add review | Planned | a second look not anchored on the agent's story |

## 4. Any model, any agent

| Feature | Status | Why it helps |
|---|---|---|
| Hooks for Claude Code, Codex CLI, Gemini CLI, opencode, OpenClaw | Built (Claude Code 0.1.0; Codex CLI, Gemini CLI, opencode 0.3.0; OpenClaw 0.6.0); none run against the live tool yet | one rule set across hosts |
| Reviewer through Anthropic, OpenAI-compatible (including local servers) or Gemini models | Built (0.3.0; more providers 0.6.0), escalate-only | model choice is the user's |
| Python package with `check()` | Built (0.4.0) | Python code can ask the same engine |
| Adapters for Python agent frameworks (DSPy, Pydantic AI, OpenAI Agents SDK first) | Planned | agents built in code get the same allow, ask and deny |
| Local MCP proxy | Planned | covers any agent that speaks MCP |
| Network allowlist and outbound scan for agents with no hooks | Planned | covers the edge of any process |

The decision never depends on which model is behind the agent. That is why one engine can serve any model.

## 5. Evaluation

| Feature | Status | Why it helps |
|---|---|---|
| `openmorals eval`: catch rate, false alarms and time per guard on case rows or your own rows | Built (0.7.0) | every claim has a number |
| Rows across several calls, turns, compactions and child agents | Planned | attacks that play out over steps are measured |
| Repeat runs for model-backed checks, scored on the worst run | Planned | a check that misses once is caught |
| A baseline that reruns when bylaws, packs, skills, the model or the host version change | Planned | silent regressions show up |
| A recipe that runs each host headless on a scripted task | Planned | the first live host claims |
| Test-lock covering evaluation rows and baselines | Planned | an agent can't edit its way to a green evaluation |
