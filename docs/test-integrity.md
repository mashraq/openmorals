# Test-integrity reason lines in `openmorals diff-class`

Added in 0.13.0. Part of the merge verdict ([docs/merge-verdict.md](merge-verdict.md), [ADR 0013](adr/0013-a-merge-verdict-decided-in-ci-the-record-can-only-raise-review.md)).

An agent that is judged by tests can also edit the tests. `openmorals diff-class` now reads the diff for the shapes that weakening takes, and names them in reason lines: a test file that lost assertions, a skip or `only` mark added, a snapshot or runner configuration changed, the package `scripts` changed, an exit call added in test code, an expected value changed in an assertion, an equality override in test helpers, a lint or type-check suppression added, a new dependency, files outside the paths the work was declared to touch, a change over a size line you set, and a declared boundary path changed with no decision record.

Each line is a pointer for the person reading the change. It says where to look. It does not say the change is wrong: on this repository's own history every firing that was read was honest work.

## What a reason line does, and what it never does

- **It can only add review.** A reason line puts the change in class B (needs review). It never lowers a class, never removes another reason, and never makes anything review-free ([ADR 0013](adr/0013-a-merge-verdict-decided-in-ci-the-record-can-only-raise-review.md): the verdict can only be raised).
- **It is not an ask and not a block.** It changes no exit code beyond the merge verdict's own: review is exit 1 with or without these lines. Nothing interrupts the agent while it works. Since nothing is review-free by default, a reason line changes the exit code only when you have switched a review-free class on and the change would otherwise have met it.
- **It is plain code.** No model call, no tokens, no credential. It reads the diff and, for two rules, the base version of a manifest.
- **It is not a score.** No pass mark, no quality figure, no ranking of agents or people. A count of lines is a count of lines.
- **Its nuisance rate is not measured.** On this repository's history the rules fire on about one commit in five (below), all honest. How often they fire on your work, and how often a firing points at something real, is unknown until they have run on real sessions. So this page does not recommend them as a default gate; read them as pointers.

## How the lines appear

Text output keeps the merge verdict's limit of **at most three reason lines**. The test-integrity lines come first after any settings or run-record facts and before the exclusion facts (which mostly say "executable source" or "a test file", true of nearly every change). When there are more facts, the first line says how many are in `--json`. The last line says how many test-integrity rules had no input. A real run, on a change that drops one assertion and marks the test `it.skip`:

```
openmorals diff-class: REVIEW (class B), 2 files; 1 more fact in --json
  - a test file lost assertion-like lines (diff: 1 removed, 0 added, net -1): test/math.test.ts
  - adds a skip, only, todo or expected-failure mark in a test file: test/math.test.ts
  - executable source: src/math.ts, test/math.test.ts
It cannot see how it was run (5 preconditions in --json and docs/merge-verdict.md); 3 test-integrity rules had no input (notChecked in --json).
```

`--json` carries every reason in `reasons` (each `{rule, path, text}`; the test-integrity ones have a `rule` starting with `integrity.`) and a `notChecked` list, one line per rule that had no input, for example `integrity.outside-paths: no declared paths (--paths)`.

## Declared inputs

Three rules need something only you can say:

- **The paths the work was declared to touch:** `--paths GLOB`, repeated for each glob (the glob rules of `always_review`: no `/` means any depth, a folder covers everything under it). Until work orders exist (`openmorals order`, planned), the flag is the source: put it in the gate script, not anywhere the agent writes. A file outside every glob gets `integrity.outside-paths`.
- **Boundary paths:** `merge.boundary_paths` in the bylaws, a list of globs for the parts of the code whose change should come with a decision record (a public interface, a bounded context, the engine). Your user-level file or the base branch's project file can add entries; a project file cannot drop yours. A change under one, in a diff that adds or changes nothing under `docs/adr/`, gets `integrity.boundary-no-adr`. Keep the list narrow: on this repository, `src/engine.ts` fired on 2 of 62 commits, `src/adapters/` on 14.
- **A size line:** `--max-lines N` and `--max-files N`. No line is set by default (below, for why). A change over either gets `integrity.size`.

