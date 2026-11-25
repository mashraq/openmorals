import { parse as parseYaml } from 'yaml';
import { redact } from '../audit.js';
import { DEFAULT_BYLAWS, parseBylaws } from '../bylaws.js';
import { loadCasesFrom } from '../eval/cases.js';
import { loosenings } from '../packs/compare.js';
import { SCAN_RULES, scanFiles } from '../scanner/index.js';
import type { BaseReader } from './apply.js';
import { applyHunks, hashNames } from './apply.js';
import type { FileDiff } from './parse.js';
import { SCAN_RULE_PREFIXES, isRootBylaws } from './rules.js';
import type { Reason } from './types.js';

export interface Rebuilt {
  base: string;
  head: string;
}

function reason(rule: string, f: FileDiff, text: string): Reason {
  return { rule, path: f.path, text };
}

/** The base and head text of a modified file: the base read from the base tree, the head rebuilt from the hunks, both checked against the `index` hashes. */
export function rebuild(f: FileDiff, base: BaseReader): { ok: true; value: Rebuilt } | { ok: false; reason: Reason } {
  if (f.status !== 'modified' || f.oldPath === null || f.newPath === null || f.oldPath !== f.newPath) return { ok: false, reason: reason('tighten.not-modified', f, `${f.path} is ${f.status}, not changed in place`) };
  if (f.oldHash === null || f.newHash === null) return { ok: false, reason: reason('tighten.no-index', f, `${f.path} has no "index" line, so its base cannot be checked (use git diff --full-index)`) };
  const r = base.read(f.oldPath);
  if (!r.ok) return { ok: false, reason: reason('tighten.no-base', f, r.error) };
  if (!hashNames(f.oldHash, r.bytes)) return { ok: false, reason: reason('tighten.base-mismatch', f, `${f.path} in the base folder is not the base this diff was made from (its git hash differs)`) };
  let baseText: string;
  try {
    baseText = new TextDecoder('utf-8', { fatal: true }).decode(r.bytes);
  } catch {
    return { ok: false, reason: reason('tighten.no-base', f, `${f.path} in the base folder is not UTF-8 text`) };
  }
  const applied = applyHunks(baseText, f.hunks);
  if (!applied.ok) return { ok: false, reason: reason('tighten.no-apply', f, `${f.path}: ${applied.error}`) };
  if (!hashNames(f.newHash, new TextEncoder().encode(applied.text))) return { ok: false, reason: reason('tighten.head-mismatch', f, `${f.path} rebuilt from the base and the diff does not match the head's git hash`) };
  return { ok: true, value: { base: baseText, head: applied.text } };
}

function addedText(f: FileDiff): string {
  return f.hunks.flatMap((h) => h.lines.filter((l) => l.op === '+').map((l) => l.text)).join('\n');
}

/** Hidden instructions, obfuscation or a secret-shaped value in the added lines. */
export function scanAdded(f: FileDiff): Reason[] {
  const text = addedText(f);
  const out: Reason[] = [];
  const rules = SCAN_RULES.filter((r) => SCAN_RULE_PREFIXES.some((p) => r.id.startsWith(p)));
  const rep = scanFiles([{ path: f.path, kind: 'text', text }], { rules });
  const ids = [...new Set(rep.findings.map((x) => x.ruleId))];
  if (ids.length > 0) out.push(reason('tighten.scanner', f, `the added lines of ${f.path} trip the scanner (${ids.join(', ')})`));
  if (redact(text) !== text) out.push(reason('tighten.secret-shape', f, `the added lines of ${f.path} hold a secret-shaped value`));
  return out;
}

const CASE_FILE = /^cases\/[^/]+\.cases\.yaml$/;
const ONE_LINE_ROW = /^\s*- \{.*\}\s*$/;

export function isCaseFile(path: string): boolean {
  return CASE_FILE.test(path);
}

