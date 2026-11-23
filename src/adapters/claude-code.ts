import { appendAudit, makeAuditRecord } from '../audit.js';
import { DEFAULT_BYLAWS, resolveBylaws } from '../bylaws.js';
import { decide, describeAction } from '../engine.js';
import { auditLogPath, configDir } from '../paths.js';
import { combineVerdict, isUnattended, recordAction, recordOutcome, sessionFindings, taintContext, unattendedVerdict } from '../session.js';
import { countToolCall, loadSession, saveSession } from '../state.js';
import type { ReviewProvider } from '../reviewer/types.js';
import { reviewVerdict } from '../reviewer/wire.js';
import type { SessionMemory } from '../session.js';
import type { TaintContext } from '../taint/index.js';
import type { Action, Bylaws, BylawsLoad, SessionState, Verdict } from '../types.js';
import { strictest } from '../types.js';

export interface ClaudeCodeHookInput {
  session_id: string | null;
  cwd: string | null;
  hook_event_name: string | null;
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string | null;
  error: string | null;
  is_interrupt: boolean;
}

export type HookInputResult = { ok: true; input: ClaudeCodeHookInput } | { ok: false; error: string };

function strField(o: Record<string, unknown>, k: string): string | null {
  const v = o[k];
  return typeof v === 'string' ? v : null;
}

export function parseHookInput(text: string): HookInputResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'the hook input on stdin is not valid JSON' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'the hook input is not a JSON object' };
  const o = raw as Record<string, unknown>;
  const tool = strField(o, 'tool_name');
  if (tool === null) return { ok: false, error: 'the hook input has no tool_name' };
  const ti = o['tool_input'];
  const toolInput = typeof ti === 'object' && ti !== null && !Array.isArray(ti) ? (ti as Record<string, unknown>) : {};
  return {
    ok: true,
    input: {
      session_id: strField(o, 'session_id'),
      cwd: strField(o, 'cwd'),
      hook_event_name: strField(o, 'hook_event_name'),
      tool_name: tool,
      tool_input: toolInput,
      tool_use_id: strField(o, 'tool_use_id'),
      error: strField(o, 'error'),
      is_interrupt: o['is_interrupt'] === true,
    },
  };
}

export function toAction(toolName: string, input: Record<string, unknown>): Action {
  const s = (k: string): string | null => {
    const v = input[k];
    return typeof v === 'string' ? v : null;
  };
  switch (toolName) {
    case 'Bash':
      return { kind: 'exec', command: s('command') ?? '', shell: 'posix', tool: toolName };
    case 'PowerShell':
      return { kind: 'exec', command: s('command') ?? '', shell: 'powershell', tool: toolName };
    case 'Read':
    case 'NotebookRead':
      return { kind: 'read', path: s('file_path') ?? s('notebook_path') ?? '', tool: toolName };
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { kind: 'write', path: s('file_path') ?? s('notebook_path') ?? '', tool: toolName };
    case 'Grep':
    case 'Glob':
    case 'LS': {
      const base = s('path') ?? '';
      const glob = s('glob') ?? (toolName === 'Glob' ? s('pattern') : null);
      const path = glob !== null ? `${base.replace(/[\\/]+$/, '')}${base === '' ? '' : '/'}${glob}` : base;
      return { kind: 'read', path, tool: toolName };
    }
    case 'WebFetch':
      return { kind: 'fetch', url: s('url') ?? '', tool: toolName };
    default:
      return { kind: 'other', tool: toolName };
  }
}

export function toHookOutput(v: Verdict): string | null {
  if (v.decision === 'allow') return null;
  const reason = `openmorals ${v.decision} [${v.rule}]: ${v.reason}`;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: v.decision, permissionDecisionReason: reason } });
}

export interface HookRun {
  stdout: string;
  exitCode: 0;
  verdict: Verdict;
}

export interface HookOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: Date;
  unattended?: boolean;
}

