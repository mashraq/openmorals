// Token usage that a host reports, folded into the session's budget counters. Pure parsing plus one small I/O step.
// openmorals reads usage only from fields a host documents (or, where marked, infers from its own naming); where a host
// reports nothing, only tool calls are counted. Claude Code's usage numbers are read from its session log instead
// (src/tokens/transcript.ts, ADR 0015), never the text of the conversation.
import { effectiveBylaws, resolveBylaws } from './bylaws.js';
import { configDir } from './paths.js';
import { addCost, addTokens, loadSession, saveSession } from './state.js';
import type { ModelPrice } from './types.js';

export interface UsageCounts {
  /** Prompt tokens, when the host splits them. */
  input: number | null;
  /** Reply tokens, when the host splits them. */
  output: number | null;
  total: number;
}

function n(o: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v);
  }
  return null;
}

/**
 * Reads a usage object in the shapes hosts use: snake case (`input_tokens`, `output_tokens`, `total_tokens`; also
 * `prompt_tokens`/`completion_tokens`), Gemini's (`promptTokenCount`, `candidatesTokenCount`, `totalTokenCount`), or
 * short (`input`, `output`, `total`). The total is the reported total, else input plus output. Null when no count can
 * be read, so an unreadable report counts nothing rather than a guessed number.
 */
export function usageCounts(raw: unknown): UsageCounts | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const input = n(o, 'input_tokens', 'prompt_tokens', 'promptTokenCount', 'input', 'inputTokens');
  const output = n(o, 'output_tokens', 'completion_tokens', 'candidatesTokenCount', 'output', 'outputTokens');
  const total = n(o, 'total_tokens', 'totalTokenCount', 'total', 'totalTokens');
  if (total !== null) return { input, output, total };
  if (input === null && output === null) return null;
  return { input, output, total: (input ?? 0) + (output ?? 0) };
}

/**
 * Prices usage with the user's own table (per million tokens), in hundredths of its currency. Null when the model is
 * not in the table. A total that is not split is priced at the higher of the two rates, so the estimate is never low.
 */
export function costOf(u: UsageCounts, model: string | null, prices: Readonly<Record<string, ModelPrice>> | undefined): number | null {
  if (model === null || prices === undefined) return null;
  const p = Object.prototype.hasOwnProperty.call(prices, model) ? prices[model] : undefined;
  if (p === undefined) return null;
  const per = (tokens: number, rate: number): number => (tokens * rate * 100) / 1_000_000;
  if (u.input !== null && u.output !== null) return per(u.input, p.input) + per(u.output, p.output);
  return per(u.total, Math.max(p.input, p.output));
}

export interface UsageEvent {
  session: string | null;
  cwd: string | null;
  /** The model id the host reports, when it does. */
  model: string | null;
  usage: unknown;
}

export interface UsageResult {
  counted: boolean;
  tokens: number;
  /** Hundredths of the price-table currency, or null when the model has no price. */
  cost: number | null;
  reason: string;
}

/** Adds one reported usage to the session's counters. The next judged call compares them with the budget limits. */
export function recordUsage(ev: UsageEvent, opts: { env?: NodeJS.ProcessEnv; cwd?: string; now?: Date } = {}): UsageResult {
  const u = usageCounts(ev.usage);
  if (u === null) return { counted: false, tokens: 0, cost: null, reason: 'no readable token counts in the event' };
  const env = opts.env ?? process.env;
  const cwd = ev.cwd ?? opts.cwd ?? process.cwd();
  const bylaws = effectiveBylaws(resolveBylaws(cwd, env));
  const cost = costOf(u, ev.model, bylaws.guards.budget.prices);
  const dir = configDir(env);
  const session = ev.session ?? 'unknown';
  const loaded = loadSession(session, dir);
  let state = addTokens(loaded.state, u.total);
  if (cost !== null) state = addCost(state, cost);
  saveSession(session, state, loaded.memory, dir, opts.now, loaded);
  return { counted: true, tokens: u.total, cost, reason: `counted ${u.total} tokens${cost !== null ? ` and ${cost.toFixed(4)} hundredths of spend` : ev.model === null ? ' (no model id, so no price)' : ` (no price for ${ev.model.slice(0, 64)})`}` };
}
