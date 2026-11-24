#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { runClaudeCodeHookReviewed, toHookOutput } from './adapters/claude-code.js';
import { runCodexHook, toCodexOutput } from './adapters/codex/index.js';
import { runGeminiHook, toGeminiOutput } from './adapters/gemini-cli/index.js';
import { AGENT_NAMES, installAgentHook, isAgentName } from './adapters/install.js';
import { runOpencodeHook, toOpencodeAnswer, toOpencodeOutput } from './adapters/opencode/index.js';
import { runOpenclawHook, toOpenclawAnswer } from './adapters/openclaw/index.js';
import { appendAudit, makeAuditRecord, readAudit } from './audit.js';
import { findBylaws, loadBylaws, resolveBylaws } from './bylaws.js';
import { decide } from './engine.js';
import { clearGuidance, GUIDANCE_FILES, writeGuidance } from './guidance/index.js';
import { initProject } from './init.js';
import { isRuleKeptBeside } from './packs/compare.js';
import { listPacks, PACK_NAMES, readPackText } from './packs/index.js';
import { reviewVerdict } from './reviewer/wire.js';
import { sandboxCommand } from './sandbox/command.js';
import { formatScanJson, formatScanText, scanPath } from './scanner/index.js';
import { isUnattended, unattendedVerdict } from './session.js';
import { list as listTrash, purge, restore, trash } from './undo/index.js';
import { auditLogPath, configDir } from './paths.js';
import type { BylawsLoad, Decision, ShellKind, Verdict } from './types.js';
import { EMPTY_STATE } from './types.js';
import { VERSION } from './version.js';

const COMMAND_USAGE: Readonly<Record<string, string>> = {
  check: `  openmorals check [--shell posix|powershell|cmd] [--bylaws FILE] [--json] [--unattended] [--review] "<command>"
      Judge a command line and print allow, ask or deny with the rule and reason.
      --review: when the answer is ask, also run the reviewer as the bylaws'
      reviewer section configures it (even if enabled: false); it can only add a
      note or tighten the answer. Exit code: 0 allow, 1 ask, 2 deny, 64 usage error.`,
  scan: `  openmorals scan <path> [--json] [--unattended]
      Scan a skill, plugin, MCP config or package folder (or one file) before you
      install it: hidden instructions, secret exfiltration, download-and-execute,
      persistence, over-broad permissions. Exit code: 0 allow, 1 ask, 2 deny.`,
  trash: `  openmorals trash <path>... [--root DIR]
      Move files or folders into the project trash (.openmorals/trash) instead of
      deleting them. Prints an id for each; nothing is deleted.
  openmorals trash --list [--all] [--json] [--root DIR]
      List what is in the trash (--all also shows restored and purged items).`,
  restore: `  openmorals restore <id> [--root DIR]
      Put a trashed item back where it was. Refuses if something is in the way.`,
  purge: `  openmorals purge --older-than <days> --yes [--root DIR]
      Permanently delete trashed items older than <days>. Without --yes nothing is deleted.`,
  guidance: `  openmorals guidance [--file AGENTS.md|CLAUDE.md|GEMINI.md] [--remove] [--root DIR]
      Write the bylaws as plain instructions for the agent into a marked block of
      that file (default AGENTS.md); text outside the block is never touched.
      --remove takes the block out again.`,
  packs: `  openmorals packs
      List the ready-made bylaws packs.`,
  hook: `  openmorals hook claude-code [--unattended]
      Claude Code hook: reads the hook JSON on stdin. PreToolUse prints the decision
      JSON (and, when reviewer.enabled is true, asks the reviewer about every ask);
      PostToolUse and PostToolUseFailure record the outcome for the loop detector and
      scan the tool result for hidden instructions; UserPromptSubmit scans the prompt.
  openmorals hook codex|gemini-cli|opencode|openclaw [--unattended]
      The same judgement for Codex (PreToolUse; an ask is sent as a block, because
      Codex hooks cannot ask; PostToolUse and UserPromptSubmit scan content;
      PostModelRequest counts tokens), Gemini CLI (BeforeTool; AfterTool and
      BeforeAgent scan content), the opencode plugin and the OpenClaw plugin
      (before_tool_call asks through OpenClaw's approval; llm_output counts tokens).`,
  init: `  openmorals init [DIR] [--agent claude-code|codex|gemini-cli|opencode|openclaw] [--pack NAME]
                  [--hook-command "<cmd>"] [--no-hook]
      Write a commented openmorals.yaml (or the named pack) and install the hook for
      the agent (default claude-code: DIR/.claude/settings.json for PreToolUse,
      PostToolUse, PostToolUseFailure and UserPromptSubmit; codex: DIR/.codex/hooks.json;
      gemini-cli: DIR/.gemini/settings.json; opencode: DIR/.opencode/plugins/openmorals.js;
      openclaw: the plugin folder DIR/.openclaw/plugins/openmorals, which you then
      install with openclaw plugins install).
      Existing files are merged, never replaced, and backed up first; a file that
      cannot be parsed is left alone and the snippet is printed to merge by hand.`,
  sandbox: `  openmorals sandbox plan [--json] [--platform darwin|linux|win32]
      Print the OS sandbox the bylaws describe: a Seatbelt profile on macOS,
      bubblewrap arguments on Linux, a written plan on Windows, and srt settings.
  openmorals sandbox run -- <command> [args...]
      Run the command under that sandbox (macOS sandbox-exec, Linux bwrap) and exit
      with its exit code. Refuses with exit code 125, running nothing, when the
      sandbox tool is missing, on Windows, or when no valid plan can be made.`,
  validate: `  openmorals validate [FILE]
      Check a bylaws file (default: the one that applies to the current directory).`,
  audit: `  openmorals audit [--tail N] [--json] [--file FILE]
      Print the decision log.`,
  help: `  openmorals help [COMMAND]   (or: openmorals COMMAND --help, openmorals COMMAND -h)
      Print the usage of one command, or of all of them. Nothing is read or written.`,
};

