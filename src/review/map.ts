import type { FileDiff } from '../diffclass/parse.js';
import { exclusionsFor } from '../diffclass/rules.js';
import type { DiffVerdict, Reason } from '../diffclass/types.js';

export type Risk = 'high' | 'medium' | 'low';

/**
 * Rules that make a file high risk to merge unread (0.33.0): what can leak a secret, weaken the tests that judge the
 * work, change what runs on build, CI or commit, or what the diff reader does not fully understand.
 */
export const HIGH_RISK_RE = /^(integrity\.(secret-added|lockfile|assert-removed|skip-added|exit-added|expected-changed|equality-override|runner-config|scripts|snapshot|suppression-added|boundary-no-adr)|exclude\.(secrets|ci-config|git-config|agent-instructions|self-protected|build-script|codeowners|classifier|test-runner-config)|doubt\.|note\.|record\.)/;
/** Rules that make a file medium risk: source code, dependencies, paths outside the declared work, paths you always review. */
export const MEDIUM_RISK_RE = /^(exclude\.(executable|manifest|lockfile|always-review)|integrity\.(dependency-added|outside-paths))/;

export function riskOf(rule: string): Risk {
  return HIGH_RISK_RE.test(rule) ? 'high' : MEDIUM_RISK_RE.test(rule) ? 'medium' : 'low';
}

const RANK: Record<Risk, number> = { high: 3, medium: 2, low: 1 };

/** Within one risk class, which rule puts a file first: a leaked secret, then what a note or the run's record raised, then weakened tests, then dependencies, then what runs on build, CI or commit. */
const PRIORITY: readonly RegExp[] = [
  /^(integrity\.secret-added|exclude\.secrets)$/,
  /^(note|record)\./,
  /^integrity\.(assert-removed|skip-added|exit-added|expected-changed|equality-override|snapshot|suppression-added|runner-config|scripts)$/,
  /^integrity\.(lockfile|dependency-added)$/,
  /^exclude\./,
  /^doubt\./,
];

function priorityOf(rules: readonly string[]): number {
  let best = PRIORITY.length;
  for (const r of rules) {
    const i = PRIORITY.findIndex((p) => p.test(r));
    if (i !== -1 && i < best) best = i;
  }
  return best;
}

export interface MapEntry {
  path: string;
  risk: Risk;
  added: number;
  removed: number;
  /** The rule ids behind the risk, highest risk first. */
  rules: string[];
  /** The first reason, as text, or null. */
  why: string | null;
}

export interface ReviewMap {
  /** Facts about the whole change (no file), highest risk first. */
  whole: Reason[];
  files: MapEntry[];
  counts: Record<Risk, number>;
}

function lineCounts(f: FileDiff): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const h of f.hunks) for (const l of h.lines) {
    if (l.op === '+') added++;
    else if (l.op === '-') removed++;
  }
  return { added, removed };
}

/**
 * Orders a change's files by what is riskiest to merge unread (0.33.0), so a reader with little time starts where it
 * matters. Pure. Built from the reasons `diff-class` already found: it adds no judgement of its own, and a low place on
 * the map never means a file is safe.
 */
export function reviewMap(verdict: DiffVerdict, files: readonly FileDiff[]): ReviewMap {
  const byPath = new Map<string, Reason[]>();
  const whole: Reason[] = [];
  for (const r of verdict.reasons) {
    if (r.path === null) whole.push(r);
    else byPath.set(r.path, [...(byPath.get(r.path) ?? []), r]);
  }
  for (const fv of verdict.files) for (const r of fv.reasons) {
    const list = byPath.get(fv.path) ?? [];
    if (!list.some((x) => x.rule === r.rule && x.text === r.text)) byPath.set(fv.path, [...list, r]);
  }
  const entries: MapEntry[] = files.map((f) => {
    const rs = [...(byPath.get(f.path) ?? []), ...(f.oldPath !== null && f.oldPath !== f.path ? (byPath.get(f.oldPath) ?? []) : [])];
    const rules = [...new Set(rs.map((r) => r.rule))].sort((a, b) => RANK[riskOf(b)] - RANK[riskOf(a)] || a.localeCompare(b));
    const risk = rules.reduce<Risk>((acc, r) => (RANK[riskOf(r)] > RANK[acc] ? riskOf(r) : acc), 'low');
    const top = rs.slice().sort((a, b) => RANK[riskOf(b.rule)] - RANK[riskOf(a.rule)])[0];
    return { path: f.path, risk, ...lineCounts(f), rules, why: top?.text ?? null };
  });
  const highs = (e: MapEntry): number => e.rules.filter((r) => riskOf(r) === 'high').length;
  entries.sort((a, b) => RANK[b.risk] - RANK[a.risk] || priorityOf(a.rules) - priorityOf(b.rules) || highs(b) - highs(a) || b.added + b.removed - (a.added + a.removed) || a.path.localeCompare(b.path));
  whole.sort((a, b) => RANK[riskOf(b.rule)] - RANK[riskOf(a.rule)]);
  const counts: Record<Risk, number> = { high: 0, medium: 0, low: 0 };
  for (const e of entries) counts[e.risk]++;
  return { whole, files: entries, counts };
}

/** The size line over which a split is suggested (0.33.0), unless `--max-lines` / `--max-files` set another. */
export const SPLIT_LINES = 400;
export const SPLIT_FILES = 25;