```yaml
# openmorals.yaml
merge:
  boundary_paths: [src/engine.ts, src/public-api/]
```

```
openmorals diff-class change.diff --base base-tree --paths src/billing/ --paths test/billing/ --max-lines 800
```

## Which files are tests

Test files are the paths of the `exclude.test-file` rule of the merge verdict: `test/`, `tests/`, `__tests__/`, `spec/`, `specs/`, `e2e/`, `testdata/`, `__snapshots__/`, `__mocks__/`, `*.test.*`, `*.spec.*`, `*_test.*`, `test_*.py`, `*_spec.rb`, `*.snap`. Test-runner configuration is the `exclude.test-runner-config` list (`jest.config.*`, `vitest.config.*`, `pytest.ini`, `conftest.py`, `.mocharc*`, `dart_test.yaml` and the rest, in `src/diffclass/rules.ts`). Tests kept anywhere else are not read as tests.

## The rules

Each rule has a stable id (the `rule` of its reason), a pattern published here exactly as the code holds it, what it misses, and the number of times it fired on this repository's history up to 0.12.0 (62 commits, no declared inputs). `cases/diff-class.cases.yaml` has rows for every rule, including near misses each rule must stay silent on, and a test deletes each rule in turn and checks that its rows then fail.

### `integrity.assert-removed`

Pattern:

```
a test file in which more removed lines than added lines match /expect|assert|\.to[A-Z]|\.(rejects|throws)\b/ (its own count of assertion-like lines fell, a deleted test file included); the line gives the diff's removed, added and net count of such lines
```

It misses: assertions written with other names (t.equal, should, matchers in helpers outside test paths); an assertion weakened in place (one line out, one weaker line in: see integrity.expected-changed for changed literals); assertions moved to a new test file in the same diff still fire for the old one

Input: the diff.

Fired on this repository's history: 1/62 commits (2%): e347d0e.

### `integrity.skip-added`

Pattern:

```
an added line in a test file matching /\b(?:it|test|describe|context|suite|specify|t)\.(?:skip|only|todo|skipIf|runIf|fails)\b|\b[xf](?:it|describe|test|context)\s*\(|[{,]\s*(?:skip|only|todo)\s*:(?!\s*(?:false\b|\d))|\bskip\s*:\s*(?:true|'|")|@pytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.(?:skip|xfail|importorskip)\s*\(|@unittest\.(?:skip\w*|expectedFailure)\b|\bself\.skipTest\s*\(|\bt\.Skip(?:Now|f)?\s*\(|@(?:Disabled|Ignore)\b|#\[ignore\]/
```

It misses: a skip decided at run time in a helper, an early return, an environment variable that filters tests, a test renamed out of the runner's file pattern; honest platform skips fire too

Input: the diff.

Fired on this repository's history: 6/62 commits (10%): 71a87ba, e4dbc32, 7525280, c8e692c, 9e1f2d4, 66d3d12.

### `integrity.snapshot`

Pattern:

```
a file added, changed or deleted whose path matches __snapshots__/, *.snap, *.snapshot, *.ambr, __screenshots__/, goldens/, *.golden, *.approved.*, *.received.*
```

It misses: snapshots stored under other names or inline in a test file (inline snapshots show only as changed test lines)

Input: the diff.

Fired on this repository's history: 0/62 commits (0%).

### `integrity.runner-config`

Pattern:

```
a file added, changed or deleted whose path matches the test-runner-config exclusion globs (jest.config.*, vitest.config.*, vitest.workspace.*, karma.conf.*, .mocharc, .mocharc.*, ava.config.*, playwright.config.*, cypress.config.*, cypress.json, pytest.ini, conftest.py, tox.ini, noxfile.py, .coveragerc, dart_test.yaml, analysis_options.yaml, phpunit.xml, phpunit.xml.dist, .rspec, .nycrc, .nycrc.*, .c8rc, .c8rc.*, jasmine.json, wdio.conf.*, codecov.yml, .codecov.yml, .test-lock)
```

It misses: runner settings kept inside package.json, pyproject.toml or another manifest (see integrity.scripts for package scripts), runner flags on a command line outside the repository

