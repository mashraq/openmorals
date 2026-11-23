#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runClaudeCodeHook, toHookOutput } from './adapters/claude-code.js';
import { appendAudit, makeAuditRecord, readAudit } from './audit.js';
import { loadBylaws, resolveBylaws } from './bylaws.js';
import { decide } from './engine.js';
import { initProject } from './init.js';
import { auditLogPath, configDir } from './paths.js';
import type { BylawsLoad, ShellKind } from './types.js';
import { EMPTY_STATE } from './types.js';
import { VERSION } from './version.js';

const HELP = `openmorals ${VERSION}: ask before an AI agent deletes, force-pushes, leaks a secret or overspends.

Usage:
  openmorals check [--shell posix|powershell|cmd] [--bylaws FILE] [--json] "<command>"
      Judge a command line and print allow, ask or deny with the rule and reason.
      Exit code: 0 allow, 1 ask, 2 deny, 64 usage error.
  openmorals hook claude-code
      Claude Code PreToolUse hook: reads the hook JSON on stdin, prints the decision JSON.
  openmorals init [DIR] [--hook-command "<cmd>"] [--no-hook]
      Write a commented openmorals.yaml and add the hook to DIR/.claude/settings.json
      (existing settings are merged, never replaced; the old file is backed up first).
  openmorals validate [FILE]
      Check a bylaws file (default: the one that applies to the current directory).
  openmorals audit [--tail N] [--json] [--file FILE]
      Print the decision log.
  openmorals --version | --help

Config directory: ${'$'}OPENMORALS_HOME, else %APPDATA%\\openmorals on Windows,
else ${'$'}XDG_CONFIG_HOME/openmorals or ~/.config/openmorals.
`;

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(['--shell', '--bylaws', '--hook-command', '--tail', '--file']);

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
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
  return { positional, flags };
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

function bylawsFor(args: Args): BylawsLoad {
  const file = flagStr(args, '--bylaws');
  return file !== null ? loadBylaws(resolve(file)) : resolveBylaws(process.cwd());
}

function cmdCheck(args: Args): number {
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
  const verdict = decide({ kind: 'exec', command, shell, tool: shell === 'powershell' ? 'PowerShell' : 'Bash' }, bylaws, EMPTY_STATE);
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
  if (args.flags.has('--json')) out(JSON.stringify({ ...verdict, bylaws: bylaws.source }));
  else {
    out(`${verdict.decision.toUpperCase().padEnd(5)} ${verdict.rule}`);
    out(`      ${verdict.reason}`);
    out(`      bylaws: ${bylaws.source}${bylaws.ok ? '' : ' (INVALID)'}`);
  }
  return verdict.decision === 'allow' ? 0 : verdict.decision === 'ask' ? 1 : 2;
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function cmdHook(args: Args): number {
  const target = args.positional[1];
  if (target !== 'claude-code') {
    err('usage: openmorals hook claude-code   (only Claude Code is supported in this version)');
    const r = toHookOutput({ decision: 'ask', rule: 'hook.unknown-target', reason: `unknown hook target ${target ?? '(none)'}` });
    if (r !== null) out(r);
    return 0;
  }
  const run = runClaudeCodeHook(readStdin());
  if (run.stdout !== '') out(run.stdout);
  return run.exitCode;
}

function cmdInit(args: Args): number {
  const dir = resolve(args.positional[1] ?? '.');
  const res = initProject(dir, { hookCommand: flagStr(args, '--hook-command') ?? undefined, installHook: !args.flags.has('--no-hook') });
  if (!res.ok) {
    err(`openmorals init: ${res.error}`);
    return 1;
  }
  out(res.bylawsWritten ? `wrote ${res.bylawsPath}` : `kept existing ${res.bylawsPath}`);
  if (res.settingsPath !== null) {
    if (res.settingsChanged) {
      out(`added the PreToolUse hook to ${res.settingsPath}`);
      if (res.backupPath !== null) out(`backed up the previous settings to ${res.backupPath}`);
    } else out(`the hook is already in ${res.settingsPath}; nothing changed`);
  }
  return 0;
}

function cmdValidate(args: Args): number {
  const file = args.positional[1];
  const load = file !== undefined ? loadBylaws(resolve(file)) : resolveBylaws(process.cwd());
  if (load.ok) {
    out(`ok: ${load.source}`);
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

function main(argv: string[]): number {
  const args = parseArgs(argv);
  const cmd = args.positional[0];
  if (args.flags.has('--version') && cmd === undefined) {
    out(VERSION);
    return 0;
  }
  switch (cmd) {
    case 'check':
      return cmdCheck(args);
    case 'hook':
      return cmdHook(args);
    case 'init':
      return cmdInit(args);
    case 'validate':
      return cmdValidate(args);
    case 'audit':
      return cmdAudit(args);
    case undefined:
    case 'help':
      out(HELP);
      return cmd === undefined && !args.flags.has('--help') ? 64 : 0;
    default:
      err(`unknown command ${cmd}\n`);
      err(HELP);
      return 64;
  }
}

const isHook = process.argv[2] === 'hook';
try {
  process.exitCode = main(process.argv.slice(2));
} catch (e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  if (isHook) {
    const r = toHookOutput({ decision: 'ask', rule: 'engine.error', reason: `openmorals crashed (${message}) and fails closed` });
    if (r !== null) out(r);
    process.exitCode = 0;
  } else {
    err(`openmorals: ${message}`);
    process.exitCode = 70;
  }
}
