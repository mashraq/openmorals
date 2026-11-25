import { configDir } from '../paths.js';
import type { ItemView, QueueRead } from './store.js';
import { CODE_RE, ID_RE, codeMatches, deferDir, readQueue, writeMarker } from './store.js';

export const PENDING_USAGE = `  openmorals pending [--all] [--json]
      List the actions held for your approval (deferred asks): id, what and why,
      the session and folder, and when each lapses. --all also lists used,
      refused and lapsed ones. Nothing is run or changed.`;

export const APPROVE_USAGE = `  openmorals approve <code>      (the code shown when the action was held)
  openmorals approve <id>        (in a terminal: shows the action and asks you)
      Let one held action run once, unchanged, in its session. The agent must
      ask again; a changed file or command, another session, an expired or used
      approval all fall back to the normal decision. An agent running this is
      asked or refused by the hook. Exit 0 when approved, 1 when not.`;

export const REFUSE_USAGE = `  openmorals refuse <id>
      Say no to a held action; it will never run from that request. Exit 0 when
      refused, 1 when there is no such waiting or approved action.`;

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface DeferCommandOptions {
  env: NodeJS.ProcessEnv;
  now?: Date;
  /** True when both standard input and output are a terminal. */
  interactive: boolean;
  /** Reads one line from the terminal, or null when none can be read. */
  readLine: () => string | null;
  /** Writes the question asked before a terminal approval. */
  prompt: (text: string) => void;
}

