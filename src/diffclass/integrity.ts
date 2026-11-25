import { parse as parseYaml } from 'yaml';
import type { BaseReader } from './apply.js';
import { applyHunks, hashNames } from './apply.js';
import { compileGlob } from './glob.js';
import type { FileDiff } from './parse.js';
import { CODE_EXTENSIONS, EXCLUSIONS } from './rules.js';
import type { Reason } from './types.js';

/**
 * Test-integrity reasons: pointers that show a reviewer where a change may have weakened its own
 * checks. Each rule is plain code over the diff with a published pattern (docs/test-integrity.md). A rule can only add
 * a reason, and a reason only ever makes a change need review: no rule lowers a class, asks, blocks or scores anything.
 */

export interface IntegrityContext {
  /** The base tree, for the rules that compare a file before and after (scripts, dependencies). */
  base: BaseReader;
  /** Globs of the paths the work was declared to touch, or null when none were declared. */
  declaredPaths: readonly string[] | null;
  /** Globs of declared boundary paths (merge.boundary_paths). Empty: the boundary rule has no input. */
  boundaryPaths: readonly string[];
  /** The size line: more changed lines than `maxLines`, or more files than `maxFiles`, adds a reason. Null: not declared. */
  maxLines: number | null;
  maxFiles: number | null;
}

export interface IntegrityRule {
  id: string;
  /** The pattern, as docs/test-integrity.md publishes it. */
  pattern: string;
  /** What the rule cannot see. */
  misses: string;
  /** The declared input the rule needs, or null when the diff (and base tree) is enough. */
  needs: 'declared-paths' | 'boundary-paths' | 'size-line' | null;
  run(files: readonly FileDiff[], ctx: IntegrityContext): Reason[];
}

export const ADR_GLOBS: readonly string[] = ['docs/adr/'];

function globsOf(id: string): readonly string[] {
  return EXCLUSIONS.find((x) => x.id === id)?.globs ?? [];
}

const anyGlob = (globs: readonly string[]): ((p: string) => boolean) => {
  const tests = globs.map(compileGlob);
  return (p: string): boolean => tests.some((t) => t(p));
};

/** Test files: the `exclude.test-file` globs. */
export const TEST_GLOBS: readonly string[] = globsOf('exclude.test-file');
/** Test-runner configuration: the `exclude.test-runner-config` globs. */
export const RUNNER_GLOBS: readonly string[] = globsOf('exclude.test-runner-config');
export const SNAPSHOT_GLOBS: readonly string[] = ['__snapshots__/', '*.snap', '*.snapshot', '*.ambr', '__screenshots__/', 'goldens/', '*.golden', '*.approved.*', '*.received.*'];

const isTest = anyGlob(TEST_GLOBS);
const isRunner = anyGlob(RUNNER_GLOBS);
const isSnapshot = anyGlob(SNAPSHOT_GLOBS);
const isAdr = anyGlob(ADR_GLOBS);
const CODE_EXT = new Set(CODE_EXTENSIONS);

function pathsOf(f: FileDiff): string[] {
  return [...new Set([f.oldPath, f.newPath].filter((p): p is string => p !== null))];
}

const touches = (f: FileDiff, test: (p: string) => boolean): boolean => pathsOf(f).some(test);
const isTestCode = (f: FileDiff): boolean => touches(f, isTest) || touches(f, isRunner);
const isCode = (f: FileDiff): boolean => touches(f, isTest) || pathsOf(f).some((p) => CODE_EXT.has((/\.([^./]+)$/.exec(p)?.[1] ?? '').toLowerCase()));

function lines(f: FileDiff, op: '+' | '-'): string[] {
  return f.hunks.flatMap((h) => h.lines.filter((l) => l.op === op).map((l) => l.text));
}

function count(texts: readonly string[], re: RegExp): number {
  return texts.filter((t) => re.test(t)).length;
}

function reason(rule: string, path: string | null, text: string): Reason {
  return { rule, path, text: path === null ? text : `${text}: ${path}` };
}

