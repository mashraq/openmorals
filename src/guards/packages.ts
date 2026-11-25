import { dirname, join, resolve } from 'node:path';
import type { Finding, Guard, GuardContext, Where } from '../guard.js';
import { makeWhere, quoteForReason } from '../guard.js';
import type { SimpleCommand } from '../shell.js';
import { cmdName } from '../shell.js';
import type { Bylaws, Decision } from '../types.js';

/**
 * The packages guard (0.32.0): asks before a command installs a package by name that the project's own manifest and
 * lockfile do not list. An agent can name a package that does not exist, or the near-miss of one that does, and someone
 * may have registered that name with code that runs on install. A name the project already lists, a bare install from
 * the manifest, and a project with no manifest of that kind are not judged.
 */

export type Ecosystem = 'npm' | 'pypi' | 'cargo' | 'go' | 'rubygems' | 'composer';

export interface Install {
  ecosystem: Ecosystem;
  /** The command as it names itself in a reason (npm install, pip install, ...). */
  verb: string;
  names: string[];
  global: boolean;
}

/** The files each ecosystem lists its packages in, looked for in the working folder and up to six folders above it. */
export const PACKAGE_LISTS: Readonly<Record<Ecosystem, readonly string[]>> = {
  npm: ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock'],
  pypi: ['requirements.txt', 'requirements-dev.txt', 'requirements_dev.txt', 'dev-requirements.txt', 'constraints.txt', 'pyproject.toml', 'poetry.lock', 'uv.lock', 'Pipfile', 'Pipfile.lock', 'setup.cfg', 'setup.py', 'pdm.lock'],
  cargo: ['Cargo.toml', 'Cargo.lock'],
  go: ['go.mod', 'go.sum'],
  rubygems: ['Gemfile', 'Gemfile.lock', 'gems.rb'],
  composer: ['composer.json', 'composer.lock'],
};

const MAX_LIST_BYTES = 8 * 1024 * 1024;
const MAX_UP = 6;

export function defaultPackagesBylaws(): { decision: Decision } {
  return { decision: 'ask' };
}

const words = (c: SimpleCommand): string[] => c.args.filter((a) => !a.startsWith('-'));
const has = (x: SimpleCommand | readonly string[], ...flags: string[]): boolean => (Array.isArray(x) ? (x as readonly string[]) : (x as SimpleCommand).args).some((a) => flags.includes(a));

/** A word that installs from a path, a URL or a VCS rather than by a registry name: not judged here. */
function notAName(w: string): boolean {
  return /^(\.{0,2}\/|~|[a-z]:\\|file:|link:|git\+|git:|github:|gitlab:|bitbucket:|https?:|ssh:|workspace:|npm:)/i.test(w) || w.endsWith('.tgz') || w.endsWith('.tar.gz') || w.endsWith('.whl') || w.endsWith('.zip');
}

function npmName(w: string): string {
  const at = w.startsWith('@') ? w.indexOf('@', 1) : w.indexOf('@');
  return (at > 0 ? w.slice(0, at) : w).toLowerCase();
}