Input: the diff.

Fired on this repository's history: 0/62 commits (0%).

### `integrity.scripts`

Pattern:

```
package.json or composer.json at any depth whose "scripts" object differs between the base and the head (both read and checked against the diff's hashes); when either cannot be read, the line says so
```

It misses: scripts in a Makefile, a shell file or a task runner (those are build-script exclusions); a script whose text is the same but whose called file changed

Input: the diff and the base tree.

Fired on this repository's history: 2/62 commits (3%): 4d16730, 478c860.

### `integrity.exit-added`

Pattern:

```
an added line in a test file or test-runner config matching /\b(?:process\.(?:exit|abort|reallyExit)|sys\.exit|os\._exit|os\.Exit|Deno\.exit|System\.exit|Environment\.Exit)\s*\(|\bprocess\.exitCode\s*=|^\s*(?:exit|quit)\s*\(/
```

It misses: an exit reached through a helper outside test paths, a thrown error caught by a wrapper that exits, a runner told to bail

Input: the diff.

Fired on this repository's history: 2/62 commits (3%): f3cad4d, 17ccee1.

### `integrity.expected-changed`

Pattern:

```
in a test file, a removed line and the added line that replaces it (same position in a run of - lines and the + run after it) both match /expect|assert|\.to[A-Z]|\.(rejects|throws)\b/ and are equal once every string, number, true/false/null literal is replaced by one placeholder
```

It misses: an expected value moved to a constant or fixture file, a changed expected value on a line that is not an assertion, a replacement that also renames anything; an honest fix to a wrong expectation fires too

Input: the diff.

Fired on this repository's history: 1/62 commits (2%): 078019a.

### `integrity.equality-override`

Pattern:

```
an added line in a test file or test-runner config matching /\bdef\s+__(?:eq|ne|hash|lt|le|gt|ge)__\s*\(|\boperator\s*==|\b(?:public|override)\b[^;{]*\bequals\s*\(|\bimpl\b[^{]*\bPartialEq\b|\bexpect\.(?:extend|addEqualityTesters|addSnapshotSerializer)\s*\(|\bassert\.\w+\s*=(?!=)|\b(?:Object|Array|String|Number|Boolean|Date|RegExp)\.prototype\.\w+\s*=(?!=)|\bfunc\s*\([^)]*\)\s*Equal\s*\(/
```

It misses: an equality or comparison override in source code outside test paths (operator overloading in the code under test), a matcher imported from a package

Input: the diff.

Fired on this repository's history: 0/62 commits (0%).

### `integrity.suppression-added`

Pattern:

```
an added line in a test file or a file with a code extension matching /eslint-disable|tslint:disable|@ts-(?:ignore|expect-error|nocheck)|#\s*type:\s*ignore|#\s*noqa\b|flake8:\s*noqa|pylint:\s*disable|pyright:\s*ignore|mypy:\s*ignore-errors|\/\/\s*ignore(?:_for_file)?:|#!?\[allow\(|@Suppress(?:Warnings)?\b|\/\/\s*nolint\b|#pragma\s+warning\s+disable|NOSONAR|(?:istanbul|c8|v8)\s+ignore|pragma:\s*no\s*cover|biome-ignore|deno-lint-ignore|rubocop:disable|swiftlint:disable|@phpstan-ignore|#\s*nosec\b|\bnoinspection\b/
```

It misses: a rule switched off in a linter or compiler config file (those are build-script exclusions), a cast such as "as any", suppressions in files without a code extension; a file that names these markers as data (this rule list itself) fires too

Input: the diff.

Fired on this repository's history: 3/62 commits (5%): e4dbc32, 7525280, d68b898.

### `integrity.dependency-added`

Pattern:

```
a dependency name present in the head and not in the base of package.json, composer.json, requirements*.txt, constraints*.txt, go.mod, Gemfile, Cargo.toml, pyproject.toml or pubspec.yaml (both versions read and checked against the diff's hashes); when either cannot be read, the line says so
```

It misses: a dependency added through a lockfile only, a vendored copy, a download in a script, a manifest format not listed; a version change of an existing dependency does not fire

