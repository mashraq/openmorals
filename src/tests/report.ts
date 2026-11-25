import { parseXml } from './xml.js';
import type { XmlElement } from './xml.js';

/** The outcome of one test in one report. A todo or an expected failure counts as skipped. */
export type TestStatus = 'pass' | 'fail' | 'skip';

export const REPORT_FORMATS = ['junit', 'jest', 'go-json', 'dart-json'] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export function isReportFormat(s: string): s is ReportFormat {
  return (REPORT_FORMATS as readonly string[]).includes(s);
}

/**
 * Why a test failed, as far as the report shows (0.17.0): an assertion that did not hold, an error that is not an
 * assertion (a missing function, module or file, a type or syntax error), or a failure the report does not explain.
 */
export type FailureKind = 'assertion' | 'error' | 'unknown';

export interface FailureInfo {
  kind: FailureKind;
  /** The evidence the kind was read from, in a few words (an error class, an element name, a result field). */
  why: string;
  /** True when this entry stands for a whole file or package that did not load, compile or build, not for one test. */
  load: boolean;
}

export interface TestResult {
  /** The test's identity: its file (when the report names one), its suites or groups, and its name, joined by " > ". */
  id: string;
  /** Where a rename would stay: the file, else the package, class or outer suite; null when the report gives nothing. */
  file: string | null;
  status: TestStatus;
  /** On a failing test only (0.17.0): why it failed, as far as the report shows. */
  failure?: FailureInfo;
}

/** A file or package that did not load, compile or build, and that the report lists with no test entry for it (0.17.0). */
export interface LoadError {
  file: string | null;
  why: string;
}

export interface TestReport {
  format: ReportFormat;
  tests: TestResult[];
  /** Lines of a JSON-lines report that were not JSON objects and were skipped (a runner's stray output). */
  skippedLines: number;
  /** Files or packages that failed as a whole and are not in `tests` (0.17.0; absent when there were none). */
  loadErrors?: LoadError[];
}

export type ReportResult = { ok: true; report: TestReport } | { ok: false; error: string };

export interface ParseOptions {
  /** Read the text as this format instead of recognising it. */
  format?: ReportFormat;
  /** A folder to strip from the front of file paths, so reports made in two different folders name tests alike. */
  root?: string;
  /** Accept a report whose only entries are files or packages that failed as a whole (used by `tests fail-first`). */
  loadErrorsOnly?: boolean;
}

export const ID_SEPARATOR = ' > ';

function slash(p: string): string {
  return p.replace(/\\/g, '/');
}

/** A file path relative to the root when it lies under it, with forward slashes; unchanged otherwise. */
export function relativeTo(path: string, root: string | undefined): string {
  const p = slash(path);
  if (root === undefined || root === '') return p;
  const r = slash(root).replace(/\/+$/, '');
  if (r === '') return p;
  if (p === r) return '.';
  return p.startsWith(`${r}/`) ? p.slice(r.length + 1) : p;
}

function joinId(parts: readonly string[]): string {
  return parts.filter((p) => p !== '').join(ID_SEPARATOR);
}

/** Gives a repeated id in one report a counter in the order the report lists it (" #2", " #3"). */
function numberRepeats(tests: TestResult[]): TestResult[] {
  const seen = new Map<string, number>();
  return tests.map((t) => {
    const n = (seen.get(t.id) ?? 0) + 1;
    seen.set(t.id, n);
    return n === 1 ? t : { ...t, id: `${t.id} #${n}` };
  });
}

