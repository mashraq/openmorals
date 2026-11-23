import type { ShellKind } from './types.js';

export interface Redirect {
  op: string;
  target: string;
}

export interface SimpleCommand {
  name: string;
  args: string[];
  redirects: Redirect[];
  shell: ShellKind;
  pipeIn: boolean;
  bulk: boolean;
  via: string[];
}

export interface ParsedCommand {
  text: string;
  shell: ShellKind;
  commands: SimpleCommand[];
  opaque: string[];
}

type Item = { t: 'w'; v: string } | { t: 'op'; v: string } | { t: 'redir'; v: string };

interface Lexed {
  items: Item[];
  nested: string[];
  opaque: string[];
}

const MAX_DEPTH = 8;

export function cmdName(word: string): string {
  const base = word.replace(/\\/g, '/').split('/').pop() ?? word;
  return base.toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '');
}

function captureBalanced(s: string, start: number, open: string, close: string): { inner: string; end: number } {
  let depth = 1;
  let i = start;
  let quote = '';
  while (i < s.length) {
    const c = s.charAt(i);
    if (quote) {
      if (c === '\\' && quote === '"') {
        i += 2;
        continue;
      }
      if (c === quote) quote = '';
      i++;
      continue;
    }
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      i++;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return { inner: s.slice(start, i), end: i + 1 };
    }
    i++;
  }
  return { inner: s.slice(start), end: s.length };
}

function decodeAnsiC(body: string): string {
  return body.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|[0-7]{1,3}|.)/g, (_m: string, e: string) => {
    if (e.startsWith('x') || e.startsWith('u')) return String.fromCharCode(parseInt(e.slice(1), 16));
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
    switch (e) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case 'a':
      case 'b':
      case 'e':
      case 'f':
      case 'v':
        return '';
      default:
        return e;
    }
  });
}

function lexPosix(s: string): Lexed {
  const items: Item[] = [];
  const nested: string[] = [];
  const opaque: string[] = [];
  let word = '';
  let started = false;
  const flush = (): void => {
    if (started) items.push({ t: 'w', v: word });
    word = '';
    started = false;
  };
  let i = 0;
  while (i < s.length) {
    const c = s.charAt(i);
    const n = s.charAt(i + 1);
    if (c === ' ' || c === '\t' || c === '\r') {
      flush();
      i++;
      continue;
    }
    if (c === '\n') {
      flush();
      items.push({ t: 'op', v: ';' });
      i++;
      continue;
    }
    if (c === '\\') {
      if (n === '\n') {
        i += 2;
        continue;
      }
      word += n;
      started = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      const stop = end === -1 ? s.length : end;
      word += s.slice(i + 1, stop);
      started = true;
      i = stop + 1;
      continue;
    }
    if (c === '$' && n === "'") {
      let j = i + 2;
      while (j < s.length && s.charAt(j) !== "'") j += s.charAt(j) === '\\' ? 2 : 1;
      word += decodeAnsiC(s.slice(i + 2, Math.min(j, s.length)));
      started = true;
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s.charAt(j) !== '"') {
        const d = s.charAt(j);
        if (d === '\\' && '$`"\\\n'.includes(s.charAt(j + 1)) && s.charAt(j + 1) !== '') {
          word += s.charAt(j + 1);
          j += 2;
          continue;
        }
        if (d === '$' && s.charAt(j + 1) === '(') {
          const cap = captureBalanced(s, j + 2, '(', ')');
          nested.push(cap.inner);
          word += s.slice(j, cap.end);
          j = cap.end;
          continue;
        }
        if (d === '`') {
          const end = s.indexOf('`', j + 1);
          const stop = end === -1 ? s.length : end;
          nested.push(s.slice(j + 1, stop));
          word += s.slice(j, stop + 1);
          j = stop + 1;
          continue;
        }
        word += d;
        j++;
      }
      started = true;
      i = j + 1;
      continue;
    }
    if (c === '$' && n === '(') {
      if (s.charAt(i + 2) === '(') {
        const cap = captureBalanced(s, i + 3, '(', ')');
        word += s.slice(i, cap.end + 1);
        started = true;
        i = cap.end + 1;
        continue;
      }
      const cap = captureBalanced(s, i + 2, '(', ')');
      nested.push(cap.inner);
      word += s.slice(i, cap.end);
      started = true;
      i = cap.end;
      continue;
    }
    if (c === '`') {
      const end = s.indexOf('`', i + 1);
      const stop = end === -1 ? s.length : end;
      nested.push(s.slice(i + 1, stop));
      word += s.slice(i, stop + 1);
      started = true;
      i = stop + 1;
      continue;
    }
    if ((c === '<' || c === '>') && n === '(') {
      const cap = captureBalanced(s, i + 2, '(', ')');
      nested.push(cap.inner);
      word += s.slice(i, cap.end);
      started = true;
      i = cap.end;
      continue;
    }
    if (c === '#' && !started) {
      const end = s.indexOf('\n', i);
      i = end === -1 ? s.length : end;
      continue;
    }
    if (c === '<' || c === '>' || (c === '&' && n === '>')) {
      if (started && /^\d+$/.test(word)) {
        word = '';
        started = false;
      } else {
        flush();
      }
      const m = /^(&>>|&>|<<<|<<-|<<|<>|<&|>>|>&|>\||<|>)/.exec(s.slice(i));
      const op = m ? m[1] ?? c : c;
      items.push({ t: 'redir', v: op });
      i += op.length;
      continue;
    }
    if (c === '|' || c === '&' || c === ';' || c === '(' || c === ')') {
      flush();
      const two = c + n;
      if (two === '&&' || two === '||' || two === '|&' || two === ';;') {
        items.push({ t: 'op', v: two === '|&' ? '|' : two });
        i += 2;
      } else {
        items.push({ t: 'op', v: c });
        i++;
      }
      continue;
    }
    word += c;
    started = true;
    i++;
  }
  flush();
  return { items, nested, opaque };
}