function rawDoc(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = parseYaml(text, { strict: true, uniqueKeys: true, maxAliasCount: 0 });
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * A1 for a case table: only added one-line rows, the old rows kept in order, every new row expecting ask or deny, and
 * the rebuilt file still loading as a case table. Returns the reasons it is not, or the number of rows it adds.
 */
export function checkCaseRows(f: FileDiff, base: BaseReader): { ok: true; rows: number } | { ok: false; reasons: Reason[] } {
  const fail = (rs: Reason[]): { ok: false; reasons: Reason[] } => ({ ok: false, reasons: rs });
  if (f.status !== 'modified') return fail([reason('tighten.not-modified', f, `${f.path} is ${f.status}, not rows added to an existing table`)]);
  const plus = f.hunks.flatMap((h) => h.lines.filter((l) => l.op === '+'));
  if (f.hunks.some((h) => h.lines.some((l) => l.op === '-'))) return fail([reason('tighten.case-removed', f, `${f.path} removes or edits a line (only added rows can tighten)`)]);
  const other = plus.find((l) => !ONE_LINE_ROW.test(l.text) && l.text.trim() !== '');
  if (other !== undefined) return fail([reason('tighten.case-not-row', f, `${f.path} adds a line that is not a one-line "- { ... }" row (a comment or a multi-line row)`)]);
  const rowLines = plus.filter((l) => ONE_LINE_ROW.test(l.text)).length;
  if (rowLines === 0) return fail([reason('tighten.case-not-row', f, `${f.path} adds no row`)]);
  const rb = rebuild(f, base);
  if (!rb.ok) return fail([rb.reason]);
  const b = rawDoc(rb.value.base);
  const h = rawDoc(rb.value.head);
  if (b === null || h === null) return fail([reason('tighten.case-unreadable', f, `${f.path} is not a YAML mapping before or after the change`)]);
  const bRows = b['cases'];
  const hRows = h['cases'];
  if (!Array.isArray(bRows) || !Array.isArray(hRows)) return fail([reason('tighten.case-unreadable', f, `${f.path} has no cases list before or after the change`)]);
  const keys = (o: Record<string, unknown>): string => JSON.stringify(Object.keys(o).sort().map((k) => (k === 'cases' ? k : [k, o[k]])));
  if (keys(b) !== keys(h)) return fail([reason('tighten.case-header', f, `${f.path} changes more than its cases list`)]);
  const added: unknown[] = [];
  let k = 0;
  for (const row of hRows as unknown[]) {
    if (k < bRows.length && JSON.stringify(row) === JSON.stringify(bRows[k])) k++;
    else added.push(row);
  }
  if (k !== bRows.length || added.length !== rowLines) return fail([reason('tighten.case-reordered', f, `${f.path}: the old rows are not all kept in order, or the added lines are not exactly the new rows`)]);
  const name = f.path.slice('cases/'.length);
  const loaded = loadCasesFrom({ name: 'the changed case table', list: () => [name], read: (x: string) => (x === name ? rb.value.head : null) });
  if (!loaded.ok) return fail([reason('tighten.case-invalid', f, `${f.path} no longer loads as a case table: ${loaded.error}`)]);
  if (loaded.value.guardFiles.length !== 1) return fail([reason('tighten.case-invalid', f, `${f.path} is not a guard case table`)]);
  const allow = added.filter((r) => typeof r !== 'object' || r === null || ((r as Record<string, unknown>)['expect'] !== 'ask' && (r as Record<string, unknown>)['expect'] !== 'deny'));
  if (allow.length > 0) return fail([reason('tighten.case-allow', f, `${f.path} adds ${allow.length} row${allow.length === 1 ? '' : 's'} not expecting ask or deny (an allow row can pin a hole open)`)]);
  const scan = scanAdded(f);
  if (scan.length > 0) return fail(scan);
  return { ok: true, rows: added.length };
}

/**
 * A1 for the root bylaws file: both versions valid, nothing looser by the one compare walk (`loosenings`), no
 * user-level-only setting changed, the `merge` section (the class definition) unchanged, and the added text clean.
 */
export function checkBylaws(f: FileDiff, base: BaseReader): { ok: true } | { ok: false; reasons: Reason[] } {
  const fail = (rs: Reason[]): { ok: false; reasons: Reason[] } => ({ ok: false, reasons: rs });
  if (!isRootBylaws(f.path)) return fail([reason('tighten.not-bylaws', f, `${f.path} is not the root bylaws file`)]);
  const rb = rebuild(f, base);
  if (!rb.ok) return fail([rb.reason]);
  const b = parseBylaws(rb.value.base, `base ${f.path}`, DEFAULT_BYLAWS, true);
  const h = parseBylaws(rb.value.head, `head ${f.path}`, DEFAULT_BYLAWS, true);
  if (!b.ok) return fail([reason('tighten.bylaws-invalid', f, `the base ${f.path} is invalid: ${b.error}`)]);
  if (!h.ok) return fail([reason('tighten.bylaws-invalid', f, `the changed ${f.path} is invalid: ${h.error}`)]);
  const loose = loosenings(h.bylaws, b.bylaws);
  if (loose.length > 0) return fail([reason('tighten.bylaws-looser', f, `${f.path} loosens ${[...new Set(loose.map((l) => l.field))].slice(0, 4).join(', ')}`)]);
  const same = (x: unknown, y: unknown): boolean => JSON.stringify(x ?? null) === JSON.stringify(y ?? null);
  const hb = h.bylaws;
  const bb = b.bylaws;
  if (!same(hb.reviewer, bb.reviewer) || !same(hb.guards.inbound.notify, bb.guards.inbound.notify) || !same(hb.guards.inbound.judge, bb.guards.inbound.judge) || !same(hb.guards.budget.prices, bb.guards.budget.prices)) {
    return fail([reason('tighten.bylaws-user-only', f, `${f.path} changes a setting only the user-level file decides (reviewer, inbound notify or judge, prices)`)]);
  }
  if (!same(hb.merge, bb.merge)) return fail([reason('tighten.bylaws-merge', f, `${f.path} changes the merge section, which defines what may merge unread`)]);
  const scan = scanAdded(f);
  if (scan.length > 0) return fail(scan);
  return { ok: true };
}
