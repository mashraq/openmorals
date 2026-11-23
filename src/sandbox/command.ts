import type { BylawsLoad } from '../types.js';
import { planSandbox } from './plan.js';
import type { RunDeps } from './run.js';
import { SANDBOX_REFUSED_EXIT, hostPlanInputs, runSandboxed } from './run.js';
import type { PlanOptions, SandboxPlan } from './types.js';

export interface SandboxCommandDeps extends RunDeps {
  /** Machine inputs for the planner; defaults to hostPlanInputs(projectRoot). */
  planInputs?: (projectRoot: string) => { projectRoot: string; opts: PlanOptions };
}

export interface SandboxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  plan: SandboxPlan | null;
}

const USAGE = 'usage: openmorals sandbox plan [--json] [--platform darwin|linux|win32]\n       openmorals sandbox run -- <command> [args...]';

/** Builds the plan for this project the way `sandbox plan` and `sandbox run` do. */
export function planForProject(bylaws: BylawsLoad, projectRoot: string, platform: string, deps: SandboxCommandDeps = {}): SandboxPlan {
  const inputs = (deps.planInputs ?? hostPlanInputs)(projectRoot);
  return planSandbox(bylaws, platform, inputs.projectRoot, inputs.opts);
}

/** Human-readable plan. */
export function formatPlanText(plan: SandboxPlan, bylawsSource: string): string {
  if (!plan.ok) return `openmorals sandbox plan: no plan for ${plan.platform}: ${plan.error}\n`;
  const p = plan.policy;
  const lines: string[] = [
    `platform: ${plan.platform}   enforced: ${plan.enforced ? `yes, by ${plan.tool}` : 'no (plan only)'}   bylaws: ${bylawsSource}`,
    `project: ${p.projectRoot}`,
    `writable: ${p.writable.join(', ')}`,
    `read-only inside the project: ${p.denyWrite.join(', ')}`,
    `unreadable: ${p.denyRead.map((d) => d.path).join(', ')}${p.denyRead.length > 0 ? '; ' : ''}files named ${p.denyReadNames.join(' ')}`,
    `network: ${p.network.mode === 'off' ? 'off' : `only ${p.network.hosts.join(', ')} (srt settings only; ${plan.platform === 'win32' ? 'not enforced' : `${plan.tool} keeps it off`})`}`,
  ];
  if (plan.platform === 'darwin') lines.push('', 'seatbelt profile (sandbox-exec -p):', plan.seatbelt.trimEnd());
  if (plan.platform === 'linux') lines.push('', 'bubblewrap arguments:', plan.bwrapArgs.map((a) => JSON.stringify(a)).join(' '));
  if (plan.platform === 'win32') lines.push('', `Windows plan (${plan.windows.design}):`, ...plan.windows.steps.map((s, i) => `  ${i + 1}. ${s}`));
  if (plan.platform !== 'win32') lines.push('', 'srt settings:', JSON.stringify(plan.srt, null, 2));
  if (plan.notes.length > 0) lines.push('', 'notes:', ...plan.notes.map((n) => `  - ${n}`));
  return `${lines.join('\n')}\n`;
}

/**
 * `openmorals sandbox plan|run`. `rest` is everything after `sandbox`. A plan that cannot be
 * made exits 1; `run` exits with the command's own code, or 125 when it refuses (nothing ran).
 */
export async function sandboxCommand(rest: readonly string[], bylaws: BylawsLoad, projectRoot: string, deps: SandboxCommandDeps = {}): Promise<SandboxCommandResult> {
  const sub = rest[0];
  const platform = deps.platform ?? process.platform;
  if (sub === 'plan') {
    let json = false;
    let target = platform;
    for (let i = 1; i < rest.length; i++) {
      const a = rest[i] ?? '';
      if (a === '--json') json = true;
      else if (a === '--platform' && rest[i + 1] !== undefined) target = rest[++i] ?? '';
      else if (a.startsWith('--platform=')) target = a.slice('--platform='.length);
      else return { exitCode: 64, stdout: '', stderr: `${USAGE}\n`, plan: null };
    }
    const plan = planForProject(bylaws, projectRoot, target, deps);
    const stdout = json ? `${JSON.stringify({ bylaws: bylaws.source, plan }, null, 2)}\n` : formatPlanText(plan, bylaws.source);
    return plan.ok ? { exitCode: 0, stdout, stderr: '', plan } : { exitCode: 1, stdout: json ? stdout : '', stderr: json ? '' : stdout, plan };
  }
  if (sub === 'run') {
    const sep = rest.indexOf('--');
    const argv = sep === -1 ? rest.slice(1) : rest.slice(sep + 1);
    if (sep !== 1 || argv.length === 0 || argv[0] === undefined) {
      return { exitCode: SANDBOX_REFUSED_EXIT, stdout: '', stderr: `openmorals sandbox: refused: write the command after "--", as in: openmorals sandbox run -- npm test. The command was not run.\n`, plan: null };
    }
    const plan = planForProject(bylaws, projectRoot, platform, deps);
    const res = await runSandboxed(argv[0], argv.slice(1), plan, deps);
    return { exitCode: res.exitCode, stdout: '', stderr: res.message === '' ? '' : `${res.message}\n`, plan };
  }
  return { exitCode: 64, stdout: '', stderr: `${USAGE}\n`, plan: null };
}
