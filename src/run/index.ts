import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { constants as osConstants } from 'node:os';
import { isAgentName, type AgentName } from '../adapters/install.js';
import { formatRunSummary, summarizeRun } from '../audit-verify.js';
import { runDoctor, type DoctorOptions, type DoctorReport } from '../doctor/index.js';
import { auditLogPath, configDir } from '../paths.js';
import { limitOf, newRunId } from '../tokens/command.js';
import { RUN_ID, readRunFile, runDir, startRun, type RunLimits } from '../tokens/run.js';
import { readStop } from '../tokens/stop.js';
import { startChild, type ChildResult, type StartChild } from './spawn.js';

/**
 * `openmorals run [--agent NAME] [--tokens N] [--tool-calls S:H] [--id ID] -- <command> [args]` (0.44.0).
 *
 * Starts an agent host with a run id, after checking that its hook is installed and starts, and prints the run card when
 * it ends. It is a convenience, not a fence: it checks the hook the way `openmorals doctor` does (the same code), and it
 * cannot check that the command it starts loads that hook (a host started with other settings, or a session the agent
 * starts in another folder, may run without it). Nothing is started when any check fails.
 */

export const RUN_USAGE = `  openmorals run [--agent NAME] [--tokens N] [--tool-calls N|SOFT:HARD] [--id ID] -- <command> [args...]
      Start your agent with a run id, after checking its hook is installed, and
      print what the run did. The host is --agent, or the command's own name:
      claude (claude-code), codex, gemini (gemini-cli), opencode, openclaw. It
      checks the host's hook in this folder as openmorals doctor does (Claude
      Code: the hook is installed, blocks on failure and answers a self-test);
      it does not check that the command loads it. The command gets
      OPENMORALS_RUN and its environment is otherwise passed on unchanged; it
      is started from its words, never through a shell, with your terminal.
      This does not limit what the agent can reach on disk or on the network.
      --tokens and --tool-calls set the run's limits (Claude Code only), as
      openmorals budget start does. --id names the run (default: a new id); a
      run already in OPENMORALS_RUN is joined, so its limits still count.
      Prints one line at start and the run card at the end, on stderr. Exit
      code: the command's (128 + N when signal N ended it), 64 usage error,
      125 refused (hook missing or not starting, run stopped; nothing was
      started), 126 or 127 the command could not be started.`;

export const RUN_USAGE_EXIT = 64;
/** Nothing was started: the hook is missing or does not start, the run is stopped, or the run could not be set up. */
export const RUN_REFUSED_EXIT = 125;

/** The hosts openmorals has adapters for, by the base name of the program each is started with. */
export const RUN_HOSTS: Readonly<Record<string, AgentName>> = {
  claude: 'claude-code',
  codex: 'codex',
  gemini: 'gemini-cli',
  opencode: 'opencode',
  openclaw: 'openclaw',
};

export const POSTURE_LINE = "openmorals run: this does not limit what the agent can reach on disk or on the network. The hook judges the tool calls the host sends to it.";

export interface RunDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  platform?: NodeJS.Platform;
  /** Whether this process reads a terminal (decides which signals are passed on). */
  terminal?: boolean;
  /** Writes to standard error. Nothing of this command goes to standard output. */
  err: (text: string) => void;
  start?: StartChild;
  /** Passed to `runDoctor`, the check `openmorals doctor` runs (tests inject its spawner and its idea of this openmorals). */
  doctor?: Omit<DoctorOptions, 'env' | 'platform'>;
  now?: () => Date;
  /** A new run id; default the one `openmorals budget start` makes. */
  newId?: (now: Date) => string;
}

interface Parsed {
  agent: string | null;
  limits: RunLimits;
  id: string | null;
  command: string;
  args: string[];
}

const VALUE_OPTIONS = ['--agent', '--tokens', '--tool-calls', '--id'] as const;

function parse(argv: readonly string[]): Parsed | { problem: string } {
  const end = argv.indexOf('--');
  if (end === -1) return { problem: 'write the command after "--", as in: openmorals run -- claude' };
  const head = argv.slice(0, end);
  const tail = argv.slice(end + 1);
  const seen = new Map<string, string>();
  for (let i = 0; i < head.length; i++) {
    const a = head[i] as string;
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const name = eq === -1 ? a : a.slice(0, eq);
    if (!(VALUE_OPTIONS as readonly string[]).includes(name)) return { problem: a.startsWith('-') ? `unknown option ${a}` : `unexpected argument ${JSON.stringify(a)} (write the command after "--")` };
    if (seen.has(name)) return { problem: `${name} is given twice` };
    const v = eq === -1 ? head[++i] : a.slice(eq + 1);
    if (v === undefined || v === '') return { problem: `${name} needs a value` };
    seen.set(name, v);
  }
  const command = tail[0];
  if (command === undefined || command === '') return { problem: 'name the command to start after "--"' };
  if (tail.some((w) => w.includes('\0'))) return { problem: 'the command or an argument contains a NUL' };
  const limits: RunLimits = {};
  for (const [flag, unit] of [['--tokens', 'tokens'], ['--tool-calls', 'tool_calls']] as const) {
    const v = seen.get(flag);
    if (v === undefined) continue;
    const l = limitOf(v);
    if (l === null) return { problem: `${flag} needs a whole number above 0, or SOFT:HARD with SOFT no higher than HARD` };
    limits[unit] = l;
  }
  const id = seen.get('--id') ?? null;
  if (id !== null && (!RUN_ID.test(id) || id === '.' || id === '..')) return { problem: '--id needs a run id (letters, digits, ., - and _, not starting or ending with ., at most 128)' };
  return { agent: seen.get('--agent') ?? null, limits, id, command, args: tail.slice(1) };
}

