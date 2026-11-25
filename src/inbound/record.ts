// The I/O half of inbound scanning, shared by every adapter: read the bylaws for the project, scan, fold the result into
// the session's taint (and, after a tool call, its outcome for the loop detector), save the session and write one audit
// line per finding. The host-specific output shape is the adapter's job.
import type { AuditFields } from '../audit.js';
import { appendAuditText, auditMeta, chainAudit, makeAuditRecord } from '../audit.js';
import { effectiveBylaws, resolveBylaws } from '../bylaws.js';
import type { Outcome } from '../loop/index.js';
import { auditLogPath, configDir } from '../paths.js';
import { findCallEntry, recordOutcome, taintContext } from '../session.js';
import { namedDetectors } from '../rules/detectors.js';
import type { SessionMemory } from '../session.js';
import { loadSession, saveSession } from '../state.js';
import { reduceTaint } from '../taint/index.js';
import type { Action, Bylaws } from '../types.js';
import type { InboundOutcome } from './policy.js';
import { judgePrompt, judgeToolResult, safeToolName } from './policy.js';
import { flaggedSpan, judgeSpan } from './judge.js';
import type { FetchLike } from '../reviewer/http.js';
import type { ReviewProvider } from '../reviewer/types.js';

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
  /** The host's event name, for the audit record (0.8.0). */
  event?: string | null;
  /** The host's agent id, when it sends one (0.8.0). */
  agent?: string | null;
}

export interface PromptEvent {
  source: string;
  session: string | null;
  cwd: string | null;
  prompt: string;
  event?: string | null;
  agent?: string | null;
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
  env: NodeJS.ProcessEnv;
}

/** Who and what the audit lines of one event name. */
interface Origin {
  source: string;
  session: string | null;
  tool: string;
  event: string | null | undefined;
  agent: string | null | undefined;
}

function contextOf(cwdIn: string | null, opts: InboundRunOptions): Ctx {
  const env = opts.env ?? process.env;
  const cwd = cwdIn ?? opts.cwd ?? process.cwd();
  const load = resolveBylaws(cwd, env);
  return { bylaws: effectiveBylaws(load), auditOn: !load.ok || load.bylaws.audit.enabled, dir: configDir(env), cwd, env };
}

/**
 * Saves the session when anything changed and writes the event's audit lines: first any `ask.approved` lines (`before`),
 * then the finding, chained after the session's head. The new head is saved with the session; when the save fails the
 * lines are rebuilt from the changed outcome with the same numbers (the next record then repeats them: a fork that
 * `audit verify` reports as a note).
 */
function finish(ctx: Ctx, from: Origin, loaded: { memory: SessionMemory; state: Parameters<typeof saveSession>[1] }, memory: SessionMemory, result: InboundOutcome, opts: InboundRunOptions, before: readonly AuditFields[] = []): InboundOutcome {
  let out = result;
  const meta = auditMeta({ bylaws: ctx.bylaws, event: from.event, agent: from.agent, env: ctx.env });
  const lines = (o: InboundOutcome): ReturnType<typeof chainAudit> | null => {
    if (!ctx.auditOn) return null;
    const recs: AuditFields[] = [...before];
    if (o.record) recs.push(makeAuditRecord({ source: from.source, session: from.session, tool: from.tool, action: `inbound ${o.origin}: ${from.tool}`, decision: o.verdict.decision, rule: o.verdict.rule, reason: o.verdict.reason, cwd: ctx.cwd, budget: null }, opts.now));
    return recs.length === 0 ? null : chainAudit(recs, meta, loaded.memory.chain);
  };
  let chained = lines(out);
  const toSave = chained?.head !== undefined ? { ...memory, chain: chained.head } : memory;
  if (toSave !== loaded.memory) {
    try {
      saveSession(from.session ?? 'unknown', loaded.state, toSave, ctx.dir, opts.now);
    } catch (err: unknown) {
      if (out.taint !== null) {
        const why = `the session taint could not be saved (${err instanceof Error ? err.message : String(err)})`;
        out = { ...out, verdict: { ...out.verdict, reason: `${out.verdict.reason}; ${why}` }, userNotice: out.userNotice ?? `openmorals: a finding (${out.verdict.rule}) could not be kept for this session: ${why}` };
        chained = lines(out);
      }
    }
  }
  if (chained !== null) {
    try {
      appendAuditText(chained.text, auditLogPath(ctx.dir));
    } catch {
      // A lost audit line cannot make reading unsafe; the notice and the taint still apply.
    }
  }
  return out;
}

/** After a tool call: record its outcome for the loop detector, scan its result, taint the session on a finding. */
export function handlePostTool(ev: PostToolEvent, opts: InboundRunOptions = {}): InboundOutcome {
  return postTool(ev, opts).outcome;
}