const COMMAND_ORDER = ['check', 'scan', 'trash', 'restore', 'purge', 'guidance', 'packs', 'hook', 'init', 'sandbox', 'validate', 'audit', 'help'] as const;

const HELP = `openmorals ${VERSION}: ask before an AI agent deletes, force-pushes, leaks a secret or overspends.

Usage:
${COMMAND_ORDER.map((c) => COMMAND_USAGE[c]).join('\n')}
  openmorals --version | --help

--unattended (or OPENMORALS_UNATTENDED=1) is for CI and other runs with nobody to
ask: every "ask" becomes "deny".

The project root for trash, restore, purge and guidance is the folder holding the
nearest openmorals.yaml, else the current folder; --root overrides it.

Config directory: ${'$'}OPENMORALS_HOME, else %APPDATA%\\openmorals on Windows,
else ${'$'}XDG_CONFIG_HOME/openmorals or ~/.config/openmorals.
`;

/** The usage text of one command, or the whole help when the command is not known. */
function usageFor(cmd: string | undefined): string {
  const u = cmd !== undefined && Object.prototype.hasOwnProperty.call(COMMAND_USAGE, cmd) ? COMMAND_USAGE[cmd] : undefined;
  return u === undefined ? HELP : `Usage:\n${u}\n`;
}

/**
 * True when the arguments ask for help: `--help` anywhere before `--`, or `-h` anywhere before `--` (for `check`, only
 * directly after the command, because the words after `check` are the command line being judged). Checked before any
 * command runs, so no help request can open or write a file.
 */
function wantsHelp(argv: readonly string[]): boolean {
  const end = argv.indexOf('--');
  const head = end === -1 ? argv : argv.slice(0, end);
  if (head.includes('--help')) return true;
  if (head[0] === 'check') return head[1] === '-h';
  return head.includes('-h');
}

/** Options each command accepts; anything else is a usage error before the command runs (the hook is exempt: see main). */
const COMMAND_FLAGS: Readonly<Record<string, readonly string[]>> = {
  check: ['--shell', '--bylaws', '--json', '--unattended', '--review'],
  scan: ['--json', '--unattended'],
  trash: ['--root', '--list', '--all', '--json'],
  restore: ['--root'],
  purge: ['--older-than', '--yes', '--root'],
  guidance: ['--file', '--remove', '--root'],
  packs: [],
  init: ['--agent', '--pack', '--hook-command', '--no-hook'],
  validate: [],
  audit: ['--tail', '--json', '--file'],
};

