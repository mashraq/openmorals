import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadBylaws, validateBylaws } from '../bylaws.js';
import type { Guard } from '../guard.js';
import { loadCases } from './cases.js';
import type { OfficeEvalScore } from './office.js';
import { formatOfficeText } from './office.js';
import { EVAL_JSON_SCHEMA, formatEvalJson, formatEvalText } from './report.js';
import type { EvalReport } from './score.js';
import { scoreCases } from './score.js';
import type { Rescore, SavedScore, SkillFolder } from './rescore.js';
import { MAX_SCORE_FILE_BYTES, compareScores, fingerprint, formatRescoreText, parseSavedScore, toSavedScore } from './rescore.js';

export * from './cases.js';
export * from './score.js';
export * from './report.js';
export * from './office.js';
export * from './sessions.js';
export * from './rescore.js';

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
  /** Write every row's outcome and the fingerprint to this file (0.34.0). */
  save?: string;
  /** Compare with a score saved earlier and exit 1 when anything moved (0.34.0). */
  since?: string;
  /** The model the agent runs on, for the fingerprint (0.34.0); null or absent when none is given. */
  model?: string | null;
  /** The skill folders for the fingerprint (0.34.0); none when absent. */
  skills?: readonly SkillFolder[];
  now?: Date;
}

export interface EvalCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  report: EvalReport | null;
  /** With `since`: what moved since the saved score. */
  rescore?: Rescore;
}

/** The eval text with the office lines put in before the closing line. */
function withOffice(report: EvalReport, office: OfficeEvalScore): string {
  const ok = report.ok && office.wrong.length === 0;
  const lines = formatEvalText(report).trimEnd().split('\n');
  const at = lines.findIndex((l) => l === 'every row matched' || /^\d+ wrong rows?:$/.test(l));
  lines.splice(at === -1 ? lines.length : at, 0, ...formatOfficeText(office));
  if (report.ok && !ok) lines[lines.length - 1] = `${office.wrong.length} wrong office row${office.wrong.length === 1 ? '' : 's'} (listed above)`;
  return `${lines.join('\n')}\n`;
}

/** The whole `openmorals eval` command without the process: load, score, format. Calls no model; writes only the `save` file and the session rows' temporary folders, which it removes. */
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
    ...(opts.save !== undefined || opts.since !== undefined ? { record: true } : {}),
  });
  if (!scored.ok) return unreadable(scored.error);
  const report = scored.value;
  if (opts.save !== undefined || opts.since !== undefined) {
    let saved: SavedScore | null = null;
    if (opts.since !== undefined) {
      const file = resolve(opts.since);
      let text: string;
      try {
        if (statSync(file).size > MAX_SCORE_FILE_BYTES) return unreadable(`the saved score ${opts.since} is larger than ${MAX_SCORE_FILE_BYTES} bytes`);
        text = readFileSync(file, 'utf8');
      } catch (e: unknown) {
        return unreadable(`cannot read the saved score ${opts.since}: ${e instanceof Error ? e.message : String(e)}`);
      }
      const p = parseSavedScore(text);
      if (!p.ok) return unreadable(`the saved score ${opts.since} is unreadable: ${p.error}`);
      if (p.value.guard !== (opts.guard ?? null)) return unreadable(`the saved score ${opts.since} was taken ${p.value.guard === null ? 'on every row' : `with --guard ${p.value.guard}`}; score the same way to compare`);
      saved = p.value;
    }
    const fp = fingerprint({ casesDigest: loaded.value.digest ?? '', bylaws: bylaws ?? validateBylaws(null, '<defaults>'), model: opts.model ?? null, skills: opts.skills ?? [] });
    const now = toSavedScore(report, fp, opts.guard ?? null, opts.now);
    const rescore = saved !== null ? compareScores(saved, now) : undefined;
    let saveError = '';
    if (opts.save !== undefined) {
      const file = resolve(opts.save);
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, `${JSON.stringify(now, null, 1)}\n`);
        renameSync(tmp, file);
      } catch (e: unknown) {
        try {
          rmSync(tmp, { force: true });
        } catch {
          // nothing to clean
        }
        saveError = `openmorals eval: cannot save the score to ${opts.save}: ${e instanceof Error ? e.message : String(e)}\n`;
      }
    }
    const moved = rescore?.moved === true;
    const ok = report.ok && !moved && (office === null || office.wrong.length === 0);
    const base = office === null ? formatEvalText(report) : withOffice(report, office);
    const tail = [...(rescore !== undefined ? formatRescoreText(rescore) : []), ...(opts.save !== undefined && saveError === '' ? [`score saved to ${opts.save} (${Object.keys(now.rows).length} rows)`] : [])];
    const text = `${base}${tail.map((l) => `${l}\n`).join('')}`;
    const json = `${JSON.stringify({ schema: EVAL_JSON_SCHEMA, ...report, ok, ...(office !== null ? { office } : {}), fingerprint: fp, ...(rescore !== undefined ? { rescore } : {}) })}\n`;
    return { exitCode: saveError !== '' ? EVAL_EXIT.unreadable : ok ? EVAL_EXIT.ok : EVAL_EXIT.wrong, stdout: opts.json === true ? json : text, stderr: saveError, report, ...(rescore !== undefined ? { rescore } : {}) };
  }
  if (office === null) return { exitCode: report.ok ? EVAL_EXIT.ok : EVAL_EXIT.wrong, stdout: opts.json === true ? formatEvalJson(report) : formatEvalText(report), stderr: '', report };
  const ok = report.ok && office.wrong.length === 0;
  const text = withOffice(report, office);
  return { exitCode: ok ? EVAL_EXIT.ok : EVAL_EXIT.wrong, stdout: opts.json === true ? `${JSON.stringify({ schema: EVAL_JSON_SCHEMA, ...report, ok, office })}\n` : text, stderr: '', report };
}