function lexPowerShell(s: string): Lexed {
  const items: Item[] = [];
  const nested: string[] = [];
  const opaque: string[] = [];
  let word = '';
  let started = false;
  const flush = (): void => {
    if (started) items.push({ t: 'w', v: word });
    word = '';
    started = false;
  };
  let i = 0;
  while (i < s.length) {
    const c = s.charAt(i);
    const n = s.charAt(i + 1);
    if (c === ' ' || c === '\t' || c === '\r') {
      flush();
      i++;
      continue;
    }
    if (c === '\n') {
      flush();
      items.push({ t: 'op', v: ';' });
      i++;
      continue;
    }
    if (c === '`') {
      if (n === '\n') {
        i += 2;
        continue;
      }
      word += n;
      started = true;
      i += 2;
      continue;
    }
    if (c === '<' && n === '#') {
      const end = s.indexOf('#>', i + 2);
      i = end === -1 ? s.length : end + 2;
      continue;
    }
    if (c === '#' && !started) {
      const end = s.indexOf('\n', i);
      i = end === -1 ? s.length : end;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < s.length) {
        if (s.charAt(j) === "'" && s.charAt(j + 1) === "'") {
          word += "'";
          j += 2;
          continue;
        }
        if (s.charAt(j) === "'") break;
        word += s.charAt(j);
        j++;
      }
      started = true;
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s.charAt(j) !== '"') {
        const d = s.charAt(j);
        if (d === '`') {
          word += s.charAt(j + 1);
          j += 2;
          continue;
        }
        if (d === '$' && s.charAt(j + 1) === '(') {
          const cap = captureBalanced(s, j + 2, '(', ')');
          nested.push(cap.inner);
          word += s.slice(j, cap.end);
          j = cap.end;
          continue;
        }
        word += d;
        j++;
      }
      started = true;
      i = j + 1;
      continue;
    }
    if (c === '$' && n === '(') {
      const cap = captureBalanced(s, i + 2, '(', ')');
      nested.push(cap.inner);
      word += s.slice(i, cap.end);
      started = true;
      i = cap.end;
      continue;
    }
    if (c === '>' || (c === '<' && n !== '#')) {
      if (started && /^[\d*]+$/.test(word)) {
        word = '';
        started = false;
      } else {
        flush();
      }
      const m = /^(>>|>&1|>&2|>|<)/.exec(s.slice(i));
      const op = m ? m[1] ?? c : c;
      items.push({ t: 'redir', v: op });
      i += op.length;
      continue;
    }
    if (c === '|' || c === ';' || c === '(' || c === ')' || c === '{' || c === '}' || (c === '&' && n === '&')) {
      flush();
      const two = c + n;
      if (two === '&&' || two === '||') {
        items.push({ t: 'op', v: two });
        i += 2;
      } else {
        items.push({ t: 'op', v: c });
        i++;
      }
      continue;
    }
    word += c;
    started = true;
    i++;
  }
  flush();
  return { items, nested, opaque };
}

