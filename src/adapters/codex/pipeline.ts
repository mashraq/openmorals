// Shared by the codex, gemini-cli and opencode adapters (see docs/adapters.md, "Wiring needed").
import { appendAuditText, auditMeta, chainAudit, makeAuditRecord } from '../../audit.js';
import { effectiveBylaws, resolveBylaws } from '../../bylaws.js';
import { BUILTIN_GUARDS, decide, describeAction } from '../../engine.js';
import { namedDetectors } from '../../rules/detectors.js';
import type { Where } from '../../guard.js';
import { makeWhere } from '../../guard.js';
import { auditLogPath, configDir } from '../../paths.js';
import { combineVerdict, isUnattended, outboundView, recordAction, sessionFindings, taintContext, unattendedVerdict, unreadableFindings } from '../../session.js';
import { appendAuditForSession, countToolCall, loadSession, saveSession, settleBudget } from '../../state.js';
import type { Action, Bylaws, BylawsLoad, Decision, SessionState, ShellKind, Verdict } from '../../types.js';
import type { SessionMemory } from '../../session.js';
import type { TaintContext } from '../../taint/index.js';
import type { InboundOutcome } from '../../inbound/index.js';
import type { Outcome } from '../../loop/index.js';
import { decisionRank, strictest } from '../../types.js';
import { scanOutbound } from '../../inbound/outbound.js';
import { reduceTaint } from '../../taint/index.js';

export interface JudgeRequest {
  source: string;
  session: string | null;
  cwd: string | null;
  tool: string;
  actions: readonly Action[];
  extra?: (bylaws: Bylaws) => readonly Verdict[];
  countCall: boolean;
  /** The host's event name, for the audit record (0.8.0). */
  event?: string | null;
  /** The host's agent id, when it sends one (0.8.0). */
  agent?: string | null;
}

export interface JudgeOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: Date;
  /** Every ask becomes deny (also set by OPENMORALS_UNATTENDED). */
  unattended?: boolean;
  /** The platform the host runs on (default `process.platform`); it decides which shell dialects a command is read in. */
  platform?: NodeJS.Platform;
}

/** The dialects a Windows host's shell command may run in: PowerShell, a POSIX shell (Git Bash, WSL, MSYS) or cmd.exe. */
export const WINDOWS_DIALECTS: readonly ShellKind[] = Object.freeze(['powershell', 'posix', 'cmd'] as const);

const DIALECT_LABEL: Readonly<Record<ShellKind, string>> = { powershell: 'PowerShell', posix: 'a POSIX shell (Git Bash, WSL)', cmd: 'cmd.exe' };

/** The dialect a host's shell command is read in first: PowerShell on Windows, POSIX elsewhere. */
export function hostShell(platform: NodeJS.Platform): ShellKind {
  return platform === 'win32' ? 'powershell' : 'posix';
}

/**
 * Every reading of one action. Codex, Gemini CLI and opencode do not say which shell runs a command, and on Windows it
 * may be PowerShell, cmd.exe, Git Bash or WSL, where `rm -rf` means three different things. So on Windows a shell
 * command is read in every dialect and the strictest verdict wins: a command is never judged more loosely on Windows
 * than on macOS or Linux. Elsewhere, and for actions that are not shell commands, the action itself.
 */
export function readingsOf(action: Action, platform: NodeJS.Platform): Action[] {
  if (action.kind !== 'exec' || platform !== 'win32') return [action];
  return [action, ...WINDOWS_DIALECTS.filter((d) => d !== action.shell).map((shell): Action => ({ ...action, shell }))];
}

/** Judges each reading; the first (the host's own dialect) wins ties, and a stricter other reading says which dialect it came from. */
function judgeReadings(action: Action, platform: NodeJS.Platform, load: BylawsLoad, state: SessionState, session: { memory: SessionMemory; bylaws: Bylaws; ctx: TaintContext } | null, where: Where): Verdict {
  const readings = readingsOf(action, platform);
  let best: Verdict | null = null;
  let from: Action = action;
  for (const r of readings) {
    const d = decide(r, load, state, BUILTIN_GUARDS, where);
    const v = session === null ? d : combineVerdict(d, sessionFindings(r, session.memory, session.bylaws, session.ctx));
    if (best === null || decisionRank(v.decision) > decisionRank(best.decision)) {
      best = v;
      from = r;
    }
  }
  if (best === null) return NO_OBJECTION;
  if (from === action || from.kind !== 'exec') return best;
  return { ...best, reason: `${best.reason} (read as a command for ${DIALECT_LABEL[from.shell]}: on Windows openmorals reads a command in every shell the host may use and keeps the strictest answer)` };
}

