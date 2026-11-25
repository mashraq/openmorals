import { basename, posix } from 'node:path';
import type { Finding, Guard, GuardContext, Where } from '../guard.js';
import { makeWhere, quoteForReason } from '../guard.js';
import { SCAN_RULES, classifyFile, scanFiles } from '../scanner/index.js';
import type { ScanFinding } from '../scanner/types.js';
import type { SimpleCommand } from '../shell.js';
import { cmdName } from '../shell.js';
import type { Action, Bylaws, Decision, LearnBylaws } from '../types.js';
import { documentPath } from './document.js';
import { NULL_DEVICES } from './moves.js';

/**
 * The learn guard (0.35.0): guards what an agent writes into the files that teach later sessions. Three kinds:
 * - `instructions`: files the agent loads at the start of every session (AGENTS.md, CLAUDE.md, GEMINI.md, rule folders,
 *   a memory index). A line written here reaches every later session, so a wrong or planted line keeps working.
 * - `memory`: notes an agent keeps for itself in a memory folder, read back on demand.
 * - `skill`: skills, sub-agent and command definitions, which can carry instructions and code.
 * A write to one of them is scanned (hidden instructions for instructions and memory; every scanner rule for a skill),
 * an instructions file that grows past a token budget is flagged, and a write from the shell, whose content openmorals
 * cannot see, is asked about. The session check (`learnTaintFinding`) asks before such a write in a session that has
 * read untrusted content.
 */

export type LearnKind = 'instructions' | 'memory' | 'skill';

/**
 * File names an agent loads at the start of every session, wherever they sit. Compared in lower case: on a
 * case-insensitive disk (macOS, Windows) `claude.md` is the same file as `CLAUDE.md`.
 */
export const INSTRUCTION_FILES: ReadonlySet<string> = new Set(['agents.md', 'agents.override.md', 'agent.md', 'claude.md', 'claude.local.md', 'gemini.md', 'memory.md', '.cursorrules', '.windsurfrules', 'copilot-instructions.md']);
/** Folders whose files are rules, prompts or output styles an agent loads: `<parent>/<folder>/...`. */
const RULE_FOLDERS: readonly (readonly [string, string])[] = [['.claude', 'rules'], ['.claude', 'output-styles'], ['.cursor', 'rules'], ['.windsurf', 'rules'], ['.github', 'instructions'], ['.github', 'prompts']];
/** Folders of skills, sub-agents and commands. */
const SKILL_FOLDERS: readonly (readonly [string, string])[] = [['.claude', 'skills'], ['.claude', 'agents'], ['.claude', 'commands'], ['.agents', 'skills'], ['.codex', 'skills'], ['.gemini', 'commands']];
/** Folders under `.claude` that hold an agent's own memory notes. */
const MEMORY_FOLDERS: ReadonlySet<string> = new Set(['memory', 'agent-memory']);

export const DEFAULT_LEARN_TOKENS = 10000;
/** The most of an existing instructions file read to work out its size after an edit. */
const MAX_READ = 4 * 1024 * 1024;
/** Commands that write to the paths they name (beyond redirects). */
/** Commands whose every path word is written. */
const ALL_WORDS: ReadonlySet<string> = new Set(['tee', 'set-content', 'add-content', 'out-file', 'ex', 'patch', 'truncate', 'touch']);
/** Commands that copy or move into their last path word, or into the folder `-t` names. */
const COPIERS: ReadonlySet<string> = new Set(['cp', 'mv', 'install', 'ln', 'rsync', 'scp', 'copy', 'move', 'copy-item', 'move-item']);
/** Interpreters whose inline code (`-c`, `-e`) may write anywhere. */
const INLINE: ReadonlySet<string> = new Set(['python', 'python3', 'node', 'deno', 'bun', 'ruby', 'perl', 'php']);

export function defaultLearnBylaws(): LearnBylaws {
  return { decision: 'ask', tokens: DEFAULT_LEARN_TOKENS };
}

export function learnBylaws(b: Bylaws): LearnBylaws {
  return b.guards.learn ?? defaultLearnBylaws();
}

function pairAt(parts: readonly string[], pairs: readonly (readonly [string, string])[]): boolean {
  for (let i = 0; i + 1 < parts.length; i++) for (const [a, b] of pairs) if (parts[i] === a && parts[i + 1] === b) return true;
  return false;
}

