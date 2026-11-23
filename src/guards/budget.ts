import type { Finding, Guard, GuardContext } from '../guard.js';
import type { Limit } from '../types.js';

function band(value: number, limit: Limit): number {
  if (value < limit.soft) return -1;
  return Math.floor((value - limit.soft) / Math.max(1, limit.step));
}

export function budgetFindings(name: string, unit: string, current: number, previous: number, limit: Limit): Finding[] {
  if (limit.hard > 0 && current >= limit.hard) {
    return [{ decision: 'deny', rule: `budget.${name}.hard`, reason: `${current} ${unit} reached the hard limit of ${limit.hard}; raise guards.budget.${name}.hard in openmorals.yaml or start a new session` }];
  }
  if (limit.soft > 0 && band(current, limit) > band(previous, limit)) {
    return [{ decision: 'ask', rule: `budget.${name}.soft`, reason: `${current} ${unit} passed the soft limit of ${limit.soft} (hard limit ${limit.hard}); continue?` }];
  }
  return [];
}

export const budgetGuard: Guard = {
  id: 'budget',
  isHard: () => false,
  evaluate(ctx: GuardContext): Finding[] {
    const b = ctx.bylaws.guards.budget;
    const s = ctx.state;
    return [
      ...budgetFindings('tool_calls', 'tool calls', s.toolCalls, s.toolCalls - 1, b.tool_calls),
      ...budgetFindings('tokens', 'tokens', s.tokens, s.prevTokens, b.tokens),
    ];
  },
};
