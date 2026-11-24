export type { ReportFormat, ReportResult, ParseOptions, TestReport, TestResult, TestStatus } from './report.js';
export { ID_SEPARATOR, REPORT_FORMATS, detectFormat, isReportFormat, parseTestReport, relativeTo } from './report.js';
export type { Approval, Comparison, Gain, Loss, LossKind, RenameGroup, Totals } from './compare.js';
export { LOSS_KINDS, compareTests, isLossKind, parseApprovals } from './compare.js';
export type { TestsCommandResult } from './command.js';
export { APPROVAL_FILE, LIMITS, MAX_REPORT_BYTES, TESTS_USAGE, UNREADABLE_EXIT, testsCommand } from './command.js';
export type { XmlElement, XmlResult } from './xml.js';
export { parseXml } from './xml.js';