/** Which kind of file teaches later sessions, from its path alone, or null. A folder path counts when it is (or is in) a skills or rules folder. */
export function learnKind(path: string): LearnKind | null {
  // Normalised (so `.claude/./rules` and `.claude/x/../rules` are seen) and lower-cased (see INSTRUCTION_FILES).
  const norm = posix.normalize(path.replace(/\\/g, '/')).toLowerCase();
  const parts = norm.split('/').filter((p) => p !== '' && p !== '.');
  const name = parts[parts.length - 1] ?? '';
  if (name === 'skill.md' || pairAt(parts, SKILL_FOLDERS)) return 'skill';
  if (INSTRUCTION_FILES.has(name) || pairAt(parts, RULE_FOLDERS) || parts.includes('.clinerules')) return 'instructions';
  const claude = parts.indexOf('.claude');
  if (claude !== -1 && parts.slice(claude + 1, -1).some((p) => MEMORY_FOLDERS.has(p))) return 'memory';
  return null;
}

const KIND_TEXT: Readonly<Record<LearnKind, string>> = {
  instructions: 'an instructions file the agent loads at the start of every session',
  memory: "a note in the agent's memory, which later sessions read back",
  skill: 'a skill or agent definition that later sessions can load and run',
};

/** The learn kind of the file a write action names, or null. */
export function learnTarget(action: Action): LearnKind | null {
  return action.kind === 'write' && action.change?.kind !== 'delete' ? learnKind(action.path) : null;
}

/** The text a write adds: the whole content, a patch's added lines, or each edit's new text. Null when the host gave none. */
function addedText(action: Extract<Action, { kind: 'write' }>): { text: string; cut: boolean } | null {
  const ch = action.change;
  if (ch?.kind === 'replace') return { text: ch.edits.map((e) => e.new.text).join('\n'), cut: ch.edits.some((e) => e.new.cut) };
  if (action.content === undefined) return null;
  return { text: action.content.text, cut: action.content.cut };
}

const INJECT_RULES = SCAN_RULES.filter((r) => r.id.startsWith('inject.'));
/**
 * For instructions and memory notes, beside hidden instructions: a line that sends secrets out or downloads and runs
 * code. Such a line in a file every session loads asks (never refuses on its own), since install notes can hold one.
 */
const RUN_RULES: ReadonlySet<string> = new Set(['secret.exfiltration', 'exec.pipe-to-shell', 'exec.download-then-run', 'exec.decode-and-run', 'exec.reverse-shell']);
const NOTE_RULES = SCAN_RULES.filter((r) => r.id.startsWith('inject.') || RUN_RULES.has(r.id));

function scanDecision(f: ScanFinding, cfg: Decision, kind: LearnKind): Decision | null {
  if (kind !== 'skill' && RUN_RULES.has(f.ruleId)) return cfg;
  if (f.severity === 'critical') return 'deny';
  if (f.severity === 'high' || f.severity === 'medium') return cfg;
  return null;
}

/** The size in tokens (about four bytes each) an instructions file has after a write, and before it; null when it cannot be told. */
export function sizesAfter(action: Extract<Action, { kind: 'write' }>, where: Where): { before: number; after: number } | null {
  const abs = documentPath(action.path, where);
  if (abs === null) return null;
  const ch = action.change;
  const needText = ch?.kind === 'replace';
  const probe = where.readFile(abs, needText ? MAX_READ : 0);
  const before = probe.kind === 'file' ? probe.bytes : probe.kind === 'missing' ? 0 : null;
  if (before === null) return null;
  let after: number;
  if (ch === undefined || ch.kind === 'whole') {
    if (action.content === undefined) return null;
    after = action.content.bytes;
  } else if (ch.kind === 'lines') {
    after = before + (action.content?.bytes ?? 0) - ch.removed.bytes;
  } else if (ch.kind === 'replace') {
    const text = probe.kind === 'file' ? probe.text : undefined;
    after = before;
    for (const e of ch.edits) {
      const n = e.all && text !== undefined && !e.old.cut && e.old.text !== '' ? Math.max(1, text.split(e.old.text).length - 1) : 1;
      after += n * (e.new.bytes - e.old.bytes);
    }
  } else return null;
  return { before: Math.ceil(before / 4), after: Math.ceil(Math.max(0, after) / 4) };
}

