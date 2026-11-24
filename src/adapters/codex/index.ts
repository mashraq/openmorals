// Codex CLI adapter: `openmorals hook codex` reads a PreToolUse event on stdin and prints the Codex hook answer.
// Contract (read 23 Nov 2026, see docs/adapters.md): Codex supports permissionDecision "deny" only. "ask" and a bare
// "allow" are parsed but unsupported and make Codex continue the call, so openmorals never prints them: allow prints
// nothing, and ask is printed as deny with a reason that tells the model to bring the question to the user.
import type { Action, ShellKind, Verdict } from '../../types.js';
import { handlePostTool, handlePrompt, textOfResult } from '../../inbound/index.js';
import { argActions, auditFailure, errText, failVerdict, hostConfigVerdicts, hostShell, inboundFailure, inboundHookOutput, isRecord, judge, mcpDeleteVerdict, outcomeOfResult, parseJsonObject, reasonText, shellJoin, strOf, unattendedOf } from './pipeline.js';
import type { JudgeOptions } from './pipeline.js';
import { parsePatchFiles } from './patch.js';

export const SOURCE = 'codex';
export const DEFAULT_COMMAND = 'openmorals hook codex';

export interface CodexHookInput {
  session_id: string | null;
  cwd: string | null;
  hook_event_name: string | null;
  turn_id: string | null;
  permission_mode: string | null;
  tool_name: string;
  tool_input: unknown;
}

export type CodexInputResult = { ok: true; input: CodexHookInput } | { ok: false; error: string };

export function parseCodexHookInput(text: string): CodexInputResult {
  const p = parseJsonObject(text);
  if (!p.ok) return p;
  const o = p.value;
  const tool = strOf(o, 'tool_name');
  if (tool === null || tool === '') return { ok: false, error: 'the hook input has no tool_name' };
  return {
    ok: true,
    input: { session_id: strOf(o, 'session_id'), cwd: strOf(o, 'cwd'), hook_event_name: strOf(o, 'hook_event_name'), turn_id: strOf(o, 'turn_id'), permission_mode: strOf(o, 'permission_mode'), tool_name: tool, tool_input: o['tool_input'] },
  };
}

export interface MappedCall {
  actions: Action[];
  problem: string | null;
  mcp: boolean;
}

const SHELL_TOOLS = new Set(['Bash', 'shell', 'local_shell', 'exec_command', 'container.exec']);
const PATCH_TOOLS = new Set(['apply_patch', 'Edit', 'Write']);

function commandOf(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (!isRecord(input)) return null;
  const c = input['command'] ?? input['cmd'];
  if (typeof c === 'string') return c;
  if (Array.isArray(c) && c.length > 0 && c.every((x): x is string => typeof x === 'string')) return shellJoin(c);
  return null;
}

/** Maps one Codex tool call to the core's actions. `problem` is set when a known tool arrives without the input it needs. */
export function codexActions(toolName: string, toolInput: unknown, shell: ShellKind = 'posix'): MappedCall {
  if (SHELL_TOOLS.has(toolName)) {
    const command = commandOf(toolInput);
    if (command === null || command.trim() === '') return { actions: [], problem: `the ${toolName} call has no command`, mcp: false };
    return { actions: [{ kind: 'exec', command, shell, tool: toolName }], problem: null, mcp: false };
  }
  if (PATCH_TOOLS.has(toolName)) {
    const text = commandOf(toolInput) ?? (isRecord(toolInput) ? strOf(toolInput, 'input') ?? strOf(toolInput, 'patch') : null);
    if (text === null) return { actions: [], problem: `the ${toolName} call has no patch text`, mcp: false };
    const parsed = parsePatchFiles(text);
    if (!parsed.ok) return { actions: [], problem: `the ${toolName} patch could not be read: ${parsed.error}`, mcp: false };
    return { actions: parsed.files.map((f) => ({ kind: 'write', path: f.path, tool: toolName })), problem: null, mcp: false };
  }
  const mcp = toolName.startsWith('mcp__');
  return { actions: [{ kind: 'other', tool: toolName }, ...argActions(toolName, toolInput)], problem: null, mcp };
}

/** The stdout Codex expects for a verdict: nothing for allow, the documented PreToolUse deny shape for ask and deny. */
export function toCodexOutput(v: Verdict): string {
  if (v.decision === 'allow') return '';
  const reason =
    v.decision === 'ask'
      ? `${reasonText(v)}. Codex hooks cannot ask the user, so openmorals blocked this call: tell the user what you wanted to run and why, and let them decide (they can run it themselves or allow it in openmorals.yaml).`
      : reasonText(v);
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
}

