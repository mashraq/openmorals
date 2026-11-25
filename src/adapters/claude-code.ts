import { appendAuditText, auditMeta, chainAudit, makeAuditRecord, summarize } from '../audit.js';
import { testWritesOf } from '../tests/provenance.js';
import { deferStep, isDeferrableRule, promptApprovals, withoutDeferrable } from '../defer/index.js';
import type { PostToolEvent } from '../inbound/index.js';
import { handlePostTool, handlePostToolJudged, handlePrompt, textOfResult } from '../inbound/index.js';
import type { InboundOutcome } from '../inbound/index.js';
import { effectiveBylaws, resolveBylaws } from '../bylaws.js';
import { BUILTIN_GUARDS, decide, describeAction, maskAction } from '../engine.js';
import { namedDetectors } from '../rules/detectors.js';
import type { Guard, Where } from '../guard.js';
import { makeWhere } from '../guard.js';
import { argActions, mcpDeleteVerdict } from './codex/pipeline.js';
import { outboundAskKeys } from '../outbound/guard.js';
import { notePending } from '../outbound/memory.js';
import { holdPaths, namedOrder } from '../order/hold.js';
import { callActivities, firstActivityText, shippedDaily, type SkillActivity } from '../guidance/daily.js';
import type { ParsedCommand } from '../shell.js';
import { parseCommand } from '../shell.js';
import { contentAction, replaceChange, replaceListChange, scanOutbound, writeContent } from '../inbound/outbound.js';
import { reduceTaint } from '../taint/index.js';
import { auditLogPath, configDir } from '../paths.js';
import { combineVerdict, isUnattended, outboundView, recordAction, sessionFindings, taintContext, unattendedVerdict, unreadableFindings } from '../session.js';
import { countToolCall, loadSession, saveSession, settleBudget } from '../state.js';
import type { ReviewProvider } from '../reviewer/types.js';
import { reviewVerdict } from '../reviewer/wire.js';
import type { SessionMemory } from '../session.js';
import type { TaintContext } from '../taint/index.js';
import type { Action, Bylaws, BylawsLoad, SessionState, Verdict } from '../types.js';
import { decisionRank, strictest } from '../types.js';

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
  /** The subagent or in-process teammate the hook fires in; absent in the main conversation (hooks reference, read 24 Nov 2026). */
  agent_id: string | null;
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
      agent_id: strField(o, 'agent_id'),
    },
  };
}

/**
 * Where each write tool's content is (0.15.0): Write `content` and Edit `new_string` (hooks reference), NotebookEdit
 * `new_source` (Agent SDK TypeScript reference, `NotebookEditInput`). MultiEdit is no longer documented; every string value
 * of its `edits` items is taken, old text included (more text checked, never less).
 */
export const WRITE_CONTENT_FIELD: Readonly<Record<string, string>> = Object.freeze({ Write: 'content', Edit: 'new_string', MultiEdit: 'edits', NotebookEdit: 'new_source' });

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
    case 'NotebookEdit': {
      const out: Extract<Action, { kind: 'write' }> = { kind: 'write', path: s('file_path') ?? s('notebook_path') ?? '', tool: toolName };
      const content = writeContent(input[WRITE_CONTENT_FIELD[toolName] ?? 'content']);
      if (content !== undefined) out.content = content;
      const change = toolName === 'Write' ? (content !== undefined ? { kind: 'whole' as const } : undefined) : toolName === 'Edit' ? replaceChange(input['old_string'], input['new_string'], input['replace_all']) : toolName === 'MultiEdit' ? replaceListChange(input['edits'], 'old_string', 'new_string', 'replace_all') : undefined;
      if (change !== undefined) out.change = change;
      return out;
    }
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
      return contentAction('claude-code', toolName, input);
  }
}

/** Claude Code names an MCP server's tools `mcp__<server>__<tool>` (hooks reference, read 24 Nov 2026). */
export function isMcpTool(toolName: string): boolean {
  return toolName.startsWith('mcp__');
}

