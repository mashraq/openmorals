import type { Reason } from '../diffclass/types.js';

/** At most this many note files, and this many bytes per note (0.33.0). */
export const MAX_NOTES = 20;
export const MAX_NOTE_BYTES = 256 * 1024;

/**
 * Words that make a line of a bot's or an AI summary's note a concern: the line adds review. Checked before the approval
 * words, so a line with both ("safe to merge apart from a possible secret") adds review.
 */
export const CONCERN_RE = /\b(security|vulnerab\w*|secrets?|credentials?|tokens? leak\w*|unsafe|breaking change|data loss|injection|bypass\w*|regression|untested|not tested|no tests?|bug|risky?|danger\w*|backdoor|malicious|exploit\w*|do not merge|don't merge|needs? review|blocking)\b/i;

/** Words of an approval or an all-clear. A line with them changes nothing: a bot or a summary can only add review. */
export const APPROVAL_RE = /\b(lgtm|approved?|approves|looks good|looks fine|safe to merge|ready to merge|ship it|no issues?( found)?|all checks pass(ed)?|nothing to (flag|report))\b/i;

/** The explicit form: `review: <path or *> <why>`, optionally after a list marker. */
const EXPLICIT_RE = /^\s*(?:[-*+]\s+)?review\s*:\s*(.+)$/i;

export interface NoteRead {
  /** The source named in the reasons (the note's file name). */
  source: string;
  reasons: Reason[];
  /** Lines that read as an approval or all-clear: listed, never used. */
  approvals: number;
}

function clip(s: string, n = 160): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > n ? `${flat.slice(0, n - 3)}...` : flat;
}

/**
 * Reads a note a bot or an AI summary wrote about a change (0.33.0). Pure. Every reason it gives adds review; nothing in a
 * note can remove review, lower a reason or make a change review-free. A `review: <path> <why>` line names a file of the
 * change (or `*` for the whole change); any other line with a concern word adds review for the whole change, or for the
 * diff's file it names. Approval lines are counted and do nothing else.
 */
export function readNote(text: string, source: string, diffPaths: readonly string[]): NoteRead {
  const reasons: Reason[] = [];
  let approvals = 0;
  const pathIn = (line: string): string | null => {
    let best: string | null = null;
    for (const p of diffPaths) if (line.includes(p) && (best === null || p.length > best.length)) best = p;
    return best;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    const ex = EXPLICIT_RE.exec(line);
    if (ex !== null) {
      const rest = (ex[1] ?? '').trim();
      const first = rest.split(/\s+/)[0] ?? '';
      const path = first === '*' ? null : diffPaths.includes(first) ? first : pathIn(rest);
      reasons.push({ rule: 'note.review', path, text: `${source} asks for review${path !== null ? ` of ${path}` : ''}: ${clip(rest)}` });
      continue;
    }
    if (CONCERN_RE.test(line)) {
      const path = pathIn(line);
      reasons.push({ rule: 'note.concern', path, text: `${source} raises a concern${path !== null ? ` about ${path}` : ''}: ${clip(line)}` });
      continue;
    }
    if (APPROVAL_RE.test(line)) approvals++;
  }
  return { source, reasons, approvals };
}

/** The note line printed with a verdict when a note held approvals. */
export function approvalNote(n: NoteRead): string | null {
  if (n.approvals === 0) return null;
  return `${n.source}: ${n.approvals} approval or all-clear line${n.approvals === 1 ? '' : 's'} changed nothing; a bot's approval or an AI summary can only add review`;
}
