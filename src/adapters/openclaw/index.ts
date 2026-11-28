// OpenClaw adapter. OpenClaw's extension point is an in-process plugin with typed hooks (read 24 Nov 2026, see
// docs/adapters.md): `before_tool_call` may return { block, blockReason } or { requireApproval } (a native ask, routed
// to the chat channel's approval buttons), and a thrown error or a timeout blocks the call. The plugin this module
// writes sends each event, as JSON, to `openmorals hook openclaw`, which `runOpenclawHook` answers. `after_tool_call`
// and `llm_output` are observe-only: they record the outcome, scan the result and count the reported tokens.
import { handlePostTool } from '../../inbound/index.js';
import type { Action, ShellKind, Verdict } from '../../types.js';
import { contentAction, contentText, writeContent } from '../../inbound/outbound.js';
import { recordUsage } from '../../usage.js';
import type { PatchFileContent } from '../codex/patch.js';
import { parsePatchContent, patchChange, patchWrites } from '../codex/patch.js';
import { argActions, auditFailure, errText, failVerdict, hostConfigVerdicts, hostShell, isRecord, judge, mcpDeleteVerdict, parseJsonObject, reasonText, strOf } from '../codex/pipeline.js';
import type { JudgeOptions } from '../codex/pipeline.js';
import { OPENCLAW_PLUGIN_DIR, OPENCLAW_PLUGIN_MARKER, openclawIndexSource, openclawManifest, openclawPackageJson } from './plugin.js';

export { OPENCLAW_PLUGIN_DIR, OPENCLAW_PLUGIN_MARKER, openclawIndexSource, openclawManifest, openclawPackageJson } from './plugin.js';

export const SOURCE = 'openclaw';
export const DEFAULT_COMMAND: readonly string[] = Object.freeze(['openmorals', 'hook', 'openclaw']);

export interface MappedCall {
  actions: Action[];
  problem: string | null;
  mcp: boolean;
}

/**
 * The host's apply_patch targets as writes (0.15.0). A target the patch text names gets that file's added lines; one it does
 * not name gets every added line of the patch (more text checked, never less); with no readable patch text, no content.
 */
function derivedWrites(paths: readonly string[], files: readonly PatchFileContent[], tool: string): Action[] {
  const all = files.flatMap((f) => (f.added !== undefined && f.added !== '' ? [f.added] : [])).join('\n');
  return paths.map((path) => {
    const own = files.find((f) => f.path === path && f.added !== undefined);
    const text = own?.added ?? (files.length > 0 ? all : undefined);
    const out: Extract<Action, { kind: 'write' }> = { kind: 'write', path, tool };
    if (text !== undefined) out.content = contentText(text);
    const named = files.find((f) => f.path === path);
    const change = named !== undefined && (named.op === 'delete' || own !== undefined) ? patchChange(named) : undefined;
    if (change !== undefined) out.change = change;
    return out;
  });
}

/**
 * Maps one before_tool_call to the core's actions. Tool ids and parameter keys MEASURED from the v2026.11.7 source:
 * exec { command, workdir }, read { path }, write { path, content }, edit { path, edits }, web_fetch { url }; apply_patch
 * targets come from the host's `derivedPaths` (documented as best-effort), else from the patch text. Any other tool is
 * judged by name and by the paths and URLs in its parameters.
 */
export function openclawToolActions(tool: string, params: unknown, derivedPaths: readonly string[], shell: ShellKind = 'posix'): MappedCall {
  const p = isRecord(params) ? params : {};
  const s = (k: string): string | null => strOf(p, k);
  const none = (problem: string): MappedCall => ({ actions: [{ kind: 'other', tool }], problem, mcp: false });
  switch (tool) {
    case 'exec': {
      const command = s('command');
      if (command === null || command.trim() === '') return none('the exec call has no command');
      return { actions: [{ kind: 'exec', command, shell, tool }], problem: null, mcp: false };
    }
    case 'read': {
      const path = s('path');
      return path === null ? none('the read call has no path') : { actions: [{ kind: 'read', path, tool }], problem: null, mcp: false };
    }
    case 'write':
    case 'edit': {
      const path = s('path');
      if (path === null) return none(`the ${tool} call has no path`);
      const content = writeContent(p[tool === 'write' ? 'content' : 'edits']);
      const out: Extract<Action, { kind: 'write' }> = { kind: 'write', path, tool };
      if (content !== undefined) out.content = content;
      if (tool === 'write' && content !== undefined) out.change = { kind: 'whole' };
      return { actions: [out], problem: null, mcp: false };
    }
    case 'apply_patch': {
      const text = s('input') ?? s('patch') ?? s('patchText');
      const parsed = text !== null ? parsePatchContent(text) : null;
      if (derivedPaths.length > 0) return { actions: derivedWrites(derivedPaths, parsed !== null && parsed.ok ? parsed.files : [], tool), problem: null, mcp: false };
      if (text === null || parsed === null) return none('the apply_patch call has neither target paths nor patch text');
      if (!parsed.ok) return none(`the patch could not be read (${parsed.error})`);
      return { actions: patchWrites(parsed.files, tool), problem: null, mcp: false };
    }
    case 'web_fetch': {
      const url = s('url');
      return url === null ? none('the web_fetch call has no url') : { actions: [{ kind: 'fetch', url, tool }], problem: null, mcp: false };
    }
    default: {
      const found = argActions(tool, p);
      const other = contentAction('openclaw', tool, p);
      return { actions: found.length > 0 ? (other.args !== undefined || other.message !== undefined ? [...found, other] : found) : [other], problem: null, mcp: tool.includes('__') };
    }
  }
}