function lexCmd(s: string): Lexed {
  const items: Item[] = [];
  let word = '';
  let started = false;
  const flush = (): void => {
    if (started) items.push({ t: 'w', v: word });
    word = '';
    started = false;
  };
  let i = 0;
  while (i < s.length) {
    const c = s.charAt(i);
    const n = s.charAt(i + 1);
    if (c === ' ' || c === '\t' || c === '\r' || c === ',') {
      flush();
      i++;
      continue;
    }
    if (c === '\n') {
      flush();
      items.push({ t: 'op', v: ';' });
      i++;
      continue;
    }
    if (c === '^') {
      word += n;
      started = true;
      i += 2;
      continue;
    }
    if (c === '"') {
      const end = s.indexOf('"', i + 1);
      const stop = end === -1 ? s.length : end;
      word += s.slice(i + 1, stop);
      started = true;
      i = stop + 1;
      continue;
    }
    if (c === '<' || c === '>') {
      if (started && /^\d$/.test(word)) {
        word = '';
        started = false;
      } else {
        flush();
      }
      const op = c === '>' && n === '>' ? '>>' : c;
      items.push({ t: 'redir', v: op });
      i += op.length;
      continue;
    }
    if (c === '&' || c === '|' || c === '(' || c === ')') {
      flush();
      const two = c + n;
      if (two === '&&' || two === '||') {
        items.push({ t: 'op', v: two });
        i += 2;
      } else {
        items.push({ t: 'op', v: c === '&' ? ';' : c });
        i++;
      }
      continue;
    }
    word += c;
    started = true;
    i++;
  }
  flush();
  return { items, nested: [], opaque: [] };
}

function lex(s: string, shell: ShellKind): Lexed {
  if (shell === 'powershell') return lexPowerShell(s);
  if (shell === 'cmd') return lexCmd(s);
  return lexPosix(s);
}

interface Stage {
  words: string[];
  redirects: Redirect[];
  pipeIn: boolean;
}

function group(items: Item[]): Stage[][] {
  const pipelines: Stage[][] = [];
  let pipeline: Stage[] = [];
  let stage: Stage = { words: [], redirects: [], pipeIn: false };
  let pendingRedir: string | null = null;
  const endStage = (): void => {
    if (stage.words.length > 0 || stage.redirects.length > 0) pipeline.push(stage);
  };
  for (const it of items) {
    if (it.t === 'w') {
      if (pendingRedir !== null) {
        stage.redirects.push({ op: pendingRedir, target: it.v });
        pendingRedir = null;
      } else {
        stage.words.push(it.v);
      }
    } else if (it.t === 'redir') {
      pendingRedir = it.v;
    } else if (it.v === '|') {
      endStage();
      stage = { words: [], redirects: [], pipeIn: true };
    } else {
      endStage();
      if (pipeline.length > 0) pipelines.push(pipeline);
      pipeline = [];
      stage = { words: [], redirects: [], pipeIn: false };
    }
  }
  endStage();
  if (pipeline.length > 0) pipelines.push(pipeline);
  return pipelines;
}

const RESERVED = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}', 'time', 'esac', 'function', 'coproc']);
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'busybox-sh']);
const PS_SHELLS = new Set(['powershell', 'pwsh']);
const SIMPLE_WRAPPERS = new Set(['nohup', 'builtin', 'unbuffer', 'busybox', 'time', 'noglob', '&', 'start-process-wrapper']);

