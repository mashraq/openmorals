import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LineCounter, isMap, isSeq, parseDocument, stringify } from 'yaml';
import { runClaudeCodeHook } from '../adapters/claude-code.js';
import { validateBylaws } from '../bylaws.js';
import type { Decision } from '../types.js';
import { isDecision } from '../types.js';

/**
 * Session rows (0.34.0): a few hook events in order, run through the real Claude Code hook with a temporary home and
 * project, so what one call leaves in the session (a web fetch, a failure, a sub-agent's read) is judged at the next
 * call. A single row of a `*.cases.yaml` file judges one call against a state written by hand; a session row checks that
 * the state is really kept and read between calls: across tool calls, across a compaction, and from a sub-agent to the
 * main agent.
 */

/** The hook events a step may send. The hook judges PreToolUse and scans PostToolUse, PostToolUseFailure and UserPromptSubmit; the rest are passed through so a row can show that they change nothing. */
export const SESSION_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'PreCompact', 'SessionStart', 'SubagentStart', 'SubagentStop', 'Stop'] as const;
export type SessionEvent = (typeof SESSION_EVENTS)[number];

export const SESSION_KEYS: readonly string[] = ['name', 'note', 'steps', 'unattended', 'bylaws', 'project_bylaws', 'files'];
export const STEP_KEYS: readonly string[] = ['event', 'tool', 'input', 'agent', 'session', 'response', 'error', 'interrupt', 'prompt', 'of', 'source', 'expect', 'rule', 'note'];

/** At most this many steps in one session row, and this many session rows in one file. */
export const MAX_SESSION_STEPS = 200;
export const MAX_SESSIONS_PER_FILE = 500;

export interface SessionStep {
  event: SessionEvent;
  tool: string | null;
  input: Record<string, unknown>;
  /** The sub-agent the event fires in (the hook's `agent_id`); null for the main agent. */
  agent: string | null;
  /** A label for a second session of the same row (another conversation); null for the row's own session. */
  session: string | null;
  response: unknown;
  error: string | null;
  interrupt: boolean;
  prompt: string | null;
  /** 1-based number of the earlier step this PostToolUse or PostToolUseFailure answers (same tool call id). */
  of: number | null;
  /** SessionStart's `source` (for example `compact`). */
  source: string | null;
  expect: Decision | null;
  rule: string | null;
  line: number | null;
}

export interface SessionCase {
  name: string;
  note: string | null;
  unattended: boolean;
  /** The person's own bylaws (written to the temporary home), or null for the defaults. */
  bylaws: Record<string, unknown> | null;
  /** The project's bylaws file (it can only tighten), or null for none. */
  projectBylaws: Record<string, unknown> | null;
  /** Files written before the first step: path relative to the project, or `~/...` under the temporary home. */
  files: Record<string, string>;
  steps: SessionStep[];
  line: number | null;
}

export interface SessionFile {
  file: string;
  cases: SessionCase[];
}

type Row<T> = { ok: true; value: T } | { ok: false; error: string };

function bad(file: string, at: string, msg: string): { ok: false; error: string } {
  return { ok: false, error: `${file}${at} ${msg}` };
}