/** Most positional arguments each command takes (after the command name); null means no limit. */
const MAX_POSITIONAL: Readonly<Record<string, number | null>> = { check: null, scan: 1, trash: null, restore: 1, purge: 0, guidance: 0, packs: 0, init: 1, validate: 1, audit: 0 };

/** The usage error for an option or argument the command does not take, or null when the arguments are acceptable. */
function argumentProblem(cmd: string, args: Args): string | null {
  const allowed = COMMAND_FLAGS[cmd];
  if (allowed === undefined) return null;
  for (const f of args.flags.keys()) if (!allowed.includes(f)) return `unknown option ${f}`;
  if (cmd !== 'check') {
    const loose = args.positional.slice(1, args.literalFrom).find((p) => p.startsWith('-') && p !== '-');
    if (loose !== undefined) return `unknown option ${loose}`;
  }
  const max = MAX_POSITIONAL[cmd];
  if (max !== undefined && max !== null && args.positional.length - 1 > max) return `unexpected argument ${JSON.stringify(args.positional[max + 1])}`;
  return null;
}

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
  /** Index in `positional` where the words after `--` start (they are never options); positional.length when there is no `--`. */
  literalFrom: number;
}

const VALUE_FLAGS = new Set(['--shell', '--bylaws', '--hook-command', '--tail', '--file', '--root', '--older-than', '--pack', '--agent']);

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--') {
      const literalFrom = positional.length;
      positional.push(...argv.slice(i + 1));
      return { positional, flags, literalFrom };
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) flags.set(a.slice(0, eq), a.slice(eq + 1));
      else if (VALUE_FLAGS.has(a)) {
        flags.set(a, argv[i + 1] ?? '');
        i++;
      } else flags.set(a, true);
      continue;
    }
    positional.push(a);
  }
  return { positional, flags, literalFrom: positional.length };
}

function flagStr(args: Args, name: string): string | null {
  const v = args.flags.get(name);
  return typeof v === 'string' ? v : null;
}

function out(s: string): void {
  process.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
}

function err(s: string): void {
  process.stderr.write(s.endsWith('\n') ? s : `${s}\n`);
}

/** One stderr line per project setting that was dropped because it would have loosened the user floor. */
function reportIgnored(load: BylawsLoad): void {
  if (!load.ok || load.ignored === undefined) return;
  for (const l of load.ignored) {
    if (isRuleKeptBeside(l)) err(`openmorals: kept ${l.field} from ${load.source} beside the user's rule of the same id; the user's rule in ${load.floorSource ?? '<defaults>'} is unchanged`);
    else err(`openmorals: ignored ${l.field} = ${l.candidate} in ${load.source}: a project file can only tighten ${load.floorSource ?? '<defaults>'} (kept ${l.baseline})`);
  }
}

/** After init: say which settings of the written file a project cannot use, and where they would work. */
function floorHint(dir: string): void {
  const load = resolveBylaws(dir);
  if (!load.ok || load.ignored === undefined || load.ignored.length === 0) return;
  reportIgnored(load);
  if (load.ignored.every(isRuleKeptBeside)) return;
  err(`openmorals: to use those settings, put them in ${join(configDir(), 'openmorals.yaml')} (your user-level file); a project file can only tighten it`);
}

function bylawsFor(args: Args): BylawsLoad {
  const file = flagStr(args, '--bylaws');
  return file !== null ? loadBylaws(resolve(file)) : resolveBylaws(process.cwd());
}