interface Ctx {
  depth: number;
  vars: Map<string, string>;
  out: SimpleCommand[];
  opaque: string[];
}

function expandVars(w: string, vars: Map<string, string>): string {
  if (!w.includes('$')) return w;
  return w.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m: string, a: string | undefined, b: string | undefined) => {
    const key = a ?? b ?? '';
    const v = vars.get(key);
    return v === undefined ? m : v;
  });
}

function skipOptions(words: string[], start: number, withArg: Set<string>): number {
  let i = start;
  while (i < words.length) {
    const w = words[i] ?? '';
    if (w === '--') return i + 1;
    if (!w.startsWith('-') || w === '-') return i;
    if (withArg.has(w)) i += 2;
    else i += 1;
  }
  return i;
}

function parseInto(text: string, shell: ShellKind, ctx: Ctx, bulk: boolean, via: string[]): void {
  if (ctx.depth >= MAX_DEPTH) {
    ctx.opaque.push('command nesting is too deep to inspect');
    return;
  }
  ctx.depth++;
  const lexed = lex(text, shell);
  for (const o of lexed.opaque) ctx.opaque.push(o);
  for (const inner of lexed.nested) parseInto(inner, shell, ctx, false, via);
  for (const pipeline of group(lexed.items)) {
    const before: SimpleCommand[] = [];
    for (const stage of pipeline) {
      const start = ctx.out.length;
      handleStage(stage.words.map((w) => expandVars(w, ctx.vars)), stage.redirects, stage.pipeIn, shell, ctx, bulk, via, before);
      for (const c of ctx.out.slice(start)) before.push(c);
    }
  }
  ctx.depth--;
}

function emit(ctx: Ctx, name: string, args: string[], redirects: Redirect[], shell: ShellKind, pipeIn: boolean, bulk: boolean, via: string[]): void {
  ctx.out.push({ name, args, redirects, shell, pipeIn, bulk, via });
}

function decodePowerShellBase64(b64: string): string | null {
  if (!/^[A-Za-z0-9+/=]+$/.test(b64)) return null;
  const text = Buffer.from(b64, 'base64').toString('utf16le');
  return text.length > 0 ? text : null;
}

