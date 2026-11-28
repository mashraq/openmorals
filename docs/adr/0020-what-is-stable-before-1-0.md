# 0020. What is stable before 1.0

- Status: Accepted
- Date: 2026-11-27 (decided by the maintainer)

## Context

The package entry point exports 468 names in 0.42.0: 287 values, 162 types and 19 namespaces. Most of them exist so that the tests, the five hooks and the command line can share code. Once the package is on npm, anyone can import any of them, and a reader cannot tell which ones are a promise. Promising all of them would freeze the engine's inside before a second host has been run live. Promising none gives a program that embeds openmorals nothing to rely on.

## Decision

1. Every export is in one of three tiers, listed in [API.md](../../API.md#stability-0420): **Stable** (not broken within 0.x), **Preview** (may change in a 0.x minor release, with a changelog line), **Internal** (may change in any release).
2. **Stable is small and only what is already documented and tested as a contract:** `decide`, `resolveBylaws`, and the types `Action`, `Bylaws`, `BylawsLoad`, `Decision`, `SessionState` and `Verdict`. Outside the exports: the command names and their stated exit codes, the hook's answer to each host, and the `openmorals.yaml` schema version 1.
   - **A type a Stable type names is Stable only in the shape reached,** and API.md says that shape type by type. The promise is the fields a caller of `decide` and `resolveBylaws` needs: the five `Action` kinds with their required fields and the shell values; the fields of `SessionState`, `Verdict` and both `BylawsLoad` shapes; the three fields of each `ignored` entry; the three `Decision` values. `Action`'s optional text fields are not promised: the adapters fill them in.
   - **`Bylaws` is Stable only as an opaque value:** what `resolveBylaws` returns, passed to `decide` as it is. Its fields and the types they name are Internal. The policy grows a field in most releases, so promising its shape would promise the engine's inside; the `openmorals.yaml` schema is the Stable way to set it.
3. **Preview is empty today.** A new entry point for programs starts there, because a live run can still change its request or answer shape.
4. **Nothing is removed to make the list.** The label does the job; removing names would churn tests and docs for no user.
5. `test/api-tiers.test.ts` reads the export list from the built entry point and fails on an export with no tier, a listed name that is not exported, or a change to the Stable list. `test/api-shapes.test.ts` reads the promised shapes from the built type files and fails when a promised field is removed, renamed, retyped or made optional, a promised value is removed, or `Action` or `SessionState` gains a required field.

## Alternatives and why they lost

- **Promise every export.** Rejected: it would make a rename inside a guard a breaking change before the engine has been run on more than one host.
- **Remove exports before the first publish.** Rejected: it breaks the tests and the docs that use them and helps no caller, since a tier says the same thing at no cost.
- **Promise `Bylaws` field by field.** Rejected: its fields name more than a dozen Internal types, most guards add a field, and a rename inside one guard's settings would become a break. The yaml schema already gives a stable way in.
- **Promise only names, not shapes.** Rejected: a Stable `Verdict` whose `reason` could be renamed under an Internal label promises nothing a caller can use.
- **Mark only Stable and leave the rest unlabelled.** Rejected: a new export would then slip in with no decision about it. Listing every name makes the test fail until someone places it.

## Consequences

- A change to a Stable name or type before 1.0 needs this record changed first.
- An outside user who builds on an Internal name and says so is the reason to consider it for Stable.
- The Internal list in API.md is long and must be kept with the code; the test makes that a build failure, not a review task.