/**
 * Every action one Claude Code call is judged as. A built-in tool with its own mapping is that one action, as before 0.8.1.
 * Any other tool (an MCP tool, or a built-in without a mapping) is the `other` action plus what `argActions` lifts from its
 * arguments, the way the Codex, Gemini CLI, opencode and OpenClaw adapters read them: a top-level string or string list
 * under a URL key becomes a fetch, under a path key a read (a write when the tool name has a write word), at most 32.
 */
export function toActions(toolName: string, input: Record<string, unknown>): Action[] {
  const primary = toAction(toolName, input);
  return primary.kind === 'other' ? [primary, ...argActions(toolName, input)] : [primary];
}

/** The adapter's own checks on a call, beside the guards: an MCP tool whose name says it deletes asks as `adapter.mcp-delete`. */
export function adapterVerdicts(toolName: string, bylaws: Bylaws): Verdict[] {
  if (!isMcpTool(toolName)) return [];
  const v = mcpDeleteVerdict(toolName, bylaws);
  return v === null ? [] : [v];
}

/** The strictest of the verdicts; the first wins a tie, so a one-action call keeps the verdict `decide` gave it. */
function strictestOf(verdicts: readonly Verdict[], fallback: Verdict): Verdict {
  let best: Verdict | null = null;
  for (const v of verdicts) if (best === null || decisionRank(v.decision) > decisionRank(best.decision)) best = v;
  return best ?? fallback;
}

/**
 * One Claude Code call judged without session memory: each of its actions through `decide`, then the adapter's own checks;
 * the strictest wins. For a built-in tool with its own mapping this is exactly `decide` on its one action. The case rows and
 * `openmorals eval` judge a `tool:` row with it, so they test the mapping the hook uses.
 */