async function cmdCheck(args: Args): Promise<number> {
  const command = args.positional.slice(1).join(' ');
  if (command.trim() === '') {
    err('usage: openmorals check "<command>"');
    return 64;
  }
  const shellFlag = flagStr(args, '--shell') ?? 'posix';
  if (shellFlag !== 'posix' && shellFlag !== 'powershell' && shellFlag !== 'cmd') {
    err('--shell must be posix, powershell or cmd');
    return 64;
  }
  const shell: ShellKind = shellFlag;
  const bylaws = bylawsFor(args);
  reportIgnored(bylaws);
  const judged = decide({ kind: 'exec', command, shell, tool: shell === 'powershell' ? 'PowerShell' : 'Bash' }, bylaws, EMPTY_STATE);
  let verdict = unattended(args) ? unattendedVerdict(judged) : judged;
  let review: { sent: boolean; verdict: string; source: string; reason: string } | null = null;
  if (args.flags.has('--review') && verdict.decision === 'ask') {
    if (!bylaws.ok) err('--review: the bylaws are invalid, so the reviewer was not run');
    else {
      const r = await reviewVerdict({ kind: 'exec', command, shell, tool: 'check' }, verdict, bylaws.bylaws.reviewer, { context: 'host: openmorals check, run by a person at a terminal' });
      verdict = r.verdict;
      if (r.outcome !== null && r.outcome.review !== null) review = { sent: r.outcome.sent, verdict: r.outcome.review.verdict, source: r.outcome.review.source, reason: r.outcome.review.reason };
    }
  }
  if (!bylaws.ok || bylaws.bylaws.audit.enabled) {
    try {
      appendAudit(
        makeAuditRecord({ source: 'check', session: null, tool: 'check', action: command, decision: verdict.decision, rule: verdict.rule, reason: verdict.reason, cwd: process.cwd(), budget: null }),
        auditLogPath(configDir()),
      );
    } catch (e: unknown) {
      err(`warning: could not write the audit log: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (args.flags.has('--json')) out(JSON.stringify({ ...verdict, bylaws: bylaws.source, ...(review !== null ? { review } : {}) }));
  else {
    out(`${verdict.decision.toUpperCase().padEnd(5)} ${verdict.rule}`);
    out(`      ${verdict.reason}`);
    out(`      bylaws: ${bylaws.source}${bylaws.ok ? '' : ' (INVALID)'}`);
    if (review !== null && bylaws.ok) out(`      reviewer: ${review.verdict} (${review.source}, provider ${bylaws.bylaws.reviewer.provider}${review.sent ? '' : ', nothing sent'})`);
  }
  return exitFor(verdict.decision);
}

function unattended(args: Args): boolean {
  return args.flags.has('--unattended') || isUnattended(process.env);
}

function exitFor(d: Decision): number {
  return d === 'allow' ? 0 : d === 'ask' ? 1 : 2;
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const HOOK_TARGETS = ['claude-code', 'codex', 'gemini-cli', 'opencode', 'openclaw'] as const;

/** The fail-closed answer in the shape the target host reads (Gemini and opencode would read the Claude Code shape as allow). */
function hookFailOutput(target: string | undefined, v: Verdict): string | null {
  if (target === 'codex') return toCodexOutput(v);
  if (target === 'gemini-cli') return toGeminiOutput(v, 'deny');
  if (target === 'opencode') return toOpencodeOutput(toOpencodeAnswer(v, { event: 'tool.execute.before', api: 'v1' }));
  if (target === 'openclaw') return JSON.stringify({ ...toOpenclawAnswer(v), block: true, approval: null });
  return toHookOutput(v);
}

async function cmdHook(args: Args): Promise<number> {
  const target = args.positional[1];
  const opts = { unattended: unattended(args) };
  if (target === 'claude-code') {
    const run = await runClaudeCodeHookReviewed(readStdin(), opts);
    if (run.stdout !== '') out(run.stdout);
    return run.exitCode;
  }
  if (target === 'codex' || target === 'gemini-cli' || target === 'opencode' || target === 'openclaw') {
    const stdin = readStdin();
    const run = target === 'codex' ? runCodexHook(stdin, opts) : target === 'gemini-cli' ? runGeminiHook(stdin, opts) : target === 'opencode' ? runOpencodeHook(stdin, opts) : runOpenclawHook(stdin, opts);
    if (run.stdout !== '') out(run.stdout);
    return run.exitCode;
  }
  err(`usage: openmorals hook ${HOOK_TARGETS.join('|')}`);
  const base: Verdict = { decision: 'ask', rule: 'hook.unknown-target', reason: `unknown hook target ${target ?? '(none)'}` };
  const r = toHookOutput(unattended(args) ? unattendedVerdict(base) : base);
  if (r !== null) out(r);
  return 0;
}

function cmdInit(args: Args): number {
  const dir = resolve(args.positional[1] ?? '.');
  const packName = flagStr(args, '--pack');
  let bylawsText: string | undefined;
  if (packName !== null) {
    const pack = readPackText(packName);
    if (!pack.ok) {
      err(`openmorals init: ${pack.error} (packs: ${PACK_NAMES.join(', ')})`);
      return 1;
    }
    bylawsText = pack.text;
  }
  const agent = flagStr(args, '--agent') ?? 'claude-code';
  if (!isAgentName(agent)) {
    err(`openmorals init: --agent must be one of ${AGENT_NAMES.join(', ')}`);
    return 64;
  }
  if (agent !== 'claude-code') return initAgent(dir, agent, args, bylawsText, packName);
  const res = initProject(dir, { hookCommand: flagStr(args, '--hook-command') ?? undefined, installHook: !args.flags.has('--no-hook'), bylawsText });
  if (!res.ok) {
    err(`openmorals init: ${res.error}`);
    return 1;
  }
  out(res.bylawsWritten ? `wrote ${res.bylawsPath}${packName !== null ? ` from the ${packName} pack` : ''}` : `kept existing ${res.bylawsPath}${packName !== null ? ` (the ${packName} pack was not applied; remove or edit the file yourself)` : ''}`);
  if (res.bylawsWritten) floorHint(dir);
  if (res.settingsPath !== null) {
    if (res.settingsChanged) {
      out(`added the hook (PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit) to ${res.settingsPath}`);
      if (res.backupPath !== null) out(`backed up the previous settings to ${res.backupPath}`);
    } else out(`the hook is already in ${res.settingsPath}; nothing changed`);
  }
  return 0;
}

function initAgent(dir: string, agent: 'codex' | 'gemini-cli' | 'opencode' | 'openclaw', args: Args, bylawsText: string | undefined, packName: string | null): number {
  const res = initProject(dir, { installHook: false, bylawsText });
  if (!res.ok) {
    err(`openmorals init: ${res.error}`);
    return 1;
  }
  out(res.bylawsWritten ? `wrote ${res.bylawsPath}${packName !== null ? ` from the ${packName} pack` : ''}` : `kept existing ${res.bylawsPath}`);
  if (res.bylawsWritten) floorHint(dir);
  if (args.flags.has('--no-hook')) return 0;
  const hook = installAgentHook(dir, agent, { hookCommand: flagStr(args, '--hook-command') ?? undefined });
  if (!hook.ok) {
    err(`openmorals init --agent ${agent}: ${hook.error}`);
    if (hook.snippet !== '') {
      err(`add this to ${hook.file} yourself:`);
      out(hook.snippet);
    }
    return 1;
  }
  if (!hook.changed) out(`the ${agent} hook is already in ${hook.file}; nothing changed`);
  else {
    out(`installed the ${agent} hook in ${hook.file}`);
    if (hook.backupPath !== null) out(`backed up the previous file to ${hook.backupPath}`);
  }
  out(hook.followUp);
  return 0;
}

function cmdValidate(args: Args): number {
  const file = args.positional[1];
  const load = file !== undefined ? loadBylaws(resolve(file)) : resolveBylaws(process.cwd());
  if (load.ok) {
    out(`ok: ${load.source}${load.floorSource !== undefined ? ` (tightening ${load.floorSource})` : ''}`);
    reportIgnored(load);
    return 0;
  }
  err(`invalid: ${load.source}\n  ${load.error.split('; ').join('\n  ')}`);
  return 1;
}

function cmdAudit(args: Args): number {
  const file = flagStr(args, '--file') ?? auditLogPath(configDir());
  const res = readAudit(file);
  const tailRaw = flagStr(args, '--tail');
  const tail = tailRaw !== null ? Number.parseInt(tailRaw, 10) : 0;
  const recs = tail > 0 ? res.records.slice(-tail) : res.records;
  if (args.flags.has('--json')) for (const r of recs) out(JSON.stringify(r));
  else {
    if (recs.length === 0) out(`no decisions recorded in ${file}`);
    for (const r of recs) out(`${r.ts}  ${r.decision.toUpperCase().padEnd(5)} ${r.rule.padEnd(32)} ${r.tool.padEnd(10)} ${r.action.replace(/\s+/g, ' ').slice(0, 100)}`);
  }
  for (const e of res.errors) err(`skipped line ${e.line}: ${e.error}`);
  return 0;
}

function cmdScan(args: Args): number {
  const target = args.positional[1];
  if (target === undefined || args.positional.length > 2) {
    err('usage: openmorals scan <path> [--json]');
    return 64;
  }
  const report = scanPath(resolve(target));
  const decision: Decision = unattended(args) && report.verdict === 'ask' ? 'deny' : report.verdict;
  if (args.flags.has('--json')) out(formatScanJson(report));
  else {
    out(formatScanText(report));
    if (decision !== report.verdict) out('unattended: ask becomes deny');
  }
  return exitFor(decision);
}

function projectRoot(args: Args): string {
  const given = flagStr(args, '--root');
  if (given !== null) return resolve(given);
  const found = findBylaws(process.cwd());
  return found !== null ? dirname(found) : process.cwd();
}

function sizeText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function cmdTrash(args: Args): number {
  const root = projectRoot(args);
  if (args.flags.has('--list')) {
    const r = listTrash({ root, all: args.flags.has('--all') });
    if (!r.ok) {
      err(`openmorals trash --list: ${r.message}`);
      return 1;
    }
    if (args.flags.has('--json')) for (const it of r.value.items) out(JSON.stringify(it));
    else {
      if (r.value.items.length === 0) out(`the trash in ${root} is empty`);
      for (const it of r.value.items) out(`${it.id}  ${it.state.padEnd(8)} ${it.time}  ${sizeText(it.size).padStart(9)}  ${it.path}`);
    }
    for (const line of r.value.badLines) err(`skipped unreadable undo log line ${line}`);
    return 0;
  }
  const targets = args.positional.slice(1);
  if (targets.length === 0) {
    err('usage: openmorals trash <path>...   or   openmorals trash --list');
    return 64;
  }
  let failed = 0;
  for (const t of targets) {
    const r = trash(t, { root, cwd: process.cwd() });
    if (r.ok) out(`trashed ${r.value.path} (${r.value.kind}, ${sizeText(r.value.size)}) as ${r.value.id}; undo: openmorals restore ${r.value.id}`);
    else {
      failed++;
      err(`openmorals trash ${t}: ${r.message} [${r.code}]; nothing was moved`);
    }
  }
  return failed === 0 ? 0 : 1;
}

function cmdRestore(args: Args): number {
  const id = args.positional[1];
  if (id === undefined || args.positional.length > 2) {
    err('usage: openmorals restore <id>   (see openmorals trash --list)');
    return 64;
  }
  const r = restore(id, { root: projectRoot(args) });
  if (!r.ok) {
    err(`openmorals restore ${id}: ${r.message} [${r.code}]`);
    return 1;
  }
  out(`restored ${r.value.path}`);
  return 0;
}

function cmdPurge(args: Args): number {
  const raw = flagStr(args, '--older-than');
  const days = raw !== null && /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(days)) {
    err('usage: openmorals purge --older-than <days> --yes');
    return 64;
  }
  const confirm = args.flags.has('--yes');
  const r = purge({ root: projectRoot(args), olderThanDays: days, confirm });
  if (!r.ok) {
    err(confirm ? `openmorals purge: ${r.message} [${r.code}]` : 'openmorals purge deletes trashed files for good; add --yes to go ahead. Nothing was deleted.');
    return 1;
  }
  out(`purged ${r.value.purged.length} item${r.value.purged.length === 1 ? '' : 's'} older than ${days} day${days === 1 ? '' : 's'}`);
  for (const f of r.value.failed) err(`could not purge ${f.id}: ${f.message}`);
  return r.value.failed.length === 0 ? 0 : 1;
}

function cmdGuidance(args: Args): number {
  const name = flagStr(args, '--file') ?? 'AGENTS.md';
  if (!GUIDANCE_FILES.includes(name)) {
    err(`--file must be one of ${GUIDANCE_FILES.join(', ')}`);
    return 64;
  }
  const root = projectRoot(args);
  const file = join(root, name);
  if (args.flags.has('--remove')) {
    const r = clearGuidance(file);
    if (!r.ok) {
      err(`openmorals guidance: ${r.message}`);
      return 1;
    }
    out(r.changed ? `removed the openmorals block from ${file}` : `no openmorals block in ${file}; nothing changed`);
    return 0;
  }
  const load = resolveBylaws(root);
  if (!load.ok) {
    err(`openmorals guidance: the bylaws file ${load.source} is invalid; fix it first (openmorals validate)`);
    return 1;
  }
  const b = load.bylaws;
  const r = writeGuidance(file, b, { trashCommand: 'openmorals trash', restoreCommand: 'openmorals restore', loopEnforced: b.guards.loop.decision !== 'allow', taintEnforced: b.guards.taint.decision !== 'allow' });
  if (!r.ok) {
    err(`openmorals guidance: ${r.message}`);
    return 1;
  }
  out(r.changed ? `${r.created ? 'created' : 'updated'} the openmorals block in ${file} (from ${load.source})` : `the openmorals block in ${file} is already current`);
  return 0;
}

function cmdPacks(): number {
  const all = listPacks();
  if (all.length === 0) {
    err('no packs found next to the installed package');
    return 1;
  }
  for (const p of all) out(`${p.name.padEnd(16)} ${p.description}`);
  out('\nStart a project from one: openmorals init --pack <name>');
  return 0;
}

async function cmdSandbox(rest: string[]): Promise<number> {
  const cwd = process.cwd();
  const found = findBylaws(cwd);
  const res = await sandboxCommand(rest, resolveBylaws(cwd), found !== null ? dirname(found) : cwd);
  if (res.stdout !== '') process.stdout.write(res.stdout);
  if (res.stderr !== '') process.stderr.write(res.stderr);
  return res.exitCode;
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === 'help') {
    const topic = argv[1] === '--help' || argv[1] === '-h' ? 'help' : argv[1];
    if (topic !== undefined && !Object.prototype.hasOwnProperty.call(COMMAND_USAGE, topic)) {
      err(`unknown command ${topic}\n`);
      err(HELP);
      return 64;
    }
    out(usageFor(topic));
    return 0;
  }
  if (wantsHelp(argv)) {
    out(usageFor(argv[0]?.startsWith('-') === true ? undefined : argv[0]));
    return 0;
  }
  if (argv[0] === 'sandbox') return await cmdSandbox(argv.slice(1));
  const args = parseArgs(argv);
  const cmd = args.positional[0];
  if (args.flags.has('--version') && cmd === undefined) {
    out(VERSION);
    return 0;
  }
  if (cmd !== undefined) {
    const problem = argumentProblem(cmd, args);
    if (problem !== null) {
      err(`openmorals ${cmd}: ${problem}; nothing was done\n`);
      err(usageFor(cmd));
      return 64;
    }
  }
  switch (cmd) {
    case 'check':
      return await cmdCheck(args);
    case 'hook':
      return await cmdHook(args);
    case 'init':
      return cmdInit(args);
    case 'validate':
      return cmdValidate(args);
    case 'audit':
      return cmdAudit(args);
    case 'scan':
      return cmdScan(args);
    case 'trash':
      return cmdTrash(args);
    case 'restore':
      return cmdRestore(args);
    case 'purge':
      return cmdPurge(args);
    case 'guidance':
      return cmdGuidance(args);
    case 'packs':
      return cmdPacks();
    case undefined:
      out(HELP);
      return 64;
    default:
      err(`unknown command ${cmd}\n`);
      err(HELP);
      return 64;
  }
}

const isHook = process.argv[2] === 'hook';

function crashed(e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  if (isHook) {
    const base: Verdict = { decision: 'ask', rule: 'engine.error', reason: `openmorals crashed (${message}) and fails closed` };
    const r = hookFailOutput(process.argv[3], process.argv.includes('--unattended') || isUnattended(process.env) ? unattendedVerdict(base) : base);
    if (r !== null) out(r);
    process.exitCode = 0;
  } else {
    err(`openmorals: ${message}`);
    process.exitCode = 70;
  }
}

try {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    crashed,
  );
} catch (e: unknown) {
  crashed(e);
}
