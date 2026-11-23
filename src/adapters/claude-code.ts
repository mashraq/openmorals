import { appendAudit, makeAuditRecord } from '../audit.js';
import { resolveBylaws } from '../bylaws.js';
import { decide, describeAction } from '../engine.js';
import { auditLogPath, configDir } from '../paths.js';
import { countToolCall, loadSessionState, saveSessionState } from '../state.js';
import type { Action, Verdict } from '../types.js';
import { strictest } from '../types.js';

export interface ClaudeCodeHookInput {
  session_id: string | null;
  cwd: string | null;
  hook_event_name: string | null;
  tool_name: string;
  tool_input: Record<string, unknown>;
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
  return { ok: true, input: { session_id: strField(o, 'session_id'), cwd: strField(o, 'cwd'), hook_event_name: strField(o, 'hook_event_name'), tool_name: tool, tool_input: toolInput } };
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
}

function failClosed(reason: string, rule: string): HookRun {
  const verdict: Verdict = { decision: 'ask', rule, reason };
  return { stdout: toHookOutput(verdict) ?? '', exitCode: 0, verdict };
}

export function runClaudeCodeHook(stdinText: string, opts: HookOptions = {}): HookRun {
  try {
    const env = opts.env ?? process.env;
    const parsed = parseHookInput(stdinText);
    if (!parsed.ok) return failClosed(parsed.error, 'hook.bad-input');
    const input = parsed.input;
    if (input.hook_event_name !== null && input.hook_event_name !== 'PreToolUse') {
      return { stdout: '', exitCode: 0, verdict: { decision: 'allow', rule: 'hook.other-event', reason: `openmorals only judges PreToolUse, got ${input.hook_event_name}` } };
    }
    const dir = configDir(env);
    const cwd = input.cwd ?? opts.cwd ?? process.cwd();
    const bylaws = resolveBylaws(cwd, env);
    const action = toAction(input.tool_name, input.tool_input);
    const session = input.session_id ?? 'unknown';
    const state = countToolCall(loadSessionState(session, dir));
    let verdict = decide(action, bylaws, state);
    try {
      saveSessionState(session, state, dir, opts.now);
    } catch (err: unknown) {
      const d = strictest(verdict.decision, 'ask');
      verdict = { decision: d, rule: d === verdict.decision && verdict.decision !== 'allow' ? verdict.rule : 'budget.unmeasured', reason: `${verdict.decision === 'allow' ? '' : `${verdict.reason}; `}the budget counter could not be saved (${err instanceof Error ? err.message : String(err)})` };
    }
    const auditOn = !bylaws.ok || bylaws.bylaws.audit.enabled;
    if (auditOn) {
      try {
        appendAudit(
          makeAuditRecord(
            { source: 'claude-code', session: input.session_id, tool: input.tool_name, action: describeAction(action), decision: verdict.decision, rule: verdict.rule, reason: verdict.reason, cwd, budget: { tool_calls: state.toolCalls, tokens: state.tokens } },
            opts.now,
          ),
          auditLogPath(dir),
        );
      } catch (err: unknown) {
        const d = strictest(verdict.decision, 'ask');
        verdict = { decision: d, rule: verdict.decision === 'allow' ? 'audit.unwritable' : verdict.rule, reason: `${verdict.decision === 'allow' ? '' : `${verdict.reason}; `}the audit log could not be written (${err instanceof Error ? err.message : String(err)})` };
      }
    }
    return { stdout: toHookOutput(verdict) ?? '', exitCode: 0, verdict };
  } catch (err: unknown) {
    return failClosed(`openmorals hit an internal error (${err instanceof Error ? err.message : String(err)}) and fails closed`, 'engine.error');
  }
}
