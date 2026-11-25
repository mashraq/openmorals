/**
 * A strict reader of `git diff` output (the extended unified format). It understands exactly what git writes and
 * nothing more: any line it does not expect makes the whole input unreadable (exit 2, read as review, ADR 0005). Shapes
 * it reads but does not trust (a rename, a mode change, a binary file, a symlink, a submodule, a carriage return, a
 * quoted or unusual path) are kept as doubts on the file, and each doubt makes the file need review.
 */

export const MAX_DIFF_BYTES = 64 * 1024 * 1024;
export const MAX_DIFF_FILES = 20000;

export type HunkOp = ' ' | '-' | '+';

export interface HunkLine {
  op: HunkOp;
  text: string;
  /** Followed by `\ No newline at end of file`. */
  noEol: boolean;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** 1-based line of the `@@` header in the input. */
  line: number;
  lines: HunkLine[];
}

export type FileStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied';

/** A fact about a file that the classifier will not judge as review-free. `id` is a stable name for it. */
export interface Doubt {
  id: string;
  text: string;
}

export interface FileDiff {
  /** The path after the change (the old path for a deleted file). */
  path: string;
  oldPath: string | null;
  newPath: string | null;
  status: FileStatus;
  oldMode: string | null;
  newMode: string | null;
  oldHash: string | null;
  newHash: string | null;
  binary: boolean;
  hunks: Hunk[];
  /** 1-based line of the `diff --git` header. */
  line: number;
  doubts: Doubt[];
}

export type ParseResult = { ok: true; files: FileDiff[] } | { ok: false; error: string; line: number | null };

const C_ESCAPES: Readonly<Record<string, number>> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };

/** Reads a C-quoted path (`"a/n\303\244me"`) starting at `s[0] === '"'`. Returns the path and the rest after the closing quote. */
function unquote(s: string): { path: string; rest: string } | null {
  const bytes: number[] = [];
  let i = 1;
  while (i < s.length) {
    const ch = s[i] ?? '';
    if (ch === '"') {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(bytes));
      return { path: text, rest: s.slice(i + 1) };
    }
    if (ch === '\\') {
      const n = s[i + 1] ?? '';
      const esc = C_ESCAPES[n];
      if (esc !== undefined) {
        bytes.push(esc);
        i += 2;
        continue;
      }
      const oct = /^[0-3][0-7]{2}/.exec(s.slice(i + 1, i + 4));
      if (oct === null) return null;
      bytes.push(Number.parseInt(oct[0], 8));
      i += 4;
      continue;
    }
    const code = ch.charCodeAt(0);
    if (code > 0x7f) {
      for (const b of new TextEncoder().encode(ch)) bytes.push(b);
    } else bytes.push(code);
    i++;
  }
  return null;
}

interface Named {
  path: string;
  quoted: boolean;
}

/** A `---`/`+++`/rename path: quoted or plain, with git's trailing tab (written after a name holding a space) removed. */
function readName(s: string): Named | null {
  if (s.startsWith('"')) {
    const q = unquote(s);
    if (q === null || (q.rest !== '' && q.rest !== '\t')) return null;
    return { path: q.path, quoted: true };
  }
  const t = s.endsWith('\t') ? s.slice(0, -1) : s;
  if (t === '' || t.includes('\t')) return null;
  return { path: t, quoted: false };
}

function stripPrefix(n: Named, prefix: 'a/' | 'b/'): Named | null {
  if (!n.path.startsWith(prefix)) return null;
  return { path: n.path.slice(2), quoted: n.quoted };
}