Input: the diff and the base tree.

Fired on this repository's history: 3/62 commits (5%): 4d16730, 478c860, 7525280.

### `integrity.outside-paths`

Pattern:

```
a file whose old or new path matches none of the declared path globs (--paths, glob rules as in always_review)
```

It misses: nothing when no paths were declared (the rule then has no input and says so in notChecked); whether the declared paths were the right ones

Input: declared paths (`--paths`). Without it the rule does not run and `notChecked` says so.

Fired on this repository's history: no input was declared, so not measured by default (see [Fire rates](#fire-rates-on-this-repositorys-history)).

### `integrity.size`

Pattern:

```
more changed lines (added plus removed, text files) than the declared size line (--max-lines), or more files than the declared file line (--max-files); no line is set by default
```

It misses: nothing until you declare a line; how hard a change is to read (a small change can hide more than a large rename)

Input: a size line (`--max-lines`, `--max-files`). Without it the rule does not run and `notChecked` says so.

Fired on this repository's history: no input was declared, so not measured by default (see [Fire rates](#fire-rates-on-this-repositorys-history)).

### `integrity.boundary-no-adr`

Pattern:

```
a file whose path matches a declared boundary glob (merge.boundary_paths) when no file under docs/adr/ is added or changed in the same diff
```

It misses: nothing when no boundary paths are declared; whether the decision record says anything useful (it checks only that one changed)

Input: boundary paths (`merge.boundary_paths`). Without it the rule does not run and `notChecked` says so.

Fired on this repository's history: no input was declared, so not measured by default (see [Fire rates](#fire-rates-on-this-repositorys-history)).

## Fire rates on this repository's history

Replayed with read-only `git log`, `git diff` and `git show` over the 62 commits up to 0.12.0, each diff against its parent, no paths declared, no boundary paths, no size line:

| | commits fired |
|---|---|
| any rule | 13 of 62 (21%) |
| the six shapes the design measured first (assertions lost, skip added, snapshot, runner config, scripts, exit added) | 11 of 62 (18%) |
| with a size line of 1000 lines or 50 files | 19 of 62 (31%) |
| with `merge.boundary_paths: [src/engine.ts]` | 13 of 62 (21%; the rule itself 2 of 62) |
| with `merge.boundary_paths: [src/types.ts]` | 19 of 62 (31%; the rule itself 7 of 62) |
| with `merge.boundary_paths: [src/adapters/]` | 21 of 62 (34%; the rule itself 14 of 62) |

The design set two lines in advance for narrowing or removing these rules: any rule whose firings are judged real by a reviewer less than 5% of the time over at least 50 firings, and all rules together firing on more than a quarter of commits. The first version fired on 23 of 62 commits (37%): a test file with any removed assertion line counted (11 commits, every one adding more assertions than it removed), a skip option set to `false` in test data counted, and a size line of 1000 lines was on by default (12 commits; this repository lands each unit as one large commit). It was narrowed to what is listed above. The per-rule line cannot be checked here: no rule fired more than 6 times, and no firing has been judged by a reviewer. Both wait on real sessions.

What the history shows is the nuisance side only. Every firing read on it was honest work (platform skips, `# noqa` on a test import, a typed negative test with `@ts-expect-error`, a fixture that sets `process.exitCode`), so this history cannot say how many weakening changes the rules would catch.

## What these lines cannot tell you

- Whether a change is good. A removed assertion can be a fix; an added skip can be the honest thing on a platform that cannot run the test. The lines say where to read, not what to conclude.
- Anything a pattern does not see: an assertion weakened in place without a literal change, a test that checks little from the start, a special case in the code under test that makes a test pass, tests run by a command outside the repository. Each rule's "It misses" line above is part of the rule.
- Whether the declared paths, boundaries and size line are the right ones. They are yours.
- That a change without reason lines kept its tests. No line means no pattern matched, nothing more. For tests that passed before and fail, vanish or are skipped after, compare the two runs by name with [`openmorals tests compare`](tests-compare.md); that one can exit 1 on an unapproved loss.
