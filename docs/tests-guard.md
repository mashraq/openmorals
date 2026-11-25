# Checking what an agent says about its tests (0.32.0)

Four commands for your own gate, after the agent's session. Each reads files you made with your own run; none runs tests, calls a model or writes anything. Each prints what it cannot tell you, every time.

| Command | Question it answers | Exit 1 when |
|---|---|---|
| `openmorals tests provenance [PATH...]` | Which test files did the agent write? | a listed test file was written by the agent |
| `openmorals tests claim <clean-report> [--claimed FILE]` | Does what the agent said passed pass in my run? | a claimed test fails, is skipped or did not run |
| `openmorals tests coverage <before> <after>` | Which files lost coverage? | a file lost `--min-drop` points or left the report |
| `tests-quarantine.txt` | Which flaky tests can no longer decide anything? | (a file, read by `compare`, `claim` and `fail-first`) |

Every command exits 2 when an input cannot be read (read it as "needs review") and 64 on a usage error.

## Which test files the agent wrote

From 0.32.0 each audit record carries `tests`: the test files that call writes, relative to the project. A test file is one that matches the diff-class `exclude.test-file` globs (see [test-integrity.md](test-integrity.md#which-files-are-tests)). Seen: the Write and Edit tools, and in a shell command a redirect target and the files `tee`, `cp`, `mv`, `install`, `ln`, `rsync` and `sed -i` write.

```
openmorals tests provenance test/payments.test.ts test/refunds.test.ts
openmorals tests provenance --session "$SESSION" --since 2026-11-25T09:00:00Z --json
```

Each path is listed with the calls that wrote it (time, session, sub-agent, host, tool) and how many tries were stopped. With paths, one with no record is listed as such.

Not checked: a test written by a script, a code generator or an interpreter one-liner (`python -c`, `node -e`) is not seen; records start at 0.32.0; and no record is not proof the agent did not write the file (the audit may have been off). A test the agent wrote can pass without showing anything, so read its changes before you accept it as proof.

## Whether "the tests pass" holds

```
openmorals tests claim clean.xml                          # the claim: every test passes
openmorals tests claim clean.xml --claimed agent.xml      # the agent's own report: its passing tests are the claim
openmorals tests claim clean.xml --claimed claimed.txt    # a list of test ids or names, one per line
```

Make `clean.xml` yourself, in a fresh checkout, with your own test command: a report from the agent's shell is its claim, not a measurement. It reads the report formats `tests compare` reads. A name matches a test id exactly, or the one id that ends with ` > <name>`; a name that matches more than one is listed as ambiguous. Files that did not load in the clean run are listed, and fail a claim that every test passes.

Not checked: a claim made in prose is read as "every test passes"; a test that passes can still check nothing.

## Held tests (flaky)

`tests-quarantine.txt` in your config directory lists tests you put on hold, one id per line, with an optional ` # why`:

```
demo.WidgetTest > retries on timeout # flaky on the shared runner, issue 412
```

A held test:

- **does not block `tests compare`**: its loss is listed as `(on hold, does not block)`;
- **never counts as proof**: a held test that now passes is marked `(on hold: not counted as proof)`; in `tests claim` a held failure is listed and does not decide;
- **fails `tests fail-first` when it is a named acceptance test**: a flaky test cannot show the change was needed (`held`).

The file sits in the configuration directory, which the self-protect guard keeps the agent from writing: only you add a hold. `tests compare --before-repeat` and `--after-repeat` already find tests whose outcome differs between runs; a flaky loss still blocks until you approve it or hold it.

## Which files lost coverage

```
openmorals tests coverage before.lcov after.lcov
openmorals tests coverage coverage-before.xml coverage-after.xml --min-drop 2 --json
```

Reads lcov tracefiles and Cobertura XML. One line per file, worst first: each file whose share of covered lines fell by at least `--min-drop` percentage points (default 1), each file that had covered lines and is gone from the after report (its tests may no longer run), and new files no test runs. The totals are printed and decide nothing: one number hides where the coverage went.

Not checked: coverage says a line ran, not that a test checked what it did; a file whose lines moved is compared by share, not line by line.

## In a gate

```sh
openmorals tests claim "$CLEAN" --claimed "$AGENT_REPORT" || exit 1
openmorals tests compare "$BEFORE" "$CLEAN" || exit 1
openmorals tests coverage "$COV_BEFORE" "$COV_AFTER" || echo "coverage fell: read the lines above"
openmorals tests provenance $(git diff --name-only "$BASE" -- test tests spec) || echo "the agent wrote these tests: read them"
```
