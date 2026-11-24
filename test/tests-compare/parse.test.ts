import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectFormat, parseTestReport, relativeTo } from '../../src/tests/report.js';
import type { TestReport } from '../../src/tests/report.js';
import { parseXml } from '../../src/tests/xml.js';
import { BASE, NODE_JUNIT, dartJson, goJson, jest, junit } from './fixtures.js';

function read(text: string, root?: string): TestReport {
  const r = parseTestReport(text, root !== undefined ? { root } : {});
  if (!r.ok) assert.fail(r.error);
  return r.report;
}

function statuses(r: TestReport): Record<string, string> {
  return Object.fromEntries(r.tests.map((t) => [t.id, t.status]));
}

function unreadable(text: string, pattern: RegExp): void {
  const r = parseTestReport(text);
  assert.equal(r.ok, false, `read as a report: ${text.slice(0, 80)}`);
  if (!r.ok) assert.match(r.error, pattern);
}

describe('tests compare: reading JUnit XML', () => {
  it('reads pass, failure, error and skipped by suite and name', () => {
    const r = read(junit(BASE).replace('</testsuite>', '<testcase classname="demo.WidgetTest" name="epsilon errs"><error message="boom"/></testcase></testsuite>'));
    assert.equal(r.format, 'junit');
    assert.deepEqual(statuses(r), {
      'demo.WidgetTest > alpha sorts': 'pass',
      'demo.WidgetTest > beta merges': 'pass',
      'demo.WidgetTest > gamma rounds': 'fail',
      'demo.WidgetTest > delta trims': 'skip',
      'demo.WidgetTest > epsilon errs': 'fail',
    });
  });

  it("reads Node's junit reporter: classname 'test' dropped, file first, describe blocks kept, entities decoded, todo is skipped", () => {
    const r = read(NODE_JUNIT, '/work/demo');
    assert.deepEqual(statuses(r), {
      'test/a.test.mjs > top level passes': 'pass',
      'test/a.test.mjs > top level fails': 'fail',
      'test/a.test.mjs > skipped one': 'skip',
      'test/a.test.mjs > todo one': 'skip',
      'test/a.test.mjs > outer <&> &quot;q&quot; > inner passes': 'pass',
      'test/a.test.mjs > outer <&> &quot;q&quot; > nested > deep': 'pass',
      'test/b.test.mjs > top level passes': 'pass',
    });
    assert.equal(r.tests[0]?.file, 'test/a.test.mjs');
  });

  it('puts the file first when a testcase names one, and strips a root folder from it', () => {
    const x = '<testsuites><testsuite name="s"><testcase name="a" classname="k" file="/work/one/test/x.py"/></testsuite></testsuites>';
    assert.deepEqual(read(x).tests.map((t) => t.id), ['/work/one/test/x.py > s > k > a']);
    const r = read(x, '/work/one');
    assert.deepEqual(r.tests.map((t) => [t.id, t.file]), [['test/x.py > s > k > a', 'test/x.py']]);
    assert.equal(relativeTo('C:\\w\\one\\t\\x.py', 'C:\\w\\one'), 't/x.py');
    assert.equal(relativeTo('/work/other/x.py', '/work/one'), '/work/other/x.py');
  });

  it('reads a single <testsuite> root', () => {
    assert.deepEqual(statuses(read('<testsuite name="s"><testcase name="a"/></testsuite>')), { 's > a': 'pass' });
  });

  it('numbers a name repeated in one report in the order listed', () => {
    const r = read('<testsuites><testcase name="same"/><testcase name="same"><failure/></testcase></testsuites>');
    assert.deepEqual(statuses(r), { same: 'pass', 'same #2': 'fail' });
  });

  it('fails closed on XML it cannot read, never as fewer tests', () => {
    unreadable('<testsuites><testcase name="a"/>', /unclosed <testsuites>/);
    unreadable('<testsuites><testsuite name="s"><testcase name="a"/></testsuites>', /does not close <testsuite>/);
    unreadable('<!DOCTYPE x [<!ENTITY a "b">]><testsuites><testcase name="&a;"/></testsuites>', /DOCTYPE/);
    unreadable('<testsuites><testcase name="a &bogus; b"/></testsuites>', /entity/);
    unreadable('<testsuites><testcase name="a"/></testsuites><testsuites/>', /more than one root/);
    unreadable('<results><testcase name="a"/></results>', /root element is <results>/);
    unreadable('<testsuites><testcase classname="k"/></testsuites>', /no name/);
    unreadable('<testsuites></testsuites>', /holds no test results/);
    unreadable(`${'<testsuite name="s">'.repeat(300)}`, /nested deeper|unclosed/);
    unreadable('<testsuites><testcase name=a/></testsuites>', /not quoted/);
  });

  it('decodes numeric references and keeps CDATA and comments out of the tree', () => {
    const x = parseXml('<?xml version="1.0"?><!-- c --><r a="&#65;&#x42;"><![CDATA[<not a tag>]]><k/></r>');
    assert.ok(x.ok);
    if (x.ok) {
      assert.equal(x.root.attrs.get('a'), 'AB');
      assert.deepEqual(x.root.children.map((c) => c.name), ['k']);
    }
  });
});

