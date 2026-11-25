# The merge verdict: `openmorals diff-class`

Added in 0.12.0. Decision record: [ADR 0013](adr/0013-a-merge-verdict-decided-in-ci-the-record-can-only-raise-review.md).

`openmorals diff-class` reads a diff made by `git diff` and answers one question: may this change merge without a person reading it (class A, "review-free"), or does it need review (class B)? For class B it names, in one to three lines, the facts that put the change there, so the reviewer knows where to look.

It is plain code. It calls no model, spends no tokens, holds no credential, merges nothing and writes nothing. It prints a verdict and exits with a code a gate can read.

**Nothing is review-free by default.** Until you switch a class on in your user-level file, every change gets exit 1 (review), with the facts. On this repository's own history the classes cover almost nothing (see [What it covers in practice](#what-it-covers-in-practice)). The honest promise is shorter, better-aimed review, not no review.

## Usage

```
openmorals diff-class <DIFF | -> [--json] [--base DIR] [--reproduced FILE]
                [--run ID [--audit FILE]] [--summary FILE] [--paths GLOB]...
                [--max-lines N] [--max-files N]
```

- `DIFF`: a file holding the output of `git diff`, or `-` for standard input. Make it with these options, so that nothing about your git settings changes the text:

  ```
  git diff --no-color --no-ext-diff --no-textconv --full-index --src-prefix=a/ --dst-prefix=b/ -M BASE HEAD
  ```