/** The host a command starts, from its base name only: `claude` or `/usr/local/bin/claude`, never `claude-dev` or `myclaude`. */
export function hostOfCommand(command: string, platform: NodeJS.Platform = process.platform): AgentName | null {
  let base = command.split(platform === 'win32' ? /[\\/]/ : /\//).pop() ?? '';
  if (platform === 'win32') base = base.toLowerCase().replace(/\.(exe|cmd)$/, '');
  return Object.prototype.hasOwnProperty.call(RUN_HOSTS, base) ? (RUN_HOSTS[base] as AgentName) : null;
}

/** Shell convention: 128 + the signal's number. */
export function exitForChild(r: ChildResult): number {
  if (r.code !== null) return r.code;
  if (r.signal !== null) {
    const n = (osConstants.signals as Record<string, number | undefined>)[r.signal];
    return 128 + (n ?? 0);
  }
  return 1;
}

const INIT_LINE: Readonly<Record<AgentName, string>> = {
  'claude-code': 'openmorals init',
  codex: 'openmorals init --agent codex',
  'gemini-cli': 'openmorals init --agent gemini-cli',
  opencode: 'openmorals init --agent opencode',
  openclaw: 'openmorals init --agent openclaw',
};

/** Why the host's hook is not known to be installed and starting in `dir`, from doctor's own report, or null. */
export function hookProblems(report: DoctorReport, host: AgentName): string[] {
  const mine = report.checks.filter((c) => c.host === host);
  if (!report.hosts.includes(host)) return [`no ${host} hook was found in ${report.dir}`];
  const problems = mine.filter((c) => c.status === 'problem').map((c) => `${c.check}: ${c.detail}`);
  if (host === 'claude-code') {
    const selfTest = mine.find((c) => c.check === 'self-test');
    if (problems.length === 0 && selfTest !== undefined && selfTest.status === 'skipped') problems.push(`self-test: did not run (${selfTest.detail}), so the hook is not shown to start`);
  }
  return problems;
}

function stoppedWhy(dir: string, run: string): string | null {
  const f = readStop(dir);
  if (f === null) return null;
  if ('error' in f) return `${f.error}, so every session would be held as stopped; check it with openmorals stop --clear`;
  if (f.all !== undefined) return 'every session is stopped (openmorals stop --all); clear it with openmorals stop --clear';
  if (f.runs?.[run] !== undefined) return `run ${run} is stopped; clear it with openmorals stop --clear --run ${run}, or start a new run`;
  return null;
}

/** Whether the stop file names this run (a new id must not be one a stop already names). */
function namedInStop(dir: string, run: string): boolean {
  const f = readStop(dir);
  return f !== null && !('error' in f) && f.runs?.[run] !== undefined;
}

/** Claims a new run's folder; false when it is already there. */
function claim(dir: string, run: string): boolean {
  mkdirSync(join(dir, 'runs'), { recursive: true, mode: 0o700 });
  try {
    mkdirSync(runDir(dir, run), { mode: 0o700 });
    return true;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
}

function card(dir: string, run: string, joined: string | null): string {
  try {
    const s = summarizeRun(auditLogPath(dir), run, { configDir: dir });
    if (s.records === 0) return `openmorals run: no run card: no hook call was recorded under run ${run}${s.counts !== undefined && s.counts.status === 'counted' ? ` (its counts: openmorals budget status ${run})` : ''}.\n`;
    const head = joined !== null ? `openmorals run: the run card of run ${run}, which this joined, so it holds its other sessions too:\n` : 'openmorals run: the run card:\n';
    return head + formatRunSummary(s);
  } catch (e: unknown) {
    return `openmorals run: no run card: the audit log could not be read (${e instanceof Error ? e.message : String(e)}).\n`;
  }
}

export async function runCommand(argv: readonly string[], d: RunDeps): Promise<number> {
  const usage = (why: string): number => {
    d.err(`openmorals run: ${why}; nothing was started\n`);
    return RUN_USAGE_EXIT;
  };
  const refuse = (why: string): number => {
    d.err(`openmorals run: refused: ${why}. Nothing was started.\n`);
    return RUN_REFUSED_EXIT;
  };
  const platform = d.platform ?? process.platform;
  const p = parse(argv);
  if ('problem' in p) return usage(p.problem);

  let host: AgentName | null;
  if (p.agent !== null) {
    if (!isAgentName(p.agent)) return usage(`unknown agent ${JSON.stringify(p.agent)} (claude-code, codex, gemini-cli, opencode or openclaw)`);
    host = p.agent;
  } else host = hostOfCommand(p.command, platform);
  if (host === null) return usage(`${JSON.stringify(p.command)} is not a host openmorals knows (claude, codex, gemini, opencode, openclaw); name it with --agent. A program that is not an agent host can ask openmorals guard --json about each tool call instead`);
  const hasLimits = Object.keys(p.limits).length > 0;
  if (hasLimits && host !== 'claude-code') return usage(`limits are counted on Claude Code only, so --tokens and --tool-calls cannot be used with ${host}`);

  const dir = configDir(d.env, platform);
  const parent = d.env['OPENMORALS_RUN'];
  let run: string;
  let joined: string | null = null;
  let fresh = false;
  let existed = false;
  if (parent !== undefined && parent !== '') {
    if (!RUN_ID.test(parent) || parent === '.' || parent === '..') return usage('OPENMORALS_RUN in this environment is not a run id (letters, digits, ., - and _), so its run cannot be joined');
    if (p.id !== null && p.id !== parent) return usage(`this is already inside run ${parent} (OPENMORALS_RUN); a run started here joins it, so its limits still count; --id ${p.id} would leave it`);
    if (hasLimits) return usage(`this is already inside run ${parent} (OPENMORALS_RUN), whose limits were set when it started; a run's limits are set once`);
    run = parent;
    joined = parent;
  } else if (p.id !== null) {
    run = p.id;
    existed = existsSync(runDir(dir, run));
    if (hasLimits && readRunFile(dir, run) !== null) return usage(`run ${run} already has limits; a run's limits are set once (start a new run with another id)`);
  } else {
    const now = (d.now ?? (() => new Date()))();
    const make = d.newId ?? newRunId;
    let id: string | null = null;
    for (let i = 0; i < 5 && id === null; i++) {
      const c = make(now);
      if (RUN_ID.test(c) && !namedInStop(dir, c) && readRunFile(dir, c) === null && !existsSync(runDir(dir, c))) id = c;
    }
    if (id === null) return refuse('no new run id was free after 5 tries');
    run = id;
    fresh = true;
  }
  const stopped = stoppedWhy(dir, run);
  if (stopped !== null) return refuse(stopped);

  const report = runDoctor(d.cwd, { ...(d.doctor ?? {}), env: d.env, platform });
  const problems = hookProblems(report, host);
  if (problems.length > 0) {
    return refuse(`the ${host} hook is not installed or does not start in ${report.dir}:\n  ${problems.join('\n  ')}\nInstall it with: ${INIT_LINE[host]}\nThen openmorals doctor shows every check`);
  }

  try {
    if (fresh && !claim(dir, run)) return refuse(`run ${run} was taken while it was being set up`);
    if (hasLimits) {
      const r = startRun(dir, run, p.limits, (d.now ?? (() => new Date()))());
      if (!r.ok) return refuse(r.error);
    }
  } catch (e: unknown) {
    return refuse(`the run could not be set up (${e instanceof Error ? e.message : String(e)})`);
  }

  const what = joined !== null ? `joins run ${run} (OPENMORALS_RUN)` : fresh ? `run ${run}` : existed ? `run ${run} (--id, already started: what it has counted goes on)` : `run ${run} (--id)`;
  d.err(`${POSTURE_LINE}\nopenmorals run: ${what}, host ${host}. Checked: its hook in ${report.dir} is installed and starts (as openmorals doctor checks it). Not checked: that ${p.command} loads it.${hasLimits ? ' Limits are counted by the Claude Code hook.' : ''}\n`);

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(d.env)) if (v !== undefined) env[k] = v;
  env['OPENMORALS_RUN'] = run;
  const res = await (d.start ?? startChild)(p.command, p.args, { cwd: d.cwd, env, terminal: d.terminal === true });
  if (res.error !== undefined) {
    d.err(`openmorals run: could not start ${p.command}: ${res.error.message}\n`);
    return res.error.errno === 'EACCES' ? 126 : 127;
  }
  const code = exitForChild(res);
  d.err(`openmorals run: ${p.command} ended with ${res.signal !== null && res.code === null ? `signal ${res.signal} (exit ${code})` : `exit ${code}`}.\n`);
  d.err(card(dir, run, joined));
  return code;
}
