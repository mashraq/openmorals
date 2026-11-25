import { closeSync, fstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Token counts from Claude Code's own session logs (0.36.0, ADR 0015). Claude Code does not pass token usage to hooks,
 * but it writes each model reply, with its usage, to the session's transcript (the `transcript_path` every hook gets)
 * and each sub-agent's to `<session>/subagents/agent-<id>.jsonl` beside it. openmorals reads only the numbers: it parses
 * the lines that carry a usage object and keeps, per file, how far it has read and the totals. No text of the
 * conversation is kept, logged or sent anywhere.
 *
 * The transcript format is Claude Code's own and not a documented interface, so every step fails soft: a line that does
 * not parse, a usage object without numbers or a file that cannot be read counts nothing (the tool-call count still runs).
 * One reply is written as several lines with the same message id and the same usage; each id is counted once.
 */

/** What is counted per file. `t`: input, output and cache-write tokens, the ones a budget limits. `r`: cache reads, shown apart. */
export interface TranscriptFile {
  /** Bytes read so far (up to the last whole line). */
  off: number;
  t: number;
  r: number;
  /** The last message ids counted and the tokens counted for each, so a reply split across two reads is counted once. */
  ids?: readonly { id: string; t: number; r: number }[];
}

export interface TranscriptMemory {
  /** By file name (the session file, or `agent-<id>.jsonl` for a sub-agent). */
  files: Readonly<Record<string, TranscriptFile>>;
  /** The total at the last judged call; the budget asks when a soft step is passed between two judged calls. */
  prev: number;
}

/** The most bytes of one file read at one hook call; a longer backlog is read over the next calls. */
export const MAX_READ_PER_CALL = 8 * 1024 * 1024;
/** The most sub-agent files followed per session. */
export const MAX_FILES = 256;
const IDS_KEEP = 8;
const SUB_FILE = /^agent-[A-Za-z0-9_-]{1,128}\.jsonl$/;

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

/** The counted tokens of one transcript line, or null when it is not a model reply with usage. */
export function lineUsage(line: string): { id: string; t: number; r: number } | null {
  if (!line.includes('"usage"')) return null;
  let d: unknown;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof d !== 'object' || d === null) return null;
  const o = d as Record<string, unknown>;
  if (o['type'] !== 'assistant') return null;
  const m = o['message'];
  if (typeof m !== 'object' || m === null) return null;
  const msg = m as Record<string, unknown>;
  const u = msg['usage'];
  if (typeof u !== 'object' || u === null) return null;
  const usage = u as Record<string, unknown>;
  const id = typeof msg['id'] === 'string' ? (msg['id'] as string).slice(0, 128) : typeof o['uuid'] === 'string' ? (o['uuid'] as string).slice(0, 128) : null;
  if (id === null) return null;
  return { id, t: num(usage['input_tokens']) + num(usage['output_tokens']) + num(usage['cache_creation_input_tokens']), r: num(usage['cache_read_input_tokens']) };
}

/** Counts the whole lines of `text` into `f`. A repeated id adds only what it reports beyond what was already counted for it. */
export function countLines(text: string, f: TranscriptFile): TranscriptFile {
  let t = f.t;
  let r = f.r;
  const ids = (f.ids ?? []).map((x) => ({ ...x }));
  for (const line of text.split('\n')) {
    const u = lineUsage(line);
    if (u === null) continue;
    const seen = ids.find((x) => x.id === u.id);
    if (seen !== undefined) {
      t += Math.max(0, u.t - seen.t);
      r += Math.max(0, u.r - seen.r);
      seen.t = Math.max(seen.t, u.t);
      seen.r = Math.max(seen.r, u.r);
      continue;
    }
    t += u.t;
    r += u.r;
    ids.push({ id: u.id, t: u.t, r: u.r });
    if (ids.length > IDS_KEEP) ids.shift();
  }
  return { off: f.off, t, r, ids };
}