/** Pairs of (removed, added) lines that replace each other: the i-th line of a run of `-` lines and of the `+` run after it. */
function replacedPairs(f: FileDiff): [string, string][] {
  const out: [string, string][] = [];
  for (const h of f.hunks) {
    let i = 0;
    while (i < h.lines.length) {
      const del: string[] = [];
      const add: string[] = [];
      while (i < h.lines.length && h.lines[i]?.op === '-') del.push(h.lines[i++]?.text ?? '');
      while (i < h.lines.length && h.lines[i]?.op === '+') add.push(h.lines[i++]?.text ?? '');
      for (let k = 0; k < Math.min(del.length, add.length); k++) out.push([del[k] ?? '', add[k] ?? '']);
      if (del.length === 0 && add.length === 0) i++;
    }
  }
  return out;
}

/** The base and head text of a file, or null when either cannot be read and checked against the `index` hashes. */
export function versions(f: FileDiff, base: BaseReader): { base: string; head: string } | null {
  if (f.binary) return null;
  if (f.status === 'added') {
    const a = applyHunks('', f.hunks);
    return a.ok ? { base: '', head: a.text } : null;
  }
  if (f.status === 'deleted') {
    const del = f.hunks.flatMap((h) => h.lines.filter((l) => l.op === '-'));
    const last = del[del.length - 1];
    return { base: del.length === 0 ? '' : `${del.map((l) => l.text).join('\n')}${last?.noEol === true ? '' : '\n'}`, head: '' };
  }
  if (f.oldPath === null || f.oldHash === null || f.newHash === null) return null;
  const r = base.read(f.oldPath);
  if (!r.ok || !hashNames(f.oldHash, r.bytes)) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(r.bytes);
  } catch {
    return null;
  }
  const a = applyHunks(text, f.hunks);
  if (!a.ok || !hashNames(f.newHash, new TextEncoder().encode(a.text))) return null;
  return { base: text, head: a.text };
}

// ---- patterns (published in docs/test-integrity.md; keep the two in step) ----

export const ASSERT_RE = /expect|assert|\.to[A-Z]|\.(rejects|throws)\b/;
export const SKIP_RE = new RegExp(
  [
    String.raw`\b(?:it|test|describe|context|suite|specify|t)\.(?:skip|only|todo|skipIf|runIf|fails)\b`,
    String.raw`\b[xf](?:it|describe|test|context)\s*\(`,
    String.raw`[{,]\s*(?:skip|only|todo)\s*:(?!\s*(?:false\b|\d))`,
    String.raw`\bskip\s*:\s*(?:true|'|")`,
    String.raw`@pytest\.mark\.(?:skip|skipif|xfail)\b`,
    String.raw`\bpytest\.(?:skip|xfail|importorskip)\s*\(`,
    String.raw`@unittest\.(?:skip\w*|expectedFailure)\b`,
    String.raw`\bself\.skipTest\s*\(`,
    String.raw`\bt\.Skip(?:Now|f)?\s*\(`,
    String.raw`@(?:Disabled|Ignore)\b`,
    String.raw`#\[ignore\]`,
  ].join('|'),
);
export const EXIT_RE = new RegExp(
  [
    String.raw`\b(?:process\.(?:exit|abort|reallyExit)|sys\.exit|os\._exit|os\.Exit|Deno\.exit|System\.exit|Environment\.Exit)\s*\(`,
    String.raw`\bprocess\.exitCode\s*=`,
    String.raw`^\s*(?:exit|quit)\s*\(`,
  ].join('|'),
);
export const EQUALITY_RE = new RegExp(
  [
    String.raw`\bdef\s+__(?:eq|ne|hash|lt|le|gt|ge)__\s*\(`,
    String.raw`\boperator\s*==`,
    String.raw`\b(?:public|override)\b[^;{]*\bequals\s*\(`,
    String.raw`\bimpl\b[^{]*\bPartialEq\b`,
    String.raw`\bexpect\.(?:extend|addEqualityTesters|addSnapshotSerializer)\s*\(`,
    String.raw`\bassert\.\w+\s*=(?!=)`,
    String.raw`\b(?:Object|Array|String|Number|Boolean|Date|RegExp)\.prototype\.\w+\s*=(?!=)`,
    String.raw`\bfunc\s*\([^)]*\)\s*Equal\s*\(`,
  ].join('|'),
);
export const SUPPRESSION_RE = new RegExp(
  [
    'eslint-disable',
    'tslint:disable',
    String.raw`@ts-(?:ignore|expect-error|nocheck)`,
    String.raw`#\s*type:\s*ignore`,
    String.raw`#\s*noqa\b`,
    String.raw`flake8:\s*noqa`,
    String.raw`pylint:\s*disable`,
    String.raw`pyright:\s*ignore`,
    String.raw`mypy:\s*ignore-errors`,
    String.raw`//\s*ignore(?:_for_file)?:`,
    String.raw`#!?\[allow\(`,
    String.raw`@Suppress(?:Warnings)?\b`,
    String.raw`//\s*nolint\b`,
    String.raw`#pragma\s+warning\s+disable`,
    'NOSONAR',
    String.raw`(?:istanbul|c8|v8)\s+ignore`,
    String.raw`pragma:\s*no\s*cover`,
    'biome-ignore',
    'deno-lint-ignore',
    'rubocop:disable',
    'swiftlint:disable',
    '@phpstan-ignore',
    String.raw`#\s*nosec\b`,
    String.raw`\bnoinspection\b`,
  ].join('|'),
);
const LITERAL_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?n?\b|\b(?:true|false|null|undefined|None|True|False|nil|NaN|Infinity)\b/g;