export interface SplitGroup {
  name: string;
  files: string[];
  lines: number;
  /** Why it is a group of its own, in a few words. */
  why: string;
}

export interface SplitSuggestion {
  lines: number;
  files: number;
  over: { lines: number; files: number };
  groups: SplitGroup[];
}

const TEST_STEM_RE = /(\.(test|spec)|_test|_spec)$/;

function stemOf(path: string): string {
  const base = path.split('/').pop() ?? path;
  const noExt = base.replace(/\.[^.]+$/, '');
  return noExt.replace(TEST_STEM_RE, '').replace(/^test_/, '');
}

function areaOf(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 1) return '(root)';
  const top = parts[0] ?? '';
  if (['src', 'lib', 'app', 'packages', 'apps', 'services', 'cmd', 'internal', 'pkg', 'test', 'tests', 'spec'].includes(top) && parts.length > 2) return `${top}/${parts[1] ?? ''}`;
  return top;
}

function kindOf(path: string): 'dependencies' | 'tooling' | 'docs' | 'test' | 'code' {
  const ids = exclusionsFor(path).map((h) => h.id);
  if (ids.includes('exclude.lockfile') || ids.includes('exclude.manifest')) return 'dependencies';
  if (ids.some((i) => ['exclude.ci-config', 'exclude.build-script', 'exclude.test-runner-config', 'exclude.git-config', 'exclude.codeowners', 'exclude.agent-instructions'].includes(i))) return 'tooling';
  if (ids.includes('exclude.test-file')) return 'test';
  if (ids.includes('exclude.readme-legal') || /\.(md|mdx|rst|txt|adoc)$/i.test(path) || path.startsWith('docs/')) return 'docs';
  return 'code';
}

/**
 * Suggests how a change over the size line could be split into smaller pull requests (0.33.0). Pure and only a
 * suggestion: it never changes the verdict. Dependencies go first (other parts build on them), each test goes with the
 * source file of the same name when the change has one, code is grouped by area, then tooling and CI, then docs.
 * Returns null when the change is within the line.
 */
export function suggestSplit(files: readonly FileDiff[], limits: { maxLines?: number; maxFiles?: number } = {}): SplitSuggestion | null {
  const maxLines = limits.maxLines ?? SPLIT_LINES;
  const maxFiles = limits.maxFiles ?? SPLIT_FILES;
  const sized = files.map((f) => {
    const c = lineCounts(f);
    return { path: f.path, lines: c.added + c.removed, kind: kindOf(f.path) };
  });
  const total = sized.reduce((n, f) => n + f.lines, 0);
  if (total <= maxLines && sized.length <= maxFiles) return null;
  const sourceArea = new Map<string, string>();
  for (const f of sized) if (f.kind === 'code') sourceArea.set(stemOf(f.path), areaOf(f.path));
  const groups = new Map<string, SplitGroup>();
  const add = (name: string, why: string, f: { path: string; lines: number }): void => {
    const g = groups.get(name) ?? { name, files: [], lines: 0, why };
    g.files.push(f.path);
    g.lines += f.lines;
    groups.set(name, g);
  };
  for (const f of sized) {
    if (f.kind === 'dependencies') add('dependencies', 'manifests and lockfiles; land first, the rest builds on them', f);
    else if (f.kind === 'tooling') add('tooling and CI', 'what runs on build, CI and commit; read on its own', f);
    else if (f.kind === 'docs') add('docs', 'prose only', f);
    else if (f.kind === 'test') {
      const area = sourceArea.get(stemOf(f.path));
      if (area !== undefined) add(`code: ${area}`, 'source with the tests of the same name', f);
      else add(`tests: ${areaOf(f.path)}`, 'tests with no source file of the same name in this change', f);
    } else add(`code: ${areaOf(f.path)}`, 'source with the tests of the same name', f);
  }
  const order = (g: SplitGroup): number => (g.name === 'dependencies' ? 0 : g.name.startsWith('code: ') ? 1 : g.name.startsWith('tests: ') ? 2 : g.name === 'tooling and CI' ? 3 : 4);
  const list = [...groups.values()].sort((a, b) => order(a) - order(b) || b.lines - a.lines || a.name.localeCompare(b.name));
  return { lines: total, files: sized.length, over: { lines: maxLines, files: maxFiles }, groups: list };
}

export function formatMapText(map: ReviewMap, split: SplitSuggestion | null): string {
  const out: string[] = [];
  out.push(`Review map, riskiest first (${map.counts.high} high, ${map.counts.medium} medium, ${map.counts.low} low). A low place never means safe.`);
  for (const r of map.whole) out.push(`  [${riskOf(r.rule)}] whole change: ${r.text}`);
  for (const e of map.files) out.push(`  [${e.risk}] ${e.path} (+${e.added} -${e.removed})${e.rules.length > 0 ? `: ${e.rules.join(', ')}` : ''}`);
  if (split !== null) {
    out.push(`Split suggestion: ${split.lines} changed lines in ${split.files} files is over the line (${split.over.lines} lines or ${split.over.files} files). One way to split it:`);
    split.groups.forEach((g, i) => out.push(`  ${i + 1}. ${g.name} (${g.files.length} file${g.files.length === 1 ? '' : 's'}, ${g.lines} lines${g.lines > split.over.lines ? `; still over ${split.over.lines}, split further by hand` : ''}): ${g.why}`));
  }
  return `${out.join('\n')}\n`;
}