export interface CodexHookRun {
  stdout: string;
  exitCode: 0;
  verdict: Verdict;
}

export interface CodexHookOptions extends JudgeOptions {
  platform?: NodeJS.Platform;
}

function failClosed(reason: string, rule: string, opts: CodexHookOptions): CodexHookRun {
  const verdict = failVerdict(reason, rule, opts);
  auditFailure(SOURCE, verdict, opts);
  return { stdout: toCodexOutput(verdict), exitCode: 0, verdict };
}

/** PostToolUse (record the outcome, scan the result) and UserPromptSubmit (scan the prompt); null for any other event. */
function runCodexContent(stdinText: string, opts: CodexHookOptions): CodexHookRun | null {
  const p = parseJsonObject(stdinText);
  if (!p.ok) return null;
  const o = p.value;
  const event = strOf(o, 'hook_event_name');
  if (event !== 'PostToolUse' && event !== 'UserPromptSubmit') return null;
  const origin = event === 'PostToolUse' ? 'tool-result' : 'prompt';
  try {
    if (event === 'UserPromptSubmit') {
      const prompt = strOf(o, 'prompt');
      const res = prompt === null ? inboundFailure('prompt', 'the UserPromptSubmit input has no prompt', opts) : handlePrompt({ source: SOURCE, session: strOf(o, 'session_id'), cwd: strOf(o, 'cwd'), prompt }, { ...opts, unattended: unattendedOf(opts) });
      return { stdout: inboundHookOutput(event, res, 'block', ''), exitCode: 0, verdict: res.verdict };
    }
    const tool = strOf(o, 'tool_name') ?? 'unknown';
    const resp = o['tool_response'];
    const mapped = codexActions(tool, o['tool_input'], hostShell(opts.platform ?? process.platform));
    const res = handlePostTool({ source: SOURCE, session: strOf(o, 'session_id'), cwd: strOf(o, 'cwd'), tool, actions: mapped.actions, outcome: outcomeOfResult(resp), id: strOf(o, 'tool_use_id'), content: textOfResult(resp) }, opts);
    return { stdout: inboundHookOutput(event, res, 'block', ''), exitCode: 0, verdict: res.verdict };
  } catch (err: unknown) {
    const res = inboundFailure(origin, `openmorals hit an internal error (${errText(err)})`, opts);
    return { stdout: inboundHookOutput(event, res, 'block', ''), exitCode: 0, verdict: res.verdict };
  }
}

export function runCodexHook(stdinText: string, opts: CodexHookOptions = {}): CodexHookRun {
  const content = runCodexContent(stdinText, opts);
  if (content !== null) return content;
  try {
    const parsed = parseCodexHookInput(stdinText);
    if (!parsed.ok) return failClosed(parsed.error, 'hook.bad-input', opts);
    const input = parsed.input;
    if (input.hook_event_name !== null && input.hook_event_name !== 'PreToolUse') {
      return { stdout: '', exitCode: 0, verdict: { decision: 'allow', rule: 'hook.other-event', reason: `openmorals judges PreToolUse and scans PostToolUse and UserPromptSubmit, got ${input.hook_event_name}` } };
    }
    const shell: ShellKind = hostShell(opts.platform ?? process.platform);
    const mapped = codexActions(input.tool_name, input.tool_input, shell);
    const problem = mapped.problem;
    const verdict = judge(
      {
        source: SOURCE,
        session: input.session_id,
        cwd: input.cwd,
        tool: input.tool_name,
        actions: mapped.actions,
        countCall: true,
        extra: (b) => [
          ...(problem === null ? [] : [{ decision: 'ask' as const, rule: 'hook.bad-input', reason: problem }]),
          ...hostConfigVerdicts(mapped.actions, b),
          ...(mapped.mcp ? [mcpDeleteVerdict(input.tool_name, b)].filter((x): x is Verdict => x !== null) : []),
        ],
      },
      opts,
    );
    return { stdout: toCodexOutput(verdict), exitCode: 0, verdict };
  } catch (err: unknown) {
    return failClosed(`openmorals hit an internal error (${err instanceof Error ? err.message : String(err)}) and fails closed`, 'engine.error', opts);
  }
}

interface CodexHandler {
  type: 'command';
  command: string;
  timeout: number;
  statusMessage: string;
}