function writeFindings(action: Extract<Action, { kind: 'write' }>, kind: LearnKind, cfg: LearnBylaws, where: Where): Finding[] {
  const out: Finding[] = [];
  const shown = quoteForReason(action.path, 80);
  const added = addedText(action);
  if (added === null) {
    out.push({ decision: cfg.decision, rule: 'learn.unseen', reason: `${action.tool} writes ${shown}, ${KIND_TEXT[kind]}, and the host did not pass what it writes, so it cannot be scanned` });
  } else if (added.text !== '') {
    const name = basename(action.path.replace(/\\/g, '/'));
    const rules = kind === 'skill' ? SCAN_RULES : NOTE_RULES;
    const rep = scanFiles([{ path: name, kind: classifyFile(name, added.text), text: added.text }], { rules });
    let worst: Decision | null = null;
    for (const f of rep.findings) {
      const d = scanDecision(f, cfg.decision, kind);
      if (d !== null && (worst === null || d === 'deny')) worst = d;
    }
    if (worst !== null) {
      const ids = [...new Set(rep.findings.map((f) => f.ruleId))].slice(0, 4).join(', ');
      out.push({ decision: worst, rule: 'learn.scan', reason: `${action.tool} writes ${shown}, ${KIND_TEXT[kind]}, and what it adds trips the scanner (${ids}); a line there keeps working in later sessions, so check it is what you meant${added.cut ? ' (only the start and end of a long write were scanned)' : ''}` });
    }
  }
  if (kind === 'instructions' && cfg.tokens > 0) {
    const s = sizesAfter(action, where);
    if (s !== null && s.after > cfg.tokens && s.after > s.before) {
      out.push({ decision: cfg.decision, rule: 'learn.budget', reason: `${action.tool} grows ${shown} to about ${s.after.toLocaleString('en-US')} tokens (from about ${s.before.toLocaleString('en-US')}), past the ${cfg.tokens.toLocaleString('en-US')}-token budget for a file every session loads; every session pays for each line, and a long file buries the lines that matter` });
    }
  }
  return out;
}

/** Split `--opt=value` into `--opt value`, so a value given either way is read the same. */
function splitArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (const a of args) {
    const m = /^(--[a-z][a-z-]*)=(.*)$/i.exec(a);
    if (m) out.push(m[1] as string, m[2] as string);
    else out.push(a);
  }
  return out;
}

/** The value after any of `flags` (`-o x`, `-ox`, `--output x`). */
function flagValues(args: readonly string[], flags: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    for (const f of flags) {
      if (a === f && i + 1 < args.length) out.push(args[i + 1] as string);
      else if (f.length === 2 && !f.startsWith('--') && a.startsWith(f) && a.length > 2 && !a.startsWith('--')) out.push(a.slice(2));
    }
  }
  return out;
}

/** Words that are not flags or flag values, for a command whose flags in `withValue` take one. */
function positional(args: readonly string[], withValue: readonly string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--') { out.push(...args.slice(i + 1)); break; }
    if (a.startsWith('-') && a !== '-') { if (withValue.includes(a)) i++; continue; }
    out.push(a);
  }
  return out;
}

/** Path-like tokens in a piece of inline code. */
function codeTokens(code: string): string[] {
  return code.split(/["'`\s(),;:{}[\]+]+/).filter((t) => t !== '');
}

/**
 * The paths one shell command writes, besides redirects. Only destinations count: `cp CLAUDE.md /tmp/b.md` reads
 * CLAUDE.md and writes /tmp/b.md.
 */
function writtenWords(c: SimpleCommand): string[] {
  const name = cmdName(c.name);
  const args = splitArgs(c.args);
  if (ALL_WORDS.has(name)) return positional(args);
  if (COPIERS.has(name)) {
    const into = flagValues(args, ['-t', '--target-directory', '-destination', '-path']);
    if (into.length > 0) return into;
    const pos = positional(args, ['-S', '--suffix', '-m', '--mode', '-o', '--owner', '-g', '--group', '-e', '--rsh']);
    return pos.length > 1 ? [pos[pos.length - 1] as string] : [];
  }
  if (name === 'curl') return flagValues(args, ['-o', '--output', '--output-dir']);
  if (name === 'wget') return flagValues(args, ['-O', '--output-document', '-P', '--directory-prefix']);
  if (name === 'tar' || name === 'bsdtar') return flagValues(args, ['-C', '--directory']);
  if (name === 'unzip' || name === '7z') return [...flagValues(args, ['-d']), ...args.filter((a) => a.startsWith('-o') && a.length > 2).map((a) => a.slice(2))];
  if (name === 'dd') return args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3));
  if (name === 'git' && args[0] === 'clone') return positional(args.slice(1), ['-b', '--branch', '--depth', '-o', '--origin', '-c', '--config']).slice(1);
  // `-i`, alone or bundled with switches that take no value (`sed -Ei`, `perl -pi`); `perl -Ilib` is not in place.
  if ((name === 'sed' || name === 'gsed') && args.some((a) => /^-[nErsuzl]*i/.test(a) || a.startsWith('--in-place'))) return positional(args, ['-e', '--expression', '-f', '--file']);
  if (/^perl[\d.]*$/.test(name) && args.some((a) => /^-[pnlawsTtWX]*i/.test(a))) return positional(args, ['-e', '-E', '-M', '-I', '-m']);
  if ((name === 'awk' || name === 'gawk') && args.some((a, i) => (a === '-i' || a === '--include') && args[i + 1] === 'inplace')) return positional(args, ['-i', '--include', '-f', '-v', '-F']);
  if (INLINE.has(name.replace(/[\d.]+$/, '')) || /^python[\d.]*$/.test(name)) return flagValues(args, ['-c', '-e', '--eval', '-p', '--print', '-r']).flatMap(codeTokens);
  return [];
}

