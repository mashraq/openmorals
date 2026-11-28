#!/usr/bin/env node
import { existsSync, readFileSync, readSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { runClaudeCodeHookReviewed, toHookOutput } from './adapters/claude-code.js';
import { DEFAULT_COMMAND as CODEX_COMMAND, runCodexHook, toCodexOutput } from './adapters/codex/index.js';
import { DEFAULT_COMMAND as GEMINI_COMMAND, runGeminiHook, toGeminiOutput } from './adapters/gemini-cli/index.js';
import { AGENT_NAMES, installAgentHook, isAgentName, opencodeCommand } from './adapters/install.js';
import type { AgentName } from './adapters/install.js';
import { DEFAULT_COMMAND as OPENCODE_COMMAND, runOpencodeHook, toOpencodeAnswer, toOpencodeOutput } from './adapters/opencode/index.js';
import { DEFAULT_COMMAND as OPENCLAW_COMMAND, runOpenclawHook, toOpenclawAnswer } from './adapters/openclaw/index.js';
import { auditMeta, makeAuditRecord, readAudit } from './audit.js';
import { formatRunSummary, formatVerify, summarizeRun, verifyAudit } from './audit-verify.js';
import { TOUCHED_USAGE, touchedCommand } from './audit-touched.js';
import { formatOversight, type OversightWindow, parseOversightTime, summarizeOversight } from './oversight.js';
import { effectiveBylaws, findBylaws, loadBylaws, resolveBylaws } from './bylaws.js';
import { DIFF_CLASS_USAGE, diffClassCommand } from './diffclass/command.js';
import { DOCTOR_USAGE, doctorCommand, hookStart, joinHookWords, ownCli, ownCommandWords } from './doctor/index.js';
import { decide } from './engine.js';
import { APPROVE_USAGE, PENDING_USAGE, REFUSE_USAGE, approveCommand, pendingCommand, refuseCommand } from './defer/command.js';
import type { CommandResult, DeferCommandOptions } from './defer/command.js';
import { maskDetected, namedDetectors } from './rules/detectors.js';
import { runEval } from './eval/index.js';
import { clearGuidance, GUIDANCE_FILES, hasDailyGuidance, installDaily, readDailyPrinciples, shippedDaily, tierZero, writeGuidance, writeGuidanceBlock } from './guidance/index.js';
import { DEFAULT_HOOK_COMMAND, initProject } from './init.js';
import { guardStdin, namesGuardCommand, readStdinLimited } from './guard-stdin.js';
import { isRuleKeptBeside } from './packs/compare.js';
import { formatPackSummary, listPacks, loadPack, PACK_NAMES, packSummary, readPackText } from './packs/index.js';
import { reviewVerdict } from './reviewer/wire.js';
import { sandboxCommand } from './sandbox/command.js';
import { formatScanJson, formatScanText, scanPath } from './scanner/index.js';
import { isUnattended, unattendedVerdict } from './session.js';
import { keepCopy, list as listTrash, purge, purgePreview, restore, trash } from './undo/index.js';
import { auditLogPath, configDir } from './paths.js';
import type { BylawsLoad, Decision, ShellKind, Verdict } from './types.js';
import { EMPTY_STATE } from './types.js';
import { appendAuditForSession } from './state.js';
import { SAMPLE_USAGE, sampleCommand } from './sample/index.js';
import { HANDOFFS_USAGE, handoffsCommand } from './inbound/handoffs-command.js';
import { FailFirstController, TESTS_USAGE, failFirstCommand, testsCommand } from './tests/index.js';
import { ORDER_USAGE } from './order/usage.js';
import { BUDGET_USAGE, SESSIONS_USAGE, STOP_USAGE, budgetCommand, sessionsCommand, stopCommand } from './tokens/command.js';
import { VERSION } from './version.js';

const COMMAND_USAGE: Readonly<Record<string, string>> = {
  check: `  openmorals check [--shell posix|powershell|cmd] [--bylaws FILE] [--json] [--unattended] [--review] "<command>"
      Judge a command line and print allow, ask or deny with the rule and reason.
      --bylaws FILE: judge against that file alone; your user-level file is not
      applied. Without it, the user-level file and the nearest project file are.
      --review: when the answer is ask, also run the reviewer as the bylaws'
      reviewer section configures it (even if enabled: false); it can only add a
      note or tighten the answer. Exit code: 0 allow, 1 ask, 2 deny, 64 usage error.`,
  guard: `  openmorals guard --json [--unattended]
      For a program that is not one of the agent hosts (Preview): reads ONE request
      on stdin, {"session", "cwd"?, "tool", "input"?, "actions"?}, judges it as the
      library call guardCall does (your user file, the project file, the built-in
      guards and the session's history), and prints one JSON line: decision, rule,
      reason. Exit code: 0 allow, 1 ask, 2 deny, 64 usage error. Input that is not
      one JSON object of at most 16 MiB asks (deny with --unattended). It is not a
      hook: init refuses it as a --hook-command. --json is required.`,
  scan: `  openmorals scan <path> [--json] [--unattended]
      Scan a skill, plugin, MCP config or package folder (or one file) before you
      install it: hidden instructions, secret exfiltration, download-and-execute,
      persistence, over-broad permissions. Exit code: 0 allow, 1 ask, 2 deny.`,
  trash: `  openmorals trash <path>... [--root DIR]
      Move files or folders into the project trash (.openmorals/trash) instead of
      deleting them. Prints an id for each; nothing is deleted.
  openmorals trash --copy <file>... [--root DIR]
      Put a copy of each file in the project trash and leave the file in place,
      before it is replaced whole (guards.replace). restore puts the copy back.
  openmorals trash --list [--all] [--json] [--root DIR]
      List what is in the trash (--all also shows restored and purged items).`,
  restore: `  openmorals restore <id> [--root DIR]
      Put a trashed item back where it was. Refuses if something is in the way.`,
  purge: `  openmorals purge --older-than <days> [--yes] [--root DIR]
  openmorals purge <id>... [--yes] [--root DIR]
      Permanently delete trashed items older than <days>, or the items named by id.
      Lists what it will delete first; in a terminal it asks (type yes), elsewhere
      nothing is deleted without --yes. An agent is asked before running it.`,
  guidance: `  openmorals guidance [--file AGENTS.md|CLAUDE.md|GEMINI.md] [--daily] [--remove] [--root DIR]
      Write the bylaws as plain instructions for the agent into a marked block of
      that file (default AGENTS.md); text outside the block is never touched.
      --daily writes the short always-on daily guidance of the daily pack instead
      (advice only, not checked). --remove takes the block out again.`,
  packs: `  openmorals packs [NAME]
  openmorals packs show NAME | --file FILE
      List the ready-made bylaws packs, or print one pack's file (to copy an
      add-on pack such as test-lock into an existing openmorals.yaml).
      show checks a pack the way the hook reads it and prints its principles:
      which are checked (and by which rules or guards) and which are advice
      only, not checked, and its disclaimer. An invalid pack exits 1.`,
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
      cannot be parsed is left alone and the snippet is printed to merge by hand.
      Before writing anything, init checks that the hook command's program is on
      PATH (folders a package runner adds for one run do not count) or is a full
      path that exists; if not, it writes nothing, exits 1 and prints a full-path
      --hook-command to use.
      --pack daily also writes the daily guidance (advice only, not checked): a
      short always-on block in DIR/CLAUDE.md (AGENTS.md, or GEMINI.md for
      gemini-cli) and, for Claude Code, three skills in DIR/.claude/skills/. No
      other init writes them.`,
  sandbox: `  openmorals sandbox plan [--json] [--platform darwin|linux|win32]
      Print the OS sandbox the bylaws describe: a Seatbelt profile on macOS,
      bubblewrap arguments on Linux, a written plan on Windows, and srt settings.
  openmorals sandbox run -- <command> [args...]
      Run the command under that sandbox (macOS sandbox-exec, Linux bwrap) and exit
      with its exit code. Refuses with exit code 125, running nothing, when the
      sandbox tool is missing, on Windows, or when no valid plan can be made.`,
  doctor: DOCTOR_USAGE,
  validate: `  openmorals validate [FILE]
      Check a bylaws file (default: the one that applies to the current directory).`,
  audit: `  openmorals audit [--tail N] [--json] [--file FILE]
      Print the decision log.
  openmorals audit verify [--run ID] [--json] [--file FILE]
      Check the log's per-session hash chain against the session files beside it:
      reports an edited line, a deleted line, a cut-off tail and a session whose
      saved state was reset; with --run, a missing log or a run with no record.
      Exit 0 when verified, 1 when anything is wrong. It cannot see a log that a
      program running as you rewrote with every hash recomputed.
  openmorals audit --run ID [--json] [--file FILE]
      Summarise one run (records written with OPENMORALS_RUN=ID): denies, asks,
      approved asks, taint marks and loosening notes, and whether its record
      verifies; what the run used (tool calls, tokens, sub-agent runs, whether it
      is stopped) from its run folder; test files written, git commits, and a "no
      check recorded" line when it wrote files with no check in its records (a
      line to read; it never changes the exit code). Exit 0 when the run has
      records and they verify, else 1.
  openmorals audit oversight [--since TIME] [--until TIME] [--json] [--file FILE]
      What the log shows of your oversight: calls, asks, asks whose call then
      ran, asks with no outcome, approval rate per rule, asks per 100 calls,
      denies, calls refused as stopped, your stops and clears, and whether the
      record verifies. Prints reasons to look, never a pass: evidence, not
      compliance. TIME is a date (2026-11-01) or an ISO time. Read only; exit 0
      when the record verifies, else 1.
${SAMPLE_USAGE}
${HANDOFFS_USAGE}
${TOUCHED_USAGE}`,
  eval: `  openmorals eval [--json] [--cases DIR] [--guard NAME] [--bylaws FILE]
                  [--save FILE] [--since FILE] [--model ID]
      Score the guards against the case rows: every cases/*.cases.yaml row through
      the engine, every inbound table row through the inbound scan, and every
      cases/*.sessions.yaml session through the hook, step by step, in a
      temporary home and project that are removed afterwards. Prints per guard
      the catch rate, the false-alarm rate, rows decided by the wrong rule, the
      time per decision, and every wrong row by file and index. Calls no model.
      Default rows: the ones shipped with openmorals (built into the single
      executable); --cases scores a folder of your own. --bylaws: the bylaws for
      guard rows that carry none (default: the built-in defaults, never your own
      files); session rows carry their own.
      --save FILE keeps every row's outcome and a fingerprint (version, rows,
      bylaws, shipped packs, the skills in .claude/skills here and in your home,
      and the model: --model, else ANTHROPIC_MODEL). --since FILE scores again
      and lists what moved since that file: fingerprint parts and rows decided
      differently, looser ones first; anything moved makes the exit code 1.
      Exit 0 when every row matches (and nothing moved), 1 when a row is wrong
      or something moved, 2 when the rows, bylaws or saved score cannot be read
      or the score cannot be saved.`,
  pending: PENDING_USAGE,
  approve: APPROVE_USAGE,
  stop: STOP_USAGE,
  sessions: SESSIONS_USAGE,
  budget: BUDGET_USAGE,
  refuse: REFUSE_USAGE,
  tests: TESTS_USAGE,
  'diff-class': DIFF_CLASS_USAGE,
  order: ORDER_USAGE,
  help: `  openmorals help [COMMAND]   (or: openmorals COMMAND --help, openmorals COMMAND -h)
      Print the usage of one command, or of all of them. Nothing is read or written.`,
};

const COMMAND_ORDER = ['check', 'guard', 'scan', 'trash', 'restore', 'purge', 'guidance', 'packs', 'hook', 'init', 'doctor', 'sandbox', 'validate', 'audit', 'pending', 'approve', 'refuse', 'sessions', 'stop', 'budget', 'eval', 'tests', 'diff-class', 'order', 'help'] as const;

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
  guard: ['--json', '--unattended'],
  scan: ['--json', '--unattended'],
  trash: ['--root', '--list', '--all', '--json', '--copy'],
  restore: ['--root'],
  purge: ['--older-than', '--yes', '--root'],
  guidance: ['--file', '--remove', '--root', '--daily'],
  packs: ['--file'],
  init: ['--agent', '--pack', '--hook-command', '--no-hook'],
  doctor: ['--json', '--no-run'],
  validate: [],
  audit: ['--tail', '--json', '--file', '--run', '--since', '--until'],
  eval: ['--json', '--cases', '--guard', '--bylaws', '--save', '--since', '--model'],
  pending: ['--all', '--json'],
  approve: [],
  refuse: [],
  stop: ['--all', '--clear', '--run'],
  sessions: ['--json', '--limit'],
};

/** Most positional arguments each command takes (after the command name); null means no limit. */
const MAX_POSITIONAL: Readonly<Record<string, number | null>> = { check: null, guard: 0, scan: 1, trash: null, restore: 1, purge: null, guidance: 0, packs: 2, init: 1, doctor: 1, validate: 1, audit: 1, eval: 0, pending: 0, approve: 1, refuse: 1, stop: 1, sessions: 0 };

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

const VALUE_FLAGS = new Set(['--shell', '--bylaws', '--hook-command', '--tail', '--file', '--root', '--older-than', '--pack', '--agent', '--cases', '--guard', '--run', '--save', '--since', '--until', '--model', '--limit']);

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
  const kept = maskDetected(command, namedDetectors(effectiveBylaws(bylaws).rules));
  let review: { sent: boolean; verdict: string; source: string; reason: string } | null = null;
  if (args.flags.has('--review') && verdict.decision === 'ask') {
    if (!bylaws.ok) err('--review: the bylaws are invalid, so the reviewer was not run');
    else {
      const r = await reviewVerdict({ kind: 'exec', command: kept, shell, tool: 'check' }, verdict, bylaws.bylaws.reviewer, { context: 'host: openmorals check, run by a person at a terminal' });
      verdict = r.verdict;
      if (r.outcome !== null && r.outcome.review !== null) review = { sent: r.outcome.sent, verdict: r.outcome.review.verdict, source: r.outcome.review.source, reason: r.outcome.review.reason };
    }
  }
  if (!bylaws.ok || bylaws.bylaws.audit.enabled) {
    try {
      appendAuditForSession(
        null,
        [makeAuditRecord({ source: 'check', session: null, tool: 'check', action: kept, decision: verdict.decision, rule: verdict.rule, reason: verdict.reason, cwd: process.cwd(), budget: null })],
        auditMeta({ bylaws: effectiveBylaws(bylaws), event: null, agent: null, env: process.env }),
        configDir(),
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

/** `openmorals guard --json` (0.43.1): one request on stdin, judged by guardCall. Without --json it is a usage error. */
function cmdGuard(args: Args): number {
  if (!args.flags.has('--json') || args.flags.get('--json') !== true) {
    err('openmorals guard: --json is required; it reads one JSON request on stdin and prints one JSON line. Nothing was read.');
    err(usageFor('guard'));
    return 64;
  }
  const r = guardStdin(readStdinLimited(), { unattended: unattended(args) });
  out(r.stdout);
  return r.exitCode;
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

/**
 * Before init writes anything (0.41.2): the hook command must start when the host runs it later. A command that does
 * not resolve is refused with what to do instead; one with shell syntax cannot be checked and is written with a warning.
 * A program found on this terminal's PATH is accepted with its full path and a note that a host may see another PATH.
 * Returns the exit code to stop with, or null to go on.
 */
function refuseDeadHook(dir: string, agent: AgentName, args: Args): number | null {
  if (args.flags.has('--no-hook')) return null;
  const flag = flagStr(args, '--hook-command');
  if (flag !== null && namesGuardCommand(flag)) {
    err(`openmorals init: the hook command "${flag}" runs openmorals guard, which is not a hook: it reads a program's request, not a host's hook call, so it would refuse every call as a bad request, and a host that reads a non-zero exit as an error could run the tool. Nothing was written.`);
    err(`Use the hook for this host: openmorals hook ${agent}`);
    return 64;
  }
  const argv = agent === 'opencode' || agent === 'openclaw';
  let command: string | readonly string[];
  if (flag !== null) {
    if (!argv) command = flag;
    else {
      const words = opencodeCommand(flag);
      if (words === null) return null;
      command = words;
    }
  } else command = agent === 'claude-code' ? DEFAULT_HOOK_COMMAND : agent === 'codex' ? CODEX_COMMAND : agent === 'gemini-cli' ? GEMINI_COMMAND : agent === 'opencode' ? OPENCODE_COMMAND : OPENCLAW_COMMAND;
  const shown = typeof command === 'string' ? `"${command}"` : JSON.stringify(command);
  const start = hookStart(command, dir, process.env, process.platform);
  if (start.ok) {
    if (!start.checked) {
      const ifDead = agent === 'claude-code' ? 'Claude Code blocks every prompt and tool call' : 'the hook fails on every call';
      err(`openmorals init: warning: the hook command ${shown} was not checked (${start.why}). If it does not start, ${ifDead}; run openmorals doctor once it is installed`);
    } else if (start.onPath) {
      err(`openmorals init: the hook runs ${start.program}, found on this terminal's PATH.`);
      err('An agent started outside this terminal (from a desktop launcher or an editor) may not have the same PATH. If its hook does not start, run init again with --hook-command and the full path.');
    }
    return null;
  }
  const effect = agent === 'claude-code'
    ? 'Claude Code would block every prompt and tool call, because init sets the hook to block when it fails'
    : 'the hook would fail on every call';
  err(`openmorals init: the hook command ${shown} would not start: ${start.why}. ${effect}. Nothing was written.`);
  err('Do one of these, then run init again:');
  err('  - put openmorals on PATH for the program that starts the agent (from a clone of this repository: npm link), then check with: openmorals doctor');
  const mine = ownCommandWords(ownCli(), process.env, process.platform);
  if (mine !== null) {
    const words = [...mine, 'hook', agent];
    const value = argv ? JSON.stringify(words) : joinHookWords(words, process.platform);
    if (process.platform === 'win32') err(`  - or give the full path of this openmorals as the --hook-command value, quoted as your shell needs: ${value}`);
    else err(`  - or give the full path of this openmorals: openmorals init ${args.positional[1] !== undefined ? `${/\s/.test(dir) ? `"${dir}"` : dir} ` : ''}${agent === 'claude-code' ? '' : `--agent ${agent} `}--hook-command '${value}'`);
  } else err('  - or install openmorals outside a package runner and give its full path with --hook-command');
  err(`  - or write the rules file with no hook: openmorals init ${agent === 'claude-code' ? '' : `--agent ${agent} `}--no-hook`);
  err('An agent started from a desktop launcher may see a different PATH from this terminal; the full path works for both.');
  return 1;
}

function cmdInit(args: Args): number {
  const dir = resolve(args.positional[1] ?? '.');
  const packName = flagStr(args, '--pack');
  let bylawsText: string | undefined;
  let packFile = '';
  if (packName !== null) {
    const pack = readPackText(packName);
    if (!pack.ok) {
      err(`openmorals init: ${pack.error} (packs: ${PACK_NAMES.join(', ')})`);
      return 1;
    }
    const load = loadPack(packName);
    if (!load.ok) {
      err(`openmorals init: the ${packName} pack is invalid (${load.error}); nothing was written`);
      return 1;
    }
    bylawsText = pack.text;
    packFile = pack.file;
  }
  const agent = flagStr(args, '--agent') ?? 'claude-code';
  if (!isAgentName(agent)) {
    err(`openmorals init: --agent must be one of ${AGENT_NAMES.join(', ')}`);
    return 64;
  }
  const dead = refuseDeadHook(dir, agent, args);
  if (dead !== null) return dead;
  if (agent !== 'claude-code') return initAgent(dir, agent, args, bylawsText, packName, packFile);
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
  return initDaily(dir, agent, bylawsText, packFile, res.bylawsWritten, res.bylawsPath, packName);
}

/**
 * After `init` with a pack (0.29.0): the daily guidance (tier 0 block, and for Claude Code the three skills), only for a
 * pack that carries guidance lines and only when that pack is the project's file in force. Any other init writes none.
 */
function initDaily(dir: string, agent: string, packText: string | undefined, packFile: string, written: boolean, bylawsPath: string, packName: string | null): number {
  if (packText === undefined) return 0;
  const d = readDailyPrinciples(packText, packFile);
  if (!d.ok || !hasDailyGuidance(d.principles)) return 0;
  let current: string | null = null;
  try {
    current = readFileSync(bylawsPath, 'utf8');
  } catch {
    current = null;
  }
  if (!written && current !== packText) {
    out('the daily guidance was not written either: the project keeps its own openmorals.yaml');
    return 0;
  }
  const r = installDaily(dir, agent, d.principles);
  for (const l of r.lines) out(l);
  if (!r.ok) {
    err(`openmorals init: ${r.error}`);
    return 1;
  }
  out(`the guidance is advice only, not checked: openmorals packs show ${packName ?? 'daily'} lists which lines a guard also checks. The hook adds none of it unless guidance.first_activity is true in your user-level file`);
  return 0;
}

function initAgent(dir: string, agent: 'codex' | 'gemini-cli' | 'opencode' | 'openclaw', args: Args, bylawsText: string | undefined, packName: string | null, packFile: string): number {
  const res = initProject(dir, { installHook: false, bylawsText });
  if (!res.ok) {
    err(`openmorals init: ${res.error}`);
    return 1;
  }
  out(res.bylawsWritten ? `wrote ${res.bylawsPath}${packName !== null ? ` from the ${packName} pack` : ''}` : `kept existing ${res.bylawsPath}`);
  if (res.bylawsWritten) floorHint(dir);
  if (args.flags.has('--no-hook')) return initDaily(dir, agent, bylawsText, packFile, res.bylawsWritten, res.bylawsPath, packName);
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
  return initDaily(dir, agent, bylawsText, packFile, res.bylawsWritten, res.bylawsPath, packName);
}

/** One line (0.23.0) naming the sites whose look-alikes are judged and which file each came from; null when `protect` is unused. */
function protectLine(load: BylawsLoad): string | null {
  if (!load.ok) return null;
  const b = load.bylaws;
  const added = b.project_protect ?? [];
  if ((b.protect ?? []).length === 0 && added.length === 0) return null;
  const own = load.floorSource ?? load.source;
  const list = (xs: readonly string[]): string => `${xs.slice(0, 10).join(', ')}${xs.length > 10 ? ` (+${xs.length - 10} more)` : ''}`;
  const parts: string[] = [];
  if ((b.sites ?? []).length > 0) parts.push(`${list(b.sites ?? [])} (sites, ${own})`);
  if ((b.protect ?? []).length > 0) parts.push(`${list(b.protect ?? [])} (protect, ${own})`);
  if (added.length > 0) parts.push(`${list(added)} (protect, added by ${load.source})`);
  return `protected from look-alikes: ${parts.join('; ')}`;
}

function cmdValidate(args: Args): number {
  const file = args.positional[1];
  const load = file !== undefined ? loadBylaws(resolve(file)) : resolveBylaws(process.cwd());
  if (load.ok) {
    out(`ok: ${load.source}${load.floorSource !== undefined ? ` (tightening ${load.floorSource})` : ''}`);
    const pl = protectLine(load);
    if (pl !== null) out(pl);
    reportIgnored(load);
    return 0;
  }
  err(`invalid: ${load.source}\n  ${load.error.split('; ').join('\n  ')}`);
  if (load.keptRest === true) err('  only its principles or disclaimer are wrong: the hook still enforces its other settings, and asks before every call until this is fixed');
  return 1;
}

function cmdAudit(args: Args): number {
  const file = flagStr(args, '--file') ?? auditLogPath(configDir());
  const sub = args.positional[1];
  const run = args.flags.has('--run') ? flagStr(args, '--run') : null;
  if (sub === 'oversight') return cmdAuditOversight(args, file);
  if (args.flags.has('--since') || args.flags.has('--until')) {
    err('openmorals audit: --since and --until only apply to audit oversight; nothing was done');
    return 64;
  }
  if (sub !== undefined && sub !== 'verify') {
    err(`openmorals audit: unknown subcommand ${JSON.stringify(sub)}; nothing was done\n`);
    err(usageFor('audit'));
    return 64;
  }
  if (args.flags.has('--run') && (run === null || run.trim() === '')) {
    err('openmorals audit: --run needs a run id; nothing was done');
    return 64;
  }
  if (args.flags.has('--tail') && (sub === 'verify' || run !== null)) {
    err('openmorals audit: --tail only applies to printing the log; nothing was done');
    return 64;
  }
  if (sub === 'verify') {
    const v = verifyAudit(file, { run });
    if (args.flags.has('--json')) out(JSON.stringify({ file, ...v }));
    else process.stdout.write(formatVerify(file, v));
    return v.ok ? 0 : 1;
  }
  if (run !== null) {
    const given = flagStr(args, '--file');
    const here = given === null ? configDir() : existsSync(join(dirname(given), 'runs')) ? dirname(given) : null;
    const s = here !== null ? summarizeRun(file, run, { configDir: here }) : { ...summarizeRun(file, run), counts: { status: 'not-here' as const, log: file } };
    if (args.flags.has('--json')) out(JSON.stringify({ file, ...s }));
    else process.stdout.write(formatRunSummary(s));
    return s.records > 0 && s.record.ok ? 0 : 1;
  }
  const res = readAudit(file);
  const tailRaw = flagStr(args, '--tail');
  const tail = tailRaw !== null ? Number.parseInt(tailRaw, 10) : 0;
  if (res.status === 'unreadable') {
    for (const e of res.errors) err(e.error);
    return 1;
  }
  const missing = `no audit log at ${file}: nothing has been recorded there yet, or it was removed`;
  const recs = tail > 0 ? res.records.slice(-tail) : res.records;
  if (args.flags.has('--json')) {
    for (const r of recs) out(JSON.stringify(r));
    if (res.status === 'missing') err(missing);
  } else {
    if (res.status === 'missing') out(missing);
    else if (recs.length === 0) out(`no decisions recorded in ${file}`);
    for (const r of recs) out(`${r.ts}  ${r.decision.toUpperCase().padEnd(5)} ${r.rule.padEnd(32)} ${r.tool.padEnd(10)} ${r.action.replace(/\s+/g, ' ').slice(0, 100)}`);
  }
  for (const e of res.errors) err(`skipped line ${e.line}: ${e.error}`);
  return 0;
}

function cmdAuditOversight(args: Args, file: string): number {
  if (args.flags.has('--run') || args.flags.has('--tail')) {
    err('openmorals audit oversight: --run and --tail do not apply; nothing was done');
    return 64;
  }
  const w: OversightWindow = {};
  for (const [flag, key] of [['--since', 'since'], ['--until', 'until']] as const) {
    if (!args.flags.has(flag)) continue;
    const raw = flagStr(args, flag);
    const t = raw === null ? null : parseOversightTime(raw);
    if (t === null) {
      err(`openmorals audit oversight: ${flag} needs a date (2026-11-01) or an ISO time; nothing was done`);
      return 64;
    }
    w[key] = t;
  }
  if (w.since !== undefined && w.until !== undefined && w.since >= w.until) {
    err('openmorals audit oversight: --since must be before --until; nothing was done');
    return 64;
  }
  const v = verifyAudit(file, { run: null });
  const s = summarizeOversight(file, v, w);
  if (args.flags.has('--json')) out(JSON.stringify({ file, ...s }));
  else process.stdout.write(formatOversight(file, s));
  return s.record.ok ? 0 : 1;
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
      for (const it of r.value.items) out(`${it.id}  ${it.state.padEnd(8)} ${it.time}  ${sizeText(it.size).padStart(9)}  ${it.path}${it.copy === true ? '  (kept copy)' : ''}`);
    }
    for (const line of r.value.badLines) err(`skipped unreadable undo log line ${line}`);
    return 0;
  }
  const targets = args.positional.slice(1);
  if (targets.length === 0) {
    err('usage: openmorals trash <path>...   or   openmorals trash --copy <file>...   or   openmorals trash --list');
    return 64;
  }
  let failed = 0;
  if (args.flags.has('--copy')) {
    for (const t of targets) {
      const r = keepCopy(t, { root, cwd: process.cwd() });
      if (r.ok) out(`kept a copy of ${r.value.path} (${sizeText(r.value.size)}) as ${r.value.id}; the file is unchanged; to put this copy back later: openmorals restore ${r.value.id}`);
      else {
        failed++;
        err(`openmorals trash --copy ${t}: ${r.message} [${r.code}]; nothing was copied`);
      }
    }
    return failed === 0 ? 0 : 1;
  }
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

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * `openmorals purge`: lists what it will delete for good, then asks in a terminal (the person types yes), or needs --yes
 * where nobody can be asked. Exactly the listed items are deleted. An agent running it is asked first (self-protect).
 */
function cmdPurge(args: Args, io: { interactive: boolean; readLine: () => string | null; prompt: (t: string) => void }): number {
  const raw = flagStr(args, '--older-than');
  const ids = args.positional.slice(1);
  const days = raw !== null && /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw === null && ids.length > 0 ? 0 : Number.NaN;
  if (!Number.isFinite(days)) {
    err('usage: openmorals purge --older-than <days> [--yes]   or   openmorals purge <id>... [--yes]');
    return 64;
  }
  const root = projectRoot(args);
  const plan = purgePreview({ root, olderThanDays: days, ...(ids.length > 0 ? { ids } : {}) });
  if (!plan.ok) {
    err(`openmorals purge: ${plan.message} [${plan.code}]; nothing was deleted`);
    return 1;
  }
  const missing = ids.filter((id) => !plan.value.some((it) => it.id === id));
  if (missing.length > 0) {
    err(`openmorals purge: no trashed item ${missing.join(', ')}${raw !== null ? ` older than ${plural(days, 'day')}` : ''} (see openmorals trash --list); nothing was deleted`);
    return 1;
  }
  if (plan.value.length === 0) {
    out(`nothing in the trash is older than ${plural(days, 'day')}; nothing was deleted`);
    return 0;
  }
  const total = plan.value.reduce((n, it) => n + it.size, 0);
  out(`openmorals purge deletes ${plural(plan.value.length, 'item')} (${sizeText(total)}) for good:`);
  for (const it of plan.value) out(`  ${it.id}  ${it.time}  ${sizeText(it.size).padStart(9)}  ${it.path}`);
  if (!args.flags.has('--yes')) {
    if (!io.interactive) {
      err('openmorals purge: add --yes to delete them, or run it in a terminal to be asked. Nothing was deleted.');
      return 1;
    }
    io.prompt(`Delete ${plan.value.length === 1 ? 'it' : `these ${plan.value.length}`} for good? Type yes: `);
    const line = io.readLine();
    if (line === null || line.trim().toLowerCase() !== 'yes') {
      err('openmorals purge: not confirmed; nothing was deleted');
      return 1;
    }
  }
  const r = purge({ root, olderThanDays: days, confirm: true, ids: plan.value.map((it) => it.id) });
  if (!r.ok) {
    err(`openmorals purge: ${r.message} [${r.code}]`);
    return 1;
  }
  out(`purged ${plural(r.value.purged.length, 'item')}`);
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
  if (args.flags.has('--daily')) {
    const daily = shippedDaily();
    const t0 = daily.ok ? tierZero(daily.principles) : { ok: false as const, error: daily.error };
    if (!t0.ok) {
      err(`openmorals guidance: the daily pack could not be rendered (${t0.error}); nothing was written`);
      return 1;
    }
    const w = writeGuidanceBlock(file, t0.text);
    if (!w.ok) {
      err(`openmorals guidance: ${w.message}`);
      return 1;
    }
    out(w.changed ? `${w.created ? 'created' : 'updated'} the daily guidance block in ${file} (${t0.text.length} characters, advice only, not checked)` : `the daily guidance block in ${file} is already current`);
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

async function cmdEval(args: Args): Promise<number> {
  const cases = flagStr(args, '--cases');
  const guard = flagStr(args, '--guard');
  const bylaws = flagStr(args, '--bylaws');
  const save = flagStr(args, '--save');
  const since = flagStr(args, '--since');
  const model = flagStr(args, '--model');
  for (const [name, v] of [['--cases', cases], ['--guard', guard], ['--bylaws', bylaws], ['--save', save], ['--since', since], ['--model', model]] as const) {
    if (args.flags.has(name) && (v === null || v === '')) {
      err(`openmorals eval: ${name} needs a value; nothing was scored`);
      return 64;
    }
  }
  // The office rows (0.30.0) are built and judged only here, so the office readers load in eval and order, never in a hook.
  const office = guard === null || guard === 'office' ? (await import('./office/eval.js')).scoreOffice() : null;
  const fp = save !== null || since !== null;
  const envModel = process.env['ANTHROPIC_MODEL'];
  const skills = fp ? [{ where: 'project', dir: join(process.cwd(), '.claude', 'skills') }, { where: 'user', dir: join(homedir(), '.claude', 'skills') }] : [];
  const r = runEval({
    ...(cases !== null ? { cases } : {}),
    ...(guard !== null ? { guard } : {}),
    ...(bylaws !== null ? { bylaws } : {}),
    json: args.flags.has('--json'),
    office,
    ...(save !== null ? { save } : {}),
    ...(since !== null ? { since } : {}),
    model: model ?? (envModel !== undefined && envModel !== '' ? envModel : null),
    skills,
  });
  if (r.stdout !== '') process.stdout.write(r.stdout);
  if (r.stderr !== '') process.stderr.write(r.stderr);
  return r.exitCode;
}

function cmdPacksShow(args: Args): number {
  const name = args.positional[2];
  const file = args.flags.has('--file') ? flagStr(args, '--file') : null;
  if ((name === undefined) === (file === null) || file === '') {
    err('openmorals packs show: name one pack, or one file with --file; nothing was done');
    err(usageFor('packs'));
    return 64;
  }
  let text: string;
  let source: string;
  let shown: string;
  if (file !== null) {
    source = resolve(file);
    shown = file;
    try {
      text = readFileSync(source, 'utf8');
    } catch (e: unknown) {
      err(`openmorals packs show: cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  } else {
    const pack = readPackText(name ?? '');
    if (!pack.ok) {
      err(`openmorals packs show: ${pack.error} (packs: ${PACK_NAMES.join(', ')})`);
      return 1;
    }
    text = pack.text;
    source = pack.file;
    shown = pack.name;
  }
  const s = packSummary(text, source);
  if (!s.ok) {
    err(`invalid: ${s.source}\n  ${s.error.split('; ').join('\n  ')}`);
    return 1;
  }
  process.stdout.write(formatPackSummary(s, shown));
  return 0;
}

function cmdPacks(args: Args): number {
  if (args.positional[1] === 'show') return cmdPacksShow(args);
  if (args.positional.length > 2) {
    err(`openmorals packs: unexpected argument ${JSON.stringify(args.positional[2])}`);
    err(usageFor('packs'));
    return 64;
  }
  if (args.flags.has('--file')) {
    err('openmorals packs: --file only applies to packs show; nothing was done');
    return 64;
  }
  const name = args.positional[1];
  if (name !== undefined) {
    const pack = readPackText(name);
    if (!pack.ok) {
      err(`openmorals packs: ${pack.error} (packs: ${PACK_NAMES.join(', ')})`);
      return 1;
    }
    process.stdout.write(pack.text.endsWith('\n') ? pack.text : `${pack.text}\n`);
    return 0;
  }
  const all = listPacks();
  if (all.length === 0) {
    err('no packs found next to the installed package');
    return 1;
  }
  for (const p of all) out(`${p.name.padEnd(16)} ${p.description}`);
  out('\nStart a project from one: openmorals init --pack <name>; print one: openmorals packs <name>; its principles: openmorals packs show <name>');
  return 0;
}

function cmdTests(rest: string[]): number {
  const r = testsCommand(rest);
  if (r.stdout !== '') process.stdout.write(r.stdout);
  if (r.stderr !== '') process.stderr.write(r.stderr);
  return r.exitCode;
}

function cmdDiffClass(rest: string[]): number {
  const r = diffClassCommand(rest, { env: process.env, cwd: process.cwd(), readStdin: () => readFileSync(0) });
  if (r.stdout !== '') process.stdout.write(r.stdout);
  if (r.stderr !== '') process.stderr.write(r.stderr);
  return r.exitCode;
}

function cmdAuditSub(rest: string[], run: (argv: string[]) => { exitCode: number; stdout: string; stderr: string } = sampleCommand): number {
  const r = run(rest);
  if (r.stdout !== '') process.stdout.write(r.stdout);
  if (r.stderr !== '') process.stderr.write(r.stderr);
  return r.exitCode;
}

async function cmdFailFirst(rest: string[]): Promise<number> {
  const controller = new FailFirstController();
  const handlers: Array<[NodeJS.Signals, () => void]> = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((sig) => [sig, (): void => controller.cancel(sig)]);
  for (const [sig, h] of handlers) process.on(sig, h);
  try {
    const r = await failFirstCommand(rest, { controller });
    if (r.stdout !== '') process.stdout.write(r.stdout);
    if (r.stderr !== '') process.stderr.write(r.stderr);
    return r.exitCode;
  } finally {
    for (const [sig, h] of handlers) process.off(sig, h);
  }
}

async function cmdSandbox(rest: string[]): Promise<number> {
  const cwd = process.cwd();
  const found = findBylaws(cwd);
  const res = await sandboxCommand(rest, resolveBylaws(cwd), found !== null ? dirname(found) : cwd);
  if (res.stdout !== '') process.stdout.write(res.stdout);
  if (res.stderr !== '') process.stderr.write(res.stderr);
  return res.exitCode;
}

/** One line typed at the terminal (up to the Enter key), or null at end of input or on a read error. */
function readLineSync(): string | null {
  const buf = Buffer.alloc(1);
  const bytes: number[] = [];
  try {
    for (;;) {
      const n = readSync(0, buf, 0, 1, null);
      if (n === 0) return bytes.length === 0 ? null : Buffer.from(bytes).toString('utf8');
      const b = buf[0] ?? 0;
      if (b === 10) return Buffer.from(bytes).toString('utf8');
      bytes.push(b);
      if (bytes.length > 256) return null;
    }
  } catch {
    return null;
  }
}

function deferOptions(): DeferCommandOptions {
  return { env: process.env, interactive: process.stdin.isTTY === true && process.stdout.isTTY === true, readLine: readLineSync, prompt: (t) => process.stdout.write(t) };
}

function printed(r: CommandResult): number {
  if (r.stdout !== '') process.stdout.write(r.stdout);
  if (r.stderr !== '') process.stderr.write(r.stderr);
  return r.exitCode;
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
  if (argv[0] === 'tests' && argv[1] === 'fail-first') return await cmdFailFirst(argv.slice(2));
  if (argv[0] === 'tests') return cmdTests(argv.slice(1));
  if (argv[0] === 'diff-class') return cmdDiffClass(argv.slice(1));
  if (argv[0] === 'doctor') return printed(doctorCommand(argv.slice(1), { env: process.env, cwd: process.cwd() }));
  if (argv[0] === 'audit' && argv[1] === 'sample') return cmdAuditSub(argv.slice(2));
  if (argv[0] === 'audit' && argv[1] === 'handoffs') return cmdAuditSub(argv.slice(2), handoffsCommand);
  if (argv[0] === 'audit' && argv[1] === 'touched') return cmdAuditSub(argv.slice(2), touchedCommand);
  if (argv[0] === 'order') {
    // Loaded here and only here (0.30.0): the order command holds the office readers, which no hook process loads.
    const { orderCommand } = await import('./order/command.js');
    const d = deferOptions();
    return printed(orderCommand(argv.slice(1), { env: d.env, interactive: d.interactive, readLine: d.readLine, prompt: d.prompt, cwd: process.cwd() }));
  }
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
    case 'guard':
      return cmdGuard(args);
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
      return cmdPurge(args, deferOptions());
    case 'guidance':
      return cmdGuidance(args);
    case 'packs':
      return cmdPacks(args);
    case 'eval':
      return await cmdEval(args);
    case 'pending':
      return printed(pendingCommand(argv.slice(1), deferOptions()));
    case 'approve':
      return printed(approveCommand(argv.slice(1), deferOptions()));
    case 'refuse':
      return printed(refuseCommand(argv.slice(1), deferOptions()));
    case 'stop':
      return printed(stopCommand(argv.slice(1), { env: process.env, terminal: process.stdin.isTTY === true }));
    case 'sessions':
      return printed(sessionsCommand(argv.slice(1), { env: process.env }));
    case 'budget':
      return printed(budgetCommand(argv.slice(1), { env: process.env }));
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
