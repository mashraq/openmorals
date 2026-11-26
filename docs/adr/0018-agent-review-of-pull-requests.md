# 0018. Pull requests to this repository get an agent review that can fix them, and code decides the merge

- Status: Proposed. A rule for how this project is developed, not a product feature: it changes nothing in what openmorals decides
- Date: 2026-11-26

## Context

The maintainers want every pull request reviewed by an agent, from an adversarial and a comparative angle, fixed where the review finds something fixable, and merged with a merge commit when it is right, so that work keeps a fast pace and openmorals' own guards are used on its own development.

A GitHub Actions workflow on every pull request was considered and not used, to keep CI usage down. It would also need a stored token or `pull_request_target` to push fixes and merge, which is a common way for a pull request to reach a repository's secrets.

ADR 0013 rejects, for the product, a model that approves a change and openmorals merging by itself. This record does not change that: it is about the project's own pull requests, merged on the maintainers' instruction, and the agent's opinion can only hold a merge, never force one (the shape of ADR 0007).

## Decision

1. The review runs on a maintainer's machine or in a Claude Code cloud sandbox, when a maintainer starts it. It is not part of CI.
2. It takes open, non-draft pull requests from branches in this repository, targeting `main`, by authors with write access, at commits not reviewed yet. Forks are not reviewed by it.
3. One review agent per pull request, several in parallel. It has only file tools: no shell, web or sub-agents, so it cannot run code, push, merge or reach the network. A hook confines its reads to the review folder and its writes to its working copy, and the openmorals hook built from `main` runs after it, unattended. No user or project agent settings load, and each review has a cost cap.
4. Code from the pull request (its build and its tests) runs only without network access and with no credentials in its environment: in a new network namespace as an unprivileged user on Linux, or under `sandbox-exec` on macOS with no network and no reads of the home folder. Where neither is available nothing is built. These runs go one at a time, nothing they start outlives them, and each test run gets a fresh copy of the code, so git never runs again where the pull request's code ran. Comments never show the names of failing tests, which that code writes. A change to package scripts, dependencies, registry lines or npm configuration is held before anything is installed.
5. Code outside the agent checks the agent's edits, commits them with the trailer `Agent-Review: fixes-for <sha>` and pushes them only as a fast-forward of the reviewed commit. It refuses edits that touch CI, host or agent configuration (in any letter case), package files, or that skip, narrow or remove tests. Fixes to this repository are pushed only with the `Signed-off-by` of the person running the review.
6. A pull request is merged with a merge commit only if all of these hold: the agent found no blocker or major problem left open; the base branch with the change merged in builds, and its tests, compared with the base branch's on the same machine, show no new failure and no fewer passing tests; no protected file, dependency or registry change; nothing that looks like a secret or like internal material; the pull request has no `hold` label; and the pull request and `main` have not moved since the check. Every error ends in a hold (ADR 0005). Each reviewed pull request gets a comment with the findings and the decision.
7. A pull request that changes the reviewer or CI or agent configuration is reviewed and commented on, never merged by it.

## Alternatives and why they lost

- **A workflow on every pull request.** CI usage, and the token risk above.
- **Letting the agent merge.** An agent misled by text in a pull request would merge it.
- **Requiring every test to pass.** A few tests depend on the machine (`docs/contributing/handover.md`); comparing with the base branch on the same machine blocks every new failure and nothing already failing.

## Consequences

- CI does not run on the agent's fix commits; the base-compared test run is the test gate for them.
- An agent cannot certify the Developer Certificate of Origin, so its fixes go out under the sign-off of the person who runs the review; without one, the pull request waits for a person.
- A change to package or registry files is not built or tested by the review; it waits for a person.
- Run so far only as a dry run on open pull requests, pushing, merging and commenting nothing.
- `CONTRIBUTING.md` asks for a `Signed-off-by` line on every commit. The review signs off its own fixes through the person running it; whether it also holds pull requests whose other commits lack one is not decided yet.