export interface OpenclawAnswer {
  decision: Verdict['decision'];
  rule: string;
  /** True: the plugin returns { block: true, blockReason: message }. */
  block: boolean;
  /** For an ask: what the plugin puts in requireApproval (allow-once or deny only; never allow-always). */
  approval: { title: string; description: string; severity: 'warning' | 'critical' } | null;
  message: string;
  /**
   * How many of the `missed` entries this call took (0.40.1). Set only after the session, with its taint mark, was saved;
   * absent from a fail-closed answer and when the save failed, so the plugin keeps the entries and the next call asks again.
   */
  missedTaken?: number;
}

export function toOpenclawAnswer(v: Verdict): OpenclawAnswer {
  if (v.decision === 'allow') return { decision: 'allow', rule: v.rule, block: false, approval: null, message: '' };
  if (v.decision === 'deny') return { decision: 'deny', rule: v.rule, block: true, approval: null, message: reasonText(v) };
  return { decision: 'ask', rule: v.rule, block: false, approval: { title: `openmorals asks before this step [${v.rule}]`, description: reasonText(v), severity: v.rule.startsWith('secrets.') ? 'critical' : 'warning' }, message: reasonText(v) };
}

export interface OpenclawHookRun {
  stdout: string;
  exitCode: 0;
  verdict: Verdict;
}

export interface OpenclawHookOptions extends JudgeOptions {
  platform?: NodeJS.Platform;
}

const OBSERVED: OpenclawAnswer = { decision: 'allow', rule: 'hook.observed', block: false, approval: null, message: '' };

function failClosed(reason: string, rule: string, opts: OpenclawHookOptions): OpenclawHookRun {
  const verdict = failVerdict(reason, rule, opts);
  auditFailure(SOURCE, verdict, opts);
  const answer: OpenclawAnswer = { decision: verdict.decision, rule, block: true, approval: null, message: `${reasonText(verdict)}. openmorals could not read this call, so it is blocked.` };
  return { stdout: JSON.stringify(answer), exitCode: 0, verdict };
}

function observed(verdict: Verdict): OpenclawHookRun {
  return { stdout: JSON.stringify(verdict.rule === 'hook.observe-error' ? { ...OBSERVED, rule: verdict.rule, message: verdict.reason } : OBSERVED), exitCode: 0, verdict };
}

/** At most this many missed events are read from one before_tool_call; more are counted, not named. */
const MISSED_KEEP = 8;

export interface MissedEvents {
  /** Tool names whose after_tool_call never reached openmorals: their results were not scanned. */
  results: string[];
  /** How many llm_output events never reached openmorals: their tokens were not counted. */
  turns: number;
  /** How many entries were sent in all. */
  total: number;
}

/**
 * The events the plugin could not deliver before this call (0.40.1). `after_tool_call` and `llm_output` only observe, so a
 * failure there cannot block anything; the plugin remembers it and sends it with the next before_tool_call of the session.
 */
export function missedEvents(v: unknown): MissedEvents {
  const out: MissedEvents = { results: [], turns: 0, total: 0 };
  if (!Array.isArray(v)) return out;
  for (const m of v) {
    out.total++;
    const event = isRecord(m) ? strOf(m, 'event') : null;
    if (event === 'llm_output') out.turns++;
    else if (out.results.length < MISSED_KEEP) {
      const tool = isRecord(m) ? strOf(m, 'toolName') : null;
      out.results.push(tool !== null && tool !== '' ? tool.slice(0, 80) : 'unknown');
    }
  }
  return out;
}

function missedVerdicts(m: MissedEvents): Verdict[] {
  const out: Verdict[] = [];
  const unscanned = m.total - m.turns;
  if (unscanned > 0) out.push({ decision: 'ask', rule: 'inbound.error', reason: `the result of ${unscanned === 1 ? 'an earlier call' : `${unscanned} earlier calls`} (${m.results.join(', ')}) never reached openmorals, so it was not scanned for hidden instructions and the session is treated as if it held them` });
  if (m.turns > 0) out.push({ decision: 'ask', rule: 'budget.unmeasured', reason: `the token use of ${m.turns === 1 ? 'an earlier model turn' : `${m.turns} earlier model turns`} never reached openmorals, so the token count is short` });
  return out;
}

