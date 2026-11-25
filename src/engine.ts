import { cloneBylaws, compileRuleRegex, effectiveBylaws, looseningNote } from './bylaws.js';
import type { Finding, Guard, GuardContext, Where } from './guard.js';
import { makeWhere, normalizePath } from './guard.js';
import { budgetGuard } from './guards/budget.js';
import { destructiveGuard } from './guards/destructive.js';
import { deleteGuard } from './guards/delete.js';
import { documentGuard } from './guards/document.js';
import { onlineDeleteGuard } from './guards/online-delete.js';
import { secretsGuard } from './guards/secrets.js';
import { selfProtectGuard } from './guards/self-protect.js';
import { outboundGuard } from './outbound/guard.js';
import { contentText } from './inbound/outbound.js';
import type { DetectorName } from './rules/detectors.js';
import { MAX_DETECTOR_HITS, detectCount, isDetectorName, maskDetected } from './rules/detectors.js';
import type { StepMeter } from './rules/pattern.js';
import { MAX_CONTENT_STEPS, contentPattern } from './rules/pattern.js';
import { actionReachesNetwork } from './taint/taint.js';
import type { ParsedCommand } from './shell.js';
import { parseCommand } from './shell.js';
import type { Action, ActionText, Bylaws, BylawsLoad, Rule, SessionState, Verdict } from './types.js';
import { decisionRank } from './types.js';

export const BUILTIN_GUARDS: readonly Guard[] = Object.freeze([destructiveGuard, onlineDeleteGuard, secretsGuard, selfProtectGuard, budgetGuard, documentGuard, outboundGuard, deleteGuard]);

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
 * The texts a detector reads (0.16.0): a write's content; a command line; a URL; an `other` action's input before
 * redaction (`raw`), or its redacted arguments and message when no raw text was carried. Nothing is read for a read.
 */
export function detectorTexts(action: Action): ActionText[] {
  switch (action.kind) {
    case 'write':
      return action.content !== undefined ? [action.content] : [];
    case 'exec':
      return action.command !== '' ? [contentText(action.command)] : [];
    case 'fetch':
      return action.url !== '' ? [contentText(action.url)] : [];
    case 'other':
      if (action.raw !== undefined) return [action.raw];
      return [action.args, action.message].filter((t): t is ActionText => t !== undefined);
    default:
      return [];
  }
}

/** Most content-pattern steps one judgement may take across all its rules (0.16.0); past it the rest are `steps`. */
export const MAX_CALL_CONTENT_STEPS = 4 * MAX_CONTENT_STEPS;

/**
 * Shared by the rules of one judgement: the content-pattern steps taken so far (bounded by MAX_CALL_CONTENT_STEPS) and
 * each detector's count per text, so many rules naming one detector scan a text once.
 */
export interface RuleMeter extends StepMeter {
  found: Map<ActionText, Map<DetectorName, number>>;
}

export function newRuleMeter(): RuleMeter {
  return { steps: 0, found: new Map() };
}

/**
 * How a rule applies to an action: `match` when every field it gives matches; null when it does not apply. When every
 * other field matches but the content pattern or the detectors did not find anything in the text that was kept, the
 * answer cannot be told if the text was cut at the cap (`cut`) or a search ran out of steps (`steps`). The engine fails
 * closed on both: a deny rule takes it as matched, an ask rule asks.
 */
export type RuleOutcome = 'match' | 'cut' | 'steps';

/** What a detector found for a rule: its name and how many, never the text. */
export interface DetectorHit {
  detector: DetectorName;
  count: number;
}

export interface RuleCheck {
  outcome: RuleOutcome | null;
  /** The detectors that found something (in the rule's order), with their counts. */
  hits: DetectorHit[];
}

function detectorNames(d: string | readonly string[]): DetectorName[] {
  const list = typeof d === 'string' ? [d] : d;
  return list.map((x) => {
    if (!isDetectorName(x)) throw new Error(`unknown detector ${JSON.stringify(x)}`);
    return x;
  });
}

function countIn(meter: RuleMeter, t: ActionText, name: DetectorName): number {
  let per = meter.found.get(t);
  if (per === undefined) {
    per = new Map();
    meter.found.set(t, per);
  }
  let n = per.get(name);
  if (n === undefined) {
    n = detectCount(name, t.text);
    per.set(name, n);
  }
  return n;
}

function joinOutcomes(a: RuleOutcome, b: RuleOutcome): RuleOutcome {
  if (a === 'match') return b;
  if (b === 'match') return a;
  return a === 'cut' || b === 'cut' ? 'cut' : 'steps';
}

