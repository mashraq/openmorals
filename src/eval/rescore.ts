import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PACK_NAMES, readPackText } from '../packs/load.js';
import type { BylawsLoad } from '../types.js';
import { decisionRank, isDecision } from '../types.js';
import { VERSION } from '../version.js';
import type { EvalReport, RowDecision } from './score.js';

/**
 * Rescoring (0.34.0). `openmorals eval --save FILE` keeps every row's outcome with a fingerprint of what the score was
 * taken on; `openmorals eval --since FILE` scores again and lists what moved: the fingerprint parts that changed (the
 * openmorals version, the rows, the bylaws, a shipped pack, an agent skill, the model) and every row whose outcome
 * changed, looser ones first. Anything that moved makes the exit code 1, so a pack, skill or model change cannot pass a
 * gate on an old score: someone reads the new one and saves it again.
 */

/** The saved file's version; raised only when a field is renamed or removed. */
export const SCORE_FILE_SCHEMA = 1;

/** Skills read per folder, files read per skill, and bytes read per file (a larger file counts by its size). */
export const MAX_SKILLS = 500;
export const MAX_SKILL_FILES = 200;
export const MAX_SKILL_FILE_BYTES = 1024 * 1024;
/** The saved file is refused above this size. */
export const MAX_SCORE_FILE_BYTES = 32 * 1024 * 1024;

export interface Fingerprint {
  openmorals: string;
  /** sha256 over the case files' names and texts. */
  cases: string;
  /** sha256 of the bylaws the rows without their own bylaws were judged under, as read. */
  bylaws: string;
  /** Each shipped pack's sha256, by name; a pack that cannot be read is `unreadable`. */
  packs: Record<string, string>;
  /** Each agent skill's sha256 (every file of its folder), by `<where>/<skill>`. */
  skills: Record<string, string>;
  /** The model the agent runs on, as given (`--model`, else ANTHROPIC_MODEL), or null when none was given. */
  model: string | null;
}

export interface SavedRow {
  kind: RowDecision['kind'];
  decision: string;
  rule: string;
}

export interface SavedScore {
  schema: number;
  saved: string;
  /** The `--guard` the score was taken with, or null for every row: a score is compared only with one taken the same way. */
  guard: string | null;
  fingerprint: Fingerprint;
  total: { rows: number; caught: number; blocking: number; falseAlarms: number; allowing: number; wrong: number };
  rows: Record<string, SavedRow>;
}

export interface SkillFolder {
  /** A short name for where the skills are (`project`, `user`). */
  where: string;
  dir: string;
}

function sha(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Every file under a folder, as sorted relative paths; links are not followed; stops after `max` files. */
function listFiles(dir: string, max: number): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string): void => {
    if (out.length >= max) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (out.length >= max) return;
      const r = rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk(dir, '');
  return out;
}

/** One sha256 per skill folder (`<where>/<name>`): over each file's path and text. A missing folder gives no entries. */
export function skillDigests(folders: readonly SkillFolder[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of folders) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(f.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const skills = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().slice(0, MAX_SKILLS);
    for (const name of skills) {
      const root = path.join(f.dir, name);
      const h = createHash('sha256');
      for (const rel of listFiles(root, MAX_SKILL_FILES)) {
        h.update(`${rel}\0`);
        try {
          const st = fs.statSync(path.join(root, rel));
          h.update(st.size > MAX_SKILL_FILE_BYTES ? `size:${st.size}` : fs.readFileSync(path.join(root, rel)));
        } catch {
          h.update('unreadable');
        }
        h.update('\0');
      }
      out[`${f.where}/${name}`] = h.digest('hex');
    }
  }
  return out;
}

/** Each shipped pack's sha256 by name. */
export function packDigests(dir?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PACK_NAMES) {
    const p = readPackText(name, dir);
    out[name] = p.ok ? sha(p.text) : 'unreadable';
  }
  return out;
}

export interface FingerprintInput {
  casesDigest: string;
  bylaws: BylawsLoad;
  model: string | null;
  skills: readonly SkillFolder[];
  packsDir?: string;
}

export function fingerprint(i: FingerprintInput): Fingerprint {
  const bylaws = i.bylaws.ok ? sha(JSON.stringify(i.bylaws.bylaws)) : 'invalid';
  return { openmorals: VERSION, cases: i.casesDigest, bylaws, packs: packDigests(i.packsDir), skills: skillDigests(i.skills), model: i.model };
}

