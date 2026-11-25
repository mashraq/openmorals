// Content patterns (0.15.0): the regular expressions a rule's `match.content` holds. They run over up to 256 KB of text an
// agent wrote, so they are matched by a Thompson NFA simulation whose time grows with the text times the pattern, never
// by backtracking: `a.*b` on 16 KB of `a` takes about 0.3 s in the native engine and grows with the square of the text.
// The syntax is the JavaScript one, case-insensitive, with `^` and `$` at line boundaries (flags `im`). Backreferences,
// lookahead and lookbehind cannot be matched this way and are refused when the bylaws are loaded.

/** Longest pattern accepted, in characters. */
export const MAX_CONTENT_PATTERN_CHARS = 1024;
/** Largest repeat count in `{n}`, `{n,}` or `{n,m}`. */
export const MAX_CONTENT_REPEAT = 1000;
/** Most instructions a pattern may compile to once its repeats are expanded. */
export const MAX_CONTENT_PROGRAM = 8192;

/** Most matcher steps one search may take (a step is one NFA state expanded); past it the search gives up and says so. */
export const MAX_CONTENT_STEPS = 10_000_000;

export interface ContentPattern {
  readonly source: string;
  /** True when the pattern matches anywhere in `text`, false when it does not, null when the search ran out of steps (MAX_CONTENT_STEPS). */
  search(text: string, maxSteps?: number): boolean | null;
}

export type ContentPatternResult = { ok: true; pattern: ContentPattern } | { ok: false; error: string };

type Node =
  | { t: 'char'; c: number }
  | { t: 'set'; set: CharSet }
  | { t: 'any' }
  | { t: 'bol' }
  | { t: 'eol' }
  | { t: 'wb' }
  | { t: 'nwb' }
  | { t: 'cat'; items: Node[] }
  | { t: 'alt'; items: Node[] }
  | { t: 'rep'; node: Node; min: number; max: number };

/** Ranges of UTF-16 code units, as [lo, hi] pairs, possibly negated. */
interface CharSet {
  ranges: number[];
  neg: boolean;
}

class PatternError extends Error {}

const DIGIT: readonly number[] = [0x30, 0x39];
const WORD: readonly number[] = [0x30, 0x39, 0x41, 0x5a, 0x5f, 0x5f, 0x61, 0x7a];
const SPACE: readonly number[] = [0x09, 0x0d, 0x20, 0x20, 0xa0, 0xa0, 0x1680, 0x1680, 0x2000, 0x200a, 0x2028, 0x2029, 0x202f, 0x202f, 0x205f, 0x205f, 0x3000, 0x3000, 0xfeff, 0xfeff];

function complement(ranges: readonly number[]): number[] {
  const sorted: [number, number][] = [];
  for (let i = 0; i < ranges.length; i += 2) sorted.push([ranges[i] ?? 0, ranges[i + 1] ?? 0]);
  sorted.sort((a, b) => a[0] - b[0]);
  const out: number[] = [];
  let next = 0;
  for (const [lo, hi] of sorted) {
    if (lo > next) out.push(next, lo - 1);
    next = Math.max(next, hi + 1);
  }
  if (next <= 0xffff) out.push(next, 0xffff);
  return out;
}

function isLineTerminator(c: number): boolean {
  return c === 0x0a || c === 0x0d || c === 0x2028 || c === 0x2029;
}

function isWordChar(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || c === 0x5f || (c >= 0x61 && c <= 0x7a);
}

let foldTable: Int32Array | null = null;

/** The case-insensitive canonical form of one code unit (the non-unicode `i` rule: upper case, never mapping into ASCII). */
function fold(c: number): number {
  if (c < 0x80) return c >= 0x61 && c <= 0x7a ? c - 0x20 : c;
  if (foldTable === null) foldTable = new Int32Array(0x10000).fill(-1);
  const hit = foldTable[c] ?? -1;
  if (hit !== -1) return hit;
  const u = String.fromCharCode(c).toUpperCase();
  const f = u.length === 1 && u.charCodeAt(0) >= 0x80 ? u.charCodeAt(0) : c;
  foldTable[c] = f;
  return f;
}