export function ruleCheck(rule: Rule, action: Action, parsed: ParsedCommand | null, meter: RuleMeter = newRuleMeter()): RuleCheck {
  const m = rule.match;
  const none: RuleCheck = { outcome: null, hits: [] };
  if (m.tool !== undefined && !compileRuleRegex(m.tool).test(action.tool)) return none;
  if (m.command !== undefined) {
    if (action.kind !== 'exec') return none;
    if (!compileRuleRegex(m.command).test(action.command)) return none;
  }
  if (m.path !== undefined) {
    const re = compileRuleRegex(m.path);
    if (!actionPaths(action, parsed).some((p) => re.test(p))) return none;
  }
  if (m.network === true && !actionReachesNetwork(action, action.kind === 'exec' ? parsed : null)) return none;
  let outcome: RuleOutcome = 'match';
  if (m.content !== undefined) {
    const c = contentOutcome(m.content, action, meter);
    if (c === null) return none;
    outcome = joinOutcomes(outcome, c);
  }
  const hits: DetectorHit[] = [];
  if (m.detector !== undefined) {
    const names = detectorNames(m.detector);
    const texts = detectorTexts(action);
    if (texts.length === 0) return none;
    for (const name of names) {
      let count = 0;
      for (const t of texts) count += countIn(meter, t, name);
      if (count > 0) hits.push({ detector: name, count });
    }
    if (hits.length === 0) {
      if (!texts.some((t) => t.cut)) return none;
      outcome = joinOutcomes(outcome, 'cut');
    }
  }
  return { outcome, hits };
}

function contentOutcome(source: string, action: Action, meter: RuleMeter): RuleOutcome | null {
  const texts = actionTexts(action);
  if (texts.length === 0) return null;
  const pattern = contentPattern(source);
  let cut = false;
  let steps = false;
  for (const t of texts) {
    const left = MAX_CALL_CONTENT_STEPS - meter.steps;
    if (left <= 0) {
      steps = true;
      continue;
    }
    const found = pattern.search(t.text, Math.min(MAX_CONTENT_STEPS, left), meter);
    if (found === true) return 'match';
    if (t.cut) cut = true;
    if (found === null) steps = true;
  }
  return cut ? 'cut' : steps ? 'steps' : null;
}

export function ruleOutcome(rule: Rule, action: Action, parsed: ParsedCommand | null, meter?: RuleMeter): RuleOutcome | null {
  return ruleCheck(rule, action, parsed, meter).outcome;
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

/** The reason's note for what detectors found: names and counts, never the text (0.16.0). Empty when none. */
export function hitNote(hits: readonly DetectorHit[]): string {
  if (hits.length === 0) return '';
  return ` (found by ${hits.map((h) => `${h.detector}: ${h.count >= MAX_DETECTOR_HITS ? `${MAX_DETECTOR_HITS} or more` : String(h.count)}`).join(', ')})`;
}

function toLoad(b: Bylaws | BylawsLoad): BylawsLoad {
  return 'ok' in b ? b : { ok: true, bylaws: b, source: '<memory>' };
}

/** The one-line text of an action for the audit log; with `mask`, the named detectors' hits are masked (0.16.0). */
export function describeAction(action: Action, mask: readonly DetectorName[] = []): string {
  const a = maskAction(action, mask);
  switch (a.kind) {
    case 'exec':
      return a.command;
    case 'read':
    case 'write':
      return `${a.tool} ${a.path}`;
    case 'fetch':
      return `${a.tool} ${a.url}`;
    default:
      return a.tool;
  }
}

/**
 * The action with the hits of the named detectors masked in its command, path or URL (0.16.0): what openmorals keeps
 * (audit, session history) or sends (the reviewer) when the bylaws name detectors. The same action when `mask` is empty.
 */
export function maskAction(action: Action, mask: readonly DetectorName[]): Action {
  if (mask.length === 0) return action;
  switch (action.kind) {
    case 'exec':
      return { ...action, command: maskDetected(action.command, mask) };
    case 'read':
    case 'write':
      return { ...action, path: maskDetected(action.path, mask) };
    case 'fetch':
      return { ...action, url: maskDetected(action.url, mask) };
    default:
      return action;
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
    const meter = newRuleMeter();
    for (const r of bylaws.rules) {
      try {
        const check = ruleCheck(r, action, parsed, meter);
        const hit = check.outcome;
        const found = hitNote(check.hits);
        if (hit === 'match') findings.push({ decision: r.decision, rule: `rules.${r.id}`, reason: `${r.reason}${found}` });
        else if (hit !== null) findings.push({ decision: r.decision, rule: `rules.${r.id}`, reason: `${r.reason}${found} (${unknownNote(r, hit)})` });
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
