import * as path from 'node:path';
import type { Action, Decision } from '../types.js';
import { parseCommand, type ParsedCommand, type SimpleCommand } from '../shell.js';
import { compileGlob } from '../diffclass/glob.js';
import { sensitiveLabel } from '../guards/secrets.js';
import { reachesNetwork } from '../network.js';

export type TaintSource = 'web-fetch' | 'web-search' | 'mcp-output' | 'network-output' | 'outside-file' | 'user-marked' | 'inbound-content';

export interface TaintMark {
  source: TaintSource | 'private';
  detail: string;
}

export interface TaintState {
  readonly untrusted: readonly TaintMark[];
  readonly privateData: readonly TaintMark[];
  readonly untrustedCount: number;
  readonly privateCount: number;
  /** How many times the inbound scanner found hidden instructions (a strong signal) in this session. Absent means 0. */
  readonly injectedCount?: number;
}

export const CLEAN_TAINT: TaintState = Object.freeze({
  untrusted: Object.freeze([]),
  privateData: Object.freeze([]),
  untrustedCount: 0,
  privateCount: 0,
});

export type TaintEvent =
  | { type: 'action'; action: Action }
  | { type: 'untrusted'; source: TaintSource; detail: string }
  | { type: 'private'; detail: string }
  | { type: 'injected'; detail: string }
  | { type: 'reset' };

export interface TaintContext {
  projectRoot: string;
  platform?: 'posix' | 'win32';
  trustedHosts?: readonly string[];
  trustedPaths?: readonly string[];
  /** Globs of files that hold private data (`guards.taint.private_paths`, 0.16.0), relative to the project root. */
  privatePaths?: readonly string[];
}

export interface Legs {
  untrusted: boolean;
  privateData: boolean;
  network: boolean;
}

export interface TaintVerdict {
  decision: Extract<Decision, 'allow' | 'ask'>;
  rule: string;
  reason: string;
  legs: Legs;
}

const KEEP = 8;
const MAX_DETAIL = 120;

function clip(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_DETAIL ? flat.slice(0, MAX_DETAIL - 3) + '...' : flat;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function hostTrusted(host: string | null, trusted: readonly string[] | undefined): boolean {
  if (host === null || trusted === undefined) return false;
  return trusted.some((t) => {
    const x = t.toLowerCase();
    return x.startsWith('.') ? host.endsWith(x) && host.length > x.length : host === x;
  });
}

function pathApi(ctx: TaintContext): path.PlatformPath {
  return ctx.platform === 'win32' ? path.win32 : path.posix;
}

function within(parent: string, child: string, ctx: TaintContext): boolean {
  const p = pathApi(ctx);
  const fold = ctx.platform === 'win32';
  const a = p.resolve(fold ? parent.toLowerCase() : parent);
  const b = p.resolve(a, fold ? child.toLowerCase() : child);
  const rel = p.relative(a, b);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + p.sep) && !p.isAbsolute(rel));
}

function isHomeRelative(p: string): boolean {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\');
}

export function isOutsideProject(file: string, ctx: TaintContext): boolean {
  const trusted = ctx.trustedPaths ?? [];
  if (isHomeRelative(file)) {
    const norm = file.replace(/\\/g, '/');
    return !trusted.some((t) => isHomeRelative(t) && within(t.replace(/\\/g, '/').replace(/^~/, '/~'), norm.replace(/^~/, '/~'), { ...ctx, platform: 'posix' }));
  }
  const abs = pathApi(ctx).resolve(ctx.projectRoot, file);
  if (within(ctx.projectRoot, abs, ctx)) return false;
  return !trusted.some((t) => !isHomeRelative(t) && within(t, abs, ctx));
}

const GLOBS = new Map<string, (p: string) => boolean>();

function glob(g: string): (p: string) => boolean {
  let f = GLOBS.get(g);
  if (f === undefined) {
    if (GLOBS.size >= 512) GLOBS.clear();
    f = compileGlob(g);
    GLOBS.set(g, f);
  }
  return f;
}