function ago(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`;
}

function describe(v: ItemView, now: Date): string {
  const it = v.item;
  const left = Date.parse(it.expires) - now.getTime();
  const when = v.state === 'waiting' || v.state === 'approved' ? `queued ${ago(now.getTime() - Date.parse(it.queued))} ago, lapses in ${ago(left)}` : `queued ${it.queued}`;
  const state = v.state === 'approved' ? `approved${v.approvedVia !== undefined ? ` (${v.approvedVia})` : ''}, not yet used` : v.state;
  return `${it.id}  ${state}  ${when}\n    ${it.tool}: ${it.shown}\n    why: [${it.rule}] ${it.reason}\n    session ${it.session}, folder ${it.cwd}`;
}

function unreadableLines(q: QueueRead): string[] {
  return q.unreadable.map((u) => `unreadable: ${u.file}: ${u.why}; it grants nothing`);
}

function parseFlags(rest: readonly string[], allowed: readonly string[]): { flags: Set<string>; positional: string[]; problem: string | null } {
  const flags = new Set<string>();
  const positional: string[] = [];
  for (const a of rest) {
    if (a.startsWith('-')) {
      if (!allowed.includes(a)) return { flags, positional, problem: `unknown option ${a}` };
      flags.add(a);
    } else positional.push(a);
  }
  return { flags, positional, problem: null };
}

export function pendingCommand(rest: readonly string[], o: DeferCommandOptions): CommandResult {
  const p = parseFlags(rest, ['--all', '--json']);
  if (p.problem !== null || p.positional.length > 0) return { stdout: '', stderr: `openmorals pending: ${p.problem ?? `unexpected argument ${JSON.stringify(p.positional[0])}`}; nothing was done\n`, exitCode: 64 };
  const now = o.now ?? new Date();
  const q = readQueue(configDir(o.env), now);
  if (q.error !== undefined) return { stdout: '', stderr: `openmorals pending: ${q.error}; nothing in it is used\n`, exitCode: 1 };
  const live = q.items.filter((v) => v.state === 'waiting' || v.state === 'approved');
  const shown = p.flags.has('--all') ? q.items : live;
  if (p.flags.has('--json')) {
    const items = shown.map((v) => ({ id: v.item.id, state: v.state, ...(v.approvedVia !== undefined ? { approved_via: v.approvedVia } : {}), tool: v.item.tool, action: v.item.shown, rule: v.item.rule, reason: v.item.reason, session: v.item.session, cwd: v.item.cwd, queued: v.item.queued, expires: v.item.expires }));
    return { stdout: `${JSON.stringify({ folder: deferDir(configDir(o.env)), items, unreadable: q.unreadable })}\n`, stderr: '', exitCode: 0 };
  }
  const lines: string[] = [];
  const waiting = live.filter((v) => v.state === 'waiting').length;
  lines.push(`openmorals: ${waiting} action${waiting === 1 ? '' : 's'} held for your approval, ${live.length - waiting} approved and not yet used; nothing held has run`);
  for (const v of shown) lines.push(describe(v, now));
  const other = q.items.length - live.length;
  if (!p.flags.has('--all') && other > 0) lines.push(`(${other} used, refused or lapsed; --all lists them)`);
  lines.push(...unreadableLines(q));
  if (waiting > 0) lines.push('approve one: openmorals approve <code> (the code shown when it was held), or here in a terminal: openmorals approve <id>; say no: openmorals refuse <id>');
  return { stdout: `${lines.join('\n')}\n`, stderr: '', exitCode: 0 };
}

export function approveCommand(rest: readonly string[], o: DeferCommandOptions): CommandResult {
  const p = parseFlags(rest, []);
  const arg = (p.positional[0] ?? '').toUpperCase();
  if (p.problem !== null || p.positional.length !== 1 || (!CODE_RE.test(arg) && !ID_RE.test(arg))) {
    return { stdout: '', stderr: `openmorals approve: ${p.problem ?? 'give one code (D-XXXX-XXXXXX) or one id (D-XXXX)'}; nothing was approved\n`, exitCode: 64 };
  }
  const now = o.now ?? new Date();
  const dir = configDir(o.env);
  const q = readQueue(dir, now);
  if (q.error !== undefined) return { stdout: '', stderr: `openmorals approve: ${q.error}; nothing was approved\n`, exitCode: 1 };
  const id = arg.slice(0, 6);
  const view = q.items.find((v) => v.item.id === id);
  if (view === undefined) return { stdout: '', stderr: `openmorals approve: no held action ${id}${q.unreadable.some((u) => u.file.startsWith(id)) ? ' can be read' : ''}; nothing was approved\n`, exitCode: 1 };
  if (view.state !== 'waiting') return { stdout: '', stderr: `openmorals approve: ${id} is ${view.state}; nothing was approved\n`, exitCode: 1 };
  let via: string;
  if (CODE_RE.test(arg)) {
    if (!codeMatches(view.item, arg)) return { stdout: '', stderr: `openmorals approve: that code does not match ${id}; nothing was approved\n`, exitCode: 1 };
    via = 'code';
  } else {
    if (!o.interactive) return { stdout: '', stderr: `openmorals approve: without its code, ${id} can be approved only in a terminal, where you are asked; nothing was approved\n`, exitCode: 1 };
    o.prompt(`${describe(view, now)}\nLet this run once, unchanged, in its session? Type ${id} to approve: `);
    const line = o.readLine();
    if (line === null || line.trim().toUpperCase() !== id) return { stdout: '\n', stderr: 'openmorals approve: not confirmed; nothing was approved\n', exitCode: 1 };
    via = 'terminal';
  }
  try {
    if (!writeMarker(dir, id, 'approved', { approved: now.toISOString(), via })) return { stdout: '', stderr: `openmorals approve: ${id} was already approved\n`, exitCode: 1 };
  } catch (err: unknown) {
    return { stdout: '', stderr: `openmorals approve: ${id} could not be approved (${err instanceof Error ? err.message : String(err)})\n`, exitCode: 1 };
  }
  return { stdout: `openmorals: approved ${id} (${view.item.shown}) to run once, unchanged, in session ${view.item.session}; the agent must ask again, and it lapses ${view.item.expires}\n`, stderr: '', exitCode: 0 };
}

export function refuseCommand(rest: readonly string[], o: DeferCommandOptions): CommandResult {
  const p = parseFlags(rest, []);
  const id = (p.positional[0] ?? '').toUpperCase().slice(0, 6);
  if (p.problem !== null || p.positional.length !== 1 || !ID_RE.test(id)) return { stdout: '', stderr: `openmorals refuse: ${p.problem ?? 'give one id (D-XXXX)'}; nothing was refused\n`, exitCode: 64 };
  const now = o.now ?? new Date();
  const dir = configDir(o.env);
  const q = readQueue(dir, now);
  if (q.error !== undefined) return { stdout: '', stderr: `openmorals refuse: ${q.error}\n`, exitCode: 1 };
  const view = q.items.find((v) => v.item.id === id);
  if (view === undefined || (view.state !== 'waiting' && view.state !== 'approved')) return { stdout: '', stderr: `openmorals refuse: no waiting or approved action ${id}\n`, exitCode: 1 };
  try {
    writeMarker(dir, id, 'refused', { refused: now.toISOString() });
  } catch (err: unknown) {
    return { stdout: '', stderr: `openmorals refuse: ${id} could not be refused (${err instanceof Error ? err.message : String(err)})\n`, exitCode: 1 };
  }
  return { stdout: `openmorals: refused ${id}; it will not run from this request\n`, stderr: '', exitCode: 0 };
}
