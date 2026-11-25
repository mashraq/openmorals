import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyFailureText, parseTestReport } from '../../src/tests/report.js';
import type { TestReport } from '../../src/tests/report.js';
import { MAX_TEXT, parseXml } from '../../src/tests/xml.js';

function read(text: string, opts: Parameters<typeof parseTestReport>[1] = {}): TestReport {
  const r = parseTestReport(text, opts);
  if (!r.ok) throw new Error(r.error);
  return r.report;
}

const kinds = (r: TestReport): Record<string, string> => Object.fromEntries(r.tests.map((t) => [t.id, t.failure === undefined ? t.status : `${t.failure.kind}${t.failure.load ? ' load' : ''}`]));

/** The shape Node's --test-reporter=junit wrote in a probe (node v25.9.0), with a fake folder. */
const NODE_JUNIT = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
	<testcase name="assert fails" time="0.001" classname="test" file="/w/c/test/a.test.mjs" failure="Expected values to be strictly equal:&#10;&#10;2 !== 3&#10;">
		<failure type="testCodeFailure" message="Expected values to be strictly equal:&#10;&#10;2 !== 3">
[Error [ERR_TEST_FAILURE]: Expected values to be strictly equal:

2 !== 3
] {
  code: 'ERR_TEST_FAILURE',
  failureType: 'testCodeFailure',
  cause: AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
      at TestContext.&lt;anonymous> (file:///w/c/test/a.test.mjs:4:37) {
    code: 'ERR_ASSERTION'
  }
}
		</failure>
	</testcase>
	<testcase name="not a function" time="0.0001" classname="test" file="/w/c/test/a.test.mjs" failure="lib.mul is not a function">
		<failure type="testCodeFailure" message="lib.mul is not a function">