export function decideCall(toolName: string, actions: readonly Action[], bylaws: Bylaws | BylawsLoad, state: SessionState, guards: readonly Guard[] = BUILTIN_GUARDS, where: Partial<Where> = {}): Verdict {
  const own = actions.map((a) => decide(a, bylaws, state, guards, where));
  const first = own[0] ?? decide({ kind: 'other', tool: toolName }, bylaws, state, guards, where);
  return strictestOf([...own, ...adapterVerdicts(toolName, 'ok' in bylaws ? effectiveBylaws(bylaws) : bylaws)], first);
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

const INTERRUPTED: HookRun = { stdout: '', exitCode: 0, verdict: { decision: 'allow', rule: 'hook.post-event', reason: 'an interrupted call is not a failure' } };

function postEvent(input: ClaudeCodeHookInput): PostToolEvent {
  const failed = input.hook_event_name === 'PostToolUseFailure';
  const content = failed ? input.error : textOfResult(input.tool_response);
  return { source: 'claude-code', session: input.session_id, cwd: input.cwd, tool: input.tool_name, actions: toActions(input.tool_name, input.tool_input), outcome: failed ? { ok: false, error: input.error ?? 'failed' } : { ok: true }, id: input.tool_use_id, content, event: input.hook_event_name, agent: input.agent_id };
}

function postRun(input: ClaudeCodeHookInput, o: InboundOutcome): HookRun {
  const out = toClaudeInboundOutput(input.hook_event_name === 'PostToolUseFailure' ? 'PostToolUseFailure' : 'PostToolUse', o);
  return { stdout: out ?? '', exitCode: 0, verdict: o.verdict.rule === 'inbound.none' ? { decision: 'allow', rule: 'hook.post-event', reason: `recorded the outcome of ${input.tool_name}` } : o.verdict };
}

function postFailure(err: unknown): HookRun {
  const reason = `could not record the outcome or scan the result (${err instanceof Error ? err.message : String(err)})`;
  return { stdout: JSON.stringify({ systemMessage: `openmorals: this tool result could not be recorded or scanned for hidden instructions (${reason.slice(0, 160)})` }), exitCode: 0, verdict: { decision: 'ask', rule: 'inbound.error', reason } };
}

function recordPost(input: ClaudeCodeHookInput, opts: HookOptions): HookRun {
  if (input.hook_event_name === 'PostToolUseFailure' && input.is_interrupt) return INTERRUPTED;
  return postRun(input, handlePostTool(postEvent(input), { env: opts.env, cwd: opts.cwd, now: opts.now }));
}

/** The post-tool path with the opt-in inbound judge (it calls the reviewer's provider only when the user enabled it). */
async function recordPostJudged(input: ClaudeCodeHookInput, opts: ReviewedHookOptions): Promise<HookRun> {
  if (input.hook_event_name === 'PostToolUseFailure' && input.is_interrupt) return INTERRUPTED;
  return postRun(input, await handlePostToolJudged(postEvent(input), { env: opts.env, cwd: opts.cwd, now: opts.now, ...(opts.reviewProvider !== undefined ? { provider: opts.reviewProvider } : {}) }));
}

function screenPrompt(input: ClaudeCodeHookInput, opts: HookOptions, unattended: boolean): HookRun {
  const o = handlePrompt({ source: 'claude-code', session: input.session_id, cwd: input.cwd, prompt: input.prompt ?? '', event: input.hook_event_name, agent: input.agent_id }, { env: opts.env, cwd: opts.cwd, now: opts.now, unattended });
  const stdout = toClaudeInboundOutput('UserPromptSubmit', o) ?? '';
  if (o.verdict.decision === 'deny') return { stdout, exitCode: 0, verdict: o.verdict };
  let lines: { user: string[]; model: string[] };
  try {
    lines = promptApprovals(input.prompt ?? '', input.session_id, configDir(opts.env ?? process.env), opts.now);
  } catch (err: unknown) {
    lines = { user: [`openmorals: approvals in this message could not be checked (${err instanceof Error ? err.message : String(err)}); nothing was approved`], model: [] };
  }
  return { stdout: withDeferLines(stdout, lines.user, lines.model), exitCode: 0, verdict: o.verdict };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Adds the deferred-ask lines to a UserPromptSubmit answer: the person's as `systemMessage`, the agent's as `additionalContext`. */
export function withDeferLines(stdout: string, user: readonly string[], model: readonly string[]): string {
  if (user.length === 0 && model.length === 0) return stdout;
  let o: Record<string, unknown> = {};
  if (stdout !== '') {
    try {
      const parsed: unknown = JSON.parse(stdout);
      if (isRecord(parsed)) o = parsed;
    } catch {
      return stdout;
    }
  }
  if (o['decision'] === 'block') return stdout;
  const join = (first: unknown, more: readonly string[]): string => [...(typeof first === 'string' && first !== '' ? [first] : []), ...more].join('\n');
  if (user.length > 0) o['systemMessage'] = join(o['systemMessage'], user);
  if (model.length > 0) {
    const h = isRecord(o['hookSpecificOutput']) ? o['hookSpecificOutput'] : { hookEventName: 'UserPromptSubmit' };
    h['additionalContext'] = join(h['additionalContext'], model);
    o['hookSpecificOutput'] = h;
  }
  return JSON.stringify(o);
}

/** The arguments a grant is bound to: all of them, except Bash's and PowerShell's `description`, a note that does not change what runs. */
export function bindingArgs(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  if (tool !== 'Bash' && tool !== 'PowerShell') return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) if (k !== 'description') out[k] = v;
  return out;
}

interface Judged {
  kind: 'judged';
  input: ClaudeCodeHookInput;
  cwd: string;
  dir: string;
  bylaws: BylawsLoad;
  effective: Bylaws;
  action: Action;
  /** Every action of the call (`action` first); more than one only for a tool without its own mapping. */
  actions: Action[];
  state: SessionState;
  memory: SessionMemory;
  ctx: TaintContext;
  verdict: Verdict;
  unattended: boolean;
  /** For a call held for approval or run on one (0.19.0): the line only the person sees (for a held call, with its code). */
  userNotice?: string;
  where: Where;
}

/**
 * The outbound asks of a call the person is being asked about (0.20.0): kept as pending in the session, so that when the
 * call runs (the post-tool event: the person approved it in the host's dialog) the same entry on the same site is not
 * asked about again in this session. Nothing is kept for an allow or a deny.
 */
function withOutboundPending(memory: SessionMemory, j: Judged, verdict: Verdict): SessionMemory {
  if (verdict.decision !== 'ask') return memory;
  const view = j.where.outbound;
  if (view === undefined || view.memory.unreadable === true) return memory;
  const bylaws = j.effective;
  const keys: string[] = [];
  for (const a of j.actions) {
    let parsed: ParsedCommand | null = null;
    if (a.kind === 'exec') {
      try {
        parsed = parseCommand(a.command, a.shell);
      } catch {
        parsed = null;
      }
    }
    keys.push(...outboundAskKeys({ action: a, parsed, bylaws, state: j.state, where: j.where }));
  }
  if (keys.length === 0) return memory;
  return { ...memory, outbound: notePending(memory.outbound ?? view.memory, j.input.tool_use_id, j.input.tool_name, keys) };
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
      return { kind: 'done', run: postFailure(err) };
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
  const effective = effectiveBylaws(bylaws);
  const actions = toActions(input.tool_name, input.tool_input);
  const action = actions[0] ?? toAction(input.tool_name, input.tool_input);
  const loaded = loadSession(input.session_id ?? 'unknown', dir);
  const state = countToolCall(loaded.state);
  const ctx = taintContext(cwd, effective);
  const order = namedOrder(env);
  const where = makeWhere({ configDir: dir, cwd, outbound: outboundView(loaded.memory, opts.now), ...(loaded.memory.wrote !== undefined ? { wrote: loaded.memory.wrote } : {}), ...(order !== undefined ? { order } : {}) }, env);
  const guarded = decideCall(input.tool_name, actions, bylaws, state, BUILTIN_GUARDS, where);
  let verdict = combineVerdict(guarded, [...actions.flatMap((a) => sessionFindings(a, loaded.memory, effective, ctx)), ...unreadableFindings(loaded.memory)]);
  const held = deferAt({ input, cwd, dir, bylaws, effective, actions, state, memory: loaded.memory, ctx, where, verdict, unattended, now: opts.now });
  verdict = held.verdict;
  if (unattended) verdict = unattendedVerdict(verdict);
  const j: Judged = { kind: 'judged', input, cwd, dir, bylaws, effective, action, actions, state, memory: loaded.memory, ctx, verdict, unattended, where };
  if (held.kind === 'held') j.userNotice = held.userNotice;
  else if (held.kind === 'granted') j.userNotice = `openmorals: ${held.id} runs now, as you approved; that approval is used.`;
  return j;
}

interface DeferAtInput {
  input: ClaudeCodeHookInput;
  cwd: string;
  dir: string;
  bylaws: BylawsLoad;
  effective: Bylaws;
  actions: Action[];
  state: SessionState;
  memory: SessionMemory;
  ctx: TaintContext;
  where: Where;
  verdict: Verdict;
  unattended: boolean;
  now: Date | undefined;
}

/**
 * The deferred ask (0.19.0) at a PreToolUse call: a deletion or document ask is held for the person (denied and queued)
 * under --unattended or with `defer: true`, and a call the person approved runs once. A failure keeps the verdict.
 */
function deferAt(d: DeferAtInput): ReturnType<typeof deferStep> {
  try {
    const residual = (): Verdict => {
      const guards = withoutDeferrable(BUILTIN_GUARDS);
      const own = d.actions.map((a) => decide(a, d.bylaws, d.state, guards, d.where));
      const first = own[0] ?? decide({ kind: 'other', tool: d.input.tool_name }, d.bylaws, d.state, guards, d.where);
      const base = strictestOf([...own, ...adapterVerdicts(d.input.tool_name, d.effective).filter((v) => !isDeferrableRule(v.rule))], first);
      return combineVerdict(base, [...d.actions.flatMap((a) => sessionFindings(a, d.memory, d.effective, d.ctx)), ...unreadableFindings(d.memory)]);
    };
    const mask = namedDetectors(d.effective.rules);
    // With a work order named (0.28.0), the files the call sends or replaces are bound too, so an approval of a held send
    // lapses when such a file changes, even for a tool call whose arguments name the file only as text.
    const extra: Action[] = [];
    if (d.where.order !== undefined) {
      for (const a of d.actions) {
        let parsed: ParsedCommand | null = null;
        if (a.kind === 'exec') {
          try {
            parsed = parseCommand(a.command, a.shell);
          } catch {
            parsed = null;
          }
        }
        for (const p of holdPaths({ action: a, parsed, bylaws: d.effective, state: d.state, where: d.where }, d.where)) extra.push({ kind: 'read', tool: 'openmorals-hold', path: p });
      }
    }
    return deferStep({
      verdict: d.verdict,
      residual,
      bylawsOk: d.bylaws.ok,
      queueOn: d.unattended || d.effective.defer === true,
      session: d.input.session_id,
      call: { cwd: d.cwd, tool: d.input.tool_name, args: bindingArgs(d.input.tool_name, d.input.tool_input), actions: [...d.actions, ...extra], home: d.where.home },
      configDir: d.dir,
      shown: summarize(d.actions.map((a) => describeAction(a, mask)).join(' ; ')),
      ...(d.now !== undefined ? { now: d.now } : {}),
    });
  } catch {
    return { kind: 'none', verdict: d.verdict };
  }
}

function finishPre(j: Judged, judged: Verdict, opts: HookOptions): HookRun {
  let verdict = judged;
  const { input, dir, state, unattended } = j;
  const auditOn = !j.bylaws.ok || j.bylaws.bylaws.audit.enabled;
  const meta = auditMeta({ bylaws: j.effective, event: input.hook_event_name ?? 'PreToolUse', agent: input.agent_id, env: opts.env ?? process.env });
  const outbound = scanOutbound(j.actions, j.effective, { source: 'claude-code', session: input.session_id, cwd: j.cwd }, opts.now);
  const mask = namedDetectors(j.effective.rules);
  const line = (v: Verdict): ReturnType<typeof chainAudit> =>
    chainAudit(
      [makeAuditRecord({ source: 'claude-code', session: input.session_id, tool: input.tool_name, action: j.actions.map((a) => describeAction(a, mask)).join(' ; '), decision: v.decision, rule: v.rule, reason: v.reason, cwd: j.cwd, budget: { tool_calls: state.toolCalls, tokens: state.tokens }, tests: testWritesOf(j.actions, j.cwd) }, opts.now), ...outbound.records],
      meta,
      j.memory.chain,
    );
  let chained = auditOn ? line(verdict) : null;
  let memory = j.memory;
  const guide = firstActivity(j, verdict);
  if (guide !== null) memory = { ...memory, guided: [...(memory.guided ?? []), ...guide.activities] };
  for (const a of j.actions) memory = recordAction(memory, a, verdict, j.ctx, input.tool_use_id, mask);
  memory = withOutboundPending(memory, j, verdict);
  for (const t of outbound.taint) memory = { ...memory, taint: reduceTaint(memory.taint, t, j.ctx) };
  try {
    saveSession(input.session_id ?? 'unknown', settleBudget(state), chained?.head !== undefined ? { ...memory, chain: chained.head } : memory, dir, opts.now);
  } catch (err: unknown) {
    const d = strictest(verdict.decision, unattended ? 'deny' : 'ask');
    verdict = { decision: d, rule: d === verdict.decision && verdict.decision !== 'allow' ? verdict.rule : 'budget.unmeasured', reason: `${verdict.decision === 'allow' ? '' : `${verdict.reason}; `}the session state (budget counter, history, taint) could not be saved (${err instanceof Error ? err.message : String(err)})` };
    if (chained !== null) chained = line(verdict);
  }
  if (chained !== null) {
    try {
      appendAuditText(chained.text, auditLogPath(dir));
    } catch (err: unknown) {
      const d = strictest(verdict.decision, unattended ? 'deny' : 'ask');
      verdict = { decision: d, rule: verdict.decision === 'allow' ? 'audit.unwritable' : verdict.rule, reason: `${verdict.decision === 'allow' ? '' : `${verdict.reason}; `}the audit log could not be written (${err instanceof Error ? err.message : String(err)})` };
    }
  }
  const stdout = withUserNotice(toHookOutput(verdict), j.userNotice);
  return { stdout: guide !== null && verdict.decision === 'allow' ? withActivityContext(stdout, guide.text) : stdout, exitCode: 0, verdict };
}

/**
 * The first-activity guidance (0.29.0): with `guidance.first_activity: true` in the person's own file, on a call the hook
 * allows, the guidance of each activity the call belongs to that this session has not had yet. Null otherwise, and on any
 * failure (the guidance is advice; it never changes or delays a decision). An asked or refused call carries only its reason.
 */
function firstActivity(j: Judged, verdict: Verdict): { activities: SkillActivity[]; text: string } | null {
  if (j.effective.guidance?.first_activity !== true || verdict.decision !== 'allow') return null;
  try {
    const had = j.memory.guided ?? [];
    const activities = callActivities(j.actions, j.effective, j.where).filter((a) => !had.includes(a));
    if (activities.length === 0) return null;
    const daily = shippedDaily();
    if (!daily.ok) return null;
    const text = firstActivityText(daily.principles, activities);
    return text === null ? null : { activities, text };
  } catch {
    return null;
  }
}

/** A PreToolUse answer with the first-activity guidance as `hookSpecificOutput.additionalContext` (no permission decision added). */
export function withActivityContext(stdout: string, text: string): string {
  let o: Record<string, unknown> = {};
  if (stdout !== '') {
    try {
      const parsed: unknown = JSON.parse(stdout);
      if (!isRecord(parsed)) return stdout;
      o = parsed;
    } catch {
      return stdout;
    }
  }
  const h = isRecord(o['hookSpecificOutput']) ? o['hookSpecificOutput'] : { hookEventName: 'PreToolUse' };
  h['additionalContext'] = text;
  o['hookSpecificOutput'] = h;
  return JSON.stringify(o);
}

/** A PreToolUse answer with a line for the person only (`systemMessage`, which the model does not read). */
export function withUserNotice(stdout: string | null, notice: string | undefined): string {
  if (notice === undefined) return stdout ?? '';
  if (stdout === null) return JSON.stringify({ systemMessage: notice });
  const o: unknown = JSON.parse(stdout);
  return JSON.stringify(isRecord(o) ? { ...o, systemMessage: notice } : o);
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
  const mask = namedDetectors(j.effective.rules);
  const steps = j.memory.history.slice(-5).map((h) => describeAction(h.action, mask));
  const lifted = j.actions.slice(1).map((a) => describeAction(a, mask));
  return `host: Claude Code; tool: ${j.input.tool_name}; project folder: ${j.cwd}${lifted.length > 0 ? `; its arguments name: ${lifted.join(' | ')}` : ''}${steps.length > 0 ? `; recent steps: ${steps.join(' | ')}` : ''}`;
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
    const parsed = parseHookInput(stdinText);
    if (parsed.ok && parsed.input.hook_event_name !== null && POST_EVENTS.includes(parsed.input.hook_event_name)) {
      try {
        return await recordPostJudged(parsed.input, { ...opts, env });
      } catch (err: unknown) {
        return postFailure(err);
      }
    }
    const pre = judgePre(stdinText, opts, unattended);
    if (pre.kind === 'done') return pre.run;
    let verdict = pre.verdict;
    const cfg = pre.effective.reviewer;
    if (pre.bylaws.ok && cfg.enabled && verdict.decision === 'ask' && !unattended) {
      verdict = (await reviewVerdict(maskAction(pre.action, namedDetectors(pre.effective.rules)), verdict, cfg, { env, provider: opts.reviewProvider, context: recentContext(pre) })).verdict;
    }
    return finishPre(pre, verdict, opts);
  } catch (err: unknown) {
    return internalError(err, unattended);
  }
}