/** An assertion line with its literals replaced, so two lines that differ only in an expected value compare equal. */
export function literalShape(line: string): string {
  return line.replace(LITERAL_RE, '\u0001').replace(/\s+/g, ' ').trim();
}

// ---- dependency names per manifest ----

type Names = Set<string>;

function jsonKeys(text: string, fields: readonly string[]): Names | null {
  if (text === '') return new Set();
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const out: Names = new Set();
  for (const k of fields) {
    const d = o[k];
    if (Array.isArray(d)) for (const x of d) if (typeof x === 'string') out.add(x);
    if (typeof d === 'object' && d !== null && !Array.isArray(d)) for (const n of Object.keys(d)) out.add(n);
  }
  return out;
}

function jsonObject(text: string, field: string): Record<string, unknown> | null | 'bad' {
  if (text === '') return null;
  try {
    const v: unknown = JSON.parse(text);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return 'bad';
    const d = (v as Record<string, unknown>)[field];
    return typeof d === 'object' && d !== null && !Array.isArray(d) ? (d as Record<string, unknown>) : null;
  } catch {
    return 'bad';
  }
}

function requirementNames(text: string): Names {
  const out: Names = new Set();
  for (const raw of text.split('\n')) {
    const l = raw.replace(/\s+#.*$/, '').trim();
    if (l === '' || l.startsWith('#')) continue;
    if (/^-(?:r|c|-requirement|-constraint)\b/.test(l)) out.add(l);
    else if (l.startsWith('-') || l.includes('://')) out.add(l);
    else {
      const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(l);
      if (m?.[1] !== undefined) out.add(m[1].toLowerCase().replace(/[-_.]+/g, '-'));
    }
  }
  return out;
}

function goModNames(text: string): Names {
  const out: Names = new Set();
  let inBlock = false;
  for (const raw of text.split('\n')) {
    const l = raw.replace(/\/\/.*$/, '').trim();
    if (/^require\s*\($/.test(l)) inBlock = true;
    else if (inBlock && l === ')') inBlock = false;
    else {
      const m = inBlock ? /^(\S+)\s+v\S+/.exec(l) : /^require\s+(\S+)\s+v\S+/.exec(l);
      if (m?.[1] !== undefined) out.add(m[1]);
    }
  }
  return out;
}

function gemNames(text: string): Names {
  const out: Names = new Set();
  for (const l of text.split('\n')) {
    const m = /^\s*gem\s+['"]([^'"]+)['"]/.exec(l);
    if (m?.[1] !== undefined) out.add(m[1]);
  }
  return out;
}

const TOML_DEP_SECTION = /(?:^|\.)(?:dev-|build-)?dependencies$|^dependency-groups$|^project\.optional-dependencies$/;

/** Names in the dependency tables and dependency arrays of a TOML manifest (Cargo.toml, pyproject.toml), read line by line. */
function tomlNames(text: string): Names {
  const out: Names = new Set();
  let section = '';
  let inArray = false;
  for (const raw of text.split('\n')) {
    const l = raw.replace(/\s+#.*$/, '').trim();
    const head = /^\[\[?([^\]]+)\]\]?$/.exec(l);
    if (head?.[1] !== undefined) {
      section = head[1].trim();
      inArray = false;
      const sub = /^(.*(?:dev-|build-)?dependencies)\.([^.]+)$/.exec(section);
      if (sub?.[2] !== undefined) out.add(sub[2].replace(/^["']|["']$/g, ''));
      continue;
    }
    if (inArray) {
      for (const m of l.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)/g)) if (m[1] !== undefined) out.add(m[1].toLowerCase());
      if (l.includes(']')) inArray = false;
      continue;
    }
    const arr = /^([A-Za-z0-9_-]*dependencies|requires|[A-Za-z0-9_-]+)\s*=\s*\[(.*)$/.exec(l);
    if (arr !== null && (/dependencies$|^requires$/.test(arr[1] ?? '') || TOML_DEP_SECTION.test(section))) {
      for (const m of (arr[2] ?? '').matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)/g)) if (m[1] !== undefined) out.add(m[1].toLowerCase());
      inArray = !(arr[2] ?? '').includes(']');
      continue;
    }
    if (TOML_DEP_SECTION.test(section)) {
      const m = /^["']?([A-Za-z0-9][A-Za-z0-9._-]*)["']?\s*=/.exec(l);
      if (m?.[1] !== undefined) out.add(m[1]);
    }
  }
  return out;
}

function pubspecNames(text: string): Names | null {
  if (text === '') return new Set();
  try {
    const v: unknown = parseYaml(text);
    if (v === null || v === undefined) return new Set();
    if (typeof v !== 'object' || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    const out: Names = new Set();
    for (const k of ['dependencies', 'dev_dependencies']) {
      const d = o[k];
      if (typeof d === 'object' && d !== null && !Array.isArray(d)) for (const n of Object.keys(d)) out.add(n);
    }
    return out;
  } catch {
    return null;
  }
}

interface Manifest {
  test: (path: string) => boolean;
  names: (text: string) => Names | null;
}

const fileName = (p: string): string => p.slice(p.lastIndexOf('/') + 1).toLowerCase();

export const MANIFESTS: readonly Manifest[] = [
  { test: (p) => fileName(p) === 'package.json', names: (t) => jsonKeys(t, ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies']) },
  { test: (p) => fileName(p) === 'composer.json', names: (t) => jsonKeys(t, ['require', 'require-dev']) },
  { test: (p) => /^(?:requirements|constraints)[^/]*\.txt$/.test(fileName(p)), names: requirementNames },
  { test: (p) => fileName(p) === 'go.mod', names: goModNames },
  { test: (p) => fileName(p) === 'gemfile', names: gemNames },
  { test: (p) => fileName(p) === 'cargo.toml' || fileName(p) === 'pyproject.toml', names: tomlNames },
  { test: (p) => fileName(p) === 'pubspec.yaml', names: pubspecNames },
];

const SCRIPT_FILES = new Set(['package.json', 'composer.json']);

function changedKeys(a: Record<string, unknown> | null, b: Record<string, unknown> | null): string[] {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  return [...keys].filter((k) => JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])).sort();
}

// ---- the rules ----

export const INTEGRITY_RULES: readonly IntegrityRule[] = [
  {
    id: 'integrity.assert-removed',
    pattern: `a test file in which more removed lines than added lines match /${ASSERT_RE.source}/ (its own count of assertion-like lines fell, a deleted test file included); the line gives the diff's removed, added and net count of such lines`,
    misses: 'assertions written with other names (t.equal, should, matchers in helpers outside test paths); an assertion weakened in place (one line out, one weaker line in: see integrity.expected-changed for changed literals); assertions moved to a new test file in the same diff still fire for the old one',
    needs: null,
    run(files) {
      const tf = files.filter((f) => touches(f, isTest) && !f.binary);
      const fell = tf.filter((f) => count(lines(f, '-'), ASSERT_RE) > count(lines(f, '+'), ASSERT_RE));
      if (fell.length === 0) return [];
      const removed = tf.reduce((n, f) => n + count(lines(f, '-'), ASSERT_RE), 0);
      const added = tf.reduce((n, f) => n + count(lines(f, '+'), ASSERT_RE), 0);
      const net = added - removed;
      const lead = `a test file lost assertion-like lines (diff: ${removed} removed, ${added} added, net ${net >= 0 ? '+' : ''}${net})`;
      return fell.map((f) => reason('integrity.assert-removed', f.path, lead));
    },
  },
  {
    id: 'integrity.skip-added',
    pattern: `an added line in a test file matching /${SKIP_RE.source}/`,
    misses: 'a skip decided at run time in a helper, an early return, an environment variable that filters tests, a test renamed out of the runner\'s file pattern; honest platform skips fire too',
    needs: null,
    run(files) {
      return files.filter((f) => touches(f, isTest) && count(lines(f, '+'), SKIP_RE) > 0).map((f) => reason('integrity.skip-added', f.path, 'adds a skip, only, todo or expected-failure mark in a test file'));
    },
  },
  {
    id: 'integrity.snapshot',
    pattern: `a file added, changed or deleted whose path matches ${SNAPSHOT_GLOBS.join(', ')}`,
    misses: 'snapshots stored under other names or inline in a test file (inline snapshots show only as changed test lines)',
    needs: null,
    run(files) {
      return files.filter((f) => touches(f, isSnapshot)).map((f) => reason('integrity.snapshot', f.path, 'changes a snapshot or golden file'));
    },
  },
  {
    id: 'integrity.runner-config',
    pattern: `a file added, changed or deleted whose path matches the test-runner-config exclusion globs (${RUNNER_GLOBS.join(', ')})`,
    misses: 'runner settings kept inside package.json, pyproject.toml or another manifest (see integrity.scripts for package scripts), runner flags on a command line outside the repository',
    needs: null,
    run(files) {
      return files.filter((f) => touches(f, isRunner)).map((f) => reason('integrity.runner-config', f.path, 'changes test-runner configuration'));
    },
  },
  {
    id: 'integrity.scripts',
    pattern: 'package.json or composer.json at any depth whose "scripts" object differs between the base and the head (both read and checked against the diff\'s hashes); when either cannot be read, the line says so',
    misses: 'scripts in a Makefile, a shell file or a task runner (those are build-script exclusions); a script whose text is the same but whose called file changed',
    needs: null,
    run(files, ctx) {
      const out: Reason[] = [];
      for (const f of files) {
        if (!pathsOf(f).some((p) => SCRIPT_FILES.has(fileName(p)))) continue;
        const v = versions(f, ctx.base);
        if (v === null) {
          out.push(reason('integrity.scripts', f.path, 'changes a package manifest whose base could not be read, so its scripts were not compared'));
          continue;
        }
        const a = jsonObject(v.base, 'scripts');
        const b = jsonObject(v.head, 'scripts');
        if (a === 'bad' || b === 'bad') {
          out.push(reason('integrity.scripts', f.path, 'changes a package manifest that is not valid JSON, so its scripts were not compared'));
          continue;
        }
        const keys = changedKeys(a, b);
        if (keys.length > 0) out.push(reason('integrity.scripts', f.path, `changes package scripts (${keys.slice(0, 5).join(', ')}${keys.length > 5 ? ', ...' : ''})`));
      }
      return out;
    },
  },
  {
    id: 'integrity.exit-added',
    pattern: `an added line in a test file or test-runner config matching /${EXIT_RE.source}/`,
    misses: 'an exit reached through a helper outside test paths, a thrown error caught by a wrapper that exits, a runner told to bail',
    needs: null,
    run(files) {
      return files.filter((f) => isTestCode(f) && count(lines(f, '+'), EXIT_RE) > 0).map((f) => reason('integrity.exit-added', f.path, 'adds an exit call in test code'));
    },
  },
  {
    id: 'integrity.expected-changed',
    pattern: `in a test file, a removed line and the added line that replaces it (same position in a run of - lines and the + run after it) both match /${ASSERT_RE.source}/ and are equal once every string, number, true/false/null literal is replaced by one placeholder`,
    misses: 'an expected value moved to a constant or fixture file, a changed expected value on a line that is not an assertion, a replacement that also renames anything; an honest fix to a wrong expectation fires too',
    needs: null,
    run(files) {
      const out: Reason[] = [];
      for (const f of files) {
        if (!touches(f, isTest) || f.binary) continue;
        const hit = replacedPairs(f).some(([a, b]) => ASSERT_RE.test(a) && ASSERT_RE.test(b) && a.trim() !== b.trim() && literalShape(a) === literalShape(b));
        if (hit) out.push(reason('integrity.expected-changed', f.path, 'changes an expected value in an assertion line'));
      }
      return out;
    },
  },
  {
    id: 'integrity.equality-override',
    pattern: `an added line in a test file or test-runner config matching /${EQUALITY_RE.source}/`,
    misses: 'an equality or comparison override in source code outside test paths (operator overloading in the code under test), a matcher imported from a package',
    needs: null,
    run(files) {
      return files.filter((f) => isTestCode(f) && count(lines(f, '+'), EQUALITY_RE) > 0).map((f) => reason('integrity.equality-override', f.path, 'adds an equality override or a custom matcher in test code'));
    },
  },
  {
    id: 'integrity.suppression-added',
    pattern: `an added line in a test file or a file with a code extension matching /${SUPPRESSION_RE.source}/`,
    misses: 'a rule switched off in a linter or compiler config file (those are build-script exclusions), a cast such as "as any", suppressions in files without a code extension; a file that names these markers as data (this rule list itself) fires too',
    needs: null,
    run(files) {
      return files.filter((f) => isCode(f) && count(lines(f, '+'), SUPPRESSION_RE) > 0).map((f) => reason('integrity.suppression-added', f.path, 'adds a lint, type-check or coverage suppression'));
    },
  },
  {
    id: 'integrity.dependency-added',
    pattern: 'a dependency name present in the head and not in the base of package.json, composer.json, requirements*.txt, constraints*.txt, go.mod, Gemfile, Cargo.toml, pyproject.toml or pubspec.yaml (both versions read and checked against the diff\'s hashes); when either cannot be read, the line says so',
    misses: 'a dependency added through a lockfile only, a vendored copy, a download in a script, a manifest format not listed; a version change of an existing dependency does not fire',
    needs: null,
    run(files, ctx) {
      const out: Reason[] = [];
      for (const f of files) {
        const m = MANIFESTS.find((x) => pathsOf(f).some((p) => x.test(p)));
        if (m === undefined) continue;
        const v = versions(f, ctx.base);
        if (v === null) {
          out.push(reason('integrity.dependency-added', f.path, 'changes a dependency manifest whose base could not be read, so new dependencies were not checked'));
          continue;
        }
        const a = m.names(v.base);
        const b = m.names(v.head);
        if (a === null || b === null) {
          out.push(reason('integrity.dependency-added', f.path, 'changes a dependency manifest it could not parse, so new dependencies were not checked'));
          continue;
        }
        const added = [...b].filter((n) => !a.has(n)).sort();
        if (added.length > 0) out.push(reason('integrity.dependency-added', f.path, `adds ${added.length === 1 ? 'a dependency' : `${added.length} dependencies`} (${added.slice(0, 3).join(', ')}${added.length > 3 ? ', ...' : ''})`));
      }
      return out;
    },
  },
  {
    id: 'integrity.outside-paths',
    pattern: 'a file whose old or new path matches none of the declared path globs (--paths, glob rules as in always_review)',
    misses: 'nothing when no paths were declared (the rule then has no input and says so in notChecked); whether the declared paths were the right ones',
    needs: 'declared-paths',
    run(files, ctx) {
      const declared = ctx.declaredPaths;
      if (declared === null) return [];
      const inside = anyGlob(declared);
      return files.filter((f) => !pathsOf(f).every(inside)).map((f) => reason('integrity.outside-paths', f.path, 'changes a file outside the declared paths'));
    },
  },
  {
    id: 'integrity.size',
    pattern: 'more changed lines (added plus removed, text files) than the declared size line (--max-lines), or more files than the declared file line (--max-files); no line is set by default',
    misses: 'nothing until you declare a line; how hard a change is to read (a small change can hide more than a large rename)',
    needs: 'size-line',
    run(files, ctx) {
      if (ctx.maxLines === null && ctx.maxFiles === null) return [];
      const changed = files.reduce((n, f) => n + f.hunks.reduce((m, h) => m + h.lines.filter((l) => l.op !== ' ').length, 0), 0);
      const overLines = ctx.maxLines !== null && changed > ctx.maxLines;
      const overFiles = ctx.maxFiles !== null && files.length > ctx.maxFiles;
      if (!overLines && !overFiles) return [];
      const line = [ctx.maxLines !== null ? `${ctx.maxLines} lines` : null, ctx.maxFiles !== null ? `${ctx.maxFiles} files` : null].filter((x) => x !== null).join(' or ');
      return [reason('integrity.size', null, `changes ${changed} lines in ${files.length} files, over the declared size line (${line})`)];
    },
  },
  {
    id: 'integrity.boundary-no-adr',
    pattern: `a file whose path matches a declared boundary glob (merge.boundary_paths) when no file under ${ADR_GLOBS.join(', ')} is added or changed in the same diff`,
    misses: 'nothing when no boundary paths are declared; whether the decision record says anything useful (it checks only that one changed)',
    needs: 'boundary-paths',
    run(files, ctx) {
      if (ctx.boundaryPaths.length === 0) return [];
      const adr = files.some((f) => f.status !== 'deleted' && f.newPath !== null && isAdr(f.newPath));
      if (adr) return [];
      const onBoundary = anyGlob(ctx.boundaryPaths);
      return files.filter((f) => pathsOf(f).some(onBoundary)).map((f) => reason('integrity.boundary-no-adr', f.path, `changes a declared boundary path with no decision record under ${ADR_GLOBS.join(', ')}`));
    },
  },
];

/** The rules that had no input for this diff, as lines for the verdict's `notChecked`. */
export function notChecked(ctx: IntegrityContext, rules: readonly IntegrityRule[] = INTEGRITY_RULES): string[] {
  const out: string[] = [];
  for (const r of rules) {
    if (r.needs === 'declared-paths' && ctx.declaredPaths === null) out.push(`${r.id}: no declared paths (--paths)`);
    if (r.needs === 'boundary-paths' && ctx.boundaryPaths.length === 0) out.push(`${r.id}: no boundary paths declared (merge.boundary_paths)`);
    if (r.needs === 'size-line' && ctx.maxLines === null && ctx.maxFiles === null) out.push(`${r.id}: no size line declared (--max-lines, --max-files)`);
  }
  return out;
}

/** Every test-integrity reason for a diff, rule by rule in list order. */
export function integrityReasons(files: readonly FileDiff[], ctx: IntegrityContext, rules: readonly IntegrityRule[] = INTEGRITY_RULES): Reason[] {
  return rules.flatMap((r) => r.run(files, ctx));
}
