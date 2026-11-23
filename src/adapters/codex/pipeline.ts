// Shared by the codex, gemini-cli and opencode adapters (see docs/adapters.md, "Wiring needed").
import { appendAudit, makeAuditRecord } from '../../audit.js';
import { DEFAULT_BYLAWS, resolveBylaws } from '../../bylaws.js';
import { decide, describeAction } from '../../engine.js';
import { auditLogPath, configDir } from '../../paths.js';
import { countToolCall, loadSessionState, saveSessionState } from '../../state.js';
import type { Action, Bylaws, Decision, SessionState, Verdict } from '../../types.js';
import { decisionRank, strictest } from '../../types.js';

export interface JudgeRequest {
  source: string;
  session: string | null;
  cwd: string | null;
  tool: string;
  actions: readonly Action[];
  extra?: (bylaws: Bylaws) => readonly Verdict[];
  countCall: boolean;
}

export interface JudgeOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: Date;
}

export const NO_OBJECTION: Verdict = Object.freeze({ decision: 'allow', rule: 'none', reason: 'no guard objected' });

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function strOf(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === 'string' ? v : null;
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function parseJsonObject(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'the hook input on stdin is not valid JSON' };
  }
  if (!isRecord(raw)) return { ok: false, error: 'the hook input is not a JSON object' };
  return { ok: true, value: raw };
}

export function combineVerdicts(verdicts: readonly Verdict[]): Verdict {
  let best: Verdict | null = null;
  for (const v of verdicts) {
    if (best === null || decisionRank(v.decision) > decisionRank(best.decision)) best = v;
  }
  return best ?? NO_OBJECTION;
}

export function reasonText(v: Verdict): string {
  return `openmorals ${v.decision} [${v.rule}]: ${v.reason}`;
}

function bylawsOf(load: ReturnType<typeof resolveBylaws>): Bylaws {
  return load.ok ? load.bylaws : DEFAULT_BYLAWS;
}

function audit(source: string, session: string | null, tool: string, action: string, v: Verdict, cwd: string | null, state: SessionState | null, dir: string, now: Date | undefined): void {
  appendAudit(
    makeAuditRecord(
      { source, session, tool, action, decision: v.decision, rule: v.rule, reason: v.reason, cwd, budget: state === null ? null : { tool_calls: state.toolCalls, tokens: state.tokens } },
      now,
    ),
    auditLogPath(dir),
  );
}

/** Judges one host event: bylaws from the project, budget count, every action through `decide`, the strictest verdict wins, one audit line. */
export function judge(req: JudgeRequest, opts: JudgeOptions = {}): Verdict {
  const env = opts.env ?? process.env;
  const dir = configDir(env);
  const cwd = req.cwd ?? opts.cwd ?? process.cwd();
  const load = resolveBylaws(cwd, env);
  const session = req.session ?? 'unknown';
  const loaded = loadSessionState(session, dir);
  const state = req.countCall ? countToolCall(loaded) : loaded;
  const actions: readonly Action[] = req.actions.length > 0 ? req.actions : [{ kind: 'other', tool: req.tool }];
  const found: Verdict[] = actions.map((a) => decide(a, load, state));
  if (req.extra !== undefined) found.push(...req.extra(bylawsOf(load)));
  let verdict = combineVerdicts(found);
  if (req.countCall) {
    try {
      saveSessionState(session, state, dir, opts.now);
    } catch (err: unknown) {
      const d = strictest(verdict.decision, 'ask');
      verdict = { decision: d, rule: verdict.decision === 'allow' ? 'budget.unmeasured' : verdict.rule, reason: `${verdict.decision === 'allow' ? '' : `${verdict.reason}; `}the budget counter could not be saved (${errText(err)})` };
    }
  }
  if (!load.ok || load.bylaws.audit.enabled) {
    try {
      audit(req.source, req.session, req.tool, actions.map(describeAction).join(' ; '), verdict, cwd, state, dir, opts.now);
    } catch (err: unknown) {
      const d = strictest(verdict.decision, 'ask');
      verdict = { decision: d, rule: verdict.decision === 'allow' ? 'audit.unwritable' : verdict.rule, reason: `${verdict.decision === 'allow' ? '' : `${verdict.reason}; `}the audit log could not be written (${errText(err)})` };
    }
  }
  return verdict;
}

/** Best-effort audit of a fail-closed answer given before the event could be read; never throws. */
export function auditFailure(source: string, v: Verdict, opts: JudgeOptions = {}): void {
  try {
    const env = opts.env ?? process.env;
    audit(source, null, 'unknown', '(unreadable hook input)', v, opts.cwd ?? null, null, configDir(env), opts.now);
  } catch {
    // The answer is already fail-closed; a lost audit line cannot loosen it.
  }
}