describe('tests compare: reading Jest and Vitest JSON', () => {
  it('reads statuses by file, ancestors and title', () => {
    const r = read(jest([{ file: '/work/one/src/widget.test.js', cases: [...BASE, { name: 'eta waits', status: 'skip', raw: 'todo' }] }]), '/work/one');
    assert.equal(r.format, 'jest');
    assert.deepEqual(statuses(r), {
      'src/widget.test.js > widget > alpha sorts': 'pass',
      'src/widget.test.js > widget > beta merges': 'pass',
      'src/widget.test.js > widget > gamma rounds': 'fail',
      'src/widget.test.js > widget > delta trims': 'skip',
      'src/widget.test.js > widget > eta waits': 'skip',
    });
    assert.equal(r.tests[0]?.file, 'src/widget.test.js');
  });

  it('fails closed on a status it does not know and on a broken list', () => {
    unreadable(jest([{ file: 'a.test.js', cases: [{ name: 'x', status: 'pass', raw: 'mystery' }] }]), /status "mystery"/);
    unreadable('{"testResults":[{"name":"a","assertionResults":{}}]}', /not a list/);
    unreadable('{"testResults":[]}', /holds no test results/);
  });
});

describe('tests compare: reading go test -json', () => {
  it('reads pass, fail, skip and subtests; a test that never finished did not pass', () => {
    const r = read(goJson([['start'], ['run', 'TestAlpha'], ['pass', 'TestAlpha'], ['run', 'TestBeta'], ['run', 'TestBeta/one'], ['fail', 'TestBeta/one'], ['fail', 'TestBeta'], ['run', 'TestGamma'], ['skip', 'TestGamma'], ['run', 'TestDelta'], ['fail']]));
    assert.equal(r.format, 'go-json');
    assert.deepEqual(statuses(r), {
      'example.test/widget > TestAlpha': 'pass',
      'example.test/widget > TestBeta': 'fail',
      'example.test/widget > TestBeta/one': 'fail',
      'example.test/widget > TestGamma': 'skip',
      'example.test/widget > TestDelta': 'fail',
    });
  });

  it('skips stray text lines and counts them, but a cut-off JSON line is unreadable', () => {
    const r = read(`# example.test/widget\n${goJson([['run', 'TestAlpha'], ['pass', 'TestAlpha']])}`);
    assert.equal(r.skippedLines, 1);
    unreadable(`${goJson([['run', 'TestAlpha'], ['pass', 'TestAlpha']])}{"Action":"pa`, /does not parse/);
  });
});

describe('tests compare: reading flutter test --machine and dart test --reporter json', () => {
  it('reads by suite path and name, drops hidden loading entries, and an unfinished test failed', () => {
    const r = read(dartJson([...BASE, { name: 'zeta hangs', status: 'pass', unfinished: true }]), '/work/demo');
    assert.equal(r.format, 'dart-json');
    assert.deepEqual(statuses(r), {
      'test/widget_test.dart > widget alpha sorts': 'pass',
      'test/widget_test.dart > widget beta merges': 'pass',
      'test/widget_test.dart > widget gamma rounds': 'fail',
      'test/widget_test.dart > widget delta trims': 'skip',
      'test/widget_test.dart > widget zeta hangs': 'fail',
    });
  });

  it('skips a daemon line that is a JSON list', () => {
    const r = read(`[{"event":"test.startedProcess","params":{}}]\n${dartJson(BASE)}`);
    assert.equal(r.skippedLines, 1);
  });
});

describe('tests compare: recognising the format', () => {
  it('recognises each format and refuses text that is none of them', () => {
    assert.equal(detectFormat(junit(BASE)), 'junit');
    assert.equal(detectFormat(jest([{ file: 'a', cases: BASE }])), 'jest');
    assert.equal(detectFormat(goJson([['run', 'TestA']])), 'go-json');
    assert.equal(detectFormat(dartJson(BASE)), 'dart-json');
    unreadable('TAP version 13\nok 1 - alpha\n', /not a test report/);
    unreadable('', /not a test report/);
    unreadable('{"something":"else"}', /not a test report/);
  });
});