export function unattendedOf(opts: JudgeOptions): boolean {
  if (opts.unattended === true) return true;
  try {
    return isUnattended(opts.env ?? process.env);
  } catch {
    return false;
  }
}

/** The fail-closed answer: ask, or deny in unattended runs. */
export function failVerdict(reason: string, rule: string, opts: JudgeOptions): Verdict {
  const v: Verdict = { decision: 'ask', rule, reason };
  return unattendedOf(opts) ? unattendedVerdict(v) : v;
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
  return effectiveBylaws(load);
}

function auditFields(source: string, session: string | null, tool: string, action: string, v: Verdict, cwd: string | null, state: SessionState | null, now: Date | undefined): ReturnType<typeof makeAuditRecord> {
  return makeAuditRecord({ source, session, tool, action, decision: v.decision, rule: v.rule, reason: v.reason, cwd, budget: state === null ? null : { tool_calls: state.toolCalls, tokens: state.tokens } }, now);
}

/**
 * Judges one host event: bylaws from the project, budget count, every action through `decide`,
 * then (for a counted call) the loop detector and the taint judge over the session memory, the
 * strictest verdict wins, unattended turns ask into deny, one audit line. Only a counted call
 * reads and records the session history, so a second event for the same call (opencode's
 * permission check) is not counted as a repeat.
 */
export function judge(req: JudgeRequest, opts: JudgeOptions = {}): Verdict {
  const env = opts.env ?? process.env;
  const unattended = unattendedOf(opts);
  const dir = configDir(env);
  const cwd = req.cwd ?? opts.cwd ?? process.cwd();
  const load = resolveBylaws(cwd, env);
  const effective = bylawsOf(load);
  const session = req.session ?? 'unknown';
  const loaded = loadSession(session, dir);
  const state = req.countCall ? countToolCall(loaded.state) : loaded.state;
  const actions: readonly Action[] = req.actions.length > 0 ? req.actions : [{ kind: 'other', tool: req.tool }];
  const platform = opts.platform ?? process.platform;
  const ctx = taintContext(cwd, effective, platform);
  const where = makeWhere({ configDir: dir, cwd, ...(req.countCall ? { outbound: outboundView(loaded.memory, opts.now) } : {}), ...(loaded.memory.wrote !== undefined ? { wrote: loaded.memory.wrote } : {}) }, env, platform);
  const found: Verdict[] = actions.map((a) => judgeReadings(a, platform, load, state, req.countCall ? { memory: loaded.memory, bylaws: effective, ctx } : null, where));
  if (req.extra !== undefined) found.push(...req.extra(effective));
  if (req.countCall) found.push(...unreadableFindings(loaded.memory));
  let verdict = combineVerdicts(found);
  if (unattended) verdict = unattendedVerdict(verdict);
  const auditOn = !load.ok || load.bylaws.audit.enabled;
  const meta = auditMeta({ bylaws: effective, event: req.event, agent: req.agent, env });
  const mask = namedDetectors(effective.rules);
  const describe = actions.map((a) => describeAction(a, mask)).join(' ; ');
  const outbound = req.countCall ? scanOutbound(actions, effective, { source: req.source, session: req.session, cwd }, opts.now) : null;
  const line = (v: Verdict): ReturnType<typeof chainAudit> => chainAudit([auditFields(req.source, req.session, req.tool, describe, v, cwd, state, opts.now), ...(outbound?.records ?? [])], meta, loaded.memory.chain);
  let chained = auditOn ? line(verdict) : null;
  const head = chained?.head;
  if (req.countCall) {
    try {
      let memory = loaded.memory;
      for (const a of actions) memory = recordAction(memory, a, verdict, ctx, null, mask);
      for (const t of outbound?.taint ?? []) memory = { ...memory, taint: reduceTaint(memory.taint, t, ctx) };
      saveSession(session, settleBudget(state), head !== undefined ? { ...memory, chain: head } : memory, dir, opts.now);
    } catch (err: unknown) {
      const d = strictest(verdict.decision, unattended ? 'deny' : 'ask');
      verdict = { decision: d, rule: verdict.decision === 'allow' ? 'budget.unmeasured' : verdict.rule, reason: `${verdict.decision === 'allow' ? '' : `${verdict.reason}; `}the session state (budget counter, history, taint) could not be saved (${errText(err)})` };
      if (chained !== null) chained = line(verdict);
    }
  } else if (head !== undefined) {
    try {
      saveSession(session, loaded.state, { ...loaded.memory, chain: head }, dir, opts.now);
    } catch {
      // The line is still written; the next record repeats its seq, which `audit verify` reports as a fork.
    }
  }
  if (chained !== null) {
    try {
      appendAuditText(chained.text, auditLogPath(dir));
    } catch (err: unknown) {
      const d = strictest(verdict.decision, unattended ? 'deny' : 'ask');
      verdict = { decision: d, rule: verdict.decision === 'allow' ? 'audit.unwritable' : verdict.rule, reason: `${verdict.decision === 'allow' ? '' : `${verdict.reason}; `}the audit log could not be written (${errText(err)})` };
    }
  }
  return verdict;
}

