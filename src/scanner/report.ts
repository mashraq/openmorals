import type { ScanFinding, ScanReport } from "./types.js";

export function formatScanJson(report: ScanReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function location(f: ScanFinding): string {
  return f.line === null ? f.file : `${f.file}:${f.line}`;
}

export function formatScanText(report: ScanReport): string {
  const c = report.counts;
  const out: string[] = [];
  out.push(`openmorals scan: ${report.root}`);
  out.push(`verdict: ${report.verdict.toUpperCase()}  (${c.critical} critical, ${c.high} high, ${c.medium} medium, ${c.low} low)`);
  out.push(
    `files scanned: ${report.stats.filesScanned}, skipped: ${report.stats.filesSkipped}, bytes: ${report.stats.bytesScanned}` +
      (report.stats.truncated ? "  (TRUNCATED: a scan cap was reached)" : ""),
  );
  if (report.findings.length === 0) {
    out.push("");
    out.push("no findings. A static scan only finds known patterns; it is not proof that the code is safe.");
    return `${out.join("\n")}\n`;
  }
  for (const f of report.findings) {
    out.push("");
    out.push(`${f.severity.toUpperCase().padEnd(8)} ${f.ruleId}  ${location(f)}`);
    out.push(`  ${f.message ?? f.description}`);
    if (f.evidence.length > 0) out.push(`  > ${f.evidence}`);
  }
  return `${out.join("\n")}\n`;
}
