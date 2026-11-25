# Reading a change in the right order (0.33.0)

Three additions to `openmorals diff-class` for the person who reviews an agent's change. None of them can make a change review-free. None calls a model or the network.

## The review map: riskiest first

```
openmorals diff-class change.diff --map
openmorals diff-class change.diff --map --json     # adds "map" and "split" to the verdict
```

After the verdict, `--map` lists every file in the change, riskiest first, with its added and removed line counts and the rule ids behind its place:

```
Review map, riskiest first (2 high, 1 medium, 1 low). A low place never means safe.
  [high] src/config.ts (+1 -0): integrity.secret-added, exclude.executable
  [high] .github/workflows/ci.yml (+1 -0): exclude.ci-config
  [medium] src/big.ts (+50 -0): exclude.executable
  [low] docs/guide.md (+2 -0): class.none
```

The map adds no judgement of its own. It sorts the reasons `diff-class` already found, by a fixed table:

| Risk | Rule ids |
|---|---|
| high | a token added (`integrity.secret-added`), secret files; a note or the run's record raising review (`note.*`, `record.*`); weakened tests (removed assertions, added skips or exits, changed expected values, snapshots, equality overrides, suppressions, runner config, package scripts); a lockfile that resolves from an odd source (`integrity.lockfile`); CI, build scripts, git config, CODEOWNERS, agent instruction files and files the self-protect guard protects; anything the diff reader does not fully understand (`doubt.*`); a boundary path with no decision record |
| medium | source code (`exclude.executable`), manifests and lockfiles, an added dependency, a file outside the declared paths, a path your settings always send to review |
| low | everything else: tests that only add, docs, README and licence files, case rows |

Within one risk level, a leaked secret comes first, then what a note or the run's record raised, then weakened tests, then dependencies, then build and CI files, then the diff reader's doubts. After that, files with more high-risk rules come first, then larger files, then alphabetical order. Facts about the whole change, such as the size line, are listed first as "whole change".

What it cannot see: the map reads paths and diff lines. A one-line change in a file it rates low can matter more than everything above it. Read the whole change. The map only tells you where to start.

## A suggested split for an oversized change

When the change is over the size line (`--max-lines` and `--max-files`; otherwise 400 changed lines or 25 files), `--map` also suggests one way to split it into smaller pull requests:

1. **dependencies**: manifests and lockfiles. They land first, since the rest builds on them.
2. **code: <area>**: source files grouped by area (`src/payments`, `src/ui`). Each test goes with the source file of the same name (`charge.ts` and `charge.test.ts`).
3. **tests: <area>**: tests with no source file of the same name in the change.
4. **tooling and CI**: what runs on build, CI and commit.
5. **docs**: prose only.

A group still over the line is marked "split further by hand". The suggestion never changes the verdict or the exit code. It cannot tell which files depend on each other beyond the shared name, so check that each part builds on its own.

Measured on this repository's last 50 commits: a split was suggested for 25 of them (its version commits are large), with 7.8 groups on average.

## Notes from bots and AI summaries can only add review

```
openmorals diff-class change.diff --note review-bot.txt --note ai-summary.md
```

A review bot's comment or an AI summary of the change, saved to a file, is read line by line:

- `review: <path> <why>` (or `review: * <why>` for the whole change) adds review for that file.
- A line with a concern word adds review: security, vulnerability, secret, credential, unsafe, breaking change, data loss, injection, bypass, regression, untested, no tests, bug, risk, danger, exploit, backdoor, malicious, token leak, blocking, "do not merge", "needs review". When the line names a file of the change, the reason names it too.
- A line of approval or all-clear (LGTM, approved, looks good, safe to merge, ship it, no issues) changes nothing. The verdict notes how many such lines were ignored.

Concern words are checked before approval words, so "safe to merge apart from a possible secret" adds review. A summary that mentions a concern only to dismiss it ("no secrets found") also adds review. That is deliberate: a note can make you read more, never less. A note that cannot be read (missing, larger than 256 KB, not UTF-8 text, or holding a NUL byte, as UTF-16 does) is treated as an unreadable input (exit 2, needs review). At most 20 notes, each up to 256 KB. One note gives at most 50 reasons, and one more reason counts the rest. Control and format characters in a note (terminal escapes, direction overrides) are not printed, so a note cannot redraw the verdict. In the text output, the tool's own findings (test integrity, the diff reader's doubts, exclusions) are listed before what a note raised.

What it cannot see: a concern written without one of those words, or in another language. A bot that stays silent tells you nothing.