/** The two paths of a `diff --git a/X b/Y` line. Plain paths holding spaces are split only when both halves are equal. */
function headerPaths(rest: string): { a: Named; b: Named } | { ambiguous: true } | null {
  if (rest.startsWith('"')) {
    const q = unquote(rest);
    if (q === null || !q.rest.startsWith(' ')) return null;
    const b = readName(q.rest.slice(1));
    if (b === null) return null;
    return { a: { path: q.path, quoted: true }, b };
  }
  const qb = rest.indexOf(' "b/');
  if (qb !== -1) {
    const b = readName(rest.slice(qb + 1));
    if (b === null) return null;
    return { a: { path: rest.slice(0, qb), quoted: false }, b };
  }
  if ((rest.length - 1) % 2 === 0) {
    const half = (rest.length - 1) / 2;
    const a = rest.slice(0, half);
    const b = rest.slice(half + 1);
    if (rest[half] === ' ' && a.slice(2) === b.slice(2)) return { a: { path: a, quoted: false }, b: { path: b, quoted: false } };
  }
  const parts = rest.split(' ');
  if (parts.length === 2) return { a: { path: parts[0] ?? '', quoted: false }, b: { path: parts[1] ?? '', quoted: false } };
  return { ambiguous: true };
}

const MODE = /^[0-7]{6}$/;
const HASH = /^[0-9a-f]{7,64}$/;
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
const BINARY_DATA = /^(?:(?:literal|delta) \d+|[A-Za-z][0-9A-Za-z!#$%&()*+\-;<=>?@^_`{|}~]*|)$/;

/** Path facts that make a file need review: whitespace, quoting, non-ASCII or control characters, `..`, absolute or Windows-style paths. */
export function pathDoubt(path: string, quoted: boolean): Doubt | null {
  if (quoted) return { id: 'doubt.quoted-path', text: `a path git had to quote (${JSON.stringify(path)})` };
  if (/\s/.test(path)) return { id: 'doubt.path-space', text: `a path with a space or tab (${JSON.stringify(path)})` };
  if (/[^\x21-\x7e]/.test(path)) return { id: 'doubt.path-characters', text: `a path with characters outside printable ASCII (${JSON.stringify(path)})` };
  if (path.startsWith('/') || path.includes('\\') || /(^|\/)\.\.?(\/|$)/.test(path) || path.includes('//') || path.endsWith('/')) return { id: 'doubt.path-shape', text: `a path that is absolute, uses \\, or has an empty, . or .. segment (${JSON.stringify(path)})` };
  return null;
}

function modeDoubts(f: FileDiff): Doubt[] {
  const out: Doubt[] = [];
  if (f.oldMode !== null && f.newMode !== null && f.oldMode !== f.newMode) out.push({ id: 'doubt.mode-change', text: `the file mode changes from ${f.oldMode} to ${f.newMode} (${f.path})` });
  for (const m of new Set([f.oldMode, f.newMode])) {
    if (m === null || m === '100644') continue;
    if (m === '120000') out.push({ id: 'doubt.symlink', text: `a symbolic link (${f.path})` });
    else if (m === '160000') out.push({ id: 'doubt.submodule', text: `a submodule (${f.path})` });
    else if (m === '100755') out.push({ id: 'doubt.executable', text: `an executable file, mode 100755 (${f.path})` });
    else out.push({ id: 'doubt.mode', text: `an unusual file mode ${m} (${f.path})` });
  }
  return out;
}

/** Characters that split or hide a line for YAML and other readers: a carriage return, NEL, the Unicode line and paragraph separators. */
const LINE_BREAKS = new RegExp('[\\r\\u0085\\u2028\\u2029]');
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]');

function lineDoubts(f: FileDiff): Doubt[] {
  const out: Doubt[] = [];
  let breaks = false;
  let control = false;
  for (const h of f.hunks) {
    for (const l of h.lines) {
      if (LINE_BREAKS.test(l.text)) breaks = true;
      if (l.op === '+' && CONTROL.test(l.text)) control = true;
    }
  }
  if (breaks) out.push({ id: 'doubt.line-break', text: `a carriage return (CRLF) or another line separator inside a line (${f.path})` });
  if (control) out.push({ id: 'doubt.control-character', text: `an added line with a control character (${f.path})` });
  return out;
}

function fail(error: string, line: number | null): ParseResult {
  return { ok: false, error, line };
}

/** Reads raw bytes as the diff text: at most MAX_DIFF_BYTES, valid UTF-8, no NUL byte. */
export function decodeDiff(bytes: Uint8Array): { ok: true; text: string } | { ok: false; error: string } {
  if (bytes.length > MAX_DIFF_BYTES) return { ok: false, error: `the diff is larger than ${MAX_DIFF_BYTES} bytes` };
  if (bytes.includes(0)) return { ok: false, error: 'the diff holds a NUL byte (binary data, not git diff text)' };
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, error: 'the diff is not valid UTF-8' };
  }
}