export interface InstallSnippet {
  agent: 'codex';
  /** Project file `openmorals init --agent codex` merges into (user-wide: $CODEX_HOME/hooks.json, default ~/.codex/hooks.json). */
  file: string;
  format: 'json';
  command: string;
  value: {
    hooks: {
      PreToolUse: [{ matcher: string; hooks: [CodexHandler] }];
      PostToolUse: [{ matcher: string; hooks: [CodexHandler] }];
      UserPromptSubmit: [{ hooks: [CodexHandler] }];
    };
  };
  text: string;
  /** The same hooks as inline `config.toml` blocks, for users who keep hooks there (use one format per layer). */
  toml: string;
}

/** The Codex events openmorals installs: the pre-tool judgement, the post-tool outcome and result scan, the prompt scan. */
export const CODEX_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit'] as const;

export function installSnippet(command: string = DEFAULT_COMMAND): InstallSnippet {
  const handler = (statusMessage: string): CodexHandler => ({ type: 'command', command, timeout: 30, statusMessage });
  const value: InstallSnippet['value'] = {
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [handler('openmorals: checking the call')] }],
      PostToolUse: [{ matcher: '*', hooks: [handler('openmorals: scanning the result')] }],
      UserPromptSubmit: [{ hooks: [handler('openmorals: scanning the prompt')] }],
    },
  };
  const block = (event: string, matcher: boolean, status: string): string[] => [`[[hooks.${event}]]`, ...(matcher ? ['matcher = "*"'] : []), '', `[[hooks.${event}.hooks]]`, 'type = "command"', `command = ${JSON.stringify(command)}`, 'timeout = 30', `statusMessage = ${JSON.stringify(status)}`, ''];
  const toml = ['# openmorals: judge every tool call before it runs, scan results and prompts for hidden instructions', ...block('PreToolUse', true, 'openmorals: checking the call'), ...block('PostToolUse', true, 'openmorals: scanning the result'), ...block('UserPromptSubmit', false, 'openmorals: scanning the prompt')].join('\n');
  return { agent: 'codex', file: '.codex/hooks.json', format: 'json', command, value, text: `${JSON.stringify(value, null, 2)}\n`, toml };
}

export type MergeResult = { ok: true; config: Record<string, unknown>; changed: boolean } | { ok: false; error: string };

/** Hook-list merge shared with the Gemini CLI adapter: adds one matcher group under hooks[event] unless a handler already runs `command`. */
export function mergeHookGroup(existing: unknown, event: string, group: Record<string, unknown>, command: string): MergeResult {
  if (existing === undefined || existing === null) return { ok: true, config: { hooks: { [event]: [group] } }, changed: true };
  if (!isRecord(existing)) return { ok: false, error: 'the existing file is not a JSON object; openmorals will not overwrite it' };
  const hooks = existing['hooks'];
  if (hooks !== undefined && !isRecord(hooks)) return { ok: false, error: "the existing 'hooks' value is not an object; openmorals will not overwrite it" };
  const list = hooks === undefined ? undefined : hooks[event];
  if (list !== undefined && !Array.isArray(list)) return { ok: false, error: `the existing 'hooks.${event}' value is not a list; openmorals will not overwrite it` };
  const present = (list ?? []).some((g: unknown) => isRecord(g) && Array.isArray(g['hooks']) && (g['hooks'] as unknown[]).some((h) => isRecord(h) && h['command'] === command));
  if (present) return { ok: true, config: existing, changed: false };
  return { ok: true, config: { ...existing, hooks: { ...(hooks ?? {}), [event]: [...(list ?? []), group] } }, changed: true };
}

/** Pure merge of the snippet into an existing parsed hooks.json (or null when the file does not exist). Never drops a key. */
export function mergeConfig(existing: unknown, snippet: InstallSnippet = installSnippet()): MergeResult {
  let config: unknown = existing;
  let changed = false;
  for (const event of CODEX_EVENTS) {
    const r = mergeHookGroup(config, event, snippet.value.hooks[event][0] as unknown as Record<string, unknown>, snippet.command);
    if (!r.ok) return r;
    config = r.config;
    changed = changed || r.changed;
  }
  return { ok: true, config: config as Record<string, unknown>, changed };
}

/** Pure merge of the TOML block into an existing config.toml text: appends it unless the command is already there. */
export function mergeTomlText(existing: string | null, snippet: InstallSnippet = installSnippet()): { text: string; changed: boolean } {
  if (existing === null || existing.trim() === '') return { text: snippet.toml, changed: true };
  if (existing.includes(`command = ${JSON.stringify(snippet.command)}`)) return { text: existing, changed: false };
  return { text: `${existing}${existing.endsWith('\n') ? '' : '\n'}\n${snippet.toml}`, changed: true };
}
