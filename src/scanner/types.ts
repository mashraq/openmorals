export type Severity = "low" | "medium" | "high" | "critical";

export type ScanVerdict = "allow" | "ask" | "deny";

export type FileKind =
  | "skill-md"
  | "markdown"
  | "script"
  | "package-json"
  | "mcp-config"
  | "hooks-config"
  | "settings-json"
  | "plugin-manifest"
  | "json"
  | "toml"
  | "text";

export interface ScanFile {
  readonly path: string;
  readonly kind: FileKind;
  readonly text: string;
}

export interface RuleHit {
  readonly line: number | null;
  readonly evidence: string;
  readonly index?: number;
  readonly message?: string;
  readonly severity?: Severity;
}

export interface RegexMatcher {
  readonly type: "regex";
  readonly patterns: readonly RegExp[];
  readonly unless?: readonly RegExp[];
  readonly kinds?: readonly FileKind[];
}

export interface FunctionMatcher {
  readonly type: "function";
  readonly kinds?: readonly FileKind[];
  readonly match: (file: ScanFile) => readonly RuleHit[];
}

export interface WalkerMatcher {
  readonly type: "walker";
}

export type RuleMatcher = RegexMatcher | FunctionMatcher | WalkerMatcher;

export interface ScanRule {
  readonly id: string;
  readonly category: string;
  readonly description: string;
  readonly severity: Severity;
  readonly matcher: RuleMatcher;
}

export interface ScanFinding {
  readonly ruleId: string;
  readonly severity: Severity;
  readonly description: string;
  readonly file: string;
  readonly line: number | null;
  readonly evidence: string;
  readonly message?: string;
}

export interface ScanLimits {
  readonly maxFileBytes: number;
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly maxDepth: number;
}

export interface ScanOptions {
  readonly limits?: Partial<ScanLimits>;
  readonly rules?: readonly ScanRule[];
  readonly disabledRules?: readonly string[];
}

export interface ScanStats {
  readonly filesScanned: number;
  readonly filesSkipped: number;
  readonly bytesScanned: number;
  readonly truncated: boolean;
}

export interface SeverityCounts {
  readonly critical: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
}

export interface ScanReport {
  readonly root: string;
  readonly verdict: ScanVerdict;
  readonly counts: SeverityCounts;
  readonly findings: readonly ScanFinding[];
  readonly stats: ScanStats;
  readonly limits: ScanLimits;
}