/** PEP 503: case and runs of - _ . are one name. Extras and version specifiers are dropped. */
export function pypiName(w: string): string {
  const base = w.split(/[[<>=!~;@ ]/)[0] ?? w;
  return base.toLowerCase().replace(/[-_.]+/g, '-');
}

/** What one simple command installs by name, or null when it installs nothing by name. */
export function installOf(c: SimpleCommand): Install | null {
  const name = cmdName(c.name);
  const w = words(c);
  const sub = w[0];
  const rest = w.slice(1);
  if (name === 'npm' && (sub === 'install' || sub === 'i' || sub === 'add' || sub === 'isntall' || sub === 'in')) {
    const names = rest.filter((x) => !notAName(x)).map(npmName);
    return names.length === 0 ? null : { ecosystem: 'npm', verb: 'npm install', names, global: has(c, '-g', '--global', '--location=global') };
  }
  if ((name === 'pnpm' || name === 'yarn' || name === 'bun') && sub === 'add') {
    const names = rest.filter((x) => !notAName(x)).map(npmName);
    return names.length === 0 ? null : { ecosystem: 'npm', verb: `${name} add`, names, global: has(c, '-g', '--global') || w.includes('global') };
  }
  if (name === 'yarn' && sub === 'global' && rest[0] === 'add') {
    const names = rest.slice(1).filter((x) => !notAName(x)).map(npmName);
    return names.length === 0 ? null : { ecosystem: 'npm', verb: 'yarn global add', names, global: true };
  }
  let pipArgs: string[] | null = null;
  if (/^pip(3(\.\d+)?)?$/.test(name)) pipArgs = c.args;
  else if (/^python(3(\.\d+)?)?$/.test(name) || name === 'py') {
    const m = c.args.indexOf('-m');
    if (m !== -1 && /^pip(3)?$/.test(c.args[m + 1] ?? '')) pipArgs = c.args.slice(m + 2);
  } else if (name === 'uv' && c.args[0] === 'pip') pipArgs = c.args.slice(1);
  else if ((name === 'uv' || name === 'poetry' || name === 'pdm') && c.args[0] === 'add') pipArgs = ['install', ...c.args.slice(1)];
  if (pipArgs !== null) {
    if (pipArgs.find((a) => !a.startsWith('-')) !== 'install') return null;
    const names: string[] = [];
    let skip = false;
    let seenInstall = false;
    for (const a of pipArgs) {
      if (skip) {
        skip = false;
        continue;
      }
      if (['-r', '--requirement', '-c', '--constraint', '-e', '--editable', '-i', '--index-url', '--extra-index-url', '-f', '--find-links', '-t', '--target', '--prefix', '--root', '--python', '-p', '--group'].includes(a)) {
        skip = true;
        continue;
      }
      if (a.startsWith('-')) continue;
      if (!seenInstall) {
        seenInstall = true;
        continue;
      }
      if (!notAName(a)) names.push(pypiName(a));
    }
    return names.length === 0 ? null : { ecosystem: 'pypi', verb: `${name === 'uv' || name === 'poetry' || name === 'pdm' ? name : 'pip'} ${name === 'poetry' || name === 'pdm' || (name === 'uv' && c.args[0] === 'add') ? 'add' : 'install'}`, names, global: has(pipArgs, '--user') };
  }
  if (name === 'cargo' && sub === 'add') {
    const names = rest.filter((x) => !notAName(x)).map((x) => (x.split('@')[0] ?? x).toLowerCase().replace(/_/g, '-'));
    return names.length === 0 ? null : { ecosystem: 'cargo', verb: 'cargo add', names, global: false };
  }
  if (name === 'go' && sub === 'get') {
    const names = rest.filter((x) => !notAName(x) && x.includes('.')).map((x) => x.split('@')[0] ?? x);
    return names.length === 0 ? null : { ecosystem: 'go', verb: 'go get', names, global: false };
  }
  if (name === 'gem' && sub === 'install') {
    const names = rest.filter((x) => !notAName(x));
    return names.length === 0 ? null : { ecosystem: 'rubygems', verb: 'gem install', names, global: true };
  }
  if (name === 'bundle' && sub === 'add') {
    const names = rest.filter((x) => !notAName(x));
    return names.length === 0 ? null : { ecosystem: 'rubygems', verb: 'bundle add', names, global: false };
  }
  if (name === 'composer' && sub === 'require') {
    const names = rest.filter((x) => !notAName(x)).map((x) => (x.split(':')[0] ?? x).toLowerCase());
    return names.length === 0 ? null : { ecosystem: 'composer', verb: 'composer require', names, global: w.includes('global') };
  }
  return null;
}

/** The text of every list file of one ecosystem in the working folder and the folders above it; null when there is none. */
export function listedText(eco: Ecosystem, where: Where): string | null {
  let dir = resolve(where.cwd);
  const parts: string[] = [];
  for (let i = 0; i <= MAX_UP; i++) {
    for (const f of PACKAGE_LISTS[eco]) {
      const p = where.readFile(join(dir, f), MAX_LIST_BYTES);
      if (p.kind === 'file' && p.text !== undefined) parts.push(p.text);
      else if (p.kind === 'file' || p.kind === 'error') parts.push('\u0000unreadable');
    }
    if (parts.length > 0) break;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return parts.length === 0 ? null : parts.join('\n');
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Whether a list file's text names the package. */
export function isListed(eco: Ecosystem, name: string, text: string): boolean {
  if (eco === 'pypi') {
    const norm = text.toLowerCase().replace(/[-_.]+/g, '-');
    return new RegExp(`(^|[^a-z0-9-])${esc(name)}($|[^a-z0-9-])`, 'm').test(norm);
  }
  const t = eco === 'go' ? text : text.toLowerCase();
  const n = eco === 'go' ? name : name.toLowerCase();
  return new RegExp(`(^|[^A-Za-z0-9_.@/-])${esc(n)}($|[^A-Za-z0-9_.-])`, 'm').test(t) || t.includes(`/${n}/`) || t.includes(`"${n}"`) || t.includes(`node_modules/${n}"`);
}

const LIST_NAMES: Readonly<Record<Ecosystem, string>> = { npm: 'package.json or lockfile', pypi: 'requirements, pyproject or lockfile', cargo: 'Cargo.toml or Cargo.lock', go: 'go.mod or go.sum', rubygems: 'Gemfile or Gemfile.lock', composer: 'composer.json or composer.lock' };

export const packagesGuard: Guard = {
  id: 'packages',
  isHard: () => false,
  evaluate(ctx: GuardContext): Finding[] {
    const cfg = ctx.bylaws.guards.packages ?? defaultPackagesBylaws();
    if (cfg.decision === 'allow' || ctx.action.kind !== 'exec' || ctx.parsed === null) return [];
    const where = ctx.where ?? makeWhere();
    const out: Finding[] = [];
    const texts = new Map<Ecosystem, string | null>();
    for (const c of ctx.parsed.commands) {
      const ins = installOf(c);
      if (ins === null) continue;
      if (!texts.has(ins.ecosystem)) texts.set(ins.ecosystem, listedText(ins.ecosystem, where));
      const text = texts.get(ins.ecosystem) ?? null;
      if (text === null) continue;
      const unlisted = [...new Set(ins.names)].filter((n) => !isListed(ins.ecosystem, n, text));
      if (unlisted.length === 0) continue;
      const shown = unlisted.slice(0, 3).map((n) => quoteForReason(n, 60)).join(', ') + (unlisted.length > 3 ? `, and ${unlisted.length - 3} more` : '');
      out.push({
        decision: cfg.decision,
        rule: 'packages.unlisted',
        reason: `${ins.verb} names ${shown}, which this project's ${LIST_NAMES[ins.ecosystem]} do${unlisted.length === 1 ? 'es' : ''} not list${ins.global ? ' (a global install)' : ''}; check each name is the package you mean before it installs: an agent can invent a name, and someone may have published code under it`,
      });
    }
    return out;
  },
};

export function packagesDecision(b: Bylaws): Decision {
  return (b.guards.packages ?? defaultPackagesBylaws()).decision;
}
