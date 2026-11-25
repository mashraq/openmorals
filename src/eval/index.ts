import { resolve } from 'node:path';
import { loadBylaws } from '../bylaws.js';
import type { Guard } from '../guard.js';
import { loadCases } from './cases.js';
import type { OfficeEvalScore } from './office.js';
import { formatOfficeText } from './office.js';
import { EVAL_JSON_SCHEMA, formatEvalJson, formatEvalText } from './report.js';
import type { EvalReport } from './score.js';
import { scoreCases } from './score.js';

export * from './cases.js';
export * from './score.js';
export * from './report.js';
export * from './office.js';

/** Exit codes of `openmorals eval`: every row matched, a row is wrong, the input could not be read (fail closed, ADR 0005). */
export const EVAL_EXIT = { ok: 0, wrong: 1, unreadable: 2 } as const;

export interface EvalCommandOptions {
  cases?: string;
  bylaws?: string;
  guard?: string;
  json?: boolean;
  guards?: readonly Guard[];
  repetitions?: number;
  /**
   * The office before-after rows (0.30.0), scored by the caller with `office/eval.js` (the CLI loads it only for eval, so
   * no hook process loads the office readers). Shown apart from the total; a wrong office row makes eval exit 1.
   */
  office?: OfficeEvalScore | null;
}

export interface EvalCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  report: EvalReport | null;
}

/** The whole `openmorals eval` command without the process: load, score, format. Calls no model and writes nothing. */
export function runEval(opts: EvalCommandOptions = {}): EvalCommandResult {
  const unreadable = (msg: string): EvalCommandResult => ({ exitCode: EVAL_EXIT.unreadable, stdout: '', stderr: `openmorals eval: ${msg}; nothing was scored\n`, report: null });
  const office = opts.office ?? null;
  if (opts.guard === 'office') {
    if (office === null) return unreadable('the office rows were not scored');
    const ok = office.wrong.length === 0;
    const text = `${formatOfficeText(office).join('\n')}\n${ok ? 'every row matched' : `${office.wrong.length} wrong office row${office.wrong.length === 1 ? '' : 's'}`}\n`;
    return { exitCode: ok ? EVAL_EXIT.ok : EVAL_EXIT.wrong, stdout: opts.json === true ? `${JSON.stringify({ schema: EVAL_JSON_SCHEMA, office })}\n` : text, stderr: '', report: null };
  }
  const loaded = loadCases(opts.cases === undefined ? undefined : resolve(opts.cases));
  if (!loaded.ok) return unreadable(loaded.error);
  let bylaws;
  if (opts.bylaws !== undefined) {
    bylaws = loadBylaws(resolve(opts.bylaws));
    if (!bylaws.ok) return unreadable(`the bylaws file ${bylaws.source} is invalid or unreadable: ${bylaws.error}`);
  }
  const scored = scoreCases(loaded.value, {
    ...(opts.guards !== undefined ? { guards: opts.guards } : {}),
    ...(bylaws !== undefined ? { bylaws } : {}),
    ...(opts.guard !== undefined ? { guard: opts.guard } : {}),
    ...(opts.repetitions !== undefined ? { repetitions: opts.repetitions } : {}),
  });
  if (!scored.ok) return unreadable(scored.error);
  const report = scored.value;
  if (office === null) return { exitCode: report.ok ? EVAL_EXIT.ok : EVAL_EXIT.wrong, stdout: opts.json === true ? formatEvalJson(report) : formatEvalText(report), stderr: '', report };
  const ok = report.ok && office.wrong.length === 0;
  let text = formatEvalText(report);
  const lines = text.trimEnd().split('\n');
  const at = lines.findIndex((l) => l === 'every row matched' || /^\d+ wrong rows?:$/.test(l));
  lines.splice(at === -1 ? lines.length : at, 0, ...formatOfficeText(office));
  if (report.ok && !ok) lines[lines.length - 1] = `${office.wrong.length} wrong office row${office.wrong.length === 1 ? '' : 's'} (listed above)`;
  text = `${lines.join('\n')}\n`;
  return { exitCode: ok ? EVAL_EXIT.ok : EVAL_EXIT.wrong, stdout: opts.json === true ? `${JSON.stringify({ schema: EVAL_JSON_SCHEMA, ...report, ok, office })}\n` : text, stderr: '', report };
}
