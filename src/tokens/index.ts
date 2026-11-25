import type { Finding } from '../guard.js';
import type { SessionMemory } from '../session.js';
import type { Bylaws, SessionState, Verdict } from '../types.js';
import { agentFindings, countAgentCall } from './agents.js';
import { stopVerdict } from './stop.js';
import { readTranscripts, transcriptTotals } from './transcript.js';

export * from './agents.js';
export * from './stop.js';
export * from './transcript.js';

export interface TokenControlInput {
  session: string | null;
  /** The sub-agent the hook fires in, or null for the main conversation. */
  agent: string | null;
  agentType: string | null;
  tool: string;
  /** Claude Code's `transcript_path`, when the host gives one. */
  transcriptPath: string | null;
  memory: SessionMemory;
  /** The session's counts with this call counted. */
  state: SessionState;
  bylaws: Bylaws;
  dir: string;
}

export interface TokenControlResult {
  /** The memory to save, with the transcript counts and agent counts updated. */
  memory: SessionMemory;
  /** The counts the budget guard judges: the session's, plus what the transcripts show. */
  guardState: SessionState;
  findings: Finding[];
  /** The refusal when the person stopped this session, or null. */
  stop: Verdict | null;
}

/**
 * Token control at one judged call (0.36.0): reads what Claude Code's logs gained since the last call, counts the call
 * for its agent, and returns the per-agent, spawn and fan-out findings and the stop verdict. A failure asks.
 */
export function tokenControl(i: TokenControlInput): TokenControlResult {
  const stop = stopVerdict(i.dir, i.session);
  try {
    let memory = i.memory;
    let extra = 0;
    let extraPrev = 0;
    if (i.transcriptPath !== null && i.bylaws.guards.budget.transcript !== false) {
      const usage = readTranscripts(i.transcriptPath, memory.usage);
      const now = transcriptTotals(usage).tokens;
      extra = now;
      extraPrev = Math.min(usage.prev, now);
      memory = { ...memory, usage: { ...usage, prev: now } };
    }
    const agents = countAgentCall(memory.agents, i.agent, i.tool, i.agentType);
    const findings = agentFindings(memory.agents, agents, i.agent, i.agentType, i.tool, i.bylaws);
    memory = { ...memory, agents };
    const guardState: SessionState = { ...i.state, tokens: i.state.tokens + extra, prevTokens: i.state.prevTokens + extraPrev };
    return { memory, guardState, findings, stop };
  } catch (err: unknown) {
    return { memory: i.memory, guardState: i.state, findings: [{ decision: 'ask', rule: 'budget.unmeasured', reason: `the token and sub-agent counts could not be updated (${err instanceof Error ? err.message : String(err)})` }], stop };
  }
}
