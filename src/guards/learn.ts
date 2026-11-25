import { basename } from 'node:path';
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

/** File names an agent loads at the start of every session, wherever they sit. */
export const INSTRUCTION_FILES: ReadonlySet<string> = new Set(['AGENTS.md', 'AGENT.md', 'CLAUDE.md', 'CLAUDE.local.md', 'GEMINI.md', 'MEMORY.md', '.cursorrules', '.windsurfrules', 'copilot-instructions.md']);
/** Folders whose files are rules an agent loads: `<parent>/<folder>/...`. */
const RULE_FOLDERS: readonly (readonly [string, string])[] = [['.claude', 'rules'], ['.cursor', 'rules'], ['.windsurf', 'rules'], ['.github', 'instructions']];
/** Folders of skills, sub-agents and commands. */
const SKILL_FOLDERS: readonly (readonly [string, string])[] = [['.claude', 'skills'], ['.claude', 'agents'], ['.claude', 'commands'], ['.agents', 'skills'], ['.codex', 'skills'], ['.gemini', 'commands']];

export const DEFAULT_LEARN_TOKENS = 10000;
/** The most of an existing instructions file read to work out its size after an edit. */
const MAX_READ = 4 * 1024 * 1024;
/** Commands that write to the paths they name (beyond redirects). */
const WRITERS: ReadonlySet<string> = new Set(['tee', 'cp', 'mv', 'install', 'ln', 'rsync', 'curl', 'wget', 'unzip', 'tar', 'dd', 'copy', 'move', 'copy-item', 'move-item', 'set-content', 'add-content', 'out-file']);

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
  const parts = path.split(/[\\/]+/).filter((p) => p !== '');
  const name = parts[parts.length - 1] ?? '';
  if (name === 'SKILL.md' || pairAt(parts, SKILL_FOLDERS)) return 'skill';
  if (INSTRUCTION_FILES.has(name) || pairAt(parts, RULE_FOLDERS) || parts.includes('.clinerules')) return 'instructions';
  const claude = parts.indexOf('.claude');
  if (claude !== -1 && parts.slice(claude + 1, -1).includes('memory')) return 'memory';
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

function scanDecision(f: ScanFinding, cfg: Decision): Decision | null {
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
    const rules = kind === 'skill' ? SCAN_RULES : INJECT_RULES;
    const rep = scanFiles([{ path: name, kind: classifyFile(name, added.text), text: added.text }], { rules });
    let worst: Decision | null = null;
    for (const f of rep.findings) {
      const d = scanDecision(f, cfg.decision);
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

/** The paths one shell command writes, besides redirects: its words after the command name, for commands that write. */
function writtenWords(c: SimpleCommand): string[] {
  const name = cmdName(c.name).toLowerCase();
  const words = c.args.filter((a) => !a.startsWith('-') || a.startsWith('of='));
  if (WRITERS.has(name)) return words.map((w) => (w.startsWith('of=') ? w.slice(3) : w));
  if ((name === 'sed' || name === 'gsed' || /^perl[\d.]*$/.test(name)) && c.args.some((a) => a === '-i' || a.startsWith('-i') || a.startsWith('--in-place'))) return words;
  if (name === 'git' && words[0] === 'clone') return words.slice(1);
  return [];
}

function execFindings(ctx: GuardContext, cfg: LearnBylaws): Finding[] {
  if (ctx.parsed === null) return [];
  for (const c of ctx.parsed.commands) {
    const targets: { word: string; via: string }[] = [];
    for (const r of c.redirects) if (r.op.includes('>') && !/^\d+$/.test(r.target) && !NULL_DEVICES.has(r.target.toLowerCase())) targets.push({ word: r.target, via: `the redirect ${r.op}` });
    for (const w of writtenWords(c)) targets.push({ word: w, via: cmdName(c.name) });
    for (const t of targets) {
      const kind = learnKind(t.word);
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