export function toSavedScore(report: EvalReport, fp: Fingerprint, guard: string | null = null, now: Date = new Date()): SavedScore {
  const rows: Record<string, SavedRow> = {};
  for (const d of report.decisions ?? []) rows[d.key] = { kind: d.kind, decision: d.decision, rule: d.rule };
  const t = report.total;
  const extra = [report.diffClass, report.sessions].filter((x) => x !== null);
  const sum = (k: 'rows' | 'caught' | 'blocking' | 'falseAlarms' | 'allowing' | 'wrong'): number => t[k] + extra.reduce((n, x) => n + (x?.[k] ?? 0), 0);
  return {
    schema: SCORE_FILE_SCHEMA,
    saved: now.toISOString(),
    guard,
    fingerprint: fp,
    total: { rows: sum('rows'), caught: sum('caught'), blocking: sum('blocking'), falseAlarms: sum('falseAlarms'), allowing: sum('allowing'), wrong: sum('wrong') },
    rows,
  };
}

const KINDS: readonly string[] = ['guard', 'inbound', 'diff-class', 'session'];

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strMap(v: unknown): Record<string, string> | null {
  if (!isRec(v)) return null;
  for (const x of Object.values(v)) if (typeof x !== 'string') return null;
  return v as Record<string, string>;
}

/** Reads a saved score; anything malformed is unreadable (never "nothing changed"). */
export function parseSavedScore(text: string): { ok: true; value: SavedScore } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'it is not JSON' };
  }
  if (!isRec(raw)) return { ok: false, error: 'it is not a JSON object' };
  if (raw['schema'] !== SCORE_FILE_SCHEMA) return { ok: false, error: `its schema is ${JSON.stringify(raw['schema'])}, this version reads ${SCORE_FILE_SCHEMA}` };
  const fp = raw['fingerprint'];
  if (!isRec(fp)) return { ok: false, error: 'it has no fingerprint' };
  const packs = strMap(fp['packs']);
  const skills = strMap(fp['skills']);
  if (typeof fp['openmorals'] !== 'string' || typeof fp['cases'] !== 'string' || typeof fp['bylaws'] !== 'string' || packs === null || skills === null || !(fp['model'] === null || typeof fp['model'] === 'string')) return { ok: false, error: 'its fingerprint is incomplete' };
  const rows = raw['rows'];
  if (!isRec(rows)) return { ok: false, error: 'it has no rows' };
  const out: Record<string, SavedRow> = {};
  for (const [k, v] of Object.entries(rows)) {
    if (!isRec(v) || typeof v['kind'] !== 'string' || !KINDS.includes(v['kind']) || typeof v['decision'] !== 'string' || typeof v['rule'] !== 'string') return { ok: false, error: `its row ${JSON.stringify(k.slice(0, 120))} is malformed` };
    out[k] = { kind: v['kind'] as SavedRow['kind'], decision: v['decision'], rule: v['rule'] };
  }
  const total = raw['total'];
  const nums = ['rows', 'caught', 'blocking', 'falseAlarms', 'allowing', 'wrong'] as const;
  if (!isRec(total) || nums.some((k) => typeof total[k] !== 'number')) return { ok: false, error: 'its total is malformed' };
  return {
    ok: true,
    value: {
      schema: SCORE_FILE_SCHEMA,
      saved: typeof raw['saved'] === 'string' ? raw['saved'] : '',
      guard: typeof raw['guard'] === 'string' ? raw['guard'] : null,
      fingerprint: { openmorals: fp['openmorals'], cases: fp['cases'], bylaws: fp['bylaws'], packs, skills, model: fp['model'] as string | null },
      total: Object.fromEntries(nums.map((k) => [k, total[k] as number])) as SavedScore['total'],
      rows: out,
    },
  };
}

export type Direction = 'looser' | 'stricter' | 'rule';

export interface ChangedRow {
  key: string;
  kind: SavedRow['kind'];
  before: string;
  after: string;
  beforeRule: string;
  afterRule: string;
  direction: Direction;
}

export interface FingerprintChange {
  part: 'openmorals' | 'cases' | 'bylaws' | 'packs' | 'skills' | 'model';
  /** What moved, in words: `strict changed`, `project/deploy added`, `0.33.0 -> 0.34.0`. */
  detail: string;
}

export interface Rescore {
  saved: string;
  fingerprint: FingerprintChange[];
  changed: ChangedRow[];
  /** Rows in the new score that the saved one does not have, and the other way round. */
  added: string[];
  removed: string[];
  before: SavedScore['total'];
  after: SavedScore['total'];
  /** True when anything above moved: `eval --since` exits 1. */
  moved: boolean;
}

function rank(kind: SavedRow['kind'], d: string): number {
  if (kind === 'guard' || kind === 'session') return isDecision(d) ? decisionRank(d) : -1;
  if (kind === 'inbound') return d === 'strong' ? 2 : d === 'weak' ? 1 : 0;
  return d === 'review-free' ? 0 : 1;
}

