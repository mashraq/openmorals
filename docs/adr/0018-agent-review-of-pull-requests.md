# 0018. Pull requests to this repository get an agent review that can fix them, and code decides the merge

- Status: Accepted. A rule for how this project is developed, not a product feature: it changes nothing in what openmorals decides
- Date: 2026-11-26

## Context

The maintainers want every pull request reviewed by an agent, from an adversarial and a comparative angle, fixed where the review finds something fixable, and merged with a merge commit when it is right, so that work keeps a fast pace and openmorals' own guards are used on its own development.

A GitHub Actions workflow on every pull request was considered and not used, to keep CI usage down. It would also need a stored token or `pull_request_target` to push fixes and merge, which is a common way for a pull request to reach a repository's secrets.

ADR 0013 rejects, for the product, a model that approves a change and openmorals merging by itself. This record does not change that: it is about the project's own pull requests, merged on the maintainers' instruction, and the agent's opinion can only hold a merge, never force one (the shape of ADR 0007).

## Decision

1. The review runs on a maintainer's machine or in a Claude Code cloud sandbox, when a maintainer starts it. It is not part of CI.
2. It takes open, non-draft pull requests from branches in this repository, targeting `main`, by authors with write access, at commits not reviewed yet. Forks are not reviewed by it.
3. One review agent per pull request, several in parallel. On a maintainer's machine the agent runs under the openmorals hook built from `main`, unattended, with a short list of tools, no web access, no GitHub token and a cost cap. It may edit its working copy; it never commits, pushes, merges or comments.
4. Code outside the agent checks the agent's edits, commits them with the trailer `Agent-Review: fixes-for <sha>` and pushes them only as a fast-forward of the reviewed commit. It refuses edits that touch CI, host or agent configuration, package files, or that skip, narrow or remove tests.
5. A pull request is merged with a merge commit only if all of these hold: the agent found no blocker or major problem left open; the base branch with the change merged in builds, and its tests, compared with the base branch's on the same machine, show no new failure and no fewer passing tests; no protected file, dependency or registry change; nothing that looks like a secret or like internal material; and the pull request and `main` have not moved since the check. Every error ends in a hold (ADR 0005). Each reviewed pull request gets a comment with the findings and the decision.
6. A pull request that changes the reviewer or CI or agent configuration is reviewed and commented on, never merged by it.

## Alternatives and why they lost

- **A workflow on every pull request.** CI usage, and the token risk above.
- **Letting the agent merge.** An agent misled by text in a pull request would merge it.
- **Requiring every test to pass.** A few tests depend on the machine (`docs/contributing/handover.md`); comparing with the base branch on the same machine blocks every new failure and nothing already failing.

## Consequences

- CI does not run on the agent's fix commits; the base-compared test run is the test gate for them.
- The agent's fix commits carry no `Signed-off-by` line: an agent cannot certify the Developer Certificate of Origin for a person. How that fits the sign-off rule in `CONTRIBUTING.md` is for the maintainers to settle.
- Not yet run with a real review agent on a real pull request.