export const POST_EVENTS: readonly string[] = ['PostToolUse', 'PostToolUseFailure'];

function failClosed(reason: string, rule: string, unattended: boolean): HookRun {
  const base: Verdict = { decision: 'ask', rule, reason };
  const verdict = unattended ? unattendedVerdict(base) : base;
  return { stdout: toHookOutput(verdict) ?? '', exitCode: 0, verdict };
}

function recordPost(input: ClaudeCodeHookInput, env: NodeJS.ProcessEnv, now: Date | undefined): HookRun {
  const quiet = (reason: string): HookRun => ({ stdout: '', exitCode: 0, verdict: { decision: 'allow', rule: 'hook.post-event', reason } });
  if (input.hook_event_name === 'PostToolUseFailure' && input.is_interrupt) return quiet('an interrupted call is not a failure');
  const session = input.session_id ?? 'unknown';
  const dir = configDir(env);
  const loaded = loadSession(session, dir);
  const outcome = input.hook_event_name === 'PostToolUse' ? { ok: true } : { ok: false, error: input.error ?? 'failed' };
  const memory = recordOutcome(loaded.memory, toAction(input.tool_name, input.tool_input), outcome, input.tool_use_id);
  if (memory !== loaded.memory) saveSession(session, loaded.state, memory, dir, now);
  return quiet(`recorded the outcome of ${input.tool_name}`);
}

interface Judged {
  kind: 'judged';
  input: ClaudeCodeHookInput;
  cwd: string;
  dir: string;
  bylaws: BylawsLoad;
  effective: Bylaws;
  action: Action;
  state: SessionState;
  memory: SessionMemory;
  ctx: TaintContext;
  verdict: Verdict;
  unattended: boolean;
}

type PreResult = { kind: 'done'; run: HookRun } | Judged;

function judgePre(stdinText: string, opts: HookOptions, unattended: boolean): PreResult {
  const env = opts.env ?? process.env;
  const parsed = parseHookInput(stdinText);
  if (!parsed.ok) return { kind: 'done', run: failClosed(parsed.error, 'hook.bad-input', unattended) };
  const input = parsed.input;
  const cwd = input.cwd ?? opts.cwd ?? process.cwd();
  if (input.hook_event_name !== null && POST_EVENTS.includes(input.hook_event_name)) {
    try {
      return { kind: 'done', run: recordPost(input, env, opts.now) };
    } catch (err: unknown) {
      return { kind: 'done', run: { stdout: '', exitCode: 0, verdict: { decision: 'allow', rule: 'hook.post-event', reason: `could not record the outcome (${err instanceof Error ? err.message : String(err)})` } } };
    }
  }
  if (input.hook_event_name !== null && input.hook_event_name !== 'PreToolUse') {
    return { kind: 'done', run: { stdout: '', exitCode: 0, verdict: { decision: 'allow', rule: 'hook.other-event', reason: `openmorals only judges PreToolUse, got ${input.hook_event_name}` } } };
  }
  const dir = configDir(env);
  const bylaws = resolveBylaws(cwd, env);
  const effective = bylaws.ok ? bylaws.bylaws : DEFAULT_BYLAWS;
  const action = toAction(input.tool_name, input.tool_input);
  const loaded = loadSession(input.session_id ?? 'unknown', dir);
  const state = countToolCall(loaded.state);
  const ctx = taintContext(cwd, effective);
  let verdict = combineVerdict(decide(action, bylaws, state), sessionFindings(action, loaded.memory, effective, ctx));
  if (unattended) verdict = unattendedVerdict(verdict);
  return { kind: 'judged', input, cwd, dir, bylaws, effective, action, state, memory: loaded.memory, ctx, verdict, unattended };
}

