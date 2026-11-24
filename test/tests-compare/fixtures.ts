/** Test reports with made-up names, one per format, for `tests compare`. */

export interface Case {
  name: string;
  status: 'pass' | 'fail' | 'skip';
}

/** A generic JUnit report (the shape pytest, Maven and most runners write), one suite, from a list of cases. */
export function junit(cases: readonly Case[], suite = 'demo.WidgetTest'): string {
  const body = cases
    .map((c) => {
      const inner = c.status === 'fail' ? '<failure message="expected 1, got 2"><![CDATA[at demo <line>]]></failure>' : c.status === 'skip' ? '<skipped/>' : '';
      return `    <testcase classname="${suite}" name="${c.name}" time="0.001">${inner}</testcase>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n  <testsuite name="${suite}" tests="${cases.length}">\n${body}\n  </testsuite>\n</testsuites>\n`;
}

/** The shape of Node's --test-reporter=junit (node 25): classname "test", a file on each case, describe blocks as nested testsuite elements, quotes in names escaped twice. */
export const NODE_JUNIT = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
\t<testcase name="top level passes" time="0.000621" classname="test" file="/work/demo/test/a.test.mjs"/>
\t<testcase name="top level fails" time="0.000548" classname="test" file="/work/demo/test/a.test.mjs" failure="1 == 2">
\t\t<failure type="testCodeFailure" message="1 == 2">
[Error [ERR_TEST_FAILURE]: 1 == 2] {
      at TestContext.&lt;anonymous> (file:///work/demo/test/a.test.mjs:4:40)
}
\t\t</failure>
\t</testcase>
\t<testcase name="skipped one" time="0.000043" classname="test" file="/work/demo/test/a.test.mjs">
\t\t<skipped type="skipped" message="not now"/>
\t</testcase>
\t<testcase name="todo one" time="0.000044" classname="test" file="/work/demo/test/a.test.mjs">
\t\t<skipped type="todo" message="true"/>
\t</testcase>
\t<testsuite name="outer &lt;&amp;> &amp;quot;q&amp;quot;" time="0.000268" disabled="0" errors="0" tests="2" failures="0" skipped="0" hostname="example-host">
\t\t<testcase name="inner passes" time="0.000058" classname="test" file="/work/demo/test/a.test.mjs"/>
\t\t<testsuite name="nested" time="0.000094" disabled="0" errors="0" tests="1" failures="0" skipped="0" hostname="example-host">
\t\t\t<testcase name="deep" time="0.000048" classname="test" file="/work/demo/test/a.test.mjs"/>
\t\t</testsuite>
\t</testsuite>
\t<testcase name="top level passes" time="0.000618" classname="test" file="/work/demo/test/b.test.mjs"/>
\t<!-- tests 7 -->
\t<!-- pass 4 -->
</testsuites>
`;

export function jest(files: readonly { file: string; cases: readonly (Case & { ancestors?: string[]; raw?: string })[] }[]): string {
  return JSON.stringify({
    numTotalTests: files.reduce((n, f) => n + f.cases.length, 0),
    testResults: files.map((f) => ({
      name: f.file,
      status: 'passed',
      assertionResults: f.cases.map((c) => ({
        ancestorTitles: c.ancestors ?? ['widget'],
        title: c.name,
        fullName: [...(c.ancestors ?? ['widget']), c.name].join(' '),
        status: c.raw ?? (c.status === 'pass' ? 'passed' : c.status === 'fail' ? 'failed' : 'pending'),
      })),
    })),
  });
}

export function goJson(events: readonly [action: string, test?: string][], pkg = 'example.test/widget'): string {
  return `${events.map(([Action, Test]) => JSON.stringify({ Time: '2000-01-01T00:00:00Z', Action, Package: pkg, ...(Test !== undefined ? { Test } : {}) })).join('\n')}\n`;
}

export function dartJson(cases: readonly (Case & { unfinished?: boolean })[], path = '/work/demo/test/widget_test.dart'): string {
  const lines: unknown[] = [{ protocolVersion: '0.1.1', runnerVersion: '1.0.0', type: 'start', time: 0 }, { suite: { id: 0, platform: 'vm', path }, type: 'suite', time: 0 }];
  lines.push({ test: { id: 1, name: `loading ${path}`, suiteID: 0, groupIDs: [], metadata: { skip: false } }, type: 'testStart', time: 1 });
  lines.push({ testID: 1, result: 'success', skipped: false, hidden: true, type: 'testDone', time: 2 });
  cases.forEach((c, i) => {
    const id = i + 2;
    lines.push({ test: { id, name: `widget ${c.name}`, suiteID: 0, groupIDs: [], metadata: { skip: c.status === 'skip' } }, type: 'testStart', time: 3 });
    if (c.unfinished !== true) lines.push({ testID: id, result: c.status === 'fail' ? 'failure' : 'success', skipped: c.status === 'skip', hidden: false, type: 'testDone', time: 4 });
  });
  lines.push({ success: true, type: 'done', time: 9 });
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}

export const BASE: readonly Case[] = [
  { name: 'alpha sorts', status: 'pass' },
  { name: 'beta merges', status: 'pass' },
  { name: 'gamma rounds', status: 'fail' },
  { name: 'delta trims', status: 'skip' },
];