function rangeLine(node: unknown, lc: LineCounter): number | null {
  return node !== null && typeof node === 'object' && 'range' in node && Array.isArray((node as { range: unknown }).range) ? lc.linePos((node as { range: number[] }).range[0] ?? 0).line : null;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toStep(raw: unknown, file: string, at: string, line: number | null, prior: number): Row<SessionStep> {
  if (!isObj(raw)) return bad(file, at, 'is not a mapping');
  for (const k of Object.keys(raw)) if (!STEP_KEYS.includes(k)) return bad(file, at, `has unknown key ${k}`);
  const { event, tool, input, agent, session, response, error, interrupt, prompt, of, source, expect, rule } = raw;
  const ev = event ?? (prompt !== undefined ? 'UserPromptSubmit' : 'PreToolUse');
  if (typeof ev !== 'string' || !(SESSION_EVENTS as readonly string[]).includes(ev)) return bad(file, at, `event must be one of ${SESSION_EVENTS.join(', ')}`);
  for (const [k, v] of [['tool', tool], ['agent', agent], ['session', session], ['error', error], ['prompt', prompt], ['source', source], ['rule', rule]] as const) {
    if (v !== undefined && typeof v !== 'string') return bad(file, at, `${k} must be a string`);
  }
  if (input !== undefined && !isObj(input)) return bad(file, at, 'input must be a mapping');
  if (interrupt !== undefined && typeof interrupt !== 'boolean') return bad(file, at, 'interrupt must be true or false');
  if (of !== undefined && !(typeof of === 'number' && Number.isInteger(of) && of >= 1 && of <= prior)) return bad(file, at, `of must be the number of an earlier step (1 to ${prior})`);
  if (expect !== undefined && !isDecision(expect)) return bad(file, at, 'expect must be allow, ask or deny');
  if (rule !== undefined && expect === undefined) return bad(file, at, 'has a rule but no expect');
  const isPost = ev === 'PostToolUse' || ev === 'PostToolUseFailure';
  if (ev === 'PreToolUse' && typeof tool !== 'string') return bad(file, at, 'needs a tool');
  if (isPost && typeof tool !== 'string' && of === undefined) return bad(file, at, 'needs a tool, or of (the step it answers)');
  if (ev === 'UserPromptSubmit' && typeof prompt !== 'string') return bad(file, at, 'needs a prompt');
  if (!isPost && (of !== undefined || response !== undefined || error !== undefined || interrupt !== undefined)) return bad(file, at, 'of, response, error and interrupt belong to PostToolUse and PostToolUseFailure');
  return {
    ok: true,
    value: {
      event: ev as SessionEvent,
      tool: typeof tool === 'string' ? tool : null,
      input: isObj(input) ? input : {},
      agent: typeof agent === 'string' ? agent : null,
      session: typeof session === 'string' ? session : null,
      response: response ?? null,
      error: typeof error === 'string' ? error : null,
      interrupt: interrupt === true,
      prompt: typeof prompt === 'string' ? prompt : null,
      of: typeof of === 'number' ? of : null,
      source: typeof source === 'string' ? source : null,
      expect: isDecision(expect) ? expect : null,
      rule: typeof rule === 'string' ? rule : null,
      line,
    },
  };
}

/** Reads one `*.sessions.yaml` file: a top-level `sessions:` list, each with `name` and `steps`. Any bad row fails the file. */
export function parseSessionFile(text: string, file: string): Row<SessionFile> {
  const lc = new LineCounter();
  let parsed;
  try {
    parsed = parseDocument(text, { lineCounter: lc, prettyErrors: false });
  } catch (e: unknown) {
    return { ok: false, error: `${file}: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (parsed.errors.length > 0) return { ok: false, error: `${file}: ${parsed.errors[0]?.message ?? 'YAML error'}` };
  if (!isMap(parsed.contents)) return { ok: false, error: `${file}: the file is not a mapping` };
  const doc = parsed.toJS() as Record<string, unknown>;
  for (const k of Object.keys(doc)) if (k !== 'sessions' && k !== 'note') return { ok: false, error: `${file}: unknown top-level key ${k} (sessions files have sessions and note)` };
  if (!Array.isArray(doc['sessions'])) return { ok: false, error: `${file} needs sessions (a list)` };
  const rows = doc['sessions'] as unknown[];
  if (rows.length > MAX_SESSIONS_PER_FILE) return { ok: false, error: `${file} has ${rows.length} sessions; at most ${MAX_SESSIONS_PER_FILE}` };
  const seqNode = parsed.contents.get('sessions', true);
  const sessionNodes = isSeq(seqNode) ? seqNode.items : [];
  const cases: SessionCase[] = [];
  const names = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const at = `[${i}]`;
    const raw = rows[i];
    if (!isObj(raw)) return bad(file, at, 'is not a mapping');
    for (const k of Object.keys(raw)) if (!SESSION_KEYS.includes(k)) return bad(file, at, `has unknown key ${k}`);
    const { name, note, steps, unattended, bylaws, project_bylaws: projectBylaws, files } = raw;
    if (typeof name !== 'string' || name.trim() === '') return bad(file, at, 'needs a name');
    if (names.has(name)) return bad(file, at, `repeats the name ${JSON.stringify(name)}; names must be unique in a file`);
    names.add(name);
    if (note !== undefined && typeof note !== 'string') return bad(file, at, 'note must be a string');
    if (unattended !== undefined && typeof unattended !== 'boolean') return bad(file, at, 'unattended must be true or false');
    for (const [k, v, project] of [['bylaws', bylaws, false], ['project_bylaws', projectBylaws, true]] as const) {
      if (v === undefined) continue;
      if (!isObj(v)) return bad(file, at, `${k} must be a mapping`);
      const check = validateBylaws(v, `${file}${at}.${k}`, undefined, project);
      if (!check.ok) return bad(file, at, `has invalid ${k}: ${check.error}`);
    }
    if (files !== undefined) {
      if (!isObj(files)) return bad(file, at, 'files must be a mapping of path to text');
      for (const [p, t] of Object.entries(files)) {
        if (typeof t !== 'string') return bad(file, at, `files.${p} must be text`);
        const rel = p.startsWith('~/') ? p.slice(2) : p;
        if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || rel === '') return bad(file, at, `files.${p} must be a path inside the project or under ~/`);
      }
    }
    if (!Array.isArray(steps) || steps.length === 0) return bad(file, at, 'needs steps (a non-empty list)');
    if (steps.length > MAX_SESSION_STEPS) return bad(file, at, `has ${steps.length} steps; at most ${MAX_SESSION_STEPS}`);
    const node = sessionNodes[i];
    const stepNodes = isMap(node) ? node.get('steps', true) : null;
    const stepLines = isSeq(stepNodes) ? stepNodes.items.map((it) => rangeLine(it, lc)) : [];
    const parsedSteps: SessionStep[] = [];
    for (let s = 0; s < steps.length; s++) {
      const r = toStep(steps[s], file, `${at}.steps[${s}]`, stepLines[s] ?? null, s);
      if (!r.ok) return r;
      parsedSteps.push(r.value);
    }
    if (!parsedSteps.some((s) => s.expect !== null)) return bad(file, at, 'has no step with expect, so it checks nothing');
    cases.push({
      name,
      note: typeof note === 'string' ? note : null,
      unattended: unattended === true,
      bylaws: isObj(bylaws) ? bylaws : null,
      projectBylaws: isObj(projectBylaws) ? projectBylaws : null,
      files: isObj(files) ? (files as Record<string, string>) : {},
      steps: parsedSteps,
      line: rangeLine(node, lc),
    });
  }
  return { ok: true, value: { file, cases } };
}

export interface StepResult {
  /** 1-based step number. */
  step: number;
  decision: Decision;
  rule: string;
  ms: number;
}

export type SessionRun = { ok: true; steps: StepResult[] } | { ok: false; error: string };

/** `{project}` and `{home}` in any string of a step become the temporary project and home folders. */
function fill<T>(v: T, project: string, home: string): T {
  if (typeof v === 'string') return v.split('{project}').join(project).split('{home}').join(home) as T;
  if (Array.isArray(v)) return v.map((x) => fill(x, project, home)) as T;
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, project, home)])) as T;
  return v;
}

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

/**
 * Runs one session row through `runClaudeCodeHook()` in a fresh temporary home and project, removed afterwards. The
 * environment holds only HOME, the config folder and PATH, so the machine's own bylaws, sessions and settings play no
 * part. Calls no model. Every step runs, scored or not; a step that throws stops the row (unreadable).
 */
export function runSessionCase(c: SessionCase, index: number): SessionRun {
  let root: string | null = null;
  try {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'openmorals-eval-')));
    const home = path.join(root, 'home');
    const project = path.join(root, 'project');
    const config = path.join(home, '.config', 'openmorals');
    fs.mkdirSync(config, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    if (c.bylaws !== null) fs.writeFileSync(path.join(config, 'openmorals.yaml'), stringify(c.bylaws));
    if (c.projectBylaws !== null) fs.writeFileSync(path.join(project, 'openmorals.yaml'), stringify(c.projectBylaws));
    for (const [p, text] of Object.entries(c.files)) {
      const abs = p.startsWith('~/') ? path.join(home, p.slice(2)) : path.join(project, p);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, fill(text, project, home));
    }
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, OPENMORALS_HOME: config, PATH: process.env['PATH'] ?? '' };
    const ids: string[] = [];
    const out: StepResult[] = [];
    for (let s = 0; s < c.steps.length; s++) {
      const st = c.steps[s] as SessionStep;
      const answered = st.of !== null ? c.steps[st.of - 1] : undefined;
      const id = answered !== undefined ? (ids[(st.of ?? 1) - 1] ?? `toolu_eval_${s}`) : `toolu_eval_${index}_${s}`;
      ids.push(id);
      const tool = st.tool ?? answered?.tool ?? null;
      const input = st.tool !== null || answered === undefined ? st.input : answered.input;
      const agent = st.agent ?? (answered !== undefined && st.of !== null ? answered.agent : null);
      const label = st.session ?? (answered !== undefined && st.of !== null ? answered.session : null);
      const payload: Record<string, unknown> = {
        session_id: `eval-${index}${label !== null ? `-${label}` : ''}`,
        cwd: project,
        hook_event_name: st.event,
        tool_use_id: id,
        ...(tool !== null ? { tool_name: tool, tool_input: fill(input, project, home) } : { tool_name: st.event }),
        ...(agent !== null ? { agent_id: agent } : {}),
        ...(st.prompt !== null ? { prompt: fill(st.prompt, project, home) } : {}),
        ...(st.event === 'PostToolUse' ? { tool_response: fill(st.response ?? {}, project, home) } : {}),
        ...(st.event === 'PostToolUseFailure' ? { error: fill(st.error ?? 'failed', project, home), is_interrupt: st.interrupt } : {}),
        ...(st.source !== null ? { source: st.source } : {}),
      };
      const t0 = nowMs();
      const r = runClaudeCodeHook(JSON.stringify(payload), { env, cwd: project, unattended: c.unattended });
      out.push({ step: s + 1, decision: r.verdict.decision, rule: r.verdict.rule, ms: nowMs() - t0 });
    }
    return { ok: true, steps: out };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (root !== null) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // a leftover temporary folder is not a wrong row
      }
    }
  }
}