function inRanges(ranges: readonly number[], c: number): boolean {
  for (let i = 0; i < ranges.length; i += 2) if (c >= (ranges[i] ?? 1) && c <= (ranges[i + 1] ?? 0)) return true;
  return false;
}

/** Whether some code unit in [lo, hi] folds to `f`: checked over the range for short ranges, else by testing `f`'s preimages. */
function rangeHasFold(lo: number, hi: number, f: number): boolean {
  if (f >= lo && f <= hi) return true;
  const lower = String.fromCharCode(f).toLowerCase();
  if (lower.length === 1) {
    const l = lower.charCodeAt(0);
    if (l >= lo && l <= hi && fold(l) === f) return true;
  }
  if (hi - lo <= 512) {
    for (let x = lo; x <= hi; x++) if (fold(x) === f) return true;
    return false;
  }
  return false;
}

/** A membership test for a set under case folding, with a lookup table for ASCII. */
function setMatcher(set: CharSet): (c: number) => boolean {
  const raw = (c: number): boolean => {
    const f = fold(c);
    for (let i = 0; i < set.ranges.length; i += 2) if (rangeHasFold(set.ranges[i] ?? 1, set.ranges[i + 1] ?? 0, f)) return true;
    return inRanges(set.ranges, c);
  };
  const ascii = new Uint8Array(0x80);
  for (let c = 0; c < 0x80; c++) ascii[c] = raw(c) !== set.neg ? 1 : 0;
  const cache = new Map<number, boolean>();
  return (c: number): boolean => {
    if (c < 0x80) return ascii[c] === 1;
    const hit = cache.get(c);
    if (hit !== undefined) return hit;
    const v = raw(c) !== set.neg;
    if (cache.size < 4096) cache.set(c, v);
    return v;
  };
}

class Parser {
  private i = 0;
  private readonly src: string;
  constructor(src: string) {
    this.src = src;
  }

  parse(): Node {
    const n = this.alternation();
    if (this.i < this.src.length) throw new PatternError(`unexpected ${JSON.stringify(this.src[this.i])} at character ${this.i + 1}`);
    return n;
  }

  private peek(k = 0): string {
    return this.src[this.i + k] ?? '';
  }

  private alternation(): Node {
    const items: Node[] = [this.concat()];
    while (this.peek() === '|') {
      this.i++;
      items.push(this.concat());
    }
    return items.length === 1 ? (items[0] as Node) : { t: 'alt', items };
  }

  private concat(): Node {
    const items: Node[] = [];
    while (this.i < this.src.length && this.peek() !== '|' && this.peek() !== ')') items.push(this.repeat());
    return { t: 'cat', items };
  }

  private quantifier(): { min: number; max: number } | null {
    const ch = this.peek();
    if (ch === '*') return (this.i++, { min: 0, max: Infinity });
    if (ch === '+') return (this.i++, { min: 1, max: Infinity });
    if (ch === '?') return (this.i++, { min: 0, max: 1 });
    if (ch !== '{') return null;
    const m = /^\{(\d+)(,(\d*))?\}/.exec(this.src.slice(this.i));
    if (m === null) return null;
    const min = Number(m[1]);
    const max = m[2] === undefined ? min : m[3] === '' || m[3] === undefined ? Infinity : Number(m[3]);
    if (min > MAX_CONTENT_REPEAT || (max !== Infinity && max > MAX_CONTENT_REPEAT)) throw new PatternError(`a repeat count over ${MAX_CONTENT_REPEAT} (${m[0]}) is not supported in a content pattern`);
    if (max < min) throw new PatternError(`the repeat ${m[0]} has its numbers out of order`);
    this.i += m[0].length;
    return { min, max };
  }

