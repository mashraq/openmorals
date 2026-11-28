// Which tool names and hook events each host documents (0.41.0). A built-in tool name the adapter does not know asks
// once per name per session, instead of passing on its arguments alone; an event the adapter does not know, carrying a
// tool call, is judged like a pre-tool call. MCP tools keep their own path. Only hosts whose built-in tools can be told
// apart from MCP and plugin tools by name are listed: Claude Code, Codex CLI and Gemini CLI. On opencode and OpenClaw an
// MCP or plugin tool has a free name, so a new built-in cannot be told from one; there nothing changes.
import { TOOL_NAME_MAX } from '../session.js';
import type { Bylaws, Decision, Verdict } from '../types.js';

export { TOOL_NAME_MAX, TOOLS_RAN_KEEP, noteToolRan } from '../session.js';

export type ToolListHost = 'claude-code' | 'codex' | 'gemini-cli';

export interface HostTools {
  /** The host's name in plain words, for the ask. */
  label: string;
  /** The day the lists were read from the host's public documentation (and, for Codex, its source). */
  read: string;
  /** Every built-in tool name the hook may report, harmless ones included. */
  tools: readonly string[];
  /** Every hook event the host documents. */
  events: readonly string[];
  /** The events openmorals judges or scans itself; any other known event is left as before. */
  judged: readonly string[];
  /** True for an MCP tool's name on this host. */
  mcp: (name: string) => boolean;
}

/**
 * Claude Code: the tools reference's table (code.claude.com/docs/en/tools-reference, read 27 Nov 2026), plus older names
 * the adapter still maps (`Task`, `MultiEdit`, `NotebookRead`, `LS`) and two older shell helpers (`BashOutput`,
 * `KillShell`). Events: the hooks reference (code.claude.com/docs/en/hooks, read 27 Nov 2026). MCP: `mcp__<server>__<tool>`.
 */
