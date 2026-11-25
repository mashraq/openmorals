import { dirname } from 'node:path';
import { findBylaws } from '../bylaws.js';
import { list } from './shell.js';

/** Where a session's trash notice stands (0.21.0): since when it counts, and how many moves it last told the person about. */
export interface TrashNote {
  since: string;
  count: number;
}

export function parseTrashNote(v: unknown): TrashNote | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const since = o['since'];
  const count = o['count'];
  if (typeof since !== 'string' || Number.isNaN(Date.parse(since)) || typeof count !== 'number' || !Number.isInteger(count) || count < 0) return undefined;
  return { since, count };
}

/**
 * The line for the person at their next message (0.21.0): how many items were moved into this project's trash since the
 * session's first message, once per new count. The first message only starts the count. Reads the undo log, writes
 * nothing; a project the trash cannot use (no log, the home folder) gives no line.
 */
export function trashNotice(cwd: string, note: TrashNote | undefined, now: Date = new Date()): { line: string | null; note: TrashNote } {
  if (note === undefined) return { line: null, note: { since: now.toISOString(), count: 0 } };
  const found = findBylaws(cwd);
  const r = list({ root: found !== null ? dirname(found) : cwd, all: true });
  if (!r.ok) return { line: null, note };
  const since = Date.parse(note.since);
  const n = r.value.items.filter((it) => it.state !== 'aborted' && Date.parse(it.time) >= since).length;
  if (n <= note.count) return { line: null, note };
  const line = `openmorals: ${n} item${n === 1 ? '' : 's'} moved to this project's trash since this session began; nothing is deleted until you purge (openmorals trash --list).`;
  return { line, note: { since: note.since, count: n } };
}