/** A target as seen from the folder an earlier `cd` in the same command moved to. */
function fromCwd(word: string, cwd: string | null): string {
  if (cwd === null || /^([\\/~]|[a-z]:)/i.test(word)) return word;
  return `${cwd}/${word}`;
}

function execFindings(ctx: GuardContext, cfg: LearnBylaws): Finding[] {
  if (ctx.parsed === null) return [];
  let cwd: string | null = null;
  for (const c of ctx.parsed.commands) {
    const name = cmdName(c.name);
    if (name === 'cd' || name === 'pushd' || name === 'set-location') {
      const to = positional(c.args)[0];
      if (to !== undefined && to !== '-') cwd = fromCwd(to, cwd);
      continue;
    }
    const targets: { word: string; via: string }[] = [];
    for (const r of c.redirects) if (r.op.includes('>') && !/^\d+$/.test(r.target) && !NULL_DEVICES.has(r.target.toLowerCase())) targets.push({ word: r.target, via: `the redirect ${r.op}` });
    for (const w of writtenWords(c)) targets.push({ word: w, via: cmdName(c.name) });
    for (const t of targets) {
      const kind = learnKind(fromCwd(t.word, cwd));
      if (kind === null) continue;
      return [{ decision: cfg.decision, rule: 'learn.shell-write', reason: `${t.via} writes ${quoteForReason(t.word, 80)}, ${KIND_TEXT[kind]}, from the shell, where openmorals cannot see or scan what goes in; use the agent's file-edit tool so the change can be checked` }];
    }
  }
  return [];
}

export const learnGuard: Guard = {
  id: 'learn',
  isHard: () => false,
  evaluate(ctx: GuardContext): Finding[] {
    const cfg = learnBylaws(ctx.bylaws);
    if (cfg.decision === 'allow') return [];
    if (ctx.action.kind === 'exec') return execFindings(ctx, cfg);
    const kind = learnTarget(ctx.action);
    if (kind === null || ctx.action.kind !== 'write') return [];
    return writeFindings(ctx.action, kind, cfg, ctx.where ?? makeWhere());
  },
};

/**
 * The session half (0.35.0): a write to a file that teaches later sessions, in a session that has read untrusted content
 * (a web page, a search, an MCP tool's output, a file from outside the project). What the agent writes there may come
 * from that content rather than from the person, and it would load into every later session.
 */
export function learnTaintFinding(action: Action, untrusted: { count: number; injected: number; last: string | null }, bylaws: Bylaws): Finding | null {
  const cfg = learnBylaws(bylaws);
  if (cfg.decision === 'allow' || untrusted.count === 0) return null;
  const kind = learnTarget(action);
  if (kind === null || action.kind !== 'write') return null;
  const from = untrusted.last !== null ? ` (${untrusted.last})` : '';
  const hidden = untrusted.injected > 0 ? ', and hidden instructions were found in it' : '';
  return {
    decision: cfg.decision,
    rule: 'learn.tainted-write',
    reason: `this session has read untrusted content${from}${hidden}, and ${action.tool} writes ${quoteForReason(action.path, 80)}, ${KIND_TEXT[kind]}; check the change comes from you, not from that content, because it will keep working in later sessions`,
  };
}
