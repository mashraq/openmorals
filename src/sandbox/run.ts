import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SECRET_FILE_NAMES } from './plan.js';
import type { PathKind, PlanOptions, SandboxPlan, SandboxTool } from './types.js';

/** Exit code when openmorals refuses to start the command (the command did not run). */
export const SANDBOX_REFUSED_EXIT = 125;

/** Fixed locations only: a sandbox tool found through PATH could be a planted fake. */
export const TOOL_LOCATIONS: Readonly<Record<SandboxTool, readonly string[]>> = {
  'sandbox-exec': ['/usr/bin/sandbox-exec'],
  bwrap: ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap'],
};

export function detectSandboxTool(tool: SandboxTool): string | null {
  for (const p of TOOL_LOCATIONS[tool]) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  return null;
}

const SECRET_ENV_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH)/i;

/** Drops variables whose NAME looks like a credential (values are never inspected). */
export function scrubEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !SECRET_ENV_NAME.test(k)) out[k] = v;
  return out;
}

export interface SpawnResult {
  code: number | null;
  signal: string | null;
  error?: string;
}

export type SpawnLike = (file: string, args: string[], options: { cwd: string; env: Record<string, string> }) => Promise<SpawnResult>;

const defaultSpawn: SpawnLike = (file, args, options) =>
  new Promise((resolve) => {
    const child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: 'inherit', shell: false });
    child.once('error', (e) => resolve({ code: null, signal: null, error: e.message }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

export interface RunDeps {
  platform?: string;
  detect?: (tool: SandboxTool) => string | null;
  spawn?: SpawnLike;
  env?: Readonly<Record<string, string | undefined>>;
  /** Keep credential-named environment variables (default false: they are dropped). */
  keepSecretEnv?: boolean;
}

export interface RunResult {
  refused: boolean;
  exitCode: number;
  message: string;
  /** The exact argument vector started, or null when nothing was started. */
  argv: string[] | null;
}

function refuse(message: string): RunResult {
  return { refused: true, exitCode: SANDBOX_REFUSED_EXIT, message: `openmorals sandbox: refused: ${message}. The command was not run.`, argv: null };
}

const SIGNALS: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };

/** Builds the argument vector for a plan. Pure. */
export function sandboxArgv(toolPath: string, cmd: string, args: readonly string[], plan: SandboxPlan): string[] | null {
  if (!plan.ok) return null;
  if (plan.platform === 'darwin') return [toolPath, '-p', plan.seatbelt, cmd, ...args];
  if (plan.platform === 'linux') return [toolPath, ...plan.bwrapArgs, '--', cmd, ...args];
  return null;
}

/**
 * Runs `cmd` with `args` (an argument vector, never a shell string) under the plan's sandbox
 * tool. Refuses, with exit code 125 and nothing started, when the plan is invalid or not
 * enforced, the platform does not match, the command is malformed, or the tool is absent.
 * There is no unsandboxed fallback.
 */
export async function runSandboxed(cmd: string, args: readonly string[], plan: SandboxPlan, deps: RunDeps = {}): Promise<RunResult> {
  const platform = deps.platform ?? process.platform;
  if (!plan.ok) return refuse(`no valid sandbox plan (${plan.error})`);
  if (!plan.enforced) return refuse(`the ${plan.platform} plan is documentation only and is not enforced`);
  if (plan.platform !== platform) return refuse(`the plan is for ${plan.platform} but this is ${platform}`);
  if (typeof cmd !== 'string' || cmd === '' || cmd.startsWith('-') || cmd.includes('\0')) return refuse('the command name is empty, starts with "-" or contains a NUL');
  if (args.some((a) => typeof a !== 'string' || a.includes('\0'))) return refuse('an argument contains a NUL');
  const toolPath = (deps.detect ?? detectSandboxTool)(plan.tool);
  if (toolPath === null) return refuse(`${plan.tool} was not found (looked in ${TOOL_LOCATIONS[plan.tool].join(', ')}); openmorals never installs it and never runs a command unsandboxed`);
  const argv = sandboxArgv(toolPath, cmd, args, plan);
  if (argv === null || argv[0] === undefined) return refuse('could not build the sandbox command');
  const baseEnv = deps.env ?? process.env;
  const env = deps.keepSecretEnv === true ? Object.fromEntries(Object.entries(baseEnv).filter((e): e is [string, string] => e[1] !== undefined)) : scrubEnv(baseEnv);
  const res = await (deps.spawn ?? defaultSpawn)(argv[0], argv.slice(1), { cwd: plan.policy.projectRoot, env });
  if (res.error !== undefined) return { refused: false, exitCode: 127, message: `openmorals sandbox: could not start ${plan.tool}: ${res.error}`, argv };
  const code = res.code ?? (res.signal !== null ? 128 + (SIGNALS[res.signal] ?? 0) : 1);
  return { refused: false, exitCode: code, message: code === 0 ? '' : `openmorals sandbox: exited with ${code}`, argv };
}

/** File-system probe for the Linux plan. */
export function statProbe(p: string): PathKind {
  try {
    return fs.statSync(p).isDirectory() ? 'dir' : 'file';
  } catch {
    return 'missing';
  }
}

function nameMatches(name: string, pattern: string): boolean {
  if (pattern.startsWith('*.')) return name.endsWith(pattern.slice(1));
  if (pattern.endsWith('.*')) return name.startsWith(pattern.slice(0, -1)) && name.length > pattern.length - 1;
  return name === pattern;
}

/** Secret-looking files inside the project (depth-limited, skips .git and node_modules, at most 500). */
export function findProjectSecretFiles(root: string, maxDepth = 4): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || out.length >= 500) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== '.git' && e.name !== 'node_modules') walk(full, depth + 1);
      } else if ((e.isFile() || e.isSymbolicLink()) && SECRET_FILE_NAMES.some((n) => nameMatches(e.name, n))) out.push(full);
    }
  };
  walk(root, 0);
  return out;
}

/**
 * The machine-specific inputs for planSandbox on the current host: real paths of the home
 * and temp directories, a stat probe, and (Linux) the secret-looking project files.
 * Returns the real project root too, because Seatbelt matches resolved paths.
 */
export function hostPlanInputs(projectRoot: string): { projectRoot: string; opts: PlanOptions } {
  const real = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  const root = real(path.resolve(projectRoot));
  const tmp = real(os.tmpdir());
  const opts: PlanOptions = { home: real(os.homedir()), probe: statProbe };
  if (process.platform === 'darwin') opts.tmpDirs = ['/private/tmp', '/private/var/tmp', tmp];
  if (process.platform === 'linux') {
    opts.tmpDirs = ['/tmp', tmp];
    opts.projectSecretFiles = findProjectSecretFiles(root);
  }
  if (process.platform === 'win32') opts.tmpDirs = [tmp];
  return { projectRoot: root, opts };
}
