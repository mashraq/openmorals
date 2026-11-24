import { resolve } from 'node:path';
import { loadBylaws } from '../bylaws.js';
import type { Guard } from '../guard.js';
import { loadCases } from './cases.js';
import { formatEvalJson, formatEvalText } from './report.js';
import type { EvalReport } from './score.js';
import { scoreCases } from './score.js';

export * from './cases.js';
export * from './score.js';
export * from './report.js';

/** Exit codes of `openmorals eval`: every row matched, a row is wrong, the input could not be read (fail closed, ADR 0005). */
export const EVAL_EXIT = { ok: 0, wrong: 1, unreadable: 2 } as const;

export interface EvalCommandOptions {
  cases?: string;
  bylaws?: string;
  guard?: string;
  json?: boolean;
  guards?: readonly Guard[];
  repetitions?: number;
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
  return { exitCode: report.ok ? EVAL_EXIT.ok : EVAL_EXIT.wrong, stdout: opts.json === true ? formatEvalJson(report) : formatEvalText(report), stderr: '', report };
}
