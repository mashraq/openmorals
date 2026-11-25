# Did the new tests fail before the change? `openmorals tests fail-first`

Added in 0.17.0. A command for your own local gate (a pre-merge or pre-push script on your machine, or a separate gate machine). It takes a change (a base commit and a head commit), runs the change's test files against the base code, and reports per test whether it fails there, and why:

- **fails on base by assertion**: an expectation in the test did not hold on the old code. This is the red a test written first should show.
- **red for the wrong reason**: it failed on base by an error, not an assertion: a function, module or file that does not exist yet, a type or syntax error, a test file that did not load. It shows something is missing on base, not that the test checks the behaviour.
- **passes on base**: the test passes on the old code too.

Only tests you name as the change's acceptance tests (`--expect-red`) can fail the check. Every other new test that passes on base is a pointer line, never a failure, because refactor and characterisation tests pass on base by design.

It calls no model and spends no tokens. It is never called from a hook. It does run your test command on code from the change, which **executes project code**: run it on a gate machine or inside a sandbox (a container or a VM), never in the hook path and never on a machine where a test you have not read must not run.

**Evidence only from your gate.** A run is evidence only when your own gate runs it, outside the agent's session, with your own test command. An agent that says it saw its test fail first, or a run the agent made in its own session, is not evidence: test-first inside one session is a design aid for the agent, not a check on it. This line is printed with every result.

## Exit codes

| Exit | Meaning |
|---|---|
| 0 | No named acceptance test failed the check (or none was named). Pointer lines may still be printed |
| 1 | A named acceptance test passes on base, is skipped on base, did not run on base with no load error to explain it, is not found (or the name matches two tests), or does not pass at head |
| 2 | Nothing was judged: not a git repository, the base or head is not a commit here (a typo, a branch that is not here, a shallow clone without it), a git step failed, the settings file is invalid, a run timed out or wrote no readable report, or the machine is Windows. Read this as "needs review", never as a pass |
| 3 | No test command is set in the user-level file (below). Nothing was run |
| 64 | Usage error |
| 128 + n | Stopped by a signal (130 for SIGINT, 143 for SIGTERM, 129 for SIGHUP): the test command was killed and the temporary checkouts removed |

Only exit 0 is a pass. A gate that treats 2 or 3 as success would pass a change whose tests never ran.

A named test that is red for the wrong reason, or red with no reason shown, is listed and does not give exit 1: the commonest honest first red is a test of a function that does not exist yet, which fails on base with a "not a function" or "cannot find module" error. The line tells you to look.

## Where the test command comes from

From one place only: `tests.yaml` in your openmorals config directory (`$OPENMORALS_HOME`, else `~/.config/openmorals`). Never from the project, its `openmorals.yaml`, its `package.json` scripts, a `tests.yaml` in the repository, or anything in the change, so a change cannot choose how it is tested. The config directory is under the self-protect guard: an agent that tries to write the file is asked about, or refused under `--unattended`.

```yaml
fail_first:
  command: node --test --test-reporter=junit --test-reporter-destination="$OPENMORALS_REPORT" "$@"
  timeout_s: 300        # optional: seconds per run, 1 to 86400; default 300
```

With no file, or no `fail_first.command`, the command exits 3 and prints this example; nothing runs. An unknown key, an empty command or a bad `timeout_s` exits 2. This is a file of its own, not a setting in `openmorals.yaml`.

The command runs under `/bin/sh -c` in a temporary checkout. It gets:

- the change's test files to run as its arguments, `"$@"` (file names are passed as arguments, never pasted into the command text, so a file name from the change cannot add shell text);
- `$OPENMORALS_REPORT`: the file it must write its report to (JUnit XML, Jest or Vitest JSON, `go test -json`, or `flutter test --machine` / `dart test --reporter json`, the formats [`tests compare`](tests-compare.md) reads);
- `$OPENMORALS_SIDE` (`base`, `head` or `before`), `$OPENMORALS_BASE` and `$OPENMORALS_HEAD` (commit ids), and `$OPENMORALS_REPO` (your repository's folder, for a command that needs something from it, such as installed dependencies).

The command's exit code is not used: a run with failing tests exits non-zero by nature. What decides is the report. A run that writes no report, or one this command cannot read, is exit 2, with the last lines of the command's output.

Examples. Only the Node one was run while building this command; the others follow each runner's documented options and are not tested here:

| Runner | `command:` |
|---|---|
| Node's test runner | `node --test --test-reporter=junit --test-reporter-destination="$OPENMORALS_REPORT" "$@"` |
| pytest | `python3 -m pytest --junitxml="$OPENMORALS_REPORT" "$@"` |
| Jest | `npx jest --json --outputFile="$OPENMORALS_REPORT" "$@"` |
| Vitest | `npx vitest run --reporter=json --outputFile="$OPENMORALS_REPORT" "$@"` |
| Go | `go test -json ./... > "$OPENMORALS_REPORT"` (Go runs packages, not files) |
| Flutter | `flutter test --machine "$@" > "$OPENMORALS_REPORT"` |

A fresh checkout has no installed dependencies. Install them in the command (for example `npm ci --offline && ...`), or link your own (`ln -s "$OPENMORALS_REPO/node_modules" node_modules && ...`); a link lets the project's test code write into your `node_modules`, which is your choice to make. A project that compiles its tests first (TypeScript to `dist/`) needs the build and the file names mapped in the command.

## What it runs

```sh
openmorals tests fail-first --base "$(git merge-base main HEAD)" --head HEAD --expect-red "test/clamp.test.mjs > clamps high"
```

1. It finds the change's test files: files added or changed between base and head that match the test-file globs of [test-integrity](test-integrity.md) (`test/`, `tests/`, `__tests__/`, `spec/`, `*.test.*`, `*.spec.*`, `*_test.*`, `test_*.py` and the rest). Of those, the ones named like a test to run (`*.test.*`, `*.spec.*`, `*_test.*`, `test_*.py`, `*_spec.rb`, not snapshots) are passed to the command; helpers, fixtures and snapshots under test folders are copied but not passed. A renamed file counts as added. Deleted test files are listed, not run.
2. In a temporary folder it makes up to three checkouts, each a shared local clone (it reads your repository's objects and writes nothing to it):
   - **base with the change's tests**: the base commit, with the head's versions of those test files on top;
   - **head**: the head commit;
   - **base as it was**: the base commit alone, run on those test files that already existed there, to learn which tests are new. When none existed, it is not run and every test is new.
3. It runs your command once in each, in that order, and reads the three reports.

The base and head are commits. Uncommitted changes in your working tree are not read; when there are some, a note says so. With no test file in the change and no named test, nothing is run and it exits 0.

## The three outcomes, and how it tells them apart

A test's name is its file, its suites and its own name, joined by ` > `, as in [`tests compare`](tests-compare.md). `--expect-red NAME` takes the full name, or the end of one after a ` > ` when only one test ends that way (`--expect-red "clamps high"`); give it once per test.

How "red by assertion" is told from "red for the wrong reason", per report format:

| Format | Red by assertion | Red for the wrong reason | Cannot tell |
|---|---|---|---|
| JUnit XML (Node's junit reporter, pytest, most others) | a `<failure>` whose type, message or text first names an assertion marker (`AssertionError`, `ERR_ASSERTION`, `AssertionFailedError`, `ComparisonFailure`, `expect(received)`, a pytest `assert` line, and the rest of `ASSERTION_MARKERS`) | an `<error>` element; a `<failure>` that first names an error marker (`TypeError`, `ReferenceError`, `SyntaxError`, `ImportError`, `ModuleNotFoundError`, `AttributeError`, `NameError`, `is not a function`, `Cannot find module`, `ENOENT`, `panic:` and the rest of `ERROR_MARKERS`); Node's one case per file that did not load (named after the file, text `cause: 'test failed'`); pytest's `collection failure` | a failure that names neither, for example a plain `Error: boom` |
| Jest, Vitest JSON | `failureMessages` first naming an assertion marker | `failureMessages` first naming an error marker; a test file with `status: failed` and no test results (it did not load) | neither named |
| `go test -json` | testify's `Error Trace:` in the test's output | `panic:`; a test that started and never finished; a package that failed with no test result (a build failure) | any other failure: Go has no assertion type |
| `flutter test --machine`, `dart test --reporter json` | `result: failure` (a `TestFailure`) | `result: error`; a failed `loading <file>` entry | a result with neither |

The two published lists (`ASSERTION_MARKERS` and `ERROR_MARKERS`, exported from the `tests` namespace). A marker that is a single word must stand as a whole word; `assert` must start a line (a pytest `E   assert ...` line counts):

- Assertion markers: `AssertionError`, `ERR_ASSERTION`, `AssertionFailedError`, `ComparisonFailure`, `expect(received)`, `ExpectationFailed`, `TestFailure`, `Minitest::Assertion`, `assert`.
- Error markers: `TypeError`, `ReferenceError`, `SyntaxError`, `ImportError`, `ModuleNotFoundError`, `AttributeError`, `NameError`, `NotImplementedError`, `FileNotFoundError`, `ERR_MODULE_NOT_FOUND`, `Cannot find module`, `is not a function`, `is not defined`, `is not a constructor`, `ENOENT`, `NoSuchMethodError`, `NoMethodError`, `UnimplementedError`, `ClassNotFoundException`, `NoClassDefFoundError`, `LoadError`, `undefined method`, `panic:`.

An error that is not on the error list (a `RangeError`, a plain `Error`, a project's own error class) is "cannot tell", not "wrong reason": the code under test may throw it on purpose.

For Node's runner, which wraps every failure, the marker read is the one after `cause:`. Where an error marker and an assertion marker both appear, the earlier one in the text wins. A test that is absent on base while its file failed to load there counts as red for the wrong reason; absent with no such failure, it "did not run on base". Only the Node shapes were seen from a real run while building this; the others are read from each runner's documented report format.

## The output

```text
openmorals tests fail-first: base 5478790c9641, head 85cea7518d3f; test command from <config dir>/tests.yaml
  test files the change added or changed: 4 run, 1 more copied (helpers, fixtures, snapshots)
  base with the change's tests: junit, 4 tests (2 pass, 2 fail, 0 skipped), 1 file(s) did not load (exit 1)
  head: junit, 5 tests (5 pass, 0 fail, 0 skipped) (exit 0)
  base as it was: junit, 1 test (1 pass, 0 fail, 0 skipped) (exit 0)
  (each run bounded by 60 s; totals are shown only and never decide the result)

Named acceptance tests: 1
  ok   test/clamp.test.mjs > clamps high   fails on base by assertion (AssertionError); passes at head
New tests that fail on base by assertion: 0
Red for the wrong reason on base (an error, not an assertion): 2
  ! test/mul.test.mjs > multiplies   red for the wrong reason on base (TypeError); passes at head
  ! test/named.test.mjs > multiplies by name   red for the wrong reason on base: the file did not load or exited before its tests ran; passes at head
Red on base, cannot tell why: 0
New tests that pass on base (pointer lines: a refactor or characterisation test passes on base by design; a test meant to show the change is needed does not): 1
  > test/add.test.mjs > adds negatives   passes on base; passes at head

Result: every named acceptance test fails on base and passes at head (exit 0).
```

That is a real run on a two-commit fixture repository with `timeout_s: 60` (the config folder's path shortened), followed by the "What this cannot tell you" lines below.

New tests skipped or not run on base, and new tests that do not pass at head, get their own lists when there are any. A test that already existed on base is not listed. `--json` prints one object: `exitCode`, `base`, `head`, `settingsFile`, `timeoutSeconds`, `testFiles`, `copiedFiles`, `deletedTestFiles`, `runs`, `rows` (one per test: `id`, `file`, `isNew`, `named`, `base`, `baseWhy`, `head`), `problems`, the id lists `newRedByAssertion`, `redWrongReason`, `redCannotTell`, `newPassingOnBase`, `newSkippedOrAbsentOnBase`, `newNotPassingAtHead`, `notes`, `reports`, `reportRoots` and `limits`; on exits 2 and 3 it prints `{"exitCode": ..., "error": "..."}`.

`--reports DIR` copies the reports (`fail-first-base.xml`, `fail-first-head.xml`, `fail-first-before.xml`, by format) to a folder outside the repository (a folder inside it is refused, exit 64) and prints the `tests compare` line to read them by test name, with the `--before-root` and `--after-root` values that strip the removed checkouts from the paths.

## Safety of running

- **Temporary, and removed.** The checkouts live in one folder named `openmorals-fail-first-*` under the system temp folder (`$TMPDIR`). It is removed when the command ends, on a pass, a failure, an error, a timeout, and on SIGINT, SIGTERM and SIGHUP. A SIGKILL or a power cut cannot be caught: then the folder stays, and you remove it by hand.
- **Bounded.** Each run of your command has a time limit: `--timeout SECONDS`, else `timeout_s`, else 300 seconds; so the whole command is bounded by three runs plus the checkouts, and each git step by 120 seconds. On a timeout or a signal, your command's whole process group is sent SIGTERM, then SIGKILL three seconds later; after every run the group is sent SIGKILL, so nothing it started outlives it.
- **Nothing written into your repository.** Not your working tree, not your index, not `.git`: the checkouts are shared clones (they read your objects through git's alternates), not `git worktree add`, which would register itself in your `.git` and share your refs, config and hooks with the test code. The dirty-tree note uses `git --no-optional-locks status`, which does not rewrite the index. The tests check this by hashing every file in a fixture repository, `.git` included, before and after.
- **No hooks, no network from git.** Every git call runs with an empty hooks folder and clone template (so neither your repository's hooks nor a global template run), fsmonitor off, network transports off (`protocol.allow=never`, local files only), git-lfs downloads skipped and prompts off. The command itself opens no network connection. Your test command may: that is the project's code, which is why it belongs in a sandbox.
- **A cleaner environment.** Your command does not get variables whose names look like credentials (the same rule as `sandbox run`: `*TOKEN*`, `*SECRET*`, `*API_KEY*`, `*PASSWORD*`, `*AUTH*` and similar), any `GIT_*` variable (so a test that runs git cannot reach your repository through `GIT_DIR` or `GIT_INDEX_FILE`), or `NODE_TEST_CONTEXT`.
- **Not on Windows yet.** It needs `/bin/sh`; on Windows it exits 2.

## What it cannot tell you

These lines are printed with every result:

- It is evidence only when your own gate runs it, outside the agent's session, with your test command. An agent saying it saw a test fail first, or a run the agent made, is not evidence.
- A test that fails on base shows the change is needed for it to pass. It does not show that the test checks the right thing: a test can fail on base and still assert too little at head. Read the tests; [`tests compare`](tests-compare.md) and the test-integrity reasons in [`diff-class`](test-integrity.md) look at the rest.
- Only the test files the change added or changed are run (as your command uses the file list). Other tests are not looked at; run `tests compare` for those.
- "Red for the wrong reason" is read from the report. Where a runner shows no error class, element or result field, the line says "cannot tell".
- It runs your test command on code from the change, which executes project code. Run it on a gate machine or inside a sandbox, never from a hook.

Also: submodules are not checked out; filter drivers you configured (other than git-lfs downloads) run on checkout as in any clone; the per-format readings of pytest, Jest, Vitest, Go and Dart come from their documented formats and have not been run here; nothing has been run against a live agent.

What it supports, and no more: on repositories where your gate runs `tests fail-first` with your test command, a test you name as an acceptance test of a change is shown to fail on the code before the change and to pass after it, or the gate says it did not.
