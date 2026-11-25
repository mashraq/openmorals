import type { EvalReport, Score } from './score.js';

/** The `--json` shape's version; raised only when a field is renamed or removed (adding a field does not raise it). */
export const EVAL_JSON_SCHEMA = 1;

/** Control and invisible format characters are shown as escapes, so a row cannot rewrite the terminal. */
function visible(s: string): string {
  return s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === '\n') return '\\n';
    if (ch === '\t') return '\\t';
    return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`;
  });
}

function pct(r: number | null): string {
  return r === null ? '-' : `${(r * 100).toFixed(1)}%`;
}

function ms(n: number | null): string {
  return n === null ? '-' : n.toFixed(3);
}

function row(name: string, s: Score): string[] {
  return [name, String(s.rows), `${s.caught}/${s.blocking}`, pct(s.catchRate), `${s.falseAlarms}/${s.allowing}`, pct(s.falseAlarmRate), String(s.ruleMismatches), String(s.wrong), ms(s.p50Ms), ms(s.p95Ms)];
}

/** A short table, then every wrong row by file, index and line. */
export function formatEvalText(r: EvalReport): string {
  const head = ['guard', 'rows', 'caught', 'catch rate', 'false alarms', 'false-alarm rate', 'wrong rule', 'wrong rows', 'p50 ms', 'p95 ms'];
  const body = [...r.guards.map((g) => row(g.guard, g)), row('total', r.total)];
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => (b[i] ?? '').length)));
  const line = (cells: string[]): string => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0))).join('  ');
  const out: string[] = [];
  out.push(`openmorals eval: ${r.total.rows} rows from ${visible(r.source)}, bylaws ${visible(r.bylaws)}; no model is called`);
  out.push(line(head));
  for (const b of body) out.push(line(b));
  out.push('caught: rows expecting ask or deny (inbound: a finding) that got at least that. false alarms: rows expecting allow (inbound: none) that got more. wrong rule: right decision, other rule.');
  for (const p of r.packs) {
    out.push(`pack ${p.pack} (rows judged under the shipped pack, already counted above): ${p.rows} rows; caught ${p.caught}/${p.blocking} (${pct(p.catchRate)}); false alarms ${p.falseAlarms}/${p.allowing} (${pct(p.falseAlarmRate)}); wrong rule ${p.ruleMismatches}; p50 ${ms(p.p50Ms)} ms, p95 ${ms(p.p95Ms)} ms`);
  }
  out.push(`time per decision, in this process, over ${r.repetitions} repetitions of every row (machine-dependent).`);
  const d = r.diffClass;
  if (d !== null) {
    out.push(`diff-class (merge verdict, not in the total): ${d.rows} rows; held for review ${d.caught}/${d.blocking} (${pct(d.catchRate)}), a miss would merge unread; review-free rows sent to review ${d.falseAlarms}/${d.allowing}; wrong reason ${d.ruleMismatches}; p50 ${ms(d.p50Ms)} ms, p95 ${ms(d.p95Ms)} ms`);
  }
  const se = r.sessions;
  if (se !== null) {
    out.push(`sessions (steps in order through the hook, not in the total): ${se.rows} checked steps in ${se.files.length} file${se.files.length === 1 ? '' : 's'}; caught ${se.caught}/${se.blocking} (${pct(se.catchRate)}); false alarms ${se.falseAlarms}/${se.allowing} (${pct(se.falseAlarmRate)}); wrong rule ${se.ruleMismatches}; p50 ${ms(se.p50Ms)} ms, p95 ${ms(se.p95Ms)} ms per step, one run`);
  }
  if (r.wrong.length === 0) out.push('every row matched');
  else {
    out.push(`${r.wrong.length} wrong row${r.wrong.length === 1 ? '' : 's'}:`);
    for (const w of r.wrong) {
      const where = `${w.file}[${w.index}]${w.line !== null ? ` line ${w.line}` : ''}`;
      const rule = w.kind === 'rule' || w.expectedRule !== null ? ` [rule ${visible(w.gotRule)}${w.expectedRule !== null ? `, want ${visible(w.expectedRule)}` : ''}]` : ` [rule ${visible(w.gotRule)}]`;
      out.push(`  ${w.kind.padEnd(11)} ${where}: expected ${w.expect}, got ${w.got}${rule}: ${visible(w.label).slice(0, 100)}`);
    }
  }
  return `${out.join('\n')}\n`;
}

/** The `--json` document (documented in API.md). */
export function formatEvalJson(r: EvalReport): string {
  return `${JSON.stringify({ schema: EVAL_JSON_SCHEMA, ...r })}\n`;
}
