import { appendAudit, makeAuditRecord } from '../audit.js';
import { handlePostTool, handlePrompt, textOfResult } from '../inbound/index.js';
import type { InboundOutcome } from '../inbound/index.js';
import { DEFAULT_BYLAWS, resolveBylaws } from '../bylaws.js';
import { decide, describeAction } from '../engine.js';
import { auditLogPath, configDir } from '../paths.js';
import { combineVerdict, isUnattended, recordAction, sessionFindings, taintContext, unattendedVerdict } from '../session.js';
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
  /** PostToolUse: the tool's result (its shape depends on the tool). */
  tool_response: unknown;
  /** UserPromptSubmit: the submitted text. */
  prompt: string | null;
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
  const event = strField(o, 'hook_event_name');
  const prompt = strField(o, 'prompt');
  if (event === 'UserPromptSubmit' && prompt === null) return { ok: false, error: 'the UserPromptSubmit input has no prompt' };
  const tool = event === 'UserPromptSubmit' ? 'prompt' : strField(o, 'tool_name');
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
      tool_response: o['tool_response'],
      prompt,
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

export type InboundHookEvent = 'PostToolUse' | 'PostToolUseFailure' | 'UserPromptSubmit';

/**
 * The Claude Code answer to an inbound scan (from the hooks reference, read 24 Nov 2026): the notice for the model as
 * `hookSpecificOutput.additionalContext`, the one for the user as `systemMessage`; a prompt is blocked with
 * `decision: "block"` and `suppressOriginalPrompt`. A tool result is never blocked (`decision: "block"` on PostToolUse
 * only adds a reason; the result is already in the model's context). Nothing is printed when there is nothing to say.
 */
export function toClaudeInboundOutput(event: InboundHookEvent, o: InboundOutcome): string | null {
  if (event === 'UserPromptSubmit' && o.verdict.decision === 'deny') {
    return JSON.stringify({ decision: 'block', reason: o.userNotice ?? `openmorals blocked this message [${o.verdict.rule}]`, hookSpecificOutput: { hookEventName: event, suppressOriginalPrompt: true } });
  }
  if (o.notice === null && o.userNotice === null) return null;
  const out: Record<string, unknown> = {};
  if (o.userNotice !== null) out['systemMessage'] = o.userNotice;
  if (o.notice !== null) out['hookSpecificOutput'] = { hookEventName: event, additionalContext: o.notice };
  return JSON.stringify(out);
}

function recordPost(input: ClaudeCodeHookInput, opts: HookOptions): HookRun {
  if (input.hook_event_name === 'PostToolUseFailure' && input.is_interrupt) return { stdout: '', exitCode: 0, verdict: { decision: 'allow', rule: 'hook.post-event', reason: 'an interrupted call is not a failure' } };
  const failed = input.hook_event_name === 'PostToolUseFailure';
  const content = failed ? input.error : textOfResult(input.tool_response);
  const o = handlePostTool(
    { source: 'claude-code', session: input.session_id, cwd: input.cwd, tool: input.tool_name, actions: [toAction(input.tool_name, input.tool_input)], outcome: failed ? { ok: false, error: input.error ?? 'failed' } : { ok: true }, id: input.tool_use_id, content },
    { env: opts.env, cwd: opts.cwd, now: opts.now },
  );
  const out = toClaudeInboundOutput(failed ? 'PostToolUseFailure' : 'PostToolUse', o);
  return { stdout: out ?? '', exitCode: 0, verdict: o.verdict.rule === 'inbound.none' ? { decision: 'allow', rule: 'hook.post-event', reason: `recorded the outcome of ${input.tool_name}` } : o.verdict };
}

function screenPrompt(input: ClaudeCodeHookInput, opts: HookOptions, unattended: boolean): HookRun {
  const o = handlePrompt({ source: 'claude-code', session: input.session_id, cwd: input.cwd, prompt: input.prompt ?? '' }, { env: opts.env, cwd: opts.cwd, now: opts.now, unattended });
  return { stdout: toClaudeInboundOutput('UserPromptSubmit', o) ?? '', exitCode: 0, verdict: o.verdict };
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
      return { kind: 'done', run: recordPost(input, { ...opts, env }) };
    } catch (err: unknown) {
      const reason = `could not record the outcome or scan the result (${err instanceof Error ? err.message : String(err)})`;
      return { kind: 'done', run: { stdout: JSON.stringify({ systemMessage: `openmorals: this tool result could not be recorded or scanned for hidden instructions (${reason.slice(0, 160)})` }), exitCode: 0, verdict: { decision: 'ask', rule: 'inbound.error', reason } } };
    }
  }
  if (input.hook_event_name === 'UserPromptSubmit') {
    try {
      return { kind: 'done', run: screenPrompt(input, { ...opts, env }, unattended) };
    } catch (err: unknown) {
      const reason = `the prompt could not be scanned (${err instanceof Error ? err.message : String(err)}), so it fails closed`;
      const failed: InboundOutcome = {
        origin: 'prompt',
        verdict: { decision: unattended ? 'deny' : 'ask', rule: 'inbound.error', reason },
        notice: null,
        userNotice: unattended ? 'openmorals blocked this message: it could not be scanned for hidden instructions (unattended run).' : 'openmorals: your message could not be scanned for hidden instructions; the agent was told to treat pasted material as data.',
        taint: null,
        scan: null,
        record: false,
      };
      return { kind: 'done', run: { stdout: toClaudeInboundOutput('UserPromptSubmit', failed) ?? '', exitCode: 0, verdict: failed.verdict } };
    }
  }
  if (input.hook_event_name !== null && input.hook_event_name !== 'PreToolUse') {
    return { kind: 'done', run: { stdout: '', exitCode: 0, verdict: { decision: 'allow', rule: 'hook.other-event', reason: `openmorals judges PreToolUse and scans PostToolUse, PostToolUseFailure and UserPromptSubmit, got ${input.hook_event_name}` } } };
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