[Error [ERR_TEST_FAILURE]: lib.mul is not a function] {
  code: 'ERR_TEST_FAILURE',
  failureType: 'testCodeFailure',
  cause: TypeError: lib.mul is not a function
      at TestContext.&lt;anonymous> (file:///w/c/test/a.test.mjs:5:36)
}
		</failure>
	</testcase>
	<testcase name="passes" time="0.0001" classname="test" file="/w/c/test/a.test.mjs"/>
	<testcase name="plain error" time="0.0001" classname="test" file="/w/c/test/a.test.mjs" failure="boom">
		<failure type="testCodeFailure" message="boom">
[Error [ERR_TEST_FAILURE]: boom] {
  code: 'ERR_TEST_FAILURE',
  failureType: 'testCodeFailure',
  cause: Error: boom
}
		</failure>
	</testcase>
	<testcase name="test/b.test.mjs" time="0.06" classname="test" file="/w/c/test/b.test.mjs" failure="test failed">
		<failure type="testCodeFailure" message="test failed">
[Error: test failed] { code: 'ERR_TEST_FAILURE', failureType: 'testCodeFailure', cause: 'test failed', exitCode: 1, signal: null }
		</failure>
	</testcase>
</testsuites>
`;

describe('tests fail-first: why a test failed, per report format', () => {
  it('Node junit: the class after "cause:" decides; a case named after its file that says "test failed" is a load error', () => {
    const r = read(NODE_JUNIT, { root: '/w/c' });
    assert.deepEqual(kinds(r), {
      'test/a.test.mjs > assert fails': 'assertion',
      'test/a.test.mjs > not a function': 'error',
      'test/a.test.mjs > passes': 'pass',
      'test/a.test.mjs > plain error': 'unknown',
      'test/b.test.mjs > test/b.test.mjs': 'error load',
    });
  });

  it('JUnit <error> is an error; pytest-style messages are read by their text (shape from the format, not a run)', () => {
    const x = `<testsuite name="pytest"><testcase classname="tests.test_m" name="test_a" file="tests/test_m.py"><failure message="assert 2 == 3">def test_a():
&gt;       assert add(1, 1) == 3
E       assert 2 == 3</failure></testcase>
<testcase classname="tests.test_m" name="test_b" file="tests/test_m.py"><failure message="AttributeError: module 'm' has no attribute 'mul'">E   AttributeError</failure></testcase>
<testcase classname="" name="tests.test_n" file="tests/test_n.py"><error message="collection failure">ModuleNotFoundError: No module named 'n'</error></testcase></testsuite>`;
    const r = read(x);
    assert.deepEqual(kinds(r), {
      'tests/test_m.py > pytest > tests.test_m > test_a': 'assertion',
      'tests/test_m.py > pytest > tests.test_m > test_b': 'error',
      'tests/test_n.py > pytest > tests.test_n': 'error load',
    });
  });

  it('Jest and Vitest JSON: failureMessages decide; a file that failed with no results is a load error (shape from the format)', () => {
    const j = JSON.stringify({
      testResults: [
        { name: '/w/c/a.test.js', status: 'failed', assertionResults: [
          { title: 'expects', ancestorTitles: [], status: 'failed', failureMessages: ['Error: expect(received).toBe(expected) // Object.is equality'] },
          { title: 'vitest', ancestorTitles: [], status: 'failed', failureMessages: ['AssertionError: expected 2 to be 3'] },
          { title: 'missing', ancestorTitles: [], status: 'failed', failureMessages: ['TypeError: mul is not a function'] },
        ] },
        { name: '/w/c/b.test.js', status: 'failed', message: '  ● Test suite failed to run\n\n    Cannot find module \'./mul\' from \'b.test.js\'', assertionResults: [] },
      ],
    });
    const r = read(j, { root: '/w/c' });
    assert.deepEqual(kinds(r), { 'a.test.js > expects': 'assertion', 'a.test.js > vitest': 'assertion', 'a.test.js > missing': 'error' });
    assert.deepEqual(r.loadErrors, [{ file: 'b.test.js', why: "the file failed with no test result: Cannot find module './mul' from 'b.test.js'" }]);
  });

  it('a report that holds only load errors is read by fail-first and stays unreadable for tests compare', () => {
    const j = JSON.stringify({ testResults: [{ name: '/w/c/b.test.js', status: 'failed', message: 'Cannot find module', assertionResults: [] }] });
    assert.equal(parseTestReport(j).ok, false);
    const r = read(j, { loadErrorsOnly: true, root: '/w/c' });
    assert.deepEqual(r.tests, []);
    assert.equal(r.loadErrors?.length, 1);
    assert.equal(parseTestReport('{"testResults":[]}', { loadErrorsOnly: true }).ok, false, 'no tests and no load errors is still unreadable');
  });

  it('go test -json: a panic is an error, testify an assertion, a plain failure cannot be told, a package with no test that failed is a load error', () => {
    const lines = [
      { Action: 'run', Package: 'p', Test: 'TestPanic' }, { Action: 'output', Package: 'p', Test: 'TestPanic', Output: 'panic: runtime error: index out of range\n' }, { Action: 'fail', Package: 'p', Test: 'TestPanic' },
      { Action: 'run', Package: 'p', Test: 'TestTestify' }, { Action: 'output', Package: 'p', Test: 'TestTestify', Output: '    Error Trace:\tx_test.go:9\n' }, { Action: 'fail', Package: 'p', Test: 'TestTestify' },
      { Action: 'run', Package: 'p', Test: 'TestPlain' }, { Action: 'output', Package: 'p', Test: 'TestPlain', Output: '    x_test.go:12: got 2 want 3\n' }, { Action: 'fail', Package: 'p', Test: 'TestPlain' },
      { Action: 'output', Package: 'q', Output: 'FAIL\tq [build failed]\n' }, { Action: 'fail', Package: 'q' },
    ].map((l) => JSON.stringify(l)).join('\n');
    const r = read(lines);
    assert.deepEqual(kinds(r), { 'p > TestPanic': 'error', 'p > TestTestify': 'assertion', 'p > TestPlain': 'unknown' });
    assert.deepEqual(r.loadErrors?.map((e) => e.file), ['q']);
  });

  it('dart and flutter JSON: result "failure" is an assertion, "error" an error, a failed "loading" entry a load error (shape from the protocol)', () => {
    const lines = [
      { type: 'suite', suite: { id: 0, path: '/w/c/test/a_test.dart' } },
      { type: 'testStart', test: { id: 1, name: 'loading /w/c/test/a_test.dart', suiteID: 0 } }, { type: 'testDone', testID: 1, result: 'success', hidden: true },
      { type: 'testStart', test: { id: 2, name: 'expects', suiteID: 0 } }, { type: 'error', testID: 2, error: 'Expected: <3>', isFailure: true }, { type: 'testDone', testID: 2, result: 'failure', hidden: false },
      { type: 'testStart', test: { id: 3, name: 'throws', suiteID: 0 } }, { type: 'error', testID: 3, error: 'NoSuchMethodError', isFailure: false }, { type: 'testDone', testID: 3, result: 'error', hidden: false },
      { type: 'suite', suite: { id: 4, path: '/w/c/test/b_test.dart' } },
      { type: 'testStart', test: { id: 5, name: 'loading /w/c/test/b_test.dart', suiteID: 4 } }, { type: 'error', testID: 5, error: 'Compilation failed', isFailure: false }, { type: 'testDone', testID: 5, result: 'error', hidden: false },
    ].map((l) => JSON.stringify(l)).join('\n');
    const r = read(lines, { root: '/w/c' });
    assert.deepEqual(kinds(r), { 'test/a_test.dart > expects': 'assertion', 'test/a_test.dart > throws': 'error', 'test/b_test.dart > loading /w/c/test/b_test.dart': 'error load' });
  });

  it('the text classifier: the earliest marker wins, unknown when none is named', () => {
    assert.equal(classifyFailureText('AssertionError: expected TypeError').kind, 'assertion');
    assert.equal(classifyFailureText('TypeError: x is not a function\n  at AssertionError').kind, 'error');
    assert.equal(classifyFailureText('Error: not implemented yet').kind, 'unknown');
    assert.equal(classifyFailureText('E   assert 1 == 2').kind, 'assertion');
    assert.equal(classifyFailureText('MyTypeErrorish thing').kind, 'unknown', 'a marker must stand as a word');
  });

  it('the XML reader keeps an element\'s text, decoded, and cuts it at MAX_TEXT', () => {
    const x = parseXml(`<r><f>a &lt; b<![CDATA[ <c> ]]></f><g>${'x'.repeat(MAX_TEXT + 10)}</g></r>`);
    assert.ok(x.ok);
    if (!x.ok) return;
    assert.equal(x.root.children[0]?.text, 'a < b <c> ');
    assert.equal(x.root.children[1]?.text?.length, MAX_TEXT);
  });
});

describe('tests fail-first: the published guide matches the code', () => {
  it('docs/tests-fail-first.md lists every marker, every exit code and the default timeout', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { REPO_ROOT } = await import('../helpers.js');
    const { ASSERTION_MARKERS, ERROR_MARKERS } = await import('../../src/tests/report.js');
    const { FAIL_FIRST_DEFAULT_TIMEOUT_S, FAIL_FIRST_EXIT, FAIL_FIRST_SETTINGS_FILE } = await import('../../src/tests/failfirst-run.js');
    const doc = readFileSync(join(REPO_ROOT, 'docs', 'tests-fail-first.md'), 'utf8');
    for (const m of [...ASSERTION_MARKERS, ...ERROR_MARKERS]) assert.ok(doc.includes(`\`${m.trim()}\``), `marker ${m} is not in the guide`);
    for (const code of Object.values(FAIL_FIRST_EXIT)) assert.ok(doc.includes(`| ${code} |`), `exit ${code} is not in the guide's table`);
    assert.ok(doc.includes(`default ${FAIL_FIRST_DEFAULT_TIMEOUT_S}`));
    assert.ok(doc.includes(`\`${FAIL_FIRST_SETTINGS_FILE}\``));
  });
});