const CLAUDE_CODE: HostTools = Object.freeze({
  label: 'Claude Code',
  read: '27 Nov 2026',
  tools: Object.freeze([
    'Agent', 'Artifact', 'AskUserQuestion', 'Bash', 'CronCreate', 'CronDelete', 'CronList', 'Edit', 'EndConversation', 'EnterPlanMode',
    'EnterWorktree', 'ExitPlanMode', 'ExitWorktree', 'Glob', 'Grep', 'ListAgents', 'ListMcpResourcesTool', 'ListPlugins', 'ListSkills', 'LSP',
    'Monitor', 'NotebookEdit', 'PowerShell', 'propose_skills', 'PushNotification', 'Read', 'ReadMcpResourceTool', 'RemoteTrigger', 'REPL',
    'ReportFindings', 'ScheduleWakeup', 'SearchPlugins', 'SearchSkills', 'SendFeedback', 'SendMessage', 'SendUserFile', 'ShareOnboardingGuide',
    'Skill', 'SubagentHandback', 'SuggestPluginInstall', 'SuggestSkills', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop',
    'TaskUpdate', 'TodoWrite', 'ToolSearch', 'WaitForMcpServers', 'WebFetch', 'WebSearch', 'Workflow', 'Write',
    'Task', 'MultiEdit', 'NotebookRead', 'LS', 'BashOutput', 'KillShell',
  ]),
  events: Object.freeze([
    'SessionStart', 'Setup', 'UserPromptSubmit', 'UserPromptExpansion', 'PreSkillShellCommand', 'PreToolUse', 'PermissionRequest',
    'PermissionDenied', 'PostToolUse', 'PostToolUseFailure', 'PostToolBatch', 'Notification', 'MessageDisplay', 'SubagentStart',
    'SubagentStop', 'TaskCreated', 'TaskCompleted', 'Stop', 'StopFailure', 'TeammateIdle', 'InstructionsLoaded', 'ConfigChange',
    'CwdChanged', 'DirectoryAdded', 'FileChanged', 'WorktreeCreate', 'WorktreeRemove', 'PreCompact', 'PostCompact', 'PreModelSwitch',
    'PostModelSwitch', 'Elicitation', 'ElicitationResult', 'SessionEnd',
  ]),
  judged: Object.freeze(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit']),
  mcp: (name: string): boolean => name.startsWith('mcp__'),
});

/**
 * Codex CLI: the hooks page (learn.chatgpt.com/docs/hooks, read 27 Nov 2026) names `Bash` (shell and unified exec),
 * `apply_patch`, `update_plan` and `spawn_agent`, and says other local function tools match by name. It lists none of
 * the rest, so the other names are the local tools in the openai/codex source (`codex-rs/core/src/tools/handlers`, read
 * 27 Nov 2026), plus the names this adapter already maps. Hosted tools such as web search do not reach the hook.
 */
const CODEX: HostTools = Object.freeze({
  label: 'Codex CLI',
  read: '27 Nov 2026',
  tools: Object.freeze([
    'Bash', 'shell', 'local_shell', 'exec_command', 'container.exec', 'write_stdin', 'apply_patch', 'Edit', 'Write', 'update_plan', 'view_image',
    'spawn_agent', 'send_input', 'send_message', 'followup_task', 'wait_agent', 'close_agent', 'resume_agent', 'interrupt_agent', 'list_agents',
    'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource', 'request_user_input', 'request_permissions', 'request_plugin_install',
    'list_available_plugins_to_install', 'tool_search', 'get_context_remaining', 'new_context', 'wait_for_environment', 'send_message_to_user_async',
    'curr_time', 'sleep',
  ]),
  events: Object.freeze([
    'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'UserPromptSubmit', 'SubagentStop', 'Stop', 'PreModelRequest',
    'PostModelRequest', 'Interrupt', 'SessionStart', 'SubagentStart', 'SessionEnd',
  ]),
  judged: Object.freeze(['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'PostModelRequest']),
  mcp: (name: string): boolean => name.startsWith('mcp__'),
});

/**
 * Gemini CLI: the Tools Reference (geminicli.com/docs/reference/tools, read 27 Nov 2026), its four built-in sub-agent
 * tools (subagents page) and the older `save_memory`. Events and the MCP name pattern `mcp_<server>_<tool>`: the hooks
 * reference (geminicli.com/docs/hooks/reference, read 27 Nov 2026).
 */
const GEMINI_CLI: HostTools = Object.freeze({
  label: 'Gemini CLI',
  read: '27 Nov 2026',
  tools: Object.freeze([
    'run_shell_command', 'glob', 'grep_search', 'search_file_content', 'list_directory', 'read_file', 'read_many_files', 'replace', 'write_file',
    'ask_user', 'write_todos', 'tracker_create_task', 'tracker_update_task', 'tracker_get_task', 'tracker_list_tasks', 'tracker_add_dependency',
    'tracker_visualize', 'update_topic', 'list_mcp_resources', 'read_mcp_resource', 'activate_skill', 'get_internal_docs', 'enter_plan_mode',
    'exit_plan_mode', 'complete_task', 'google_web_search', 'web_fetch', 'codebase_investigator', 'cli_help', 'generalist', 'browser_agent',
    'save_memory',
  ]),
  events: Object.freeze(['BeforeTool', 'AfterTool', 'BeforeAgent', 'AfterAgent', 'BeforeModel', 'BeforeToolSelection', 'AfterModel', 'SessionStart', 'SessionEnd', 'Notification', 'PreCompress']),
  judged: Object.freeze(['BeforeTool', 'AfterTool', 'BeforeAgent']),
  mcp: (name: string): boolean => name.startsWith('mcp_'),
});

export const HOST_TOOLS: Readonly<Record<ToolListHost, HostTools>> = Object.freeze({ 'claude-code': CLAUDE_CODE, codex: CODEX, 'gemini-cli': GEMINI_CLI });

export function isToolListHost(source: string): source is ToolListHost {
  return source === 'claude-code' || source === 'codex' || source === 'gemini-cli';
}

/** The rule id of the ask. */
export const UNKNOWN_TOOL_RULE = 'adapter.unknown-tool';

/** True when the host documents this name as a built-in tool. */
export function isKnownTool(host: ToolListHost, name: string): boolean {
  return HOST_TOOLS[host].tools.includes(name);
}

/** True for a name the unknown-tool check applies to: not a documented built-in and not an MCP tool. */
export function isUnknownTool(host: ToolListHost, name: string): boolean {
  return !isKnownTool(host, name) && !HOST_TOOLS[host].mcp(name);
}

/** True for an event name the host does not document. */
export function isUnknownEvent(host: ToolListHost, event: string): boolean {
  return !HOST_TOOLS[host].events.includes(event);
}

/** The unknown-tools settings with their defaults: ask, and no names allowed. */
export function unknownToolSettings(bylaws: Bylaws): { decision: Decision; allow: readonly string[] } {
  const s = bylaws.guards['unknown-tools'];
  return { decision: s?.decision ?? 'ask', allow: s?.allow ?? [] };
}

/**
 * The adapter's check on a tool name it does not know. Null for a documented built-in, an MCP tool, a name the bylaws
 * allow, a name that already ran in this session (`ran`: the person approved it once), or with `decision: allow`.
 * Otherwise the bylaws' decision (ask by default), so the person sees the name before it runs.
 */
export function unknownToolVerdict(host: ToolListHost, name: string, bylaws: Bylaws, ran: readonly string[] = []): Verdict | null {
  if (!isUnknownTool(host, name)) return null;
  const s = unknownToolSettings(bylaws);
  if (s.decision === 'allow' || s.allow.includes(name)) return null;
  const key = name.slice(0, TOOL_NAME_MAX);
  if (s.decision === 'ask' && ran.includes(key)) return null;
  const shown = name.length > 80 ? `${name.slice(0, 80)}...` : name;
  const t = HOST_TOOLS[host];
  return {
    decision: s.decision,
    rule: UNKNOWN_TOOL_RULE,
    reason: `openmorals does not know the tool '${shown}', so it cannot tell what this call does. It is not one of the ${t.label} tools openmorals knows (read ${t.read}) and not an MCP tool. If you approve it, openmorals will not ask about it again in this session. To allow it every time, add it to guards.unknown-tools.allow in your user-level openmorals.yaml`,
  };
}

/** True when a post-tool event of `source` for `tool` should be remembered: a host with a tool list, and a name it does not know. */
export function remembersRun(source: string, tool: string): boolean {
  return isToolListHost(source) && tool !== '' && isUnknownTool(source, tool);
}
