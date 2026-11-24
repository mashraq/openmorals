# Compare two test runs by test name: `openmorals tests compare`

Added in 0.10.0. A command you run yourself, or from your own local gate (a pre-commit or pre-merge script on your machine). It reads two test reports, one from the code before a change and one from after, and prints two lists by test name:

- **Failed or absent before, pass after**: tests that now show something new. Each says whether it was failing, skipped, or is a new test.
- **Passed before, now failing, gone or skipped**: what the change lost.

It never runs tests, never calls a model, writes nothing, and never judges or scores an agent. The totals and the pass rate are printed for reference only; they never decide the result, because whoever writes the tests controls the total.

## Exit codes

| Exit | Meaning |
|---|---|
| 0 | No test that passed before is failing, gone or skipped, except ones you approved |
| 1 | At least one test that passed before is failing, gone or newly skipped, and no approval line covers it |
| 2 | A report or the approval file cannot be read. Nothing was compared: read this as "needs review", never as "no damage" |
| 64 | Usage error |

Only exit 1 and 2 should stop a gate. A gate that treats 2 as success would pass a report that was cut off, empty or in a format this command does not read.

## Reports it reads

The format is recognised from the file; `--format junit|jest|go-json|dart-json` sets it.

| Runner | How to write a report |
|---|---|
| Node's test runner | `node --test --test-reporter=junit --test-reporter-destination=after.xml` |
| pytest | `pytest --junitxml=after.xml` |
| Maven, Gradle and most other runners | their JUnit XML output |
| Jest | `jest --json --outputFile=after.json` |
| Vitest | `vitest run --reporter=json --outputFile=after.json` |
| Go | `go test -json ./... > after.jsonl` |
| Flutter, Dart | `flutter test --machine > after.jsonl`, `dart test --reporter json > after.jsonl` |

A test's name is its file (when the report gives one), its suites or groups, and its own name, joined by ` > `. A report with no test results at all is unreadable (exit 2). TAP and the human-readable outputs are not read.

## In a local gate

Make both reports yourself, from your own gate, in clean copies of the code: never from a report the agent produced or a run you did not see. A sketch for a Node project, POSIX shell, run from the repository root on your machine:

```sh
set -u
base=$(git merge-base HEAD main)
work=$(mktemp -d)
git worktree add --detach "$work/base" "$base"
(cd "$work/base" && npm ci && npm run build && node --test --test-reporter=junit --test-reporter-destination="$work/before.xml" "dist/test/**/*.test.js")
npm run build && node --test --test-reporter=junit --test-reporter-destination="$work/after.xml" "dist/test/**/*.test.js"
openmorals tests compare "$work/before.xml" "$work/after.xml" --before-root "$work/base" --after-root "$(pwd)"
status=$?
git worktree remove --force "$work/base"
exit $status
```

The two `node --test` commands may exit non-zero when a test fails; the script carries on so the comparison decides. `--before-root` and `--after-root` strip each copy's folder from the file paths in the names, so the same test has the same name in both reports. When the two reports share no test name at all, the output says so and suggests these options.

To see flaky tests, run the same code more than once and pass the extra reports with `--before-repeat FILE` and `--after-repeat FILE` (each may be given several times). A test whose outcome differs between runs of one side is listed as flaky. A flaky test that passed in any before run and failed in any after run is still counted as lost: approve it by name if you accept it.

`--json` prints the same result as one JSON object (`exitCode`, `blocking`, `totals`, `failToPass`, `passToFail`, `gone`, `newlySkipped`, `likelyRenames`, `flaky`, `failingGone`, `approvalFile`, `unusedApprovals`, `noCommonIds`, `editable`, `limits`); on exit 2 it prints `{"exitCode": 2, "error": "..."}`.

## Approving a loss

When a change is meant to remove, rename or skip a test, add one line per test to `tests-approved.txt` in your config directory (`$OPENMORALS_HOME`, else `~/.config/openmorals`, or `%APPDATA%\openmorals` on Windows):

```
# lines starting with # are notes
gone src/widget.test.js > widget > sorts by name
fails src/widget.test.js > widget > rounds half up
skipped src/widget.test.js > widget > reads the old format
```

The word in front (`fails`, `gone` or `skipped`) must match: approving that a test is gone does not approve it failing later. A line in any other form makes the file unreadable (exit 2), so a typo never approves anything. When the command exits 1 it prints the exact lines to add. Lines that matched nothing in this comparison are listed, so you can remove them once the change has landed.

The file lives in the user-level config directory, which the self-protect guard covers: an agent that tries to write it is asked about (or refused under `--unattended`) like any other edit to your openmorals settings.

## Other lines in the output

- **Likely renames**: a test that is gone and a new test in the same file. A rename shows as one gone and one new; the gone one still needs its `gone` line.
- **Failing before and now gone**: not counted as a loss, and not in the exit code, but worth a look: deleting a failing test is one way to make a run look green.

## What it cannot tell you

These lines are printed with every result:

- It cannot tell which of these tests the agent could edit. A test the agent wrote or changed can pass without showing anything. Lock the tests that judge the work with the `test-lock` pack ([extras.md](extras.md#the-test-lock-pack-090)), and read the test changes. Read-only tests stop an agent editing them; they do not stop code written to pass those exact tests. You still read a sample.
- A renamed test shows as one gone and one new.
- These lists say nothing about tests that check little: a new test that asserts nothing passes, and shows in the first list like any other.
- A report is only as trustworthy as the run that made it. Make both reports with your own gate, not the agent's.

Repeated names: when one report holds the same name twice, the second is named `<name> #2` in the order the report lists it, so a runner that lists them in a different order next time can show a false loss. Give tests distinct names, or keep the file in the name.

What it supports, and no more: no test that passed before may fail, disappear or be skipped without your named approval, on repositories where your gate runs `tests compare`.
