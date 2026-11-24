// Gemini CLI adapter: `openmorals hook gemini-cli` reads a BeforeTool event on stdin and prints the hook answer JSON.
// Contract (read 23 Nov 2026, see docs/adapters.md): exit 0 with JSON on stdout; `decision: "deny"` blocks and `reason`
// goes to the model; `decision: "ask"` forces Gemini CLI's confirmation prompt (honoured by the CLI source since at least
// v0.40.0, not yet in the hooks reference). Non-JSON stdout or another exit code lets the call run, so this adapter always
// prints exactly one JSON object and exits 0.
import type { Action, ShellKind, Verdict } from '../../types.js';
import { mergeHookGroup } from '../codex/index.js';
import type { MergeResult } from '../codex/index.js';
import { handlePostTool, handlePrompt, textOfResult } from '../../inbound/index.js';
import { argActions, auditFailure, errText, failVerdict, hostConfigVerdicts, hostShell, inboundFailure, inboundHookOutput, isRecord, judge, mcpDeleteVerdict, outcomeOfResult, parseJsonObject, reasonText, strOf, unattendedOf } from '../codex/pipeline.js';
import type { JudgeOptions } from '../codex/pipeline.js';

export type { MergeResult } from '../codex/index.js';

export const SOURCE = 'gemini-cli';
export const DEFAULT_COMMAND = 'openmorals hook gemini-cli';
/** Set to `deny` to print every ask as a deny, for Gemini CLI releases that predate `decision: "ask"` (they would run the call). */
export const ASK_MODE_ENV = 'OPENMORALS_GEMINI_ASK';

export interface GeminiHookInput {
  session_id: string | null;
  cwd: string | null;
  hook_event_name: string | null;
  tool_name: string;
  tool_input: Record<string, unknown>;
  original_request_name: string | null;
}

export type GeminiInputResult = { ok: true; input: GeminiHookInput } | { ok: false; error: string };

export function parseGeminiHookInput(text: string): GeminiInputResult {
  const p = parseJsonObject(text);
  if (!p.ok) return p;
  const o = p.value;
  const tool = strOf(o, 'tool_name');
  if (tool === null || tool === '') return { ok: false, error: 'the hook input has no tool_name' };
  const ti = o['tool_input'];
  if (ti !== undefined && ti !== null && !isRecord(ti)) return { ok: false, error: 'the hook input has a tool_input that is not an object' };
  return {
    ok: true,
    input: { session_id: strOf(o, 'session_id'), cwd: strOf(o, 'cwd'), hook_event_name: strOf(o, 'hook_event_name'), tool_name: tool, tool_input: isRecord(ti) ? ti : {}, original_request_name: strOf(o, 'original_request_name') },
  };
}

export interface MappedCall {
  actions: Action[];
  problem: string | null;
  mcp: boolean;
}

