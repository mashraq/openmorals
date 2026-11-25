import type { TestReport, TestStatus } from './report.js';
import { matchName } from './failfirst.js';

export type ClaimMiss = 'fails' | 'skipped' | 'did-not-run' | 'ambiguous';

export interface ClaimProblem {
  /** The claim as given: a test id, a name, or a test from the agent's own report. */
  claimed: string;
  /** The test id in the clean report, when one matched. */
  id: string | null;
  miss: ClaimMiss;
  /** True when the test is on hold: listed, but it does not decide the exit code. */
  held: boolean;
}

export interface ClaimResult {
  /** "all" when the claim was that every test passes; "list" when the agent named tests. */
  claim: 'all' | 'list';
  checked: number;
  confirmed: number;
  problems: ClaimProblem[];
  /** Files or packages that did not load in the clean run: a claim that "all pass" cannot hold while any are listed. */
  loadErrors: string[];
  /** Problems that are not held. The exit code is 1 exactly when this is above 0. */
  blocking: number;
}

/**
 * Checks what an agent said passed against a clean run the person made (0.32.0). Pure. With `claimed` null the claim is
 * "every test passes": each failing or skipped test in the clean report is a problem, and so is a load error. With a
 * list, each claimed test must be in the clean report and pass there.
 */
export function checkClaim(clean: TestReport, claimed: readonly string[] | null, held: ReadonlySet<string> = new Set()): ClaimResult {
  const status = new Map<string, TestStatus>();
  for (const t of clean.tests) {
    const prev = status.get(t.id);
    // A test listed twice (repeats inside one report) counts as its worst outcome.
    if (prev === undefined || prev === 'pass' || (prev === 'skip' && t.status === 'fail')) status.set(t.id, t.status);
  }
  const ids = [...status.keys()];
  const problems: ClaimProblem[] = [];
  let confirmed = 0;
  const loadErrors = (clean.loadErrors ?? []).map((l) => l.file ?? '(unnamed)');
  if (claimed === null) {
    for (const [id, s] of status) {
      if (s === 'pass') confirmed++;
      else problems.push({ claimed: id, id, miss: s === 'fail' ? 'fails' : 'skipped', held: held.has(id) });
    }
  } else {
    for (const c of [...new Set(claimed)]) {
      const m = matchName(c, ids);
      if ('many' in m) {
        problems.push({ claimed: c, id: null, miss: 'ambiguous', held: false });
        continue;
      }
      if ('none' in m) {
        problems.push({ claimed: c, id: null, miss: 'did-not-run', held: held.has(c) });
        continue;
      }
      const s = status.get(m.id);
      if (s === 'pass') confirmed++;
      else problems.push({ claimed: c, id: m.id, miss: s === 'fail' ? 'fails' : 'skipped', held: held.has(m.id) });
    }
  }
  problems.sort((a, b) => a.miss.localeCompare(b.miss) || a.claimed.localeCompare(b.claimed));
  const blocking = problems.filter((p) => !p.held).length + (claimed === null ? loadErrors.length : 0);
  return { claim: claimed === null ? 'all' : 'list', checked: claimed === null ? status.size : new Set(claimed).size, confirmed, problems, loadErrors, blocking };
}

/** The tests an agent's own report shows as passing: its claim, when it handed over a report. */
export function passingIds(report: TestReport): string[] {
  return [...new Set(report.tests.filter((t) => t.status === 'pass').map((t) => t.id))];
}

/** Reads a plain claim list: one test id or name per line; blank lines and lines starting with # are skipped. */
export function parseClaimList(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
}