  private repeat(): Node {
    const atom = this.atom();
    const q = this.quantifier();
    if (q === null) return atom;
    if (atom.t === 'bol' || atom.t === 'eol' || atom.t === 'wb' || atom.t === 'nwb') throw new PatternError('nothing to repeat: an anchor or word boundary cannot take a repeat');
    if (this.peek() === '?') this.i++;
    if (this.quantifier() !== null) throw new PatternError('nothing to repeat: two repeats in a row');
    return { t: 'rep', node: atom, min: q.min, max: q.max };
  }

  private atom(): Node {
    const ch = this.peek();
    if (ch === '(') return this.group();
    if (ch === '[') return this.charClass();
    if (ch === '.') return (this.i++, { t: 'any' });
    if (ch === '^') return (this.i++, { t: 'bol' });
    if (ch === '$') return (this.i++, { t: 'eol' });
    if (ch === '\\') return this.escape(false);
    if (ch === '*' || ch === '+' || ch === '?') throw new PatternError(`nothing to repeat at character ${this.i + 1}`);
    if (ch === '{' && /^\{\d+(,\d*)?\}/.test(this.src.slice(this.i))) throw new PatternError(`nothing to repeat at character ${this.i + 1}`);
    this.i++;
    return { t: 'char', c: ch.charCodeAt(0) };
  }

  private group(): Node {
    this.i++;
    if (this.peek() === '?') {
      const next = this.peek(1);
      if (next === ':') this.i += 2;
      else if (next === '=' || next === '!' || (next === '<' && (this.peek(2) === '=' || this.peek(2) === '!'))) throw new PatternError('lookahead and lookbehind are not supported in a content pattern (they cannot be matched in linear time)');
      else if (next === '<') {
        const m = /^\?<[A-Za-z_$][A-Za-z0-9_$]*>/.exec(this.src.slice(this.i));
        if (m === null) throw new PatternError('a named group needs a name made of letters, digits, _ or $');
        this.i += m[0].length;
      } else throw new PatternError(`the group syntax (?${next} is not supported in a content pattern`);
    }
    const inner = this.alternation();
    if (this.peek() !== ')') throw new PatternError('a group is not closed');
    this.i++;
    return inner;
  }

  /** One escape after `\`. Inside a class `\b` is a backspace and the assertions do not exist. */
  private escape(inClass: boolean): Node {
    this.i++;
    const ch = this.peek();
    if (ch === '') throw new PatternError('the pattern ends with a lone backslash');
    this.i++;
    switch (ch) {
      case 'd':
        return { t: 'set', set: { ranges: [...DIGIT], neg: false } };
      case 'D':
        return { t: 'set', set: { ranges: [...DIGIT], neg: true } };
      case 'w':
        return { t: 'set', set: { ranges: [...WORD], neg: false } };
      case 'W':
        return { t: 'set', set: { ranges: [...WORD], neg: true } };
      case 's':
        return { t: 'set', set: { ranges: [...SPACE], neg: false } };
      case 'S':
        return { t: 'set', set: { ranges: [...SPACE], neg: true } };
      case 'b':
        return inClass ? { t: 'char', c: 0x08 } : { t: 'wb' };
      case 'B':
        if (inClass) throw new PatternError('\\B is not allowed inside a character class');
        return { t: 'nwb' };
      case 'n':
        return { t: 'char', c: 0x0a };
      case 'r':
        return { t: 'char', c: 0x0d };
      case 't':
        return { t: 'char', c: 0x09 };
      case 'v':
        return { t: 'char', c: 0x0b };
      case 'f':
        return { t: 'char', c: 0x0c };
      case '0':
        if (/[0-9]/.test(this.peek())) throw new PatternError('octal escapes are not supported in a content pattern; write \\xHH');
        return { t: 'char', c: 0 };
      case 'c': {
        const x = this.peek();
        if (!/[A-Za-z]/.test(x)) throw new PatternError('\\c must be followed by a letter');
        this.i++;
        return { t: 'char', c: x.charCodeAt(0) % 32 };
      }
      case 'x': {
        const m = /^[0-9A-Fa-f]{2}/.exec(this.src.slice(this.i));
        if (m === null) throw new PatternError('\\x must be followed by two hex digits');
        this.i += 2;
        return { t: 'char', c: parseInt(m[0], 16) };
      }
      case 'u': {
        const m = /^[0-9A-Fa-f]{4}/.exec(this.src.slice(this.i));
        if (m === null) throw new PatternError('\\u must be followed by four hex digits (\\u{...} is not supported)');
        this.i += 4;
        return { t: 'char', c: parseInt(m[0], 16) };
      }
      case 'k':
        throw new PatternError('backreferences are not supported in a content pattern (they cannot be matched in linear time)');
      case 'p':
      case 'P':
        throw new PatternError('unicode property escapes (\\p{...}) are not supported in a content pattern');
      default:
        if (/[1-9]/.test(ch)) throw new PatternError('backreferences are not supported in a content pattern (they cannot be matched in linear time)');
        if (/[A-Za-z0-9]/.test(ch)) throw new PatternError(`the escape \\${ch} is not supported in a content pattern`);
        return { t: 'char', c: ch.charCodeAt(0) };
    }
  }