const URL_RE = /https?:\/\/[^\s"'<>()[\]{}]+/gi;

function joinPath(dir: string | null, rest: string | null): string {
  if (rest === null || rest === '') return dir ?? '';
  if (dir === null || dir === '' || /^([\\/]|[A-Za-z]:)/.test(rest)) return rest;
  return `${dir.replace(/[\\/]+$/, '')}/${rest}`;
}

function strings(v: unknown): string[] {
  if (typeof v === 'string') return v === '' ? [] : [v];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string' && x !== '');
  return [];
}

/** Maps one Gemini CLI tool call (tool names and argument keys from the Tools Reference) to the core's actions. */
export function geminiActions(toolName: string, input: Record<string, unknown>, shell: ShellKind = 'posix'): MappedCall {
  const s = (k: string): string | null => strOf(input, k);
  const none = (problem: string): MappedCall => ({ actions: [], problem, mcp: false });
  switch (toolName) {
    case 'run_shell_command': {
      const command = s('command');
      if (command === null || command.trim() === '') return none('the run_shell_command call has no command');
      return { actions: [{ kind: 'exec', command, shell, tool: toolName }], problem: null, mcp: false };
    }
    case 'read_file': {
      const path = s('file_path') ?? s('absolute_path') ?? s('path');
      if (path === null || path === '') return none('the read_file call has no file_path');
      return { actions: [{ kind: 'read', path, tool: toolName }], problem: null, mcp: false };
    }
    case 'write_file':
    case 'replace': {
      const path = s('file_path') ?? s('absolute_path') ?? s('path');
      if (path === null || path === '') return none(`the ${toolName} call has no file_path`);
      return { actions: [{ kind: 'write', path, tool: toolName }], problem: null, mcp: false };
    }
    case 'read_many_files': {
      const items = [...strings(input['include']), ...strings(input['paths'])];
      if (items.length === 0) return none('the read_many_files call names no file');
      return { actions: items.slice(0, 64).map((path) => ({ kind: 'read', path, tool: toolName })), problem: null, mcp: false };
    }
    case 'list_directory':
      return { actions: [{ kind: 'read', path: s('dir_path') ?? s('path') ?? '', tool: toolName }], problem: null, mcp: false };
    case 'glob':
      return { actions: [{ kind: 'read', path: joinPath(s('dir_path') ?? s('path'), s('pattern')), tool: toolName }], problem: null, mcp: false };
    case 'grep_search':
    case 'search_file_content':
      return { actions: [{ kind: 'read', path: joinPath(s('dir_path') ?? s('path'), s('include_pattern') ?? s('include')), tool: toolName }], problem: null, mcp: false };
    case 'web_fetch': {
      const text = [s('prompt'), s('url')].filter((x): x is string => x !== null).join(' ');
      const urls = [...new Set(text.match(URL_RE) ?? [])];
      if (urls.length === 0) return { actions: [{ kind: 'other', tool: toolName }], problem: null, mcp: false };
      return { actions: urls.slice(0, 20).map((url) => ({ kind: 'fetch', url, tool: toolName })), problem: null, mcp: false };
    }
    default: {
      const mcp = toolName.startsWith('mcp_');
      return { actions: [{ kind: 'other', tool: toolName }, ...argActions(toolName, input)], problem: null, mcp };
    }
  }
}

export type AskMode = 'ask' | 'deny';

/** The stdout Gemini CLI expects: `{}` (no decision) for allow, `decision` ask or deny with reason and systemMessage otherwise. */
export function toGeminiOutput(v: Verdict, askMode: AskMode = 'ask'): string {
  if (v.decision === 'allow') return '{}';
  const text = reasonText(v);
  const decision = v.decision === 'ask' && askMode === 'ask' ? 'ask' : 'deny';
  const reason = v.decision === 'ask' && decision === 'deny' ? `${text}. openmorals is set to block what it would ask about here: tell the user what you wanted to run and why, and let them decide.` : text;
  return JSON.stringify({ decision, reason, systemMessage: text });
}

export interface GeminiHookRun {
  stdout: string;
  exitCode: 0;
  verdict: Verdict;
}

export interface GeminiHookOptions extends JudgeOptions {
  platform?: NodeJS.Platform;
}

function askModeOf(env: NodeJS.ProcessEnv): AskMode {
  return (env[ASK_MODE_ENV] ?? '').trim().toLowerCase() === 'deny' ? 'deny' : 'ask';
}

/** AfterTool (record the outcome, scan `tool_response.llmContent`) and BeforeAgent (scan the prompt); null for any other event. */
function runGeminiContent(stdinText: string, opts: GeminiHookOptions): GeminiHookRun | null {
  const p = parseJsonObject(stdinText);
  if (!p.ok) return null;
  const o = p.value;
  const event = strOf(o, 'hook_event_name');
  if (event !== 'AfterTool' && event !== 'BeforeAgent') return null;
  const origin = event === 'AfterTool' ? 'tool-result' : 'prompt';
  try {
    if (event === 'BeforeAgent') {
      const prompt = strOf(o, 'prompt');
      const res = prompt === null ? inboundFailure('prompt', 'the BeforeAgent input has no prompt', opts) : handlePrompt({ source: SOURCE, session: strOf(o, 'session_id'), cwd: strOf(o, 'cwd'), prompt }, { ...opts, unattended: unattendedOf(opts) });
      return { stdout: inboundHookOutput(event, res, 'deny', '{}'), exitCode: 0, verdict: res.verdict };
    }
    const tool = strOf(o, 'tool_name') ?? 'unknown';
    const resp = o['tool_response'];
    const ti = o['tool_input'];
    const mapped = geminiActions(tool, isRecord(ti) ? ti : {}, hostShell(opts.platform ?? process.platform));
    const content = textOfResult(isRecord(resp) && resp['llmContent'] !== undefined ? [resp['llmContent'], resp['error']] : resp);
    const res = handlePostTool({ source: SOURCE, session: strOf(o, 'session_id'), cwd: strOf(o, 'cwd'), tool, actions: mapped.actions, outcome: outcomeOfResult(resp), id: null, content }, opts);
    return { stdout: inboundHookOutput(event, res, 'deny', '{}'), exitCode: 0, verdict: res.verdict };
  } catch (err: unknown) {
    const res = inboundFailure(origin, `openmorals hit an internal error (${errText(err)})`, opts);
    return { stdout: inboundHookOutput(event, res, 'deny', '{}'), exitCode: 0, verdict: res.verdict };
  }
}

export function runGeminiHook(stdinText: string, opts: GeminiHookOptions = {}): GeminiHookRun {
  const content = runGeminiContent(stdinText, opts);
  if (content !== null) return content;
  let askMode: AskMode = 'ask';
  try {
    askMode = askModeOf(opts.env ?? process.env);
    const parsed = parseGeminiHookInput(stdinText);
    if (!parsed.ok) {
      const verdict = failVerdict(parsed.error, 'hook.bad-input', opts);
      auditFailure(SOURCE, verdict, opts);
      return { stdout: toGeminiOutput(verdict, askMode), exitCode: 0, verdict };
    }
    const input = parsed.input;
    if (input.hook_event_name !== null && input.hook_event_name !== 'BeforeTool') {
      return { stdout: '{}', exitCode: 0, verdict: { decision: 'allow', rule: 'hook.other-event', reason: `openmorals judges BeforeTool and scans AfterTool and BeforeAgent, got ${input.hook_event_name}` } };
    }
    const shell: ShellKind = hostShell(opts.platform ?? process.platform);
    const mapped = geminiActions(input.tool_name, input.tool_input, shell);
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
    return { stdout: toGeminiOutput(verdict, askMode), exitCode: 0, verdict };
  } catch (err: unknown) {
    const verdict = failVerdict(`openmorals hit an internal error (${err instanceof Error ? err.message : String(err)}) and fails closed`, 'engine.error', opts);
    auditFailure(SOURCE, verdict, opts);
    return { stdout: toGeminiOutput(verdict, askMode), exitCode: 0, verdict };
  }
}

interface GeminiHandler {
  name: string;
  type: 'command';
  command: string;
  timeout: number;
  description: string;
}

export interface InstallSnippet {
  agent: 'gemini-cli';
  /** Project file `openmorals init --agent gemini-cli` merges into (user-wide: ~/.gemini/settings.json). */
  file: string;
  format: 'json';
  command: string;
  value: {
    hooks: {
      BeforeTool: [{ matcher: string; hooks: [GeminiHandler] }];
      AfterTool: [{ matcher: string; hooks: [GeminiHandler] }];
      BeforeAgent: [{ hooks: [GeminiHandler] }];
    };
  };
  text: string;
}

/** The Gemini CLI events openmorals installs: the pre-tool judgement, the post-tool outcome and result scan, the prompt scan. */
export const GEMINI_EVENTS = ['BeforeTool', 'AfterTool', 'BeforeAgent'] as const;

export function installSnippet(command: string = DEFAULT_COMMAND): InstallSnippet {
  const handler = (description: string): GeminiHandler => ({ name: 'openmorals', type: 'command', command, timeout: 30000, description });
  const value: InstallSnippet['value'] = {
    hooks: {
      BeforeTool: [{ matcher: '*', hooks: [handler('openmorals: allow, ask or deny each tool call from openmorals.yaml')] }],
      AfterTool: [{ matcher: '*', hooks: [handler('openmorals: record the outcome and scan the result for hidden instructions')] }],
      BeforeAgent: [{ hooks: [handler('openmorals: scan the prompt for hidden instructions')] }],
    },
  };
  return { agent: 'gemini-cli', file: '.gemini/settings.json', format: 'json', command, value, text: `${JSON.stringify(value, null, 2)}\n` };
}

/** Pure merge of the snippet into an existing parsed settings.json (or null when the file does not exist). Never drops a key. */
export function mergeConfig(existing: unknown, snippet: InstallSnippet = installSnippet()): MergeResult {
  let config: unknown = existing;
  let changed = false;
  for (const event of GEMINI_EVENTS) {
    const r = mergeHookGroup(config, event, snippet.value.hooks[event][0] as unknown as Record<string, unknown>, snippet.command);
    if (!r.ok) return r;
    config = r.config;
    changed = changed || r.changed;
  }
  return { ok: true, config: config as Record<string, unknown>, changed };
}
