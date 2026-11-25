/** The user-level file that holds the test command. openmorals reads no project file, package script or diff for it. */
export const FAIL_FIRST_SETTINGS_FILE = 'tests.yaml';
export const FAIL_FIRST_DEFAULT_TIMEOUT_S = 300;
export const FAIL_FIRST_USAGE = `  openmorals tests fail-first --base REV [--head REV] [--expect-red TEST]... [--order FILE]
                  [--timeout SECONDS] [--repo DIR] [--reports DIR] [--json]
      Run the change's test files on the base commit, from your own gate, outside the
      agent's session. In temporary checkouts (shared local clones, removed on every
      exit) it runs the base with the change's added and changed test files on top,
      then the head, then the base as it was, with the test command from
      ${FAIL_FIRST_SETTINGS_FILE} in the config directory (never from the project, its package
      scripts or the change), and reports per test whether it fails on base, and
      whether by an assertion or for the wrong reason (an error such as a missing
      module or function). --expect-red names an acceptance test of the change: the
      only tests that can fail the check. Other new tests that pass on base are
      pointer lines (refactor and characterisation tests pass on base by design).
      --order names them from the tests conditions of a work order you approved
      (an order that is not approved as it reads now: exit 2).
      Each run is bounded by --timeout (default ${FAIL_FIRST_DEFAULT_TIMEOUT_S} s). --reports copies the
      reports to a folder outside the repository, for tests compare. It executes
      project code: run it on a gate machine or in a sandbox, never from a hook.
      Exit code: 0 no named test failed the check, 1 a named acceptance test passes
      or is skipped on base, did not run there, is not found, or does not pass at
      head, 2 nothing was judged (no git repository, base or head, a git step,
      a run that timed out or wrote no readable report), 3 no test command is set,
      64 usage error. A signal ends it with 128 + the signal number.`;