  /** One class member: a single code unit, or a set from a class escape (null code). */
  private classAtom(): { c: number | null; set: number[] | null; neg: boolean } {
    if (this.peek() === '\\') {
      const n = this.escape(true);
      if (n.t === 'char') return { c: n.c, set: null, neg: false };
      if (n.t === 'set') return { c: null, set: n.set.ranges, neg: n.set.neg };
      throw new PatternError('unsupported escape inside a character class');
    }
    const ch = this.peek();
    this.i++;
    return { c: ch.charCodeAt(0), set: null, neg: false };
  }

  private charClass(): Node {
    this.i++;
    let neg = false;
    if (this.peek() === '^') {
      neg = true;
      this.i++;
    }
    const ranges: number[] = [];
    while (this.peek() !== ']') {
      if (this.i >= this.src.length) throw new PatternError('a character class is not closed');
      const a = this.classAtom();
      if (a.c !== null && this.peek() === '-' && this.peek(1) !== ']' && this.peek(1) !== '') {
        const save = this.i;
        this.i++;
        const b = this.classAtom();
        if (b.c !== null) {
          if (b.c < a.c) throw new PatternError('a range in a character class is out of order');
          ranges.push(a.c, b.c);
          continue;
        }
        this.i = save;
      }
      if (a.c !== null) ranges.push(a.c, a.c);
      else if (a.set !== null) ranges.push(...(a.neg ? complement(a.set) : a.set));
    }
    this.i++;
    return { t: 'set', set: { ranges, neg } };
  }
}

const OP_CHAR = 0;
const OP_SET = 1;
const OP_ANY = 2;
const OP_SPLIT = 3;
const OP_JMP = 4;
const OP_MATCH = 5;
const OP_BOL = 6;
const OP_EOL = 7;
const OP_WB = 8;
const OP_NWB = 9;

class Program {
  op: number[] = [];
  a: number[] = [];
  b: number[] = [];
  sets: ((c: number) => boolean)[] = [];
  private readonly setIndex = new Map<CharSet, number>();

  emit(op: number, a = 0, b = 0): number {
    if (this.op.length >= MAX_CONTENT_PROGRAM) throw new PatternError(`the pattern is too large once its repeats are expanded (over ${MAX_CONTENT_PROGRAM} steps)`);
    this.op.push(op);
    this.a.push(a);
    this.b.push(b);
    return this.op.length - 1;
  }