function mapChanges(a: Record<string, string>, b: Record<string, string>): string[] {
  const out: string[] = [];
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (!(k in a)) out.push(`${k} added`);
    else if (!(k in b)) out.push(`${k} removed`);
    else if (a[k] !== b[k]) out.push(`${k} changed`);
  }
  return out;
}

/** Compares a saved score with a new one. Pure. */
export function compareScores(before: SavedScore, after: SavedScore): Rescore {
  const fa = before.fingerprint;
  const fb = after.fingerprint;
  const fp: FingerprintChange[] = [];
  if (fa.openmorals !== fb.openmorals) fp.push({ part: 'openmorals', detail: `${fa.openmorals} -> ${fb.openmorals}` });
  if (fa.cases !== fb.cases) fp.push({ part: 'cases', detail: 'the case files changed' });
  if (fa.bylaws !== fb.bylaws) fp.push({ part: 'bylaws', detail: 'the bylaws changed' });
  for (const d of mapChanges(fa.packs, fb.packs)) fp.push({ part: 'packs', detail: d });
  for (const d of mapChanges(fa.skills, fb.skills)) fp.push({ part: 'skills', detail: d });
  if (fa.model !== fb.model) fp.push({ part: 'model', detail: `${fa.model ?? '(none given)'} -> ${fb.model ?? '(none given)'}` });
  const changed: ChangedRow[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [k, n] of Object.entries(after.rows)) {
    const o = before.rows[k];
    if (o === undefined) {
      added.push(k);
      continue;
    }
    if (o.decision === n.decision && o.rule === n.rule) continue;
    const ra = rank(o.kind, o.decision);
    const rb = rank(n.kind, n.decision);
    const direction: Direction = rb < ra ? 'looser' : rb > ra ? 'stricter' : 'rule';
    changed.push({ key: k, kind: n.kind, before: o.decision, after: n.decision, beforeRule: o.rule, afterRule: n.rule, direction });
  }
  for (const k of Object.keys(before.rows)) if (!(k in after.rows)) removed.push(k);
  const order: Record<Direction, number> = { looser: 0, stricter: 1, rule: 2 };
  changed.sort((x, y) => order[x.direction] - order[y.direction] || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  added.sort();
  removed.sort();
  return { saved: before.saved, fingerprint: fp, changed, added, removed, before: before.total, after: after.total, moved: fp.length + changed.length + added.length + removed.length > 0 };
}

/** Control and invisible format characters are shown as escapes, so a row name cannot rewrite the terminal. */
function visible(s: string): string {
  return s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (ch) => `\\u${(ch.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`);
}

/** At most this many rows of each list are printed; the counts are always whole. */
export const RESCORE_SHOWN = 50;

export function formatRescoreText(r: Rescore): string[] {
  const out: string[] = [];
  const when = r.saved !== '' ? ` (saved ${visible(r.saved)})` : '';
  if (!r.moved) {
    out.push(`since the saved score${when}: nothing moved; same version, rows, bylaws, packs, skills and model, and every row decided the same`);
    return out;
  }
  const looser = r.changed.filter((c) => c.direction === 'looser').length;
  out.push(`since the saved score${when}: ${r.fingerprint.length} fingerprint change${r.fingerprint.length === 1 ? '' : 's'}, ${r.changed.length} row${r.changed.length === 1 ? '' : 's'} decided differently (${looser} looser), ${r.added.length} new, ${r.removed.length} gone; read them and save the score again`);
  for (const f of r.fingerprint) out.push(`  ${f.part}: ${visible(f.detail)}`);
  out.push(`  caught ${r.before.caught}/${r.before.blocking} -> ${r.after.caught}/${r.after.blocking}; false alarms ${r.before.falseAlarms}/${r.before.allowing} -> ${r.after.falseAlarms}/${r.after.allowing}; wrong rows ${r.before.wrong} -> ${r.after.wrong}`);
  for (const c of r.changed.slice(0, RESCORE_SHOWN)) out.push(`  ${c.direction.padEnd(8)} ${visible(c.key).slice(0, 160)}: ${c.before} [${visible(c.beforeRule)}] -> ${c.after} [${visible(c.afterRule)}]`);
  if (r.changed.length > RESCORE_SHOWN) out.push(`  ... and ${r.changed.length - RESCORE_SHOWN} more changed rows (all are in --json)`);
  for (const [name, list] of [['new', r.added], ['gone', r.removed]] as const) {
    for (const k of list.slice(0, RESCORE_SHOWN)) out.push(`  ${name.padEnd(8)} ${visible(k).slice(0, 160)}`);
    if (list.length > RESCORE_SHOWN) out.push(`  ... and ${list.length - RESCORE_SHOWN} more ${name} rows (all are in --json)`);
  }
  return out;
}
