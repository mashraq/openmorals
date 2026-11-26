# Future roadmap

Status: **Planned**. Nothing on this page is in a release; items may change or be dropped. What is scheduled next, item by item, is in [ROADMAP.md](../../../ROADMAP.md); what exists is in [../features.md](../features.md) and [CHANGELOG.md](../../../CHANGELOG.md). Why the phases are in this order is in [product-analysis.md](product-analysis.md).

## The rule that orders it

**Nothing widens until the narrow thing is proven.** Each phase ends with evidence, and the next one opens when that evidence exists, not on a date.

## Phase 1: Prove

The core promise is true on one real host, and anyone can install it.

- **Fail-closed install.** Done for Claude Code in 0.36.0. `openmorals init` writes each host's "block if the hook fails" setting where one exists, and a `doctor` check proves the hook fires and lists hosts that would let a call through.
- **The host's own sandbox, set from your bylaws**, so programs an agent runs are contained where no hook can see.
- **A live run on Claude Code**: a scripted session that tries each hard-to-undo act, starts a sub-agent, compacts, and writes to memory after a fetch, with the log published.
- **An ask counter**: asks per 100 harmless calls (target under 1), asks per active hour beside it, and how many are approved, from the audit log.
- **An outside test corpus**: real destructive commands and agent transcripts the guards were not written against, each with a harmless twin, and a first honest catch rate and false-ask rate.
- **Checks on more than one platform**: at least one Linux run per release, or a plain statement of what is checked.
- **A first release** on npm with provenance. Claude Code marked verified; other hosts and the content packs marked "experimental, not run live"; the README leads with what openmorals does not do.

Done when: a published live-run log, a measured ask rate, a published outside-corpus result, and a package you can install.

## Phase 2: Use

People use it, and the numbers show it helps without nagging.

- **Codex verified live** with the same run.
- **Hosts that speak Claude Code's hook format.** Several agents send Claude-Code-shaped events; the adapter detects which host it is in, fails closed, and each host is listed only after a captured real payload passes.
- **A coverage table** per host: whether it honours ask and deny, whether hooks fire in sub-agents and around compaction, and what happens when the hook fails.
- **A scorecard per release**: catch and false-ask rates on the outside corpus, asks per 100 harmless calls and per hour, overhead.
- **State that follows the tree**: a sub-agent inherits the parent's marks and limits by the host's own ids, and a new session in the same run cannot start clean.

Done when: real users have reported their ask rates, and the defaults are tuned to them (safe alternatives or silence where asks are too frequent).

## Phase 3: The merge check

The one boundary every agent passes, wherever it ran, is worth a reviewer's attention.

- **A GitHub Action** that runs `diff-class`, the test checks (`compare`, `fail-first`, `provenance`, `claim`, `coverage`) and the secret and lockfile rules, and posts the review map.
- **Measured on real agent pull requests**: how often a reviewer agrees a flagged line needed a look.
- **Spend, second step**: read a gateway's usage into the token budget, and let gateways call openmorals as a guardrail for tool calls as the model emits them.
- **A measured savings run**: the same tasks with openmorals off and on; solve rate, turns, cost, cache hits and spawns. A savings figure is published only from this run.

Done when: a reviewer-agreement figure on real pull requests is published.

## Phase 4: Reach, on evidence

Each item starts when a user needs it and its trigger is met, and is listed as supported only after a live run.

| Item | Starts when |
|---|---|
| More hosts (Antigravity CLI, Copilot CLI, Cursor and others) | Claude Code and Codex pass live runs, and someone uses that host |
| A local MCP proxy, for agents reached only through MCP | a user with such an agent; a threat model written first |
| A helper for the Claude Agent SDK; other framework adapters | someone building on that framework asks |
| A setting for shared stores in swarms of agents | a measured swarm run |

## Phase 5: Advisers, only if they help

| Item | Starts when |
|---|---|
| A local classifier as one optional, raise-only input to the inbound judge | live sessions show real misses that rules cannot express |
| New packs for everyday agents (mail, documents, forms) | an everyday agent's host offers a check point before it acts |

## Not planned

A context manager (hard stops, pruning, scheduled forgetting, tool loading), a search index over agent traces, a memory or skill product, an agent evaluation platform, a general LLM gateway, intercepting encrypted traffic of closed apps, and anything that approves, rewrites a tool's output or lets a model lower a decision.