function finishPre(j: Judged, judged: Verdict, opts: HookOptions): HookRun {
  let verdict = judged;
  const { input, dir, state, unattended } = j;
  try {
    saveSession(input.session_id ?? 'unknown', state, recordAction(j.memory, j.action, verdict, j.ctx, input.tool_use_id), dir, opts.now);
  } catch (err: unknown) {
    const d = strictest(verdict.decision, unattended ? 'deny' : 'ask');
    verdict = { decision: d, rule: d === verdict.decision && verdict.decision !== 'allow' ? verdict.rule : 'budget.unmeasured', reason: `${verdict.decision === 'allow' ? '' : `${verdict.reason}; `}the session state (budget counter, history, taint) could not be saved (${err instanceof Error ? err.message : String(err)})` };
  }
  const auditOn = !j.bylaws.ok || j.bylaws.bylaws.audit.enabled;
  if (auditOn) {
    try {
      appendAudit(
        makeAuditRecord(
          { source: 'claude-code', session: input.session_id, tool: input.tool_name, action: describeAction(j.action), decision: verdict.decision, rule: verdict.rule, reason: verdict.reason, cwd: j.cwd, budget: { tool_calls: state.toolCalls, tokens: state.tokens } },
          opts.now,
        ),
        auditLogPath(dir),
      );
    } catch (err: unknown) {
      const d = strictest(verdict.decision, unattended ? 'deny' : 'ask');
      verdict = { decision: d, rule: verdict.decision === 'allow' ? 'audit.unwritable' : verdict.rule, reason: `${verdict.decision === 'allow' ? '' : `${verdict.reason}; `}the audit log could not be written (${err instanceof Error ? err.message : String(err)})` };
    }
  }
  return { stdout: toHookOutput(verdict) ?? '', exitCode: 0, verdict };
}

function internalError(err: unknown, unattended: boolean): HookRun {
  return failClosed(`openmorals hit an internal error (${err instanceof Error ? err.message : String(err)}) and fails closed`, 'engine.error', unattended);
}

/** Synchronous hook: the guards, the loop detector and the taint judge. It never calls the reviewer. */
export function runClaudeCodeHook(stdinText: string, opts: HookOptions = {}): HookRun {
  let unattended = opts.unattended === true;
  try {
    unattended = unattended || isUnattended(opts.env ?? process.env);
    const pre = judgePre(stdinText, opts, unattended);
    return pre.kind === 'done' ? pre.run : finishPre(pre, pre.verdict, opts);
  } catch (err: unknown) {
    return internalError(err, unattended);
  }
}

export interface ReviewedHookOptions extends HookOptions {
  /** Replaces the provider named in the bylaws (tests inject a fake one here). */
  reviewProvider?: ReviewProvider;
}

function recentContext(j: Judged): string {
  const steps = j.memory.history.slice(-5).map((h) => describeAction(h.action));
  return `host: Claude Code; tool: ${j.input.tool_name}; project folder: ${j.cwd}${steps.length > 0 ? `; recent steps: ${steps.join(' | ')}` : ''}`;
}

/**
 * The hook as the CLI runs it: runClaudeCodeHook, plus the independent reviewer when the bylaws
 * switch it on and the verdict is `ask`. The reviewer can only keep or tighten the verdict, a
 * failure keeps the `ask`, and in unattended runs it is skipped (an ask is already a deny there).
 */
export async function runClaudeCodeHookReviewed(stdinText: string, opts: ReviewedHookOptions = {}): Promise<HookRun> {
  let unattended = opts.unattended === true;
  try {
    const env = opts.env ?? process.env;
    unattended = unattended || isUnattended(env);
    const pre = judgePre(stdinText, opts, unattended);
    if (pre.kind === 'done') return pre.run;
    let verdict = pre.verdict;
    const cfg = pre.effective.reviewer;
    if (pre.bylaws.ok && cfg.enabled && verdict.decision === 'ask' && !unattended) {
      verdict = (await reviewVerdict(pre.action, verdict, cfg, { env, provider: opts.reviewProvider, context: recentContext(pre) })).verdict;
    }
    return finishPre(pre, verdict, opts);
  } catch (err: unknown) {
    return internalError(err, unattended);
  }
}