function handleStage(
  inWords: string[],
  redirects: Redirect[],
  pipeIn: boolean,
  shell: ShellKind,
  ctx: Ctx,
  bulkIn: boolean,
  viaIn: string[],
  earlier: SimpleCommand[],
): void {
  let words = inWords.slice();
  let bulk = bulkIn;
  const via = viaIn.slice();
  for (const r of redirects) {
    if (r.op === '<<<' && words.length > 0 && POSIX_SHELLS.has(cmdName(words[0] ?? ''))) {
      parseInto(r.target, 'posix', ctx, bulk, via.concat(cmdName(words[0] ?? '')));
    }
  }
  for (let guard = 0; guard < 64 && words.length > 0; guard++) {
    const first = words[0] ?? '';
    if (shell === 'posix' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) {
      const eq = first.indexOf('=');
      ctx.vars.set(first.slice(0, eq), first.slice(eq + 1));
      words = words.slice(1);
      continue;
    }
    if (shell === 'powershell' && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(first) && words[1] === '=') {
      ctx.vars.set(first.slice(1), words.slice(2).join(' '));
      words = [];
      break;
    }
    const name = cmdName(first);
    if (RESERVED.has(name) && shell === 'posix') {
      words = words.slice(1);
      continue;
    }
    if (name === 'for' || name === 'select' || name === 'case') {
      words = [];
      break;
    }
    if (SIMPLE_WRAPPERS.has(name) || name === '.' && shell === 'powershell') {
      via.push(name);
      words = words.slice(1);
      continue;
    }
    if (name === 'command' || name === 'exec') {
      via.push(name);
      words = words.slice(skipOptions(words, 1, new Set(['-a'])));
      continue;
    }
    if (name === 'sudo' || name === 'doas' || name === 'run0') {
      via.push(name);
      words = words.slice(skipOptions(words, 1, new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '--user', '--group'])));
      continue;
    }
    if (name === 'env') {
      via.push(name);
      let i = 1;
      while (i < words.length) {
        const w = words[i] ?? '';
        if (w === '-S' || w === '--split-string') {
          parseInto(words.slice(i + 1).join(' '), 'posix', ctx, bulk, via);
          words = [];
          break;
        }
        if (w === '-u' || w === '-C' || w === '--unset' || w === '--chdir') i += 2;
        else if (w.startsWith('-')) i++;
        else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++;
        else break;
      }
      if (words.length === 0 || i >= words.length) break;
      words = words.slice(i);
      continue;
    }
    if (name === 'nice' || name === 'ionice' || name === 'stdbuf' || name === 'caffeinate' || name === 'watch' || name === 'chrt' || name === 'taskset') {
      via.push(name);
      words = words.slice(skipOptions(words, 1, new Set(['-n', '-c', '-p', '-t', '-w', '-o', '-e', '-i', '--adjustment', '--interval'])));
      if ((name === 'chrt' || name === 'taskset') && words.length > 0 && /^[\d,x-]+$/.test(words[0] ?? '')) words = words.slice(1);
      continue;
    }
    if (name === 'timeout') {
      via.push(name);
      const i = skipOptions(words, 1, new Set(['-s', '-k', '--signal', '--kill-after']));
      words = words.slice(i + 1);
      continue;
    }
    if (name === 'chroot') {
      via.push(name);
      const i = skipOptions(words, 1, new Set(['--userspec', '--groups']));
      words = words.slice(i + 1);
      continue;
    }
    if (name === 'xargs' || name === 'parallel') {
      via.push(name);
      bulk = true;
      const i = skipOptions(words, 1, new Set(['-I', '-L', '-n', '-P', '-d', '-E', '-s', '-a', '--max-args', '--max-procs', '--delimiter', '-j', '--jobs']));
      words = words.slice(i);
      const sep = words.indexOf(':::');
      if (sep !== -1) words = words.slice(0, sep);
      if (words.length === 0) words = ['echo'];
      continue;
    }
    if (name === 'eval' || name === 'invoke-expression' || name === 'iex') {
      parseInto(words.slice(1).join(' '), shell === 'posix' ? 'posix' : 'powershell', ctx, bulk, via.concat(name));
      words = [];
      break;
    }
    if (POSIX_SHELLS.has(name)) {
      let i = 1;
      let script: string | null = null;
      while (i < words.length) {
        const w = words[i] ?? '';
        if (w === '--') {
          i++;
          break;
        }
        if (/^-[A-Za-z]*c[A-Za-z]*$/.test(w) || w === '--command') {
          script = words[i + 1] ?? '';
          break;
        }
        if (w.startsWith('-') || w.startsWith('+')) {
          if (w === '-o' || w === '+o' || w === '--rcfile' || w === '--init-file') i += 2;
          else i++;
          continue;
        }
        break;
      }
      if (script !== null) {
        parseInto(script, 'posix', ctx, bulk, via.concat(name));
      } else if (i >= words.length && pipeIn) {
        inspectPipedScript(earlier, 'posix', ctx, bulk, via.concat(name));
      }
      emit(ctx, name, words.slice(1), redirects, shell, pipeIn, bulk, via);
      return;
    }
    if (PS_SHELLS.has(name)) {
      let i = 1;
      let script: string | null = null;
      while (i < words.length) {
        const w = words[i] ?? '';
        const lw = w.toLowerCase();
        if (!w.startsWith('-') && !w.startsWith('/')) {
          script = words.slice(i).join(' ');
          break;
        }
        if (lw === '-c' || (lw.startsWith('-co') && '-command'.startsWith(lw))) {
          script = words.slice(i + 1).join(' ');
          break;
        }
        if (lw === '-e' || lw === '-ec' || (lw.startsWith('-en') && '-encodedcommand'.startsWith(lw))) {
          const decoded = decodePowerShellBase64(words[i + 1] ?? '');
          if (decoded === null) ctx.opaque.push('PowerShell -EncodedCommand could not be decoded');
          else parseInto(decoded, 'powershell', ctx, bulk, via.concat(name));
          script = null;
          i = words.length;
          break;
        }
        if (lw === '-f' || (lw.startsWith('-fi') && '-file'.startsWith(lw))) {
          i = words.length;
          break;
        }
        if (['-executionpolicy', '-ex', '-ep', '-windowstyle', '-w', '-workingdirectory', '-wd', '-configurationname', '-outputformat', '-o', '-inputformat', '-if', '-psconsolefile', '-version', '-v', '-settingsfile'].includes(lw)) i += 2;
        else i++;
      }
      if (script !== null) parseInto(script, 'powershell', ctx, bulk, via.concat(name));
      else if (i >= words.length && pipeIn && words.length === 1) inspectPipedScript(earlier, 'powershell', ctx, bulk, via.concat(name));
      emit(ctx, name, words.slice(1), redirects, shell, pipeIn, bulk, via);
      return;
    }
    if (name === 'cmd') {
      const idx = words.findIndex((w, k) => k > 0 && /^\/[ck]$/i.test(w));
      if (idx !== -1) parseInto(words.slice(idx + 1).join(' '), 'cmd', ctx, bulk, via.concat('cmd'));
      else if (pipeIn) inspectPipedScript(earlier, 'cmd', ctx, bulk, via.concat('cmd'));
      emit(ctx, name, words.slice(1), redirects, shell, pipeIn, bulk, via);
      return;
    }
    break;
  }
  if (words.length === 0) {
    if (redirects.length > 0) emit(ctx, '', [], redirects, shell, pipeIn, bulk, via);
    return;
  }
  let name = cmdName(words[0] ?? '');
  let args = words.slice(1);
  const glued = /^(del|erase|rd|rmdir|format)(\/.*)$/i.exec(words[0] ?? '');
  if (glued) {
    name = (glued[1] ?? '').toLowerCase();
    args = (glued[2] ?? '').split(/(?=\/)/).concat(args);
  }
  if (name === 'find') {
    for (let i = 0; i < args.length; i++) {
      const a = args[i] ?? '';
      if (a === '-exec' || a === '-execdir' || a === '-ok' || a === '-okdir') {
        let j = i + 1;
        while (j < args.length && args[j] !== ';' && args[j] !== '+') j++;
        const inner = args.slice(i + 1, j);
        if (inner.length > 0) handleStage(inner, [], false, shell, ctx, true, via.concat('find'), []);
        i = j;
      }
    }
  }
  if (name === 'git' && args.includes('-c')) {
    for (let i = 0; i < args.length; i++) {
      const v = args[i + 1] ?? '';
      if (args[i] === '-c' && /^alias\./i.test(v)) {
        const body = v.slice(v.indexOf('=') + 1).replace(/^!/, '');
        parseInto(body, 'posix', ctx, bulk, via.concat('git-alias'));
      }
    }
  }
  if (name.startsWith('$') || name.includes('$(') || name.includes('`')) {
    ctx.opaque.push(`the command name is computed at run time (${words[0] ?? ''})`);
  }
  emit(ctx, name, args, redirects, shell, pipeIn, bulk, via);
}

const PRINTERS = new Set(['echo', 'printf', 'write-output', 'write-host', 'print']);

function inspectPipedScript(earlier: SimpleCommand[], shell: ShellKind, ctx: Ctx, bulk: boolean, via: string[]): void {
  const sources = earlier.filter((c) => !c.via.some((v) => v === 'find'));
  if (sources.length === 0) {
    ctx.opaque.push('a shell reads commands from a pipe whose source is not visible');
    return;
  }
  for (const src of sources) {
    if (PRINTERS.has(src.name)) {
      const text = src.args.filter((a) => !/^-[neE]+$/.test(a)).join(' ').replace(/\\n/g, '\n');
      parseInto(text, shell, ctx, bulk, via);
    } else {
      ctx.opaque.push(`a shell runs commands piped from '${src.name}', whose output is not visible before it runs`);
    }
  }
}

export function parseCommand(text: string, shell: ShellKind = 'posix'): ParsedCommand {
  const ctx: Ctx = { depth: 0, vars: new Map<string, string>(), out: [], opaque: [] };
  parseInto(text, shell, ctx, false, []);
  return { text, shell, commands: ctx.out, opaque: ctx.opaque };
}