- `--base DIR`: a folder holding the base tree (default: the current folder). It is read for two things: the base branch's `openmorals.yaml` (its `merge:` section can only narrow your settings), and the base version of any file a tighten-only check rebuilds.
- `--reproduced FILE`: the diff a pinned, network-free tool (a formatter, a code generator) produced when run on the base tree. When the change is byte for byte that diff, it meets the `reproduced` class.
- `--run ID`: also read the audit record of that run (records written with `OPENMORALS_RUN=ID`), from the config directory or from `--audit FILE`. `--summary FILE` reads a saved `openmorals audit --run ID --json` instead. The record can only add review (see [The run record](#the-run-record)).
- `--paths GLOB` (repeat it), `--max-lines N`, `--max-files N` (0.13.0): declared inputs for the test-integrity reasons: the paths the work was declared to touch and a size line. See [docs/test-integrity.md](test-integrity.md).
- `--json`: the verdict as one JSON object: `verdict` (`review` or `review-free`), `class` (`A` or `B`), `basis` (the class that made it review-free), `qualifies` (the class the change meets whether or not it is switched on), `exitCode`, `reasons` (every fact, each `{rule, path, text}`), `files`, `switchedOn`, `notes`, `cannotSee` and (0.13.0) `notChecked`, the test-integrity rules that had no input.

## Exit codes

| Exit | Meaning |
|---|---|
| 0 | Review-free: the change meets a class you switched on, and nothing raised it |
| 1 | Review: the facts are printed (all of them with `--json`) |
| 2 | An input cannot be read: the diff is empty, cut off, not git diff output, or another file is missing or malformed. Nothing was judged: read this as "needs review" |
| 64 | Usage error |

Only exit 0 may let a change skip review. A gate that treats any other code as success would merge a change nobody read because, for example, the diff was cut off.

## Switching a class on

Only the user-level file (`openmorals.yaml` in the openmorals config directory) can switch a class on. A project file, including the base branch's own, can only switch one off again and add paths that always need review. This is the user floor of [ADR 0010](adr/0010-the-user-file-is-a-floor.md), applied by the same comparison that keeps every other setting from being loosened.

```yaml
# ~/.config/openmorals/openmorals.yaml (or $OPENMORALS_HOME/openmorals.yaml)
version: 1
merge:
  review_free: [tighten-only]     # tighten-only | reproduced; empty by default
  always_review: [clinical/**]    # globs; a project file may add more, never remove these
```

A project file that tries to add a class is ignored, and `diff-class` prints a note saying so. If the settings cannot be read, nothing is review-free.

Globs: a glob without `/` matches a file or folder name at any depth (`README*`); a glob with `/` is anchored at the repository root (`docs/adr/**`); `*` and `?` stay within one folder, `**` crosses folders; matching ignores letter case; a glob that matches a folder covers everything under it.

## The classes

A change is review-free only when every file in it meets one class, none of the exclusions or doubts below applies, and the run record raises nothing.

**`tighten-only`**: changes that can only make the declared policy stricter.

- Rows added to an existing `cases/*.cases.yaml` table: only added lines, each a one-line `- { ... }` row (blank lines allowed), every new row expecting `ask` or `deny`. The rebuilt table must still load as a case table, with every old row kept in order. A row expecting `allow` needs review, because such a row can pin a hole open. A comment line needs review too: it is prose that the next agent reads.
- A change to the root `openmorals.yaml` (or `.yml`) that loosens nothing: both versions are valid, the comparison every floor check uses finds nothing looser, no user-level-only setting (reviewer, inbound notify and judge, prices) changed, and the `merge:` section, which defines the classes, is unchanged.
- For both, the added lines must pass the scanner's hidden-instruction and obfuscation rules and hold no secret-shaped value. Not the dangerous-command rules: a case row carries the command it tests as data, and CI runs the rows.
- Both rebuild the file from the base folder and the diff's hunks, and check the base file and the result against the git hashes on the diff's `index` lines. A base folder that is not the base of this diff, or a file that cannot be rebuilt, needs review.

CI running the rows on the merged code then proves the code already met the stricter claim. The worst case is a red build.

**`reproduced`**: the whole diff is byte for byte the `--reproduced` diff. `diff-class` cannot see where that diff came from: it must be made by CI, by a deterministic, network-free tool pinned in the base branch, run on the base tree. The exclusions below still apply, so a formatter's output over source files needs review.

**Not built yet:** a docs tier (ordinary prose files) waits for a measured miss rate of the scanner on a seeded corpus of docs with hidden instructions. Until then a docs change needs review.

## Always review

Whatever else holds, a change touching any of these needs review. Each is a rule with an id; the reason line names it.

| Rule | Covers (examples) |
|---|---|
| `exclude.ci-config` | `.github/`, `.gitlab-ci.yml`, `.circleci/`, `Jenkinsfile` and other CI configuration |
| `exclude.codeowners` | `CODEOWNERS` at any depth |
| `exclude.lockfile` | `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `Cargo.lock`, `go.sum`, `poetry.lock`, `*.lock` and others |
| `exclude.manifest` | `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `requirements*.txt`, `.npmrc`, toolchain pins and others |
| `exclude.build-script` | `Makefile`, `scripts/`, `bin/`, `Dockerfile`, `tsconfig*.json`, `*.config.js`/`.ts`, git hook folders and others |
| `exclude.test-runner-config` | `jest.config.*`, `vitest.config.*`, `pytest.ini`, `conftest.py`, `tox.ini`, `dart_test.yaml` and others |
| `exclude.test-file` | `test/`, `tests/`, `__tests__/`, `spec/`, `*.test.*`, `*.spec.*`, `*_test.*`, snapshots. A new test is code that runs in every later CI run and on every developer's machine |
| `exclude.executable` | `src/`, `lib/`, `app/` and files with a code or script extension |
| `exclude.agent-instructions` | `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `SKILL.md`, prompt files, `.claude/`, `.codex/`, `.gemini/`, `.cursor/`, `.vscode/`, MCP configuration and other host folders |
| `exclude.readme-legal` | `README*`, `SECURITY*`, `LICENSE*`, `NOTICE*`, `COPYING*`, `CONTRIBUTING*` |
| `exclude.secrets` | `.env`, key and certificate files, credential files |
| `exclude.git-config` | `.gitattributes`, `.gitmodules` |
| `exclude.classifier` | this classifier itself: its rows, this document, its source |
| `exclude.self-protected` | any other file the self-protect guard protects, such as a nested `openmorals.yaml` |
| `exclude.always-review` | the `always_review` globs of your settings (regulated, clinical, or simply important paths) |

The full lists are in `src/diffclass/rules.ts`; `--json` names the rule for every path.

## Anything it does not fully understand needs review

The diff reader accepts exactly what git writes. Text before the first `diff --git` header, an unknown header line, a hunk whose line counts do not add up, a diff that does not end with a newline, a NUL byte, invalid UTF-8, CRLF line endings throughout, or paths without the `a/` and `b/` prefixes make the input unreadable (exit 2).

Shapes it reads but does not trust make the file need review (exit 1), each with its own rule: a rename (`doubt.rename`, also named by the exclusion of either path), a copy, a deleted file, a mode change, an executable file, a symbolic link, a submodule, a binary file, a carriage return or another line separator inside a changed line (`doubt.line-break`, because it can hide a second row from a line-by-line reader), a control character, a path git had to quote, a path with a space or a character outside printable ASCII, a path with `..`, and a path that appears twice (a file turned into a link).

## Test-integrity reasons

From 0.13.0 every diff is also read for the shapes a change that weakens its own tests takes: a test file that lost assertion lines, an added skip or `only`, a changed snapshot, runner configuration or package `scripts`, an exit call in test code, an expected value changed in an assertion, an equality override in test helpers, an added suppression, a new dependency, files outside the declared paths (`--paths`), a change over a declared size line, and a declared boundary path (`merge.boundary_paths`) changed with no `docs/adr/` change. Each is a rule with an `integrity.*` id and a published pattern. They can only add review: a reason never lowers a class, never asks, never blocks by itself. In the text output they come before the exclusion facts, within the same three lines. Their nuisance rate on real work is not measured yet. Rules, patterns, what each misses and their fire rates on this repository: [docs/test-integrity.md](test-integrity.md).

## The run record

With `--run ID` or `--summary FILE` the run's audit record is read as well. It can only add review, never remove it, because a record kept on the agent's machine, under the agent's user, can be edited by a program the agent starts, and a clean record is also what a run with no hook at all leaves behind. Each of these makes the change need review:

- a denied action (`record.deny`);
- any ask (`record.ask`): where the host sends no event after the call, an ask that was approved looks the same as one that was refused;
- an ask a person approved (`record.approved-ask`);
- a taint or injection mark (`record.taint`);
- a project file that tried to loosen the bylaws (`record.loosening`);
- a record that does not verify: an edited, missing or cut-off line, or a reset session (`record.unverified`);
- a declared run with no record, or no log at all (`record.missing`).

A clean record changes nothing.

## What it cannot see

The verdict is only as good as where it runs. `diff-class` prints, with every class-A verdict, what it cannot check from a diff:

- whether it ran on CI from the base branch's code and settings, reading the head only as git objects and never running it;
- whether its result is a required status pinned to an app identity the agent holds no credential for;
- whether CI itself ran the tests on the commit to be merged (it never reads a test result from the agent's record);
- whether merging publishes or deploys anything (if it does, no change should skip review);
- whether the base folder is the base of this diff, beyond the git hashes of the files it rebuilds;
- for `reproduced`, whether the reproduced diff came from a pinned, network-free tool run by CI on the base tree.

## In a local gate

This project runs its gates on the developer's machine. A local gate is weaker than CI: the agent works on the same machine, under the same user, so the conditions above that need a separate identity cannot be met. The self-protect guard asks before an agent edits your user-level file or the records, but a program the agent starts can still change them. Use a local gate for review you aim better, not for review you skip on a machine the agent shares.

A sketch, POSIX shell, run by you from the repository root before you merge an agent's branch:

```sh
#!/bin/sh
# merge-verdict.sh BRANCH [BASE]: say whether BRANCH may merge into BASE without being read.
set -eu
branch=$1
base=${2:-main}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git diff --no-color --no-ext-diff --no-textconv --full-index --src-prefix=a/ --dst-prefix=b/ -M \
  "$base" "$branch" > "$tmp/change.diff"
mkdir "$tmp/base"
git archive "$base" > "$tmp/base.tar"
tar -x -C "$tmp/base" -f "$tmp/base.tar"
set +e
openmorals diff-class "$tmp/change.diff" --base "$tmp/base"
verdict=$?
set -e
if [ "$verdict" -eq 0 ]; then
  echo "review-free: $branch may merge without being read"
else
  echo "needs review: read $branch before merging (exit $verdict)"
  exit 1
fi
```

Every step writes to a file and is checked by `set -e`, so a failed `git diff` stops the script instead of handing `diff-class` a short diff. Only exit 0 lets the branch skip review. To also read the run's record, add `--run <id>` with the id the agent ran under.

## On CI (text only, not tested here)

**Untested: this project does not run CI, and nothing below was run.** It shows the shape ADR 0013 asks for on GitHub. The verdict job comes from the base branch (`pull_request_target`), checks out the base, fetches the head only as git objects and never runs anything from it.

```yaml
# .github/workflows/merge-verdict.yml in the BASE branch (sketch, not run here)
on: pull_request_target
permissions: { contents: read }
jobs:
  verdict:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4          # the base branch, never the head
        with: { path: base, persist-credentials: false }
      - run: git -C base fetch --no-tags origin "pull/${{ github.event.number }}/head:pr"
      - run: |
          git -C base diff --no-color --no-ext-diff --no-textconv --full-index \
            --src-prefix=a/ --dst-prefix=b/ -M HEAD pr > change.diff
      - run: npx --yes openmorals@0.12.0 diff-class change.diff --base base   # once the package is published
        env: { OPENMORALS_HOME: "${{ runner.temp }}/om" }   # holds the user-level file your org controls
```

For the result to mean anything: write the user-level file in a step the pull request cannot change; make this job's check required and pinned to the app that runs it; let your host's own auto-merge, not openmorals, consume it; keep the normal review rule for every change this job does not pass; and run the tests in CI yourself. A separate team package can run the same rules as an organisation-level check.

## What it covers in practice

On this repository's own history the classes cover very little. Replayed through the built classifier with both classes switched on (no reproduced diffs exist in the history, so only `tighten-only` could apply), **none of the 60 commits up to 0.11.0 is review-free**; every one needs review. The most common first fact: executable source (26 commits), then README and other licence or notice files (20). Of the 18 changes to case tables or the root bylaws file in that history, one met `tighten-only` on its own; it came in a commit that also changed source. The others added comments or multi-line rows (7), created new tables (6), added an `allow` row (1), edited a line (1) or were in no class (1). On a repository whose agent work is mostly code, expect the verdict to aim review, not to skip it.
