import { cloneBylaws, compileRuleRegex, DEFAULT_BYLAWS } from './bylaws.js';
import type { Finding, Guard, GuardContext } from './guard.js';
import { normalizePath } from './guard.js';
import { budgetGuard } from './guards/budget.js';
import { destructiveGuard } from './guards/destructive.js';
import { onlineDeleteGuard } from './guards/online-delete.js';
import { secretsGuard } from './guards/secrets.js';
import { selfProtectGuard } from './guards/self-protect.js';
import type { ParsedCommand } from './shell.js';
import { parseCommand } from './shell.js';
import type { Action, Bylaws, BylawsLoad, Rule, SessionState, Verdict } from './types.js';
import { decisionRank } from './types.js';

export const BUILTIN_GUARDS: readonly Guard[] = Object.freeze([destructiveGuard, onlineDeleteGuard, secretsGuard, selfProtectGuard, budgetGuard]);

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function actionPaths(action: Action, parsed: ParsedCommand | null): string[] {
  if (action.kind === 'read' || action.kind === 'write') return [action.path, normalizePath(action.path)];
  if (action.kind === 'fetch') return [action.url];
  if (parsed !== null) return parsed.commands.flatMap((c) => [...c.args, ...c.redirects.map((r) => r.target)]);
  return [];
}

export function ruleMatches(rule: Rule, action: Action, parsed: ParsedCommand | null): boolean {
  const m = rule.match;
  if (m.tool !== undefined && !compileRuleRegex(m.tool).test(action.tool)) return false;
  if (m.command !== undefined) {
    if (action.kind !== 'exec') return false;
    if (!compileRuleRegex(m.command).test(action.command)) return false;
  }
  if (m.path !== undefined) {
    const re = compileRuleRegex(m.path);
    if (!actionPaths(action, parsed).some((p) => re.test(p))) return false;
  }
  return true;
}

function toLoad(b: Bylaws | BylawsLoad): BylawsLoad {
  return 'ok' in b ? b : { ok: true, bylaws: b, source: '<memory>' };
}

export function describeAction(action: Action): string {
  switch (action.kind) {
    case 'exec':
      return action.command;
    case 'read':
    case 'write':
      return `${action.tool} ${action.path}`;
    case 'fetch':
      return `${action.tool} ${action.url}`;
    default:
      return action.tool;
  }
}

export function decide(action: Action, bylawsIn: Bylaws | BylawsLoad, state: SessionState, guards: readonly Guard[] = BUILTIN_GUARDS): Verdict {
  try {
    const load = toLoad(bylawsIn);
    const bylaws = load.ok ? load.bylaws : cloneBylaws(DEFAULT_BYLAWS);
    const findings: Finding[] = [];
    let parsed: ParsedCommand | null = null;
    if (action.kind === 'exec') {
      try {
        parsed = parseCommand(action.command, action.shell);
        for (const why of parsed.opaque) findings.push({ decision: 'ask', rule: 'parser.opaque', reason: `${why}, so openmorals cannot see what it will do` });
      } catch (err: unknown) {
        findings.push({ decision: 'ask', rule: 'parser.error', reason: `could not parse the command: ${errText(err)}` });
      }
    }
    const ctx: GuardContext = { action, parsed, bylaws, state };
    for (const g of guards) {
      try {
        for (const f of g.evaluate(ctx)) if (f.decision !== 'allow') findings.push(f);
      } catch (err: unknown) {
        findings.push({ decision: g.isHard(bylaws) ? 'deny' : 'ask', rule: `${g.id}.error`, reason: `the ${g.id} guard failed (${errText(err)}), so it fails closed` });
      }
    }
    for (const r of bylaws.rules) {
      try {
        if (ruleMatches(r, action, parsed)) findings.push({ decision: r.decision, rule: `rules.${r.id}`, reason: r.reason });
      } catch (err: unknown) {
        findings.push({ decision: r.hard ? 'deny' : 'ask', rule: `rules.${r.id}.error`, reason: `your rule ${r.id} failed (${errText(err)}), so it fails closed` });
      }
    }
    let best: Finding | null = null;
    for (const f of findings) if (best === null || decisionRank(f.decision) > decisionRank(best.decision)) best = f;
    if (!load.ok) {
      const note = `the bylaws file ${load.source} is invalid (${load.error}); using the defaults and asking`;
      if (best === null) return { decision: 'ask', rule: 'bylaws.invalid', reason: note };
      return { decision: best.decision, rule: best.rule, reason: `${best.reason}; also ${note}` };
    }
    if (best === null) return { decision: 'allow', rule: 'none', reason: 'no guard objected' };
    const others = findings.filter((f) => f !== best && f.rule !== best?.rule).length;
    return { decision: best.decision, rule: best.rule, reason: others > 0 ? `${best.reason} (+${others} more)` : best.reason };
  } catch (err: unknown) {
    return { decision: 'ask', rule: 'engine.error', reason: `openmorals hit an internal error (${errText(err)}) and fails closed` };
  }
}