/** Reads what was added to one file since `f.off`, up to the last whole line. Null when the file cannot be read. */
function readFile(path: string, f: TranscriptFile | undefined): TranscriptFile | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    // A file shorter than what was read was rewritten: count it again from the start.
    let cur: TranscriptFile = f === undefined || st.size < f.off ? { off: 0, t: 0, r: 0 } : f;
    const want = Math.min(st.size - cur.off, MAX_READ_PER_CALL);
    if (want <= 0) return cur;
    const buf = Buffer.alloc(want);
    let got = 0;
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, cur.off + got);
      if (n <= 0) break;
      got += n;
    }
    const nl = buf.lastIndexOf(0x0a, got - 1);
    if (nl < 0) {
      // No whole line yet. A single line longer than the read window is skipped so the read can move on.
      return got === MAX_READ_PER_CALL ? { ...cur, off: cur.off + got } : cur;
    }
    cur = countLines(buf.subarray(0, nl).toString('utf8'), cur);
    return { ...cur, off: cur.off + nl + 1 };
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Nothing to do.
    }
  }
}

/** The session's transcript and its sub-agents' files, from the `transcript_path` of any hook in the session. */
export function transcriptFiles(transcriptPath: string): { main: string; subDir: string } | null {
  if (!transcriptPath.endsWith('.jsonl')) return null;
  const dir = dirname(transcriptPath);
  if (basename(dir) === 'subagents') return { main: `${dirname(dir)}.jsonl`, subDir: dir };
  return { main: transcriptPath, subDir: join(transcriptPath.slice(0, -'.jsonl'.length), 'subagents') };
}

/** Totals over every file. */
export function transcriptTotals(m: TranscriptMemory | undefined): { tokens: number; cacheRead: number; files: number } {
  let tokens = 0;
  let cacheRead = 0;
  let files = 0;
  for (const f of Object.values(m?.files ?? {})) {
    tokens += f.t;
    cacheRead += f.r;
    files++;
  }
  return { tokens, cacheRead, files };
}

/** Reads what the session's files gained since the last call. Fails soft: what cannot be read keeps its last counts. */
export function readTranscripts(transcriptPath: string, before: TranscriptMemory | undefined): TranscriptMemory {
  const where = transcriptFiles(transcriptPath);
  const files: Record<string, TranscriptFile> = { ...(before?.files ?? {}) };
  const prev = before?.prev ?? 0;
  if (where === null) return { files, prev };
  const mainName = basename(where.main);
  const main = readFile(where.main, files[mainName]);
  if (main !== null) files[mainName] = main;
  let subs: string[] = [];
  try {
    subs = readdirSync(where.subDir).filter((n) => SUB_FILE.test(n)).sort();
  } catch {
    subs = [];
  }
  for (const name of subs) {
    if (files[name] === undefined && Object.keys(files).length >= MAX_FILES) break;
    const f = readFile(join(where.subDir, name), files[name]);
    if (f !== null) files[name] = f;
  }
  return { files, prev };
}

/** Parses the saved form; anything malformed is dropped (counted again from the start, which can only raise the count). */
export function parseTranscriptMemory(v: unknown): TranscriptMemory | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const fo = o['files'];
  const files: Record<string, TranscriptFile> = {};
  if (typeof fo === 'object' && fo !== null && !Array.isArray(fo)) {
    for (const [k, raw] of Object.entries(fo as Record<string, unknown>).slice(0, MAX_FILES + 1)) {
      if (typeof raw !== 'object' || raw === null) continue;
      const f = raw as Record<string, unknown>;
      const ids = Array.isArray(f['ids']) ? (f['ids'] as unknown[]).filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null && typeof (x as { id?: unknown }).id === 'string').slice(-IDS_KEEP) : [];
      files[k.slice(0, 160)] = { off: num(f['off']), t: num(f['t']), r: num(f['r']), ids: ids.map((x) => ({ id: String(x['id']).slice(0, 128), t: num(x['t']), r: num(x['r']) })) };
    }
  }
  return { files, prev: num(o['prev']) };
}

/** Two writers of one session: per file, the one that read further has counted more. The baseline keeps the larger. */
export function mergeTranscriptMemory(disk: TranscriptMemory | undefined, ours: TranscriptMemory | undefined): TranscriptMemory | undefined {
  if (disk === undefined) return ours;
  if (ours === undefined) return disk;
  const files: Record<string, TranscriptFile> = { ...disk.files };
  for (const [k, f] of Object.entries(ours.files)) {
    const d = files[k];
    if (d === undefined || f.off > d.off) files[k] = f;
  }
  return { files, prev: Math.max(disk.prev, ours.prev) };
}
