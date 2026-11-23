import { countSeverities, scanFile, sortFindings, verdictFor, worstSeverity } from "./engine.js";
import { SCAN_RULES } from "./rules.js";
import type { ScanFinding, ScanRule, ScanFile, ScanLimits, ScanOptions, ScanReport } from "./types.js";
import { DEFAULT_SCAN_LIMITS, walk } from "./walk.js";

export type {
  FileKind,
  ScanFinding,
  ScanRule,
  RuleHit,
  RuleMatcher,
  ScanFile,
  ScanLimits,
  ScanOptions,
  ScanReport,
  ScanStats,
  ScanVerdict,
  Severity,
  SeverityCounts,
} from "./types.js";
export { SCAN_RULES, ruleById } from "./rules.js";
export { DEFAULT_SCAN_LIMITS } from "./walk.js";
export { classifyFile } from "./classify.js";
export { redactSecrets } from "./redact.js";
export { verdictFor } from "./engine.js";
export { formatScanJson, formatScanText } from "./report.js";

export const UNDISABLEABLE_RULES: readonly string[] = [
  "scan.unreadable",
  "scan.limit-reached",
  "scan.file-too-large",
  "scan.binary-file",
  "scan.special-file",
  "scan.rule-error",
  "scan.unparseable-config",
  "scan.symlink-escape",
];

function disabledSet(options: ScanOptions | undefined): Set<string> {
  return new Set<string>((options?.disabledRules ?? []).filter((id: string) => !UNDISABLEABLE_RULES.includes(id)));
}

function resolveLimits(options: ScanOptions | undefined): ScanLimits {
  return { ...DEFAULT_SCAN_LIMITS, ...(options?.limits ?? {}) };
}

function buildReport(root: string, findings: readonly ScanFinding[], limits: ScanLimits, filesScanned: number, filesSkipped: number, bytes: number, truncated: boolean): ScanReport {
  const sorted = sortFindings(findings);
  return {
    root,
    verdict: verdictFor(worstSeverity(sorted)),
    counts: countSeverities(sorted),
    findings: sorted,
    stats: { filesScanned, filesSkipped, bytesScanned: bytes, truncated },
    limits,
  };
}

export function scanFiles(files: readonly ScanFile[], options?: ScanOptions, root = "<memory>"): ScanReport {
  const rules: readonly ScanRule[] = options?.rules ?? SCAN_RULES;
  const disabled = disabledSet(options);
  const findings: ScanFinding[] = [];
  let bytes = 0;
  for (const f of files) {
    bytes += Buffer.byteLength(f.text, "utf8");
    findings.push(...scanFile(f, rules, disabled));
  }
  return buildReport(root, findings, resolveLimits(options), files.length, 0, bytes, false);
}

export function scanPath(target: string, options?: ScanOptions): ScanReport {
  const rules: readonly ScanRule[] = options?.rules ?? SCAN_RULES;
  const disabled = disabledSet(options);
  const limits = resolveLimits(options);
  const w = walk(target, limits, rules);
  const findings: ScanFinding[] = w.findings.filter((f: ScanFinding) => !disabled.has(f.ruleId));
  for (const f of w.files) findings.push(...scanFile(f, rules, disabled));
  return buildReport(target, findings, limits, w.files.length, w.filesSkipped, w.bytesRead, w.truncated);
}
