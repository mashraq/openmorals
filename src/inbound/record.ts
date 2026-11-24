// The I/O half of inbound scanning, shared by every adapter: read the bylaws for the project, scan, fold the result into
// the session's taint (and, after a tool call, its outcome for the loop detector), save the session and write one audit
// line per finding. The host-specific output shape is the adapter's job.
import { appendAudit, makeAuditRecord } from '../audit.js';
import { DEFAULT_BYLAWS, resolveBylaws } from '../bylaws.js';
import type { Outcome } from '../loop/index.js';
import { auditLogPath, configDir } from '../paths.js';
import { recordOutcome, taintContext } from '../session.js';
import type { SessionMemory } from '../session.js';
import { loadSession, saveSession } from '../state.js';
import { reduceTaint } from '../taint/index.js';
import type { Action, Bylaws } from '../types.js';
import type { InboundOutcome } from './policy.js';
import { judgePrompt, judgeToolResult, safeToolName } from './policy.js';

export interface PostToolEvent {
  /** Audit source: claude-code, codex, gemini-cli or opencode. */
  source: string;
  session: string | null;
  cwd: string | null;
  tool: string;
  /** The actions the call was judged as before it ran, used to find its history entry. */
  actions: readonly Action[];
  /** Whether the call worked, when the host says; null when it does not. */
  outcome: Outcome | null;
  /** The host's id for the call, when it sends one. */
  id: string | null;
  /** The text of the result (or the error), or null when there is none to scan. */
  content: string | null;
}

export interface PromptEvent {
  source: string;
  session: string | null;
  cwd: string | null;
  prompt: string;
}

export interface InboundRunOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  now?: Date;
  unattended?: boolean;
  platform?: NodeJS.Platform;
}

interface Ctx {
  bylaws: Bylaws;
  auditOn: boolean;
  dir: string;
  cwd: string;
}

function contextOf(cwdIn: string | null, opts: InboundRunOptions): Ctx {
  const env = opts.env ?? process.env;
  const cwd = cwdIn ?? opts.cwd ?? process.cwd();
  const load = resolveBylaws(cwd, env);
  return { bylaws: load.ok ? load.bylaws : DEFAULT_BYLAWS, auditOn: !load.ok || load.bylaws.audit.enabled, dir: configDir(env), cwd };
}

function finish(ctx: Ctx, source: string, session: string | null, tool: string, loaded: { memory: SessionMemory; state: Parameters<typeof saveSession>[1] }, memory: SessionMemory, result: InboundOutcome, opts: InboundRunOptions): InboundOutcome {
  let out = result;
  if (memory !== loaded.memory) {
    try {
      saveSession(session ?? 'unknown', loaded.state, memory, ctx.dir, opts.now);
    } catch (err: unknown) {
      if (out.taint !== null) {
        const why = `the session taint could not be saved (${err instanceof Error ? err.message : String(err)})`;
        out = { ...out, verdict: { ...out.verdict, reason: `${out.verdict.reason}; ${why}` }, userNotice: out.userNotice ?? `openmorals: a finding (${out.verdict.rule}) could not be kept for this session: ${why}` };
      }
    }
  }
  if (out.record && ctx.auditOn) {
    try {
      appendAudit(
        makeAuditRecord({ source, session, tool, action: `inbound ${out.origin}: ${tool}`, decision: out.verdict.decision, rule: out.verdict.rule, reason: out.verdict.reason, cwd: ctx.cwd, budget: null }, opts.now),
        auditLogPath(ctx.dir),
      );
    } catch {
      // A lost audit line cannot make reading unsafe; the notice and the taint still apply.
    }
  }
  return out;
}

/** After a tool call: record its outcome for the loop detector, scan its result, taint the session on a finding. */
export function handlePostTool(ev: PostToolEvent, opts: InboundRunOptions = {}): InboundOutcome {
  const ctx = contextOf(ev.cwd, opts);
  const loaded = loadSession(ev.session ?? 'unknown', ctx.dir);
  let memory = loaded.memory;
  if (ev.outcome !== null) {
    ev.actions.forEach((a, i) => {
      memory = recordOutcome(memory, a, ev.outcome ?? { ok: true }, i === 0 ? ev.id : null);
    });
  }
  const tool = safeToolName(ev.tool);
  const result = ev.content === null || ev.content === '' ? judgeToolResult(tool, '', { ...ctx.bylaws.guards.inbound, enabled: false }) : judgeToolResult(tool, ev.content, ctx.bylaws.guards.inbound, { taintDecision: ctx.bylaws.guards.taint.decision });
  if (result.taint !== null) memory = { ...memory, taint: reduceTaint(memory.taint, result.taint, taintContext(ctx.cwd, ctx.bylaws, opts.platform)) };
  return finish(ctx, ev.source, ev.session, tool, loaded, memory, result, opts);
}

/** On a submitted prompt: scan it, taint the session on a finding, and say what the host should do. */
export function handlePrompt(ev: PromptEvent, opts: InboundRunOptions = {}): InboundOutcome {
  const ctx = contextOf(ev.cwd, opts);
  const loaded = loadSession(ev.session ?? 'unknown', ctx.dir);
  let memory = loaded.memory;
  const result = judgePrompt(ev.prompt, ctx.bylaws.guards.inbound, { unattended: opts.unattended === true, taintDecision: ctx.bylaws.guards.taint.decision, secretsDecision: ctx.bylaws.guards.secrets.send });
  if (result.taint !== null) memory = { ...memory, taint: reduceTaint(memory.taint, result.taint, taintContext(ctx.cwd, ctx.bylaws, opts.platform)) };
  return finish(ctx, ev.source, ev.session, 'prompt', loaded, memory, result, opts);
}