/**
 * The `private_paths` glob a file falls under, or null. Inside the project the path relative to its root is matched; a
 * file outside it (or under ~) is matched only by globs with no folder in them (a name at any depth, such as `*.hl7`).
 */
export function privatePathGlob(file: string, ctx: TaintContext): string | null {
  const globs = ctx.privatePaths ?? [];
  if (globs.length === 0) return null;
  const clean = file.replace(/^["']|["']$/g, '');
  if (clean === '') return null;
  let rel: string | null = null;
  if (!isHomeRelative(clean)) {
    const p = pathApi(ctx);
    const abs = p.resolve(ctx.projectRoot, clean);
    if (within(ctx.projectRoot, abs, ctx)) rel = p.relative(p.resolve(ctx.projectRoot), abs).replace(/\\/g, '/');
  }
  const flat = clean.replace(/\\/g, '/').replace(/^~\/?/, '').replace(/^[a-z]:\//i, '').replace(/^\/+/, '');
  for (const g of globs) {
    const anchored = g.replace(/\/+$/, '').includes('/');
    if (rel !== null && rel !== '' && glob(g)(rel)) return g;
    if (rel === null && !anchored && flat !== '' && glob(g)(flat)) return g;
  }
  return null;
}

function privateLabel(file: string, ctx: TaintContext): string | null {
  const l = sensitiveLabel(file);
  if (l !== null) return l;
  const g = privatePathGlob(file, ctx);
  return g !== null ? `a declared private path (${g})` : null;
}

/**
 * Whether the action reaches the network: a fetch; a command one of whose parts talks to the network (`reachesNetwork`);
 * an MCP tool, web search or web fetch. `parsed` is the command already parsed (the engine's); a command that could not
 * be parsed is taken to reach it (fail closed).
 */
export function actionReachesNetwork(action: Action, parsed?: ParsedCommand | null): boolean {
  switch (action.kind) {
    case 'fetch':
      return true;
    case 'read':
    case 'write':
      return false;
    case 'exec': {
      let p = parsed ?? null;
      if (p === null) {
        try {
          p = parseCommand(action.command, action.shell);
        } catch {
          return true;
        }
      }
      return p.commands.some(reachesNetwork);
    }
    case 'other':
      return /^mcp__/i.test(action.tool) || /^web.?search$/i.test(action.tool) || /^web.?fetch$/i.test(action.tool);
  }
}

const SECRET_VAR = /\$\{?[A-Za-z_][A-Za-z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL)[A-Za-z0-9_]*\}?|\$env:[A-Za-z_][A-Za-z0-9_]*(SECRET|TOKEN|PASSWORD|API_?KEY|ACCESS_?KEY)/i;

function commandPrivate(c: SimpleCommand, ctx: TaintContext): string | null {
  const n = c.name;
  const a0 = c.args[0];
  const a1 = c.args[1];
  if ((n === 'env' || n === 'printenv' || n === 'export' || (n === 'set' && c.shell === 'posix')) && c.args.filter((a) => !a.startsWith('-')).length === 0) return 'the environment';
  if ((n === 'get-childitem' || n === 'gci' || n === 'dir' || n === 'ls') && c.args.some((a) => /^env:/i.test(a))) return 'the environment';
  if (n === 'gh' && a0 === 'auth' && a1 === 'token') return 'a GitHub token';
  if (n === 'security' && a0 !== undefined && /^find-(generic|internet)-password$/.test(a0)) return 'the keychain';
  if (n === 'op' && (a0 === 'read' || (a0 === 'item' && a1 === 'get'))) return 'a password manager';
  if (n === 'pass' && (a0 === undefined || a0 === 'show')) return 'a password store';
  if (n === 'aws' && a0 === 'configure' && (a1 === 'get' || a1 === 'export-credentials')) return 'AWS credentials';
  if (n === 'gcloud' && c.args.includes('print-access-token')) return 'a Google Cloud token';
  if (n === 'az' && c.args.includes('get-access-token')) return 'an Azure token';
  if (n === 'kubectl' && a0 === 'get' && (a1 === 'secret' || a1 === 'secrets')) return 'Kubernetes secrets';
  if (n === 'vault' && (a0 === 'read' || a0 === 'kv')) return 'a Vault secret';
  if (n === 'git' && a0 === 'credential') return 'git credentials';
  for (const a of c.args) {
    const l = privateLabel(a, ctx);
    if (l !== null) return l;
    for (const part of a.split(/[=@,]/)) {
      if (part === '' || part === a) continue;
      const pl = privateLabel(part, ctx);
      if (pl !== null) return pl;
    }
  }
  for (const r of c.redirects) {
    if (r.op.includes('<')) {
      const l = privateLabel(r.target, ctx);
      if (l !== null) return l;
    }
  }
  return null;
}

export interface ActionTraits {
  untrusted: TaintMark | null;
  privateData: TaintMark | null;
  network: boolean;
}

export function traitsOf(action: Action, ctx: TaintContext): ActionTraits {
  switch (action.kind) {
    case 'fetch': {
      const host = hostOf(action.url);
      const untrusted = hostTrusted(host, ctx.trustedHosts) ? null : { source: 'web-fetch' as const, detail: clip(host ?? 'unparseable URL') };
      return { untrusted, privateData: null, network: true };
    }
    case 'read': {
      const label = privateLabel(action.path, ctx);
      const outside = isOutsideProject(action.path, ctx);
      return {
        untrusted: outside ? { source: 'outside-file', detail: clip(action.path) } : null,
        privateData: label !== null ? { source: 'private', detail: clip(`${label}: ${action.path}`) } : null,
        network: false,
      };
    }
    case 'write':
      return { untrusted: null, privateData: null, network: false };
    case 'exec': {
      const parsed = parseCommand(action.command, action.shell);
      const network = actionReachesNetwork(action, parsed);
      let priv: string | null = null;
      for (const c of parsed.commands) {
        priv = commandPrivate(c, ctx);
        if (priv !== null) break;
      }
      if (priv === null && SECRET_VAR.test(action.command)) priv = 'a secret environment variable';
      return {
        untrusted: network ? { source: 'network-output', detail: clip(parsed.commands.find(reachesNetwork)?.name ?? 'network command') } : null,
        privateData: priv !== null ? { source: 'private', detail: clip(priv) } : null,
        network,
      };
    }
    case 'other': {
      const t = action.tool;
      if (/^mcp__/i.test(t)) return { untrusted: { source: 'mcp-output', detail: clip(t) }, privateData: null, network: true };
      if (/^web.?search$/i.test(t)) return { untrusted: { source: 'web-search', detail: clip(t) }, privateData: null, network: true };
      if (/^web.?fetch$/i.test(t)) return { untrusted: { source: 'web-fetch', detail: clip(t) }, privateData: null, network: true };
      return { untrusted: null, privateData: null, network: false };
    }
  }
}

function pushMark(list: readonly TaintMark[], m: TaintMark): TaintMark[] {
  const next = list.filter((x) => !(x.source === m.source && x.detail === m.detail));
  next.push(m);
  return next.slice(-KEEP);
}

export function reduceTaint(state: TaintState, event: TaintEvent, ctx: TaintContext): TaintState {
  switch (event.type) {
    case 'reset':
      return CLEAN_TAINT;
    case 'untrusted': {
      const m: TaintMark = { source: event.source, detail: clip(event.detail) };
      return { ...state, untrusted: pushMark(state.untrusted, m), untrustedCount: state.untrustedCount + 1 };
    }
    case 'injected': {
      const m: TaintMark = { source: 'inbound-content', detail: clip(event.detail) };
      return { ...state, untrusted: pushMark(state.untrusted, m), untrustedCount: state.untrustedCount + 1, injectedCount: (state.injectedCount ?? 0) + 1 };
    }
    case 'private': {
      const m: TaintMark = { source: 'private', detail: clip(event.detail) };
      return { ...state, privateData: pushMark(state.privateData, m), privateCount: state.privateCount + 1 };
    }
    case 'action': {
      const t = traitsOf(event.action, ctx);
      let next = state;
      if (t.untrusted !== null) next = { ...next, untrusted: pushMark(next.untrusted, t.untrusted), untrustedCount: next.untrustedCount + 1 };
      if (t.privateData !== null) next = { ...next, privateData: pushMark(next.privateData, t.privateData), privateCount: next.privateCount + 1 };
      return next;
    }
  }
}

/**
 * Merges the taint a writer saves with what another writer saved meanwhile (0.32.1: sub-agents of one session run
 * hooks at the same time). `base` is what this writer loaded; `disk` is the file as it stands now. Marks and counts
 * the other writer added since `base` are kept, so taint never drops because two calls overlapped.
 */
export function mergeTaint(base: TaintState, disk: TaintState, ours: TaintState): TaintState {
  const same = (a: TaintMark, b: TaintMark): boolean => a.source === b.source && a.detail === b.detail;
  const marks = (b: readonly TaintMark[], d: readonly TaintMark[], o: readonly TaintMark[]): TaintMark[] => {
    let out: TaintMark[] = [...o];
    for (const m of d) if (!b.some((x) => same(x, m))) out = pushMark(out, m);
    return out.slice(-KEEP);
  };
  const count = (b: number, d: number, o: number): number => Math.max(0, d + (o - b));
  const injected = count(base.injectedCount ?? 0, disk.injectedCount ?? 0, ours.injectedCount ?? 0);
  return {
    untrusted: marks(base.untrusted, disk.untrusted, ours.untrusted),
    privateData: marks(base.privateData, disk.privateData, ours.privateData),
    untrustedCount: count(base.untrustedCount, disk.untrustedCount, ours.untrustedCount),
    privateCount: count(base.privateCount, disk.privateCount, ours.privateCount),
    ...(injected > 0 ? { injectedCount: injected } : {}),
  };
}

export function replayTaint(events: readonly TaintEvent[], ctx: TaintContext, start: TaintState = CLEAN_TAINT): TaintState {
  return events.reduce((s, e) => reduceTaint(s, e, ctx), start);
}

export function judge(action: Action, state: TaintState, ctx: TaintContext): TaintVerdict {
  const t = traitsOf(action, ctx);
  const legs: Legs = {
    untrusted: state.untrustedCount > 0,
    privateData: state.privateCount > 0 || t.privateData !== null,
    network: t.network,
  };
  if ((state.injectedCount ?? 0) > 0 && (legs.network || t.privateData !== null)) {
    const src = [...state.untrusted].reverse().find((m) => m.source === 'inbound-content');
    const what = t.network && t.privateData !== null ? 'touches private data and reaches the network' : t.network ? 'reaches the network' : 'touches private data';
    return {
      decision: 'ask',
      rule: 'taint.injected-content',
      reason: `hidden instructions were found in content that entered this session (${src?.detail ?? 'inbound content'}), and this step ${what}; confirm it is what you asked for, not something the content asked for`,
      legs,
    };
  }
  if (legs.untrusted && legs.privateData && legs.network) {
    const src = state.untrusted[state.untrusted.length - 1];
    const priv = t.privateData ?? state.privateData[state.privateData.length - 1];
    const where = t.privateData !== null ? 'this step touches' : 'this session has touched';
    return {
      decision: 'ask',
      rule: 'taint.rule-of-two',
      reason: `untrusted content entered this session (${src?.source ?? 'untrusted'}: ${src?.detail ?? '?'}), ${where} private data (${priv?.detail ?? '?'}), and this step reaches the network; confirm it is what you asked for`,
      legs,
    };
  }
  return { decision: 'allow', rule: 'none', reason: 'at most two of untrusted input, private data and network in play', legs };
}