/** Parses `git diff` output. Never throws; every loop is bounded by the number of input lines. */
export function parseDiff(text: string): ParseResult {
  if (text === '') return fail('the diff is empty: no change was found, and an empty diff is also what a wrong range gives', null);
  if (!text.endsWith('\n')) return fail('the diff does not end with a newline (cut off?)', null);
  const lines = text.slice(0, -1).split('\n');
  const files: FileDiff[] = [];
  let i = 0;
  if (!(lines[0] ?? '').startsWith('diff --git ')) return fail('text before the first "diff --git" header (give the output of git diff, not of git show or git format-patch)', 1);
  while (i < lines.length) {
    const headerLine = i + 1;
    const head = lines[i] ?? '';
    if (!head.startsWith('diff --git ')) return fail(`expected a "diff --git" header, got ${JSON.stringify(head.slice(0, 80))}`, headerLine);
    if (head.endsWith('\r')) return fail('a header line ends with a carriage return (the diff has CRLF line endings)', headerLine);
    if (files.length >= MAX_DIFF_FILES) return fail(`more than ${MAX_DIFF_FILES} files`, headerLine);
    const hp = headerPaths(head.slice('diff --git '.length));
    if (hp === null) return fail('cannot read the paths of the "diff --git" header', headerLine);
    i++;
    let oldMode: string | null = null;
    let newMode: string | null = null;
    let mode: string | null = null;
    let status: FileStatus = 'modified';
    let oldHash: string | null = null;
    let newHash: string | null = null;
    let renameFrom: Named | null = null;
    let renameTo: Named | null = null;
    const quoted: Named[] = [];
    while (i < lines.length) {
      const l = lines[i] ?? '';
      if (l.startsWith('diff --git ') || l.startsWith('--- ') || l.startsWith('Binary files ') || l === 'GIT binary patch') break;
      let m: RegExpExecArray | null;
      if ((m = /^old mode (\d+)$/.exec(l)) !== null) oldMode = m[1] ?? null;
      else if ((m = /^new mode (\d+)$/.exec(l)) !== null) newMode = m[1] ?? null;
      else if ((m = /^deleted file mode (\d+)$/.exec(l)) !== null) {
        status = 'deleted';
        oldMode = m[1] ?? null;
      } else if ((m = /^new file mode (\d+)$/.exec(l)) !== null) {
        status = 'added';
        newMode = m[1] ?? null;
      } else if (/^(similarity|dissimilarity) index \d{1,3}%$/.test(l)) {
        /* scored with the rename or copy below */
      } else if ((m = /^(rename|copy) (from|to) (.+)$/.exec(l)) !== null) {
        const n = readName(m[3] ?? '');
        if (n === null) return fail(`cannot read the path of ${JSON.stringify(l.slice(0, 80))}`, i + 1);
        status = m[1] === 'rename' ? 'renamed' : 'copied';
        if (m[2] === 'from') renameFrom = n;
        else renameTo = n;
      } else if ((m = /^index ([0-9a-f]+)\.\.([0-9a-f]+)(?: (\d+))?$/.exec(l)) !== null) {
        if (!HASH.test(m[1] ?? '') || !HASH.test(m[2] ?? '')) return fail('an index line with a hash git would not write', i + 1);
        oldHash = m[1] ?? null;
        newHash = m[2] ?? null;
        mode = m[3] ?? null;
      } else return fail(`a header line git diff does not write: ${JSON.stringify(l.slice(0, 80))}`, i + 1);
      i++;
    }
    for (const x of [oldMode, newMode, mode]) if (x !== null && !MODE.test(x)) return fail(`a file mode git would not write (${x})`, headerLine);
    if (mode !== null) {
      oldMode = oldMode ?? mode;
      newMode = newMode ?? mode;
    }
    if (status === 'added') oldMode = null;
    if (status === 'deleted') newMode = null;
    let oldPath: Named | null = null;
    let newPath: Named | null = null;
    if ('a' in hp) {
      oldPath = stripPrefix(hp.a, 'a/');
      newPath = stripPrefix(hp.b, 'b/');
      if (oldPath === null || newPath === null) return fail('paths without the a/ and b/ prefixes (run git diff with --src-prefix=a/ --dst-prefix=b/, or without diff.noprefix)', headerLine);
    }
    if (renameFrom !== null || renameTo !== null) {
      if (renameFrom === null || renameTo === null) return fail('a rename or copy with only one of its two paths', headerLine);
      if (oldPath !== null && newPath !== null && (oldPath.path !== renameFrom.path || newPath.path !== renameTo.path)) return fail('the rename paths do not match the "diff --git" header', headerLine);
      oldPath = renameFrom;
      newPath = renameTo;
    }
    let binary = false;
    const hunks: Hunk[] = [];
    const l0 = lines[i] ?? '';
    if (i < lines.length && l0.startsWith('--- ')) {
      const minus = l0.slice(4);
      const plusLine = lines[i + 1] ?? '';
      if (!plusLine.startsWith('+++ ')) return fail('a "---" line not followed by "+++"', i + 1);
      const plus = plusLine.slice(4);
      const a = minus === '/dev/null' ? null : readName(minus);
      const b = plus === '/dev/null' ? null : readName(plus);
      if ((minus !== '/dev/null' && a === null) || (plus !== '/dev/null' && b === null)) return fail('cannot read the path of a "---" or "+++" line', i + 1);
      const ap = a === null ? null : stripPrefix(a, 'a/');
      const bp = b === null ? null : stripPrefix(b, 'b/');
      if ((a !== null && ap === null) || (b !== null && bp === null)) return fail('paths without the a/ and b/ prefixes on a "---" or "+++" line', i + 1);
      if ((ap === null) !== (status === 'added') || (bp === null) !== (status === 'deleted')) return fail('the "---" and "+++" lines do not agree with the header about which side exists', i + 1);
      if (oldPath !== null && ap !== null && ap.path !== oldPath.path) return fail('the "---" path does not match the header', i + 1);
      if (newPath !== null && bp !== null && bp.path !== newPath.path) return fail('the "+++" path does not match the header', i + 2);
      oldPath = oldPath ?? ap;
      newPath = newPath ?? bp;
      for (const n of [a, b]) if (n !== null && n.quoted) quoted.push(n);
      i += 2;
      let lastOld = 0;
      let lastNew = 0;
      while (i < lines.length && (lines[i] ?? '').startsWith('@@')) {
        const hl = lines[i] ?? '';
        const hm = HUNK.exec(hl);
        if (hm === null) return fail(`a hunk header git would not write: ${JSON.stringify(hl.slice(0, 80))}`, i + 1);
        const h: Hunk = { oldStart: Number(hm[1]), oldLines: hm[2] === undefined ? 1 : Number(hm[2]), newStart: Number(hm[3]), newLines: hm[4] === undefined ? 1 : Number(hm[4]), line: i + 1, lines: [] };
        if (h.oldStart < lastOld || h.newStart < lastNew) return fail('hunks out of order or overlapping', i + 1);
        i++;
        let o = 0;
        let n = 0;
        while (o < h.oldLines || n < h.newLines) {
          if (i >= lines.length) return fail(`the hunk at line ${h.line} is cut off: it promises ${h.oldLines} old and ${h.newLines} new lines`, h.line);
          const t = lines[i] ?? '';
          const op = t[0];
          if (op === ' ' || op === '-' || op === '+') {
            if (op !== '+') o++;
            if (op !== '-') n++;
            if (o > h.oldLines || n > h.newLines) return fail(`the hunk at line ${h.line} has more lines than its header counts`, i + 1);
            h.lines.push({ op, text: t.slice(1), noEol: false });
          } else if (t.startsWith('\\ ') && h.lines.length > 0) {
            const prev = h.lines[h.lines.length - 1];
            if (prev !== undefined) prev.noEol = true;
          } else return fail(`a line inside a hunk that is not context, removed or added: ${JSON.stringify(t.slice(0, 80))}`, i + 1);
          i++;
        }
        if (i < lines.length && (lines[i] ?? '').startsWith('\\ ') && h.lines.length > 0) {
          const prev = h.lines[h.lines.length - 1];
          if (prev !== undefined) prev.noEol = true;
          i++;
        }
        lastOld = h.oldStart + h.oldLines;
        lastNew = h.newStart + h.newLines;
        hunks.push(h);
      }
      if (hunks.length === 0) return fail('"---" and "+++" lines with no hunk', i);
    } else if (i < lines.length && l0.startsWith('Binary files ')) {
      if (!/ differ$/.test(l0)) return fail('a "Binary files" line git would not write', i + 1);
      binary = true;
      i++;
    } else if (i < lines.length && l0 === 'GIT binary patch') {
      binary = true;
      i++;
      while (i < lines.length && !(lines[i] ?? '').startsWith('diff --git ')) {
        if (!BINARY_DATA.test(lines[i] ?? '')) return fail('a line inside a binary patch that is not binary patch data', i + 1);
        i++;
      }
    }
    if (oldPath === null && newPath === null) return fail('cannot tell the paths of a file whose name holds spaces (no rename or "---"/"+++" line names them)', headerLine);
    if ('a' in hp) {
      if (hp.a.quoted) quoted.push(hp.a);
      if (hp.b.quoted) quoted.push(hp.b);
    }
    if (status === 'added') oldPath = null;
    if (status === 'deleted') newPath = null;
    const path = (newPath ?? oldPath)?.path ?? '';
    const f: FileDiff = { path, oldPath: oldPath?.path ?? null, newPath: newPath?.path ?? null, status, oldMode, newMode, oldHash, newHash, binary, hunks, line: headerLine, doubts: [] };
    const isQuoted = quoted.length > 0;
    const pd = new Map<string, Doubt>();
    for (const p of new Set([f.oldPath, f.newPath])) {
      if (p === null) continue;
      const d = pathDoubt(p, isQuoted);
      if (d !== null) pd.set(d.text, d);
    }
    f.doubts.push(...pd.values());
    if (status === 'renamed') f.doubts.push({ id: 'doubt.rename', text: `a rename, ${f.oldPath ?? ''} to ${f.newPath ?? ''}` });
    if (status === 'copied') f.doubts.push({ id: 'doubt.copy', text: `a copy, ${f.oldPath ?? ''} to ${f.newPath ?? ''}` });
    if (status === 'deleted') f.doubts.push({ id: 'doubt.delete', text: `a deleted file (${f.path})` });
    if (binary) f.doubts.push({ id: 'doubt.binary', text: `a binary file (${f.path})` });
    f.doubts.push(...modeDoubts(f), ...lineDoubts(f));
    files.push(f);
  }
  const count = new Map<string, number>();
  for (const f of files) for (const p of new Set([f.oldPath, f.newPath])) if (p !== null) count.set(p, (count.get(p) ?? 0) + 1);
  for (const f of files) {
    const twice = [...new Set([f.oldPath, f.newPath])].find((p) => p !== null && (count.get(p) ?? 0) > 1);
    if (twice !== undefined && twice !== null) f.doubts.push({ id: 'doubt.path-repeated', text: `a path that appears in more than one entry of the diff, such as a file turned into a link (${twice})` });
  }
  return { ok: true, files };
}
