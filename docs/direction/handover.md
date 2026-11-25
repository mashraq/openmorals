# For contributors: where to start

These pages set a direction; they are not a promise of dates. Current behaviour is in [../product/features.md](../product/features.md) and [../architecture/guards.md](../architecture/guards.md).

## Start here

1. Read [README.md](README.md) for the three promises and the principles.
2. Pick from the first block of [plan.md](plan.md). Each item names a requirement in [requirements.md](requirements.md) with the test that proves it; write that test first, expecting ask or deny where the requirement says so.
3. Keep to the repository's conventions: case rows under `cases/`, tests under `test/`, a page under `docs/`, a CHANGELOG entry that says what was added, what is unchanged, what was measured and what is not claimed.

## Open questions

- **Counting tokens where a host doesn't report them.** The guard reads no transcript content today. Candidate stand-ins: bytes of tool results the hook has seen, or a transcript file's size read without opening it. Each record must say which source it used.
- **Hard context limits.** Proposed as opt-in until the false-ask measure is in.
- **Order of framework adapters.** Proposed: DSPy, Pydantic AI, the OpenAI Agents SDK, then others.
- **Compaction on hosts other than Claude Code.** Each host's equivalent of a before-and-after-compaction event has to be found and confirmed live.

## Rules that don't change

- Deterministic code decides; any model can only make an answer stricter.
- When openmorals can't judge, it asks.
- openmorals never answers "allow" to a host ([ADR 0009](../adr/0009-never-grant-permission-the-host-would-not.md)).
- A project file can only tighten the user's own floor ([ADR 0010](../adr/0010-the-user-file-is-a-floor.md)).
