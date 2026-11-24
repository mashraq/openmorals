# 0003. Apache-2.0 for this repository; team features in a separate package

- Status: Accepted
- Date: 2026-11-23

## Context

openmorals is security tooling installed on developer machines and in CI. People need to read it, audit it and run it at work without a legal review that stalls adoption. There is also a set of features only a team needs: one policy shared by many people that members cannot loosen, a pinned copy of it in every project, a CI check that runs outside the agent, and reports over many people's audit logs.

## Decision

- This repository is licensed under **Apache-2.0** (full text in [LICENSE](../../LICENSE), notices in [NOTICE](../../NOTICE)). Built (0.1.0).
- Everything one person needs on their own machine lives here: the engine, all guards, all adapters, the scanner, trash and undo, the reviewer, the sandbox, packs and the audit log.
- Team features live in a **separate package in a separate repository**, under its own licence. It depends on this package's public API and does not copy the engine. Built (separately).
- Features that exist in this repository are not moved out of it into the team package.
- Contributions are accepted under the Developer Certificate of Origin ([CONTRIBUTING.md](../../CONTRIBUTING.md)).

## Alternatives and why they lost

- **MIT.** Also acceptable to most legal teams. Apache-2.0 was chosen for its explicit patent grant, which matters for a security tool companies will run.
- **AGPL.** Protects network services, not a tool installed locally; it would make many companies say no and protect nothing here.
- **One repository with a source-available folder for team features.** Workable, but mixing two licences in one tree makes it harder for a user to know what they may use. Two repositories keep the line clear.
- **Source-available licence for everything.** Rejected: it would slow adoption of the part that should be everywhere, and the guards need outside eyes.

## Consequences

- The public API ([API.md](../../API.md)) is a contract: the team package builds on it, so breaking changes are listed in each release.
- Anything a single user needs for safety belongs here, even if a team would also pay for it.