/** Answers one event from the openmorals OpenClaw plugin. Never throws; an unreadable before_tool_call is blocked. */
export function runOpenclawHook(stdinText: string, opts: OpenclawHookOptions = {}): OpenclawHookRun {
  const p = parseJsonObject(stdinText);
  if (!p.ok) return failClosed(p.error, 'hook.bad-input', opts);
  const o = p.value;
  const event = strOf(o, 'event');
  const session = strOf(o, 'sessionId');
  const cwd = strOf(o, 'cwd');
  try {
    if (event === 'llm_output') {
      const r = recordUsage({ session, cwd, model: strOf(o, 'model'), usage: o['usage'] }, opts);
      return observed({ decision: 'allow', rule: 'budget.usage', reason: r.reason });
    }
    const tool = strOf(o, 'toolName');
    if (event === 'after_tool_call') {
      const name = tool ?? 'unknown';
      const error = strOf(o, 'error');
      const mapped = openclawToolActions(name, o['params'], [], hostShell(opts.platform ?? process.platform));
      const content = [strOf(o, 'output'), error].filter((x): x is string => x !== null && x !== '').join('\n');
      const res = handlePostTool({ source: SOURCE, session, cwd, tool: name, actions: mapped.actions, outcome: error !== null ? { ok: false, error } : { ok: true }, id: strOf(o, 'toolCallId'), content, event, agent: strOf(o, 'agentId') }, opts);
      if (res.unsaved !== undefined) return observed({ decision: 'allow', rule: 'hook.observe-error', reason: `the ${name} result was scanned but its mark (${res.verdict.rule}) could not be saved: ${res.unsaved}` });
      return observed(res.verdict);
    }
    if (event !== 'before_tool_call') return failClosed(event === null ? 'the input has no event name' : `unknown event '${event}'`, 'hook.bad-input', opts);
    if (tool === null || tool === '') return failClosed('the before_tool_call event has no toolName', 'hook.bad-input', opts);
    const dp = o['derivedPaths'];
    const derived = Array.isArray(dp) ? dp.filter((x): x is string => typeof x === 'string' && x !== '') : [];
    const mapped = openclawToolActions(tool, o['params'], derived, hostShell(opts.platform ?? process.platform));
    const problem = mapped.problem;
    const missed = missedEvents(o['missed']);
    let saved = false;
    const verdict = judge(
      {
        source: SOURCE,
        session,
        cwd,
        tool,
        actions: mapped.actions,
        countCall: true,
        event,
        agent: strOf(o, 'agentId'),
        // The id after_tool_call carries too (0.41.3), so an asked call's taint waits for it.
        id: strOf(o, 'toolCallId'),
        extra: (b) => [
          ...(problem === null ? [] : [{ decision: 'ask' as const, rule: 'hook.bad-input', reason: problem }]),
          ...hostConfigVerdicts(mapped.actions, b),
          ...(mapped.mcp ? [mcpDeleteVerdict(tool, b)].filter((x): x is Verdict => x !== null) : []),
          ...missedVerdicts(missed),
        ],
        taint: missed.total > missed.turns ? [{ type: 'injected', detail: `inbound.error in ${missed.results[0] ?? 'unknown'} output (not delivered)` }] : [],
        onSaved: () => {
          saved = true;
        },
      },
      opts,
    );
    const answer: OpenclawAnswer = { ...toOpenclawAnswer(verdict), ...(saved && missed.total > 0 ? { missedTaken: missed.total } : {}) };
    return { stdout: JSON.stringify(answer), exitCode: 0, verdict };
  } catch (err: unknown) {
    if (event === 'llm_output' || event === 'after_tool_call') return observed({ decision: 'allow', rule: 'hook.observe-error', reason: `could not record the ${event} event (${errText(err)})` });
    return failClosed(`openmorals hit an internal error (${errText(err)}) and fails closed`, 'engine.error', opts);
  }
}

export interface InstallSnippet {
  agent: 'openclaw';
  /** The plugin folder, relative to the project; install it with `openclaw plugins install <folder>`. */
  dir: string;
  command: readonly string[];
  files: { 'index.js': string; 'openclaw.plugin.json': string; 'package.json': string };
}

export function installSnippet(projectDir: string, command: readonly string[] = DEFAULT_COMMAND): InstallSnippet {
  return { agent: 'openclaw', dir: OPENCLAW_PLUGIN_DIR, command, files: { 'index.js': openclawIndexSource(command, projectDir), 'openclaw.plugin.json': openclawManifest(), 'package.json': openclawPackageJson() } };
}