const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Joins an argv array into one POSIX command line the core parser can read (so `bash -lc '...'` is still seen through). */
export function shellJoin(argv: readonly string[]): string {
  return argv.map((a) => (a !== '' && SAFE_WORD.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

const PATH_KEYS = new Set(['path', 'paths', 'file', 'files', 'file_path', 'filepath', 'filePath', 'filename', 'dir', 'dir_path', 'directory', 'target', 'destination', 'dest', 'source', 'uri']);
const URL_KEYS = new Set(['url', 'uri', 'href', 'endpoint']);
const WRITE_WORDS = new Set(['write', 'edit', 'create', 'update', 'patch', 'put', 'delete', 'remove', 'move', 'rename', 'append', 'save', 'upload', 'insert', 'replace', 'set', 'mkdir', 'rm']);
const DELETE_WORDS = new Set(['delete', 'destroy', 'drop', 'purge', 'remove', 'wipe', 'truncate', 'terminate', 'unpublish', 'erase', 'rm']);

export function toolWords(tool: string): string[] {
  return tool
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '');
}

/**
 * Heuristic for tools the adapter has no exact mapping for (MCP and plugin tools): a top-level string argument named like a
 * path becomes a read (or a write when the tool name has a write verb), one named like a URL becomes a fetch. It can only
 * add checks, never remove one.
 */
export function argActions(tool: string, args: unknown): Action[] {
  if (!isRecord(args)) return [];
  const writes = toolWords(tool).some((w) => WRITE_WORDS.has(w));
  const out: Action[] = [];
  for (const [k, v] of Object.entries(args)) {
    const values = typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    for (const s of values) {
      if (s === '') continue;
      if (/^https?:\/\//i.test(s) && (URL_KEYS.has(k) || PATH_KEYS.has(k))) out.push({ kind: 'fetch', url: s, tool });
      else if (PATH_KEYS.has(k)) {
        const path = s.replace(/^file:\/\//i, '');
        out.push(writes ? { kind: 'write', path, tool } : { kind: 'read', path, tool });
      }
      if (out.length >= 32) return out;
    }
  }
  return out;
}

/** An MCP tool whose name says it deletes something is treated like an online delete (ask by default). */
export function mcpDeleteVerdict(tool: string, bylaws: Bylaws): Verdict | null {
  const decision: Decision = bylaws.guards['online-delete'].decision;
  if (decision === 'allow') return null;
  const word = toolWords(tool).find((w) => DELETE_WORDS.has(w));
  if (word === undefined) return null;
  return { decision, rule: 'adapter.mcp-delete', reason: `the MCP tool ${tool} looks like it deletes something ('${word}' in its name); openmorals cannot see what it targets` };
}

const HOST_CONFIG: readonly { re: RegExp; label: string }[] = [
  { re: /(^|[\\/])\.codex[\\/](hooks\.json|config\.toml|requirements\.toml)$/i, label: 'the Codex hook configuration' },
  { re: /(^|[\\/])codex[\\/](hooks\.json|requirements\.toml)$/i, label: 'the Codex hook configuration' },
  { re: /(^|[\\/])\.gemini[\\/]settings\.json$/i, label: 'the Gemini CLI settings that hold its hooks' },
  { re: /(^|[\\/])gemini-cli[\\/]settings\.json$/i, label: 'the Gemini CLI settings that hold its hooks' },
  { re: /(^|[\\/])\.opencode[\\/]plugins?([\\/]|$)/i, label: 'the opencode plugin folder' },
  { re: /(^|[\\/])opencode[\\/]plugins?([\\/]|$)/i, label: 'the opencode plugin folder' },
  { re: /(^|[\\/])(\.opencode[\\/])?opencode\.jsonc?$/i, label: 'the opencode configuration' },
];

/** A write to an agent host's own hook or plugin configuration is a self-protect matter: the agent could switch openmorals off. */
export function hostConfigVerdicts(actions: readonly Action[], bylaws: Bylaws): Verdict[] {
  const decision: Decision = bylaws.guards['self-protect'].decision;
  if (decision === 'allow') return [];
  const out: Verdict[] = [];
  for (const a of actions) {
    if (a.kind !== 'write') continue;
    const hit = HOST_CONFIG.find((h) => h.re.test(a.path));
    if (hit !== undefined) out.push({ decision, rule: 'adapter.host-config', reason: `${a.tool} changes ${hit.label} ('${a.path}'), which can switch openmorals off` });
  }
  return out;
}
