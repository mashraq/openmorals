// Only the pure glob module is imported: the bylaws validator uses this too, and importing the planner there would make a cycle.
import { globProblem } from '../diffclass/glob.js';

export const SANDBOX_HOST_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

function stringList(v: unknown, where: string, errors: string[]): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    errors.push(`${where}: must be a list of strings`);
    return [];
  }
  return v as string[];
}

function onlyKeys(o: Record<string, unknown>, keys: string[], where: string, errors: string[]): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) errors.push(`${where}.${k}: unknown key`);
}

function obj(v: unknown, where: string, errors: string[]): Record<string, unknown> | null {
  if (v === undefined) return null;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    errors.push(`${where}: must be a mapping`);
    return null;
  }
  return v as Record<string, unknown>;
}

/** The named set in `sandbox.write.protected_paths` that stands for the paths the test-lock pack protects by rule. */
export const TEST_LOCK_SET = 'test-lock';
export const MAX_PROTECTED_PATHS = 200;

/**
 * The paths the test-lock pack (packs/test-lock.yaml) protects by rule, as path globs (the `merge.always_review`
 * grammar, from the project root): its judging tests (acceptance and contract folders under test/ or tests/ at any
 * depth, snapshot folders and files, conftest.py) and its runner configuration (vitest and jest config, pytest.ini,
 * dart_test.yaml). A test keeps this list and the pack's two regular expressions in step.
 */
export const TEST_LOCK_PROTECTED_GLOBS: readonly string[] = [
  '**/test/acceptance/', '**/tests/acceptance/', '**/test/contract/', '**/test/contracts/', '**/tests/contract/', '**/tests/contracts/',
  '__snapshots__/', '*.snap', 'conftest.py', 'vitest.config.*', 'jest.config.*', 'pytest.ini', 'dart_test.yaml',
];

/** `sandbox.write.protected_paths` with the named set expanded: project-relative globs, without repeats. */
export function expandProtectedPaths(entries: readonly string[]): string[] {
  const out: string[] = [];
  for (const e of entries) for (const g of e === TEST_LOCK_SET ? TEST_LOCK_PROTECTED_GLOBS : [e]) if (!out.includes(g)) out.push(g);
  return out;
}

/** Strict validation of the sandbox section; unknown keys are errors. */
export function validateSandboxSection(raw: unknown): { ok: true; section: { hosts: string[]; write: string[]; denyRead: string[]; protectedPaths: string[] | undefined } } | { ok: false; error: string } {
  const errors: string[] = [];
  const top = obj(raw, 'sandbox', errors);
  let hosts: string[] = [];
  let write: string[] = [];
  let denyRead: string[] = [];
  let protectedPaths: string[] | undefined;
  if (top !== null) {
    onlyKeys(top, ['network', 'write', 'read'], 'sandbox', errors);
    const net = obj(top['network'], 'sandbox.network', errors);
    if (net !== null) {
      onlyKeys(net, ['allow_hosts'], 'sandbox.network', errors);
      hosts = stringList(net['allow_hosts'], 'sandbox.network.allow_hosts', errors).map((h) => h.trim().toLowerCase());
      for (const h of hosts) if (!SANDBOX_HOST_RE.test(h) || h.length > 253) errors.push(`sandbox.network.allow_hosts: '${h}' is not a host name (IP addresses and a bare * are not accepted)`);
    }
    const w = obj(top['write'], 'sandbox.write', errors);
    if (w !== null) {
      onlyKeys(w, ['allow', 'protected_paths'], 'sandbox.write', errors);
      write = stringList(w['allow'], 'sandbox.write.allow', errors);
      if (w['protected_paths'] !== undefined && w['protected_paths'] !== null) {
        const list = stringList(w['protected_paths'], 'sandbox.write.protected_paths', errors);
        if (list.length > MAX_PROTECTED_PATHS) errors.push(`sandbox.write.protected_paths: at most ${MAX_PROTECTED_PATHS} entries`);
        for (const g of list) {
          if (g === TEST_LOCK_SET) continue;
          const why = globProblem(g) ?? (g.includes('"') ? 'has a double quote' : null);
          if (why !== null) errors.push(`sandbox.write.protected_paths: ${JSON.stringify(g)} ${why}`);
        }
        protectedPaths = [...new Set(list)];
      } else if (w['protected_paths'] === null) protectedPaths = [];
    }
    const r = obj(top['read'], 'sandbox.read', errors);
    if (r !== null) {
      onlyKeys(r, ['deny'], 'sandbox.read', errors);
      denyRead = stringList(r['deny'], 'sandbox.read.deny', errors);
    }
  }
  if (errors.length > 0) return { ok: false, error: errors.join('; ') };
  return { ok: true, section: { hosts: [...new Set(hosts)], write, denyRead, protectedPaths } };
}