  gen(n: Node): void {
    switch (n.t) {
      case 'char':
        this.emit(OP_CHAR, fold(n.c));
        return;
      case 'set': {
        let idx = this.setIndex.get(n.set);
        if (idx === undefined) {
          this.sets.push(setMatcher(n.set));
          idx = this.sets.length - 1;
          this.setIndex.set(n.set, idx);
        }
        this.emit(OP_SET, idx);
        return;
      }
      case 'any':
        this.emit(OP_ANY);
        return;
      case 'bol':
        this.emit(OP_BOL);
        return;
      case 'eol':
        this.emit(OP_EOL);
        return;
      case 'wb':
        this.emit(OP_WB);
        return;
      case 'nwb':
        this.emit(OP_NWB);
        return;
      case 'cat':
        for (const x of n.items) this.gen(x);
        return;
      case 'alt': {
        const jumps: number[] = [];
        n.items.forEach((x, k) => {
          if (k < n.items.length - 1) {
            const split = this.emit(OP_SPLIT);
            this.a[split] = split + 1;
            this.gen(x);
            jumps.push(this.emit(OP_JMP));
            this.b[split] = this.op.length;
          } else this.gen(x);
        });
        for (const j of jumps) this.a[j] = this.op.length;
        return;
      }
      case 'rep': {
        for (let k = 0; k < n.min; k++) this.gen(n.node);
        if (n.max === Infinity) {
          const split = this.emit(OP_SPLIT);
          this.a[split] = split + 1;
          this.gen(n.node);
          this.emit(OP_JMP, split);
          this.b[split] = this.op.length;
          return;
        }
        const splits: number[] = [];
        for (let k = n.min; k < n.max; k++) {
          const split = this.emit(OP_SPLIT);
          this.a[split] = split + 1;
          splits.push(split);
          this.gen(n.node);
        }
        for (const s of splits) this.b[s] = this.op.length;
        return;
      }
    }
  }
}

/** Most DFA states kept for one test; past it the cache is dropped and rebuilt, so memory stays bounded. */
export const MAX_CONTENT_DFA_STATES = 2048;

const PREV_START = 0;
const PREV_WORD = 1;
const PREV_LINE = 2;
const PREV_OTHER = 3;

function prevClass(c: number): number {
  return isWordChar(c) ? PREV_WORD : isLineTerminator(c) ? PREV_LINE : PREV_OTHER;
}

/**
 * A state of the lazily built DFA: the NFA steps waiting to be expanded at the next position, and what kind of character
 * came before it (for `^`, `$` and `\b`). Transitions are cached per code unit; `null` in the cache means "not built".
 */
interface DState {
  pend: Int32Array;
  prev: number;
  ascii: (DState | typeof MATCHED | undefined)[];
  other: Map<number, DState | typeof MATCHED>;
}

const MATCHED = Symbol('matched');

