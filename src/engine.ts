import { cloneBylaws, compileRuleRegex, effectiveBylaws, looseningNote } from './bylaws.js';
import type { Finding, Guard, GuardContext, Where } from './guard.js';
import { makeWhere, normalizePath } from './guard.js';
import { budgetGuard } from './guards/budget.js';
import { destructiveGuard } from './guards/destructive.js';
import { onlineDeleteGuard } from './guards/online-delete.js';
import { secretsGuard } from './guards/secrets.js';
import { selfProtectGuard } from './guards/self-protect.js';
import { contentPattern } from './rules/pattern.js';
import type { ParsedCommand } from './shell.js';
import { parseCommand } from './shell.js';
import type { Action, ActionText, Bylaws, BylawsLoad, Rule, SessionState, Verdict } from './types.js';
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

/** The texts a content rule reads (0.15.0): a write's content, an `other` action's arguments and message. */
export function actionTexts(action: Action): ActionText[] {
  if (action.kind === 'write') return action.content !== undefined ? [action.content] : [];
  if (action.kind === 'other') return [action.args, action.message].filter((t): t is ActionText => t !== undefined);
  return [];
}

/**
 * How a rule applies to an action: `match` when every field it gives matches; null when it does not apply. When every
 * other field matches but the content pattern did not match the text that was kept, the answer cannot be told if the
 * text was cut at the cap (`cut`) or the search ran out of steps (`steps`). The engine fails closed on both: a deny rule
 * takes it as matched, an ask rule asks.
 */
export type RuleOutcome = 'match' | 'cut' | 'steps';

export function ruleOutcome(rule: Rule, action: Action, parsed: ParsedCommand | null): RuleOutcome | null {
  const m = rule.match;
  if (m.tool !== undefined && !compileRuleRegex(m.tool).test(action.tool)) return null;
  if (m.command !== undefined) {
    if (action.kind !== 'exec') return null;
    if (!compileRuleRegex(m.command).test(action.command)) return null;
  }
  if (m.path !== undefined) {
    const re = compileRuleRegex(m.path);
    if (!actionPaths(action, parsed).some((p) => re.test(p))) return null;
  }
  if (m.content !== undefined) {
    const texts = actionTexts(action);
    if (texts.length === 0) return null;
    const pattern = contentPattern(m.content);
    let cut = false;
    let steps = false;
    for (const t of texts) {
      const found = pattern.search(t.text);
      if (found === true) return 'match';
      if (t.cut) cut = true;
      if (found === null) steps = true;
    }
    return cut ? 'cut' : steps ? 'steps' : null;
  }
  return 'match';
}

/** True when the rule fires on the action: it matches, or its content could not be checked (cut or out of steps). */
export function ruleMatches(rule: Rule, action: Action, parsed: ParsedCommand | null): boolean {
  return ruleOutcome(rule, action, parsed) !== null;
}

/** The reason a content rule fired without a match: what could not be checked, and what openmorals did about it. */
export function unknownNote(rule: Rule, hit: 'cut' | 'steps'): string {
  const what = hit === 'cut' ? 'the content was over the 262,144-byte cap and was cut' : 'the content pattern needed more steps than allowed to search this content';
  return rule.decision === 'deny' ? `${what}, so openmorals takes the rule as matched` : `${what}, so openmorals could not check it and asks`;
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

/**
 * `where` says which config directory is the real one and which folder relative paths start from; anything
 * left out comes from the process (`configDir()`, `process.cwd()`).
 */
export function decide(action: Action, bylawsIn: Bylaws | BylawsLoad, state: SessionState, guards: readonly Guard[] = BUILTIN_GUARDS, where: Partial<Where> = {}): Verdict {
  try {
    const load = toLoad(bylawsIn);
    const bylaws = cloneBylaws(effectiveBylaws(load));
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
    const ctx: GuardContext = { action, parsed, bylaws, state, where: makeWhere(where) };
    for (const g of guards) {
      try {
        for (const f of g.evaluate(ctx)) if (f.decision !== 'allow') findings.push(f);
      } catch (err: unknown) {
        findings.push({ decision: g.isHard(bylaws) ? 'deny' : 'ask', rule: `${g.id}.error`, reason: `the ${g.id} guard failed (${errText(err)}), so it fails closed` });
      }
    }
    for (const r of bylaws.rules) {
      try {
        const hit = ruleOutcome(r, action, parsed);
        if (hit === 'match') findings.push({ decision: r.decision, rule: `rules.${r.id}`, reason: r.reason });
        else if (hit !== null) findings.push({ decision: r.decision, rule: `rules.${r.id}`, reason: `${r.reason} (${unknownNote(r, hit)})` });
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
    const note = looseningNote(load);
    const tail = note !== null ? `; ${note}` : '';
    if (best === null) return { decision: 'allow', rule: 'none', reason: `no guard objected${tail}` };
    const others = findings.filter((f) => f !== best && f.rule !== best?.rule).length;
    return { decision: best.decision, rule: best.rule, reason: `${others > 0 ? `${best.reason} (+${others} more)` : best.reason}${tail}` };
  } catch (err: unknown) {
    return { decision: 'ask', rule: 'engine.error', reason: `openmorals hit an internal error (${errText(err)}) and fails closed` };
  }
}