function postTool(ev: PostToolEvent, opts: InboundRunOptions): { ctx: Ctx; outcome: InboundOutcome } {
  const ctx = contextOf(ev.cwd, opts);
  const loaded = loadSession(ev.session ?? 'unknown', ctx.dir);
  let memory = loaded.memory;
  const tool = safeToolName(ev.tool);
  const approved: AuditFields[] = [];
  if (ev.outcome !== null) {
    const mask = namedDetectors(ctx.bylaws.rules);
    ev.actions.forEach((a, i) => {
      const id = i === 0 ? ev.id : null;
      const entry = memory.history[findCallEntry(memory.history, a, id, mask)];
      if (entry?.asked !== undefined && entry.outcome === undefined) {
        approved.push(makeAuditRecord({ source: ev.source, session: ev.session, tool, action: `outcome: ${tool}`, decision: 'allow', rule: 'ask.approved', reason: `the call ran after openmorals asked [${entry.asked}], so the ask was approved${ev.outcome?.ok === false ? '; the call then failed' : ''}`, cwd: ctx.cwd, budget: null }, opts.now));
      }
      memory = recordOutcome(memory, a, ev.outcome ?? { ok: true }, id, mask);
    });
  }
  const result = ev.content === null || ev.content === '' ? judgeToolResult(tool, '', { ...ctx.bylaws.guards.inbound, enabled: false }) : judgeToolResult(tool, ev.content, ctx.bylaws.guards.inbound, { taintDecision: ctx.bylaws.guards.taint.decision });
  if (result.taint !== null) memory = { ...memory, taint: reduceTaint(memory.taint, result.taint, taintContext(ctx.cwd, ctx.bylaws, opts.platform)) };
  return { ctx, outcome: finish(ctx, { source: ev.source, session: ev.session, tool, event: ev.event, agent: ev.agent }, loaded, memory, result, opts, approved) };
}

export interface JudgedRunOptions extends InboundRunOptions {
  /** Replaces the reviewer provider the bylaws name (tests). */
  provider?: ReviewProvider;
  /** The fetch the configured provider uses (tests). */
  fetch?: FetchLike;
  nonce?: string;
}

/**
 * `handlePostTool`, then, only when the user-level bylaws switch `guards.inbound.judge` on and the result held a weak
 * finding (visible text that reads like an instruction), the judge: the flagged lines go to the reviewer's provider.
 * Its `escalate` (or any failure) adds an injection mark to the session, so later steps that reach the network or touch
 * private data ask; `no-objection` changes nothing. With the judge off this is exactly `handlePostTool` and sends nothing.
 */
export async function handlePostToolJudged(ev: PostToolEvent, opts: JudgedRunOptions = {}): Promise<InboundOutcome> {
  const { ctx, outcome } = postTool(ev, opts);
  if (ctx.bylaws.guards.inbound.judge !== true || ev.content === null || outcome.scan === null || outcome.taint?.type !== 'untrusted') return outcome;
  const flagged = flaggedSpan(ev.content, outcome.scan);
  if (flagged === null) return outcome;
  const tool = safeToolName(ev.tool);
  const env = opts.env ?? process.env;
  const j = await judgeSpan(tool, flagged, ctx.bylaws.reviewer, { env, dir: ctx.dir, ...(opts.provider !== undefined ? { provider: opts.provider } : {}), ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}), ...(opts.nonce !== undefined ? { nonce: opts.nonce } : {}), ...(opts.now !== undefined ? { now: opts.now } : {}) });
  const note = `judge (${ctx.bylaws.reviewer.provider}, ${j.source}${j.sent ? '' : ', nothing sent'}): ${j.verdict === 'escalate' ? 'confirmed or could not clear it as an injection, so later network or private-data steps ask' : 'reads as ordinary content; nothing changed'}`;
  const verdict = { ...outcome.verdict, reason: `${outcome.verdict.reason}; ${note}` };
  const loaded = loadSession(ev.session ?? 'unknown', ctx.dir);
  let memory = loaded.memory;
  if (j.verdict === 'escalate') memory = { ...memory, taint: reduceTaint(memory.taint, { type: 'injected', detail: `${outcome.verdict.rule} in ${tool} output, confirmed by the judge` }, taintContext(ctx.cwd, ctx.bylaws, opts.platform)) };
  const judged: InboundOutcome = { ...outcome, verdict: { ...verdict, rule: j.verdict === 'escalate' ? 'inbound.judge-escalated' : 'inbound.judge-cleared' }, record: true };
  return finish(ctx, { source: ev.source, session: ev.session, tool, event: ev.event, agent: ev.agent }, loaded, memory, judged, opts);
}

/** On a submitted prompt: scan it, taint the session on a finding, and say what the host should do. */
export function handlePrompt(ev: PromptEvent, opts: InboundRunOptions = {}): InboundOutcome {
  const ctx = contextOf(ev.cwd, opts);
  const loaded = loadSession(ev.session ?? 'unknown', ctx.dir);
  let memory = loaded.memory;
  const result = judgePrompt(ev.prompt, ctx.bylaws.guards.inbound, { unattended: opts.unattended === true, taintDecision: ctx.bylaws.guards.taint.decision, secretsDecision: ctx.bylaws.guards.secrets.send });
  if (result.taint !== null) memory = { ...memory, taint: reduceTaint(memory.taint, result.taint, taintContext(ctx.cwd, ctx.bylaws, opts.platform)) };
  return finish(ctx, { source: ev.source, session: ev.session, tool: 'prompt', event: ev.event, agent: ev.agent }, loaded, memory, result, opts);
}