/** Best-effort audit of a fail-closed answer given before the event could be read; never throws. */
export function auditFailure(source: string, v: Verdict, opts: JudgeOptions = {}): void {
  try {
    const env = opts.env ?? process.env;
    appendAuditForSession(null, [auditFields(source, null, 'unknown', '(unreadable hook input)', v, opts.cwd ?? null, null, opts.now)], auditMeta({ bylaws: null, event: null, agent: null, env }), configDir(env), opts.now);
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

/**
 * The answer to an inbound scan on a host whose post-tool and prompt hooks read `hookSpecificOutput.additionalContext`
 * (for the model) and `systemMessage` (for the user): Codex and Gemini CLI. A prompt the bylaws deny is blocked with
 * `decision` set to `blockWord` and the reason for the user. A tool result is never blocked here: on both hosts a
 * post-tool block replaces or hides the result, and openmorals never stops the agent reading. `empty` is printed when
 * there is nothing to say.
 */
export function inboundHookOutput(hookEventName: string, o: InboundOutcome, blockWord: 'block' | 'deny', empty: string): string {
  if (o.origin === 'prompt' && o.verdict.decision === 'deny') return JSON.stringify({ decision: blockWord, reason: o.userNotice ?? `openmorals blocked this message [${o.verdict.rule}]` });
  if (o.notice === null && o.userNotice === null) return empty;
  const out: Record<string, unknown> = {};
  if (o.userNotice !== null) out['systemMessage'] = o.userNotice;
  if (o.notice !== null) out['hookSpecificOutput'] = { hookEventName: hookEventName, additionalContext: o.notice };
  return JSON.stringify(out);
}

/** The fail-closed inbound outcome when the event itself cannot be read or handled: a notice, or a block for an unattended prompt. */
export function inboundFailure(origin: 'tool-result' | 'prompt', reason: string, opts: JudgeOptions): InboundOutcome {
  const unattended = unattendedOf(opts);
  const deny = origin === 'prompt' && unattended;
  const subject = origin === 'prompt' ? "the user's message" : 'this tool result';
  return {
    origin,
    verdict: { decision: deny ? 'deny' : 'ask', rule: 'inbound.error', reason },
    notice: null,
    userNotice: deny ? 'openmorals blocked this message: it could not be scanned for hidden instructions (unattended run).' : `openmorals: ${subject} could not be scanned for hidden instructions (${reason.slice(0, 160)}).`,
    taint: null,
    scan: null,
    record: false,
  };
}

/** INFERRED from the documented "tool-specific output": a result object with a non-zero exit code, `success: false` or `is_error: true` is a failure. */
export function outcomeOfResult(resp: unknown): Outcome {
  if (!isRecord(resp)) return { ok: true };
  const code = resp['exit_code'] ?? resp['exitCode'];
  const failed = (typeof code === 'number' && code !== 0) || resp['success'] === false || resp['is_error'] === true || (typeof resp['error'] === 'string' && resp['error'] !== '');
  if (!failed) return { ok: true };
  const err = strOf(resp, 'error') ?? strOf(resp, 'stderr') ?? strOf(resp, 'output') ?? `exit code ${String(code)}`;
  return { ok: false, error: err };
}