/** Recognises the format from the text: XML is JUnit, one JSON object with testResults is Jest or Vitest, JSON lines with Action are go test, with type are dart or flutter test. */
export function detectFormat(text: string): ReportFormat | null {
  const t = text.replace(/^﻿/, '').trimStart();
  if (t.startsWith('<')) return 'junit';
  if (t.startsWith('{')) {
    try {
      const whole: unknown = JSON.parse(t);
      if (isObject(whole) && Array.isArray(whole['testResults'])) return 'jest';
    } catch {
      // not one JSON value; try JSON lines below
    }
  }
  for (const line of t.split(/\r?\n/)) {
    const obj = jsonObject(line);
    if (obj === null) continue;
    if (typeof obj['Action'] === 'string') return 'go-json';
    if (typeof obj['type'] === 'string') return 'dart-json';
    return null;
  }
  return null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function jsonObject(line: string): Record<string, unknown> | null {
  const s = line.trim();
  if (!s.startsWith('{')) return null;
  try {
    const v: unknown = JSON.parse(s);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

export function parseTestReport(text: string, opts: ParseOptions = {}): ReportResult {
  const format = opts.format ?? detectFormat(text);
  if (format === null) return { ok: false, error: 'not a test report this command reads (JUnit XML, Jest or Vitest JSON, go test -json, flutter test --machine or dart test --reporter json)' };
  const r = format === 'junit' ? readJunit(text, opts.root) : format === 'jest' ? readJest(text, opts.root) : format === 'go-json' ? readGo(text) : readDart(text, opts.root);
  if (!r.ok) return { ok: false, error: `${format}: ${r.error}` };
  if (r.tests.length === 0 && (opts.loadErrorsOnly !== true || (r.loadErrors?.length ?? 0) === 0)) return { ok: false, error: `${format}: the report holds no test results, so it cannot show what passed` };
  return { ok: true, report: { format, tests: numberRepeats(r.tests), skippedLines: r.skippedLines, ...(r.loadErrors !== undefined && r.loadErrors.length > 0 ? { loadErrors: r.loadErrors } : {}) } };
}

type Read = { ok: true; tests: TestResult[]; skippedLines: number; loadErrors?: LoadError[] } | { ok: false; error: string };

/**
 * Error classes and messages that say something is missing or broken rather than that an expectation did not hold.
 * Published in docs/tests-fail-first.md; a failure that names none of these and no assertion is "cannot tell".
 */
export const ERROR_MARKERS: readonly string[] = [
  'TypeError', 'ReferenceError', 'SyntaxError', 'ImportError', 'ModuleNotFoundError', 'AttributeError', 'NameError',
  'NotImplementedError', 'FileNotFoundError', 'ERR_MODULE_NOT_FOUND', 'Cannot find module', 'is not a function',
  'is not defined', 'is not a constructor', 'ENOENT', 'NoSuchMethodError', 'NoMethodError', 'UnimplementedError',
  'ClassNotFoundException', 'NoClassDefFoundError', 'LoadError', 'undefined method', 'panic:',
];

/** Messages and error classes that say an expectation did not hold. */
export const ASSERTION_MARKERS: readonly string[] = [
  'AssertionError', 'ERR_ASSERTION', 'AssertionFailedError', 'ComparisonFailure', 'expect(received)', 'ExpectationFailed',
  'TestFailure', 'Minitest::Assertion', 'assert ',
];

function markerAt(text: string, marker: string): number {
  if (marker === 'assert ') {
    const m = /(^|\n)(E\s+)?assert\s/.exec(text);
    return m === null ? -1 : m.index;
  }
  if (/^[A-Za-z_:]+$/.test(marker)) {
    const m = new RegExp(`(^|[^A-Za-z0-9_])${marker}($|[^A-Za-z0-9_])`).exec(text);
    return m === null ? -1 : m.index;
  }
  return text.indexOf(marker);
}

/** Reads the kind from a failure's text: the earliest assertion or error marker wins; Node's wrapper names the real one after `cause:`. */
export function classifyFailureText(text: string): { kind: FailureKind; why: string } {
  const t = text.slice(0, 8192);
  const cause = /\bcause: ([A-Za-z_][A-Za-z0-9_]*)/.exec(t);
  const scan = cause !== null ? t.slice(cause.index) : t;
  let best: { at: number; kind: FailureKind; why: string } | null = null;
  for (const [kind, list] of [['assertion', ASSERTION_MARKERS], ['error', ERROR_MARKERS]] as const) {
    for (const m of list) {
      const at = markerAt(scan, m);
      if (at !== -1 && (best === null || at < best.at)) best = { at, kind, why: m.trim() };
    }
  }
  return best === null ? { kind: 'unknown', why: 'names no assertion and no known error' } : { kind: best.kind, why: best.why };
}

function baseName(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? p : p.slice(i + 1);
}

// ---- JUnit XML (also Node's --test-reporter=junit, pytest --junitxml, Maven Surefire, and most other runners) ----

/** Node's junit reporter names every case's class "test"; it is not part of the identity. */
const NODE_CLASSNAME = 'test';

function readJunit(text: string, root: string | undefined): Read {
  const x = parseXml(text);
  if (!x.ok) return { ok: false, error: `unreadable XML: ${x.error}` };
  if (x.root.name !== 'testsuites' && x.root.name !== 'testsuite') return { ok: false, error: `the root element is <${x.root.name}>, not <testsuites> or <testsuite>` };
  const tests: TestResult[] = [];
  let problem: string | null = null;
  const walk = (el: XmlElement, suites: readonly string[], file: string | null): void => {
    for (const c of el.children) {
      if (problem !== null) return;
      if (c.name === 'testsuite') {
        const fileAttr = c.attrs.get('file') ?? c.attrs.get('filepath');
        walk(c, [...suites, c.attrs.get('name') ?? ''], fileAttr !== undefined ? relativeTo(fileAttr, root) : file);
      } else if (c.name === 'testcase') {
        const name = c.attrs.get('name');
        if (name === undefined || name === '') {
          problem = 'a <testcase> has no name';
          return;
        }
        const fileAttr = c.attrs.get('file') ?? c.attrs.get('filepath');
        const caseFile = fileAttr !== undefined ? relativeTo(fileAttr, root) : file;
        const cls = c.attrs.get('classname') ?? '';
        const nearest = suites[suites.length - 1] ?? '';
        const clsPart = cls === NODE_CLASSNAME || cls === nearest ? '' : cls;
        const names = c.children.map((k) => k.name);
        const status: TestStatus = names.includes('failure') || names.includes('error') ? 'fail' : names.includes('skipped') ? 'skip' : 'pass';
        const group = caseFile ?? (clsPart !== '' ? clsPart : nearest !== '' ? suites.join(ID_SEPARATOR) : null);
        const result: TestResult = { id: joinId([caseFile ?? '', ...suites, clsPart, name]), file: group, status };
        if (status === 'fail') result.failure = junitFailure(c, name, caseFile);
        tests.push(result);
      }
    }
  };
  if (x.root.name === 'testsuite') {
    const fileAttr = x.root.attrs.get('file') ?? x.root.attrs.get('filepath');
    walk({ name: 'testsuites', attrs: new Map(), children: [x.root] }, [], fileAttr !== undefined ? relativeTo(fileAttr, root) : null);
  } else walk(x.root, [], null);
  if (problem !== null) return { ok: false, error: problem };
  return { ok: true, tests, skippedLines: 0 };
}

/**
 * A JUnit failure: an <error> element is an error; Node's runner writes a file that did not load as one case named
 * after the file (its path from the folder the runner ran in) whose text says `cause: 'test failed'`; otherwise the kind is read from the message and the text.
 */
function junitFailure(c: XmlElement, name: string, file: string | null): FailureInfo {
  const err = c.children.find((k) => k.name === 'error');
  const fl = c.children.find((k) => k.name === 'failure');
  const el = err ?? fl;
  const text = `${el?.attrs.get('type') ?? ''}\n${el?.attrs.get('message') ?? ''}\n${el?.text ?? ''}`;
  if (fl !== undefined && err === undefined && file !== null && (file === name || file.endsWith(`/${name}`) || name === baseName(file)) && /cause: 'test failed'/.test(fl.text ?? '')) {
    return { kind: 'error', why: 'the file did not load or exited before its tests ran', load: true };
  }
  if (err !== undefined) {
    const k = classifyFailureText(text);
    return { kind: 'error', why: k.kind === 'error' ? `<error> element, ${k.why}` : '<error> element', load: /collection failure|failed to load|error collecting/i.test(text) };
  }
  return { ...classifyFailureText(text), load: false };
}

// ---- Jest and Vitest JSON (--json, --reporter=json) ----

const JEST_STATUS: Readonly<Record<string, TestStatus>> = { passed: 'pass', failed: 'fail', pending: 'skip', skipped: 'skip', todo: 'skip', disabled: 'skip' };

function readJest(text: string, root: string | undefined): Read {
  let whole: unknown;
  try {
    whole = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e: unknown) {
    return { ok: false, error: `unreadable JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isObject(whole) || !Array.isArray(whole['testResults'])) return { ok: false, error: 'no testResults list' };
  const tests: TestResult[] = [];
  const loadErrors: LoadError[] = [];
  for (const [fi, f] of whole['testResults'].entries()) {
    if (!isObject(f)) return { ok: false, error: `testResults[${fi}] is not an object` };
    const fileRaw = typeof f['name'] === 'string' ? f['name'] : typeof f['testFilePath'] === 'string' ? f['testFilePath'] : null;
    const file = fileRaw !== null ? relativeTo(fileRaw, root) : null;
    const list = f['assertionResults'] ?? f['testResults'];
    const fileFailed = f['status'] === 'failed' && (list === undefined || (Array.isArray(list) && list.length === 0));
    if (fileFailed) loadErrors.push({ file, why: `the file failed with no test result${typeof f['message'] === 'string' && f['message'] !== '' ? `: ${firstLine(f['message'])}` : ''}` });
    if (list === undefined) continue;
    if (!Array.isArray(list)) return { ok: false, error: `testResults[${fi}].assertionResults is not a list` };
    for (const [ai, a] of list.entries()) {
      if (!isObject(a)) return { ok: false, error: `testResults[${fi}].assertionResults[${ai}] is not an object` };
      const title = typeof a['title'] === 'string' ? a['title'] : typeof a['fullName'] === 'string' ? a['fullName'] : '';
      if (title === '') return { ok: false, error: `testResults[${fi}].assertionResults[${ai}] has no title` };
      const st = typeof a['status'] === 'string' ? a['status'] : '';
      const status = Object.prototype.hasOwnProperty.call(JEST_STATUS, st) ? JEST_STATUS[st] : undefined;
      if (status === undefined) return { ok: false, error: `testResults[${fi}].assertionResults[${ai}] has status ${JSON.stringify(st)}, which is not read` };
      const anc = Array.isArray(a['ancestorTitles']) ? a['ancestorTitles'].filter((t): t is string => typeof t === 'string') : [];
      const result: TestResult = { id: joinId([file ?? '', ...anc, title]), file, status };
      if (status === 'fail') {
        const msgs = Array.isArray(a['failureMessages']) ? a['failureMessages'].filter((m): m is string => typeof m === 'string').join('\n') : '';
        result.failure = { ...classifyFailureText(msgs), load: false };
      }
      tests.push(result);
    }
  }
  return { ok: true, tests, skippedLines: 0, ...(loadErrors.length > 0 ? { loadErrors } : {}) };
}

function firstLine(s: string): string {
  const line = s.split(/\r?\n/).map((l) => l.replace(/^[\s●]+/, '').trim()).find((l) => l !== '' && !/^Test suite failed to run$/i.test(l)) ?? '';
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

// ---- go test -json ----

function readGo(text: string): Read {
  const state = new Map<string, { pkg: string; status: TestStatus | 'running' }>();
  const output = new Map<string, string>();
  const pkgFailed = new Set<string>();
  const pkgTests = new Set<string>();
  let skippedLines = 0;
  for (const [n, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === '') continue;
    const ev = jsonObject(line);
    if (ev === null) {
      if (line.trim().startsWith('{')) return { ok: false, error: `line ${n + 1} starts a JSON object that does not parse (a cut-off report?)` };
      skippedLines++;
      continue;
    }
    const action = ev['Action'];
    const test = ev['Test'];
    const pkg = typeof ev['Package'] === 'string' ? ev['Package'] : '';
    if (typeof action !== 'string') return { ok: false, error: `line ${n + 1} has no Action` };
    if (typeof test !== 'string' || test === '') {
      if (action === 'fail' || action === 'build-fail') pkgFailed.add(pkg !== '' ? pkg : typeof ev['ImportPath'] === 'string' ? ev['ImportPath'] : '');
      continue;
    }
    const id = joinId([pkg, test]);
    pkgTests.add(pkg);
    if (action === 'output' && typeof ev['Output'] === 'string') {
      const o = output.get(id) ?? '';
      if (o.length < 8192) output.set(id, o + ev['Output']);
    }
    if (action === 'run') state.set(id, { pkg, status: 'running' });
    else if (action === 'pass' || action === 'fail' || action === 'skip') state.set(id, { pkg, status: action === 'pass' ? 'pass' : action === 'fail' ? 'fail' : 'skip' });
  }
  // A test that started and never finished (a panic, a timeout, a killed run) did not pass.
  const tests = [...state].map(([id, s]): TestResult => {
    const status: TestStatus = s.status === 'running' ? 'fail' : s.status;
    if (status !== 'fail') return { id, file: s.pkg === '' ? null : s.pkg, status };
    const o = output.get(id) ?? '';
    // Go has no assertion type: a panic is an error, testify's "Error Trace" an assertion, anything else cannot be told.
    const failure: FailureInfo = s.status === 'running'
      ? { kind: 'error', why: 'started and never finished (a panic, a timeout or a killed run)', load: false }
      : /panic:/.test(o) ? { kind: 'error', why: 'panic:', load: false } : /Error Trace:/.test(o) ? { kind: 'assertion', why: 'Error Trace: (testify)', load: false } : { kind: 'unknown', why: 'go test has no assertion type', load: false };
    return { id, file: s.pkg === '' ? null : s.pkg, status, failure };
  });
  const loadErrors: LoadError[] = [...pkgFailed].filter((p) => !pkgTests.has(p)).map((p) => ({ file: p === '' ? null : p, why: 'the package failed with no test result (a build failure or a package-level error)' }));
  return { ok: true, tests, skippedLines, ...(loadErrors.length > 0 ? { loadErrors } : {}) };
}

// ---- dart test --reporter json and flutter test --machine ----

function readDart(text: string, root: string | undefined): Read {
  const suites = new Map<number, string>();
  const started = new Map<number, { name: string; suite: string | null; skip: boolean }>();
  const done = new Map<number, TestStatus | 'hidden'>();
  const result = new Map<number, string>();
  const errorIsFailure = new Map<number, boolean>();
  let skippedLines = 0;
  for (const [n, line] of text.split(/\r?\n/).entries()) {
    if (line.trim() === '') continue;
    const ev = jsonObject(line);
    if (ev === null) {
      if (line.trim().startsWith('{')) return { ok: false, error: `line ${n + 1} starts a JSON object that does not parse (a cut-off report?)` };
      skippedLines++;
      continue;
    }
    const type = ev['type'];
    if (type === 'suite' && isObject(ev['suite'])) {
      const s = ev['suite'];
      if (typeof s['id'] === 'number' && typeof s['path'] === 'string') suites.set(s['id'], relativeTo(s['path'], root));
    } else if (type === 'testStart' && isObject(ev['test'])) {
      const t = ev['test'];
      if (typeof t['id'] !== 'number' || typeof t['name'] !== 'string') return { ok: false, error: `line ${n + 1}: a testStart with no id or name` };
      const meta = isObject(t['metadata']) ? t['metadata'] : {};
      started.set(t['id'], { name: t['name'], suite: typeof t['suiteID'] === 'number' ? suites.get(t['suiteID']) ?? null : null, skip: meta['skip'] === true });
    } else if (type === 'error' && typeof ev['testID'] === 'number') {
      if (!errorIsFailure.has(ev['testID'])) errorIsFailure.set(ev['testID'], ev['isFailure'] === true);
    } else if (type === 'testDone') {
      const id = ev['testID'];
      if (typeof id !== 'number') return { ok: false, error: `line ${n + 1}: a testDone with no testID` };
      if (typeof ev['result'] === 'string') result.set(id, ev['result']);
      if (ev['hidden'] === true) done.set(id, 'hidden');
      else if (ev['skipped'] === true) done.set(id, 'skip');
      else done.set(id, ev['result'] === 'success' ? 'pass' : 'fail');
    }
  }
  const tests: TestResult[] = [];
  for (const [id, t] of started) {
    const d = done.get(id);
    if (d === 'hidden') continue;
    // The runner's own "loading <file>" entry is hidden when it succeeds; one that never finished is a crash, so it stays.
    const status: TestStatus = d === undefined ? (t.skip ? 'skip' : 'fail') : d;
    const entry: TestResult = { id: joinId([t.suite ?? '', t.name]), file: t.suite, status };
    if (status === 'fail') {
      const load = /^loading /.test(t.name);
      const r = result.get(id);
      const isFailure = errorIsFailure.get(id);
      // The JSON reporter's own split: result "failure" is a failed expectation (TestFailure), "error" any other error.
      entry.failure = d === undefined
        ? { kind: 'error', why: 'started and never finished', load }
        : load ? { kind: 'error', why: 'the file did not load', load: true }
          : r === 'failure' || isFailure === true ? { kind: 'assertion', why: 'result failure (TestFailure)', load: false }
            : r === 'error' || isFailure === false ? { kind: 'error', why: 'result error (not a TestFailure)', load: false }
              : { kind: 'unknown', why: 'the report gives no result kind', load: false };
    }
    tests.push(entry);
  }
  return { ok: true, tests, skippedLines };
}
