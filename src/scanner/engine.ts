import { escapeInvisible, makeEvidence, redactSecrets } from "./redact.js";
import { SCAN_RULES } from "./rules.js";
import type { ScanFinding, ScanRule, RuleHit, ScanFile, ScanVerdict, Severity, SeverityCounts } from "./types.js";
import { splitLines } from "./util.js";

export const MAX_HITS_PER_RULE_PER_FILE = 20;
export const MAX_CONTINUATION_LINES = 8;
const CONTINUED = /(?:\\|\||&&)\s*$/;

const RANK: Readonly<Record<Severity, number>> = { low: 1, medium: 2, high: 3, critical: 4 };

export function severityRank(s: Severity): number {
  return RANK[s];
}

export function verdictFor(severity: Severity | null): ScanVerdict {
  if (severity === "critical") return "deny";
  if (severity === "high" || severity === "medium") return "ask";
  return "allow";
}

export function worstSeverity(findings: readonly ScanFinding[]): Severity | null {
  let worst: Severity | null = null;
  for (const f of findings) {
    if (worst === null || RANK[f.severity] > RANK[worst]) worst = f.severity;
  }
  return worst;
}

export function countSeverities(findings: readonly ScanFinding[]): SeverityCounts {
  const c = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) c[f.severity]++;
  return c;
}

function stripGlobal(p: RegExp): RegExp {
  return p.global || p.sticky ? new RegExp(p.source, p.flags.replace(/[gy]/g, "")) : p;
}

function regexHits(rule: ScanRule, file: ScanFile): RuleHit[] {
  if (rule.matcher.type !== "regex") return [];
  const patterns = rule.matcher.patterns.map(stripGlobal);
  const unless = (rule.matcher.unless ?? []).map(stripGlobal);
  const hits: RuleHit[] = [];
  const lines = splitLines(file.text);
  lines.forEach((physical: string, i: number) => {
    const candidates: string[] = [physical];
    let logical = physical;
    for (let j = i + 1; j < lines.length && j <= i + MAX_CONTINUATION_LINES && CONTINUED.test(logical); j++) {
      logical = `${logical.replace(/\\\s*$/, "")} ${(lines[j] ?? "").trim()}`;
      candidates.push(logical);
    }
    for (const line of candidates) {
      if (unless.some((u: RegExp) => u.test(line))) continue;
      for (const p of patterns) {
        const m = p.exec(line);
        if (m !== null) {
          hits.push({ line: i + 1, evidence: line, index: m.index });
          return;
        }
      }
    }
  });
  return hits;
}

export function makeFinding(rule: ScanRule, file: string, hit: RuleHit): ScanFinding {
  const base = {
    ruleId: rule.id,
    severity: hit.severity ?? rule.severity,
    description: rule.description,
    file,
    line: hit.line,
    evidence: makeEvidence(hit.evidence, hit.index ?? 0),
  };
  return hit.message === undefined ? base : { ...base, message: escapeInvisible(redactSecrets(hit.message)) };
}

export function walkerFinding(ruleId: string, file: string, message: string, rules: readonly ScanRule[] = SCAN_RULES): ScanFinding {
  const rule = rules.find((r: ScanRule) => r.id === ruleId) ?? SCAN_RULES.find((r: ScanRule) => r.id === ruleId);
  const severity: Severity = rule?.severity ?? "medium";
  return {
    ruleId,
    severity,
    description: rule?.description ?? ruleId,
    file,
    line: null,
    evidence: "",
    message: escapeInvisible(redactSecrets(message)),
  };
}

export function scanFile(file: ScanFile, rules: readonly ScanRule[] = SCAN_RULES, disabled: ReadonlySet<string> = new Set<string>()): ScanFinding[] {
  const findings: ScanFinding[] = [];
  for (const rule of rules) {
    if (disabled.has(rule.id) || rule.matcher.type === "walker") continue;
    const kinds = rule.matcher.kinds;
    if (kinds !== undefined && !kinds.includes(file.kind)) continue;
    let hits: readonly RuleHit[];
    try {
      hits = rule.matcher.type === "regex" ? regexHits(rule, file) : rule.matcher.match(file);
    } catch (e: unknown) {
      const why = e instanceof Error ? e.message : String(e);
      findings.push(walkerFinding("scan.rule-error", file.path, `rule ${rule.id} failed: ${why}`, rules));
      continue;
    }
    const seen = new Set<string>();
    let n = 0;
    for (const h of hits) {
      const key = `${h.line ?? "-"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (n++ >= MAX_HITS_PER_RULE_PER_FILE) break;
      findings.push(makeFinding(rule, file.path, h));
    }
  }
  return findings;
}

export function sortFindings(findings: readonly ScanFinding[]): ScanFinding[] {
  return [...findings].sort((a: ScanFinding, b: ScanFinding) =>
    RANK[b.severity] - RANK[a.severity] ||
    (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));
}