function makeSearch(p: Program): (text: string, maxSteps?: number) => boolean | null {
  const op = Int32Array.from(p.op);
  const a = Int32Array.from(p.a);
  const b = Int32Array.from(p.b);
  const sets = p.sets;
  const size = op.length;
  return (s: string, maxSteps: number = MAX_CONTENT_STEPS): boolean | null => {
    const n = s.length;
    let steps = 0;
    const mark = new Int32Array(size);
    const stack = new Int32Array(size * 2 + 2);
    const consuming = new Int32Array(size);
    const out = new Int32Array(size);
    let gen = 0;
    let states = new Map<string, DState>();
    const intern = (pend: Int32Array, prev: number): DState => {
      const key = `${prev}:${pend.join(',')}`;
      const hit = states.get(key);
      if (hit !== undefined) return hit;
      const st: DState = { pend, prev, ascii: new Array<DState | typeof MATCHED | undefined>(0x80), other: new Map() };
      states.set(key, st);
      return st;
    };
    /** Expands the state's waiting steps (and a new start: the search is unanchored) at a position whose next code unit is `next` (-1 at the end). Returns the consuming steps, or -1 when the pattern has matched. */
    const expand = (st: DState, next: number): number => {
      gen++;
      const atStart = st.prev === PREV_START || st.prev === PREV_LINE;
      const atEnd = next === -1 || isLineTerminator(next);
      const boundary = (st.prev === PREV_WORD) !== (next !== -1 && isWordChar(next));
      let len = 0;
      let sp = 0;
      for (let k = st.pend.length - 1; k >= 0; k--) stack[sp++] = st.pend[k] ?? 0;
      stack[sp++] = 0;
      while (sp > 0) {
        const pc = stack[--sp] ?? 0;
        if (mark[pc] === gen) continue;
        mark[pc] = gen;
        steps++;
        const o = op[pc] ?? OP_MATCH;
        if (o === OP_MATCH) return -1;
        if (o === OP_JMP) stack[sp++] = a[pc] ?? 0;
        else if (o === OP_SPLIT) {
          stack[sp++] = b[pc] ?? 0;
          stack[sp++] = a[pc] ?? 0;
        } else if (o === OP_BOL) {
          if (atStart) stack[sp++] = pc + 1;
        } else if (o === OP_EOL) {
          if (atEnd) stack[sp++] = pc + 1;
        } else if (o === OP_WB) {
          if (boundary) stack[sp++] = pc + 1;
        } else if (o === OP_NWB) {
          if (!boundary) stack[sp++] = pc + 1;
        } else consuming[len++] = pc;
      }
      return len;
    };
    const step = (st: DState, c: number): DState | typeof MATCHED => {
      const len = expand(st, c);
      if (len === -1) return MATCHED;
      const fc = fold(c);
      let m = 0;
      for (let k = 0; k < len; k++) {
        const pc = consuming[k] ?? 0;
        const o = op[pc];
        const ok = o === OP_CHAR ? a[pc] === fc : o === OP_SET ? (sets[a[pc] ?? 0] as (c: number) => boolean)(c) : !isLineTerminator(c);
        if (ok) out[m++] = pc + 1;
      }
      const pend = out.slice(0, m).sort();
      let w = 0;
      for (let k = 0; k < pend.length; k++) if (k === 0 || pend[k] !== pend[k - 1]) pend[w++] = pend[k] ?? 0;
      return intern(pend.slice(0, w), prevClass(c));
    };
    let cur = intern(new Int32Array(0), PREV_START);
    for (let i = 0; i < n; i++) {
      const c = s.charCodeAt(i);
      let nxt = c < 0x80 ? cur.ascii[c] : cur.other.get(c);
      if (nxt === undefined) {
        nxt = step(cur, c);
        if (nxt === MATCHED) return true;
        if (steps > maxSteps) return null;
        if (states.size > MAX_CONTENT_DFA_STATES) {
          states = new Map();
          nxt = intern(nxt.pend, nxt.prev);
        } else if (c < 0x80) cur.ascii[c] = nxt;
        else if (cur.other.size < 256) cur.other.set(c, nxt);
      }
      if (nxt === MATCHED) return true;
      cur = nxt;
    }
    return expand(cur, -1) === -1;
  };
}

/**
 * Compiles a content pattern. It must be a valid JavaScript regular expression, at most MAX_CONTENT_PATTERN_CHARS long,
 * without backreferences, lookaround, `\p{...}` or repeat counts over MAX_CONTENT_REPEAT. The error says which.
 */
export function compileContentPattern(source: string): ContentPatternResult {
  if (source.length > MAX_CONTENT_PATTERN_CHARS) return { ok: false, error: `a content pattern may be at most ${MAX_CONTENT_PATTERN_CHARS} characters (this one is ${source.length})` };
  try {
    new RegExp(source, 'im');
  } catch (err: unknown) {
    return { ok: false, error: `invalid regular expression: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    const ast = new Parser(source).parse();
    const p = new Program();
    p.gen(ast);
    p.emit(OP_MATCH);
    const search = makeSearch(p);
    return { ok: true, pattern: Object.freeze({ source, search }) };
  } catch (err: unknown) {
    if (err instanceof PatternError) return { ok: false, error: err.message };
    throw err;
  }
}

const CACHE_MAX = 256;
const cache = new Map<string, ContentPattern>();

/** The compiled pattern for a source, cached; throws with the compile error, so a rule that skipped validation fails closed. */
export function contentPattern(source: string): ContentPattern {
  const hit = cache.get(source);
  if (hit !== undefined) return hit;
  const r = compileContentPattern(source);
  if (!r.ok) throw new Error(`the content pattern cannot be used: ${r.error}`);
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(source, r.pattern);
  return r.pattern;
}
