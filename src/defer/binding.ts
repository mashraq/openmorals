import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parseCommand } from '../shell.js';
import type { Action } from '../types.js';
import type { Binding, FileState } from './store.js';
import { MAX_FILE_STATES, sha256 } from './store.js';

/** Words of a command looked at for files to bind; a longer command is not deferred (the normal verdict stands). */
export const MAX_BOUND_WORDS = 256;

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = canonical(o[k]);
    return out;
  }
  return v;
}

/** The salted SHA-256 of a call's exact arguments: the tool name and every argument, keys in a fixed order. */
export function actionHash(salt: string, tool: string, args: Record<string, unknown>): string {
  return sha256(`${salt}\0${JSON.stringify(canonical(['openmorals-defer-action-1', tool, args]))}`);
}

const GLOB = /[*?[\]{}]/;

function stripQuotes(s: string): string {
  return s.replace(/^["']|["']$/g, '');
}

/** The absolute path a word names, or null when it cannot be one (a URL, an option, a word with a line break). */
function pathOf(word: string, cwd: string, home: string): string | null {
  const w = stripQuotes(word);
  if (w === '' || w.length > 4096 || /[\r\n\0]/.test(w) || w.includes('://')) return null;
  if (w.startsWith('-') && w !== '-') return null;
  const t = /^~(?=$|\/)/.test(w) ? `${home}${w.slice(1)}` : w.replace(/^\$HOME(?=$|\/)|^\$\{HOME\}(?=$|\/)/, home);
  return isAbsolute(t) ? resolve(t) : resolve(cwd, t);
}

function stateOf(p: string): FileState | null {
  try {
    const st = statSync(p);
    return { path: p, kind: st.isFile() ? 'file' : st.isDirectory() ? 'folder' : 'other', size: st.size, mtime_ms: st.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * The paths a call names: a read's or write's path; every word and redirect target of a command that names something on
 * disk; for a word with a wildcard, the folder it is in (the files it matches are decided by the shell when it runs, so
 * the folder's modified time stands in for them). Null when there are more than MAX_BOUND_WORDS words or
 * MAX_FILE_STATES existing paths: such a call is not deferred.
 */
export function boundPaths(actions: readonly Action[], cwd: string, home: string = homedir()): string[] | null {
  const words: string[] = [];
  for (const a of actions) {
    if (a.kind === 'read' || a.kind === 'write') words.push(a.path);
    else if (a.kind === 'exec') {
      const parsed = parseCommand(a.command, a.shell);
      for (const c of parsed.commands) words.push(...c.args, ...c.redirects.map((r) => r.target));
    }
    if (words.length > MAX_BOUND_WORDS) return null;
  }
  const out = new Set<string>();
  for (const w of words) {
    const p = pathOf(w, cwd, home);
    if (p === null) continue;
    out.add(GLOB.test(stripQuotes(w)) ? dirname(p) : p);
  }
  return [...out].sort();
}

/** The state of each path that exists, sorted by path. Null when there are more than MAX_FILE_STATES. */
export function fileStates(paths: readonly string[]): FileState[] | null {
  const out: FileState[] = [];
  for (const p of paths) {
    const s = stateOf(p);
    if (s === null) continue;
    out.push(s);
    if (out.length > MAX_FILE_STATES) return null;
  }
  return out;
}

export interface BindingInput {
  session: string;
  cwd: string;
  tool: string;
  /** The call's arguments as the binding counts them (the adapter drops fields that do not change what runs). */
  args: Record<string, unknown>;
  actions: readonly Action[];
  home?: string;
}

/** The binding of a call, or why it cannot be bound (then it is not deferred and no grant can match it). */
export function bindCall(b: BindingInput, salt: string): Binding | string {
  const paths = boundPaths(b.actions, b.cwd, b.home);
  if (paths === null) return `the call names more than ${MAX_BOUND_WORDS} words`;
  const files = fileStates(paths);
  if (files === null) return `the call names more than ${MAX_FILE_STATES} files`;
  return { session: b.session, cwd: b.cwd, tool: b.tool, salt, action_sha256: actionHash(salt, b.tool, b.args), files };
}

/** True when two file lists are the same paths with the same kind, size and modified time. */
export function sameFiles(a: readonly FileState[], b: readonly FileState[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined) return false;
    if (x.path !== y.path || x.kind !== y.kind || x.size !== y.size || x.mtime_ms !== y.mtime_ms) return false;
  }
  return true;
}
