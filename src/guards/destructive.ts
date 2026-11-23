import type { Finding, Guard, GuardContext } from '../guard.js';
import { isOption, quoteForReason } from '../guard.js';
import type { SimpleCommand } from '../shell.js';

interface Hit {
  rule: string;
  reason: string;
  targets: string[];
  allowable: boolean;
}

const CATASTROPHIC = new Set(['/', '/*', '~', '~/', '~/*', '$home', '${home}', '$home/', '${home}/', '*', '.', './', '..', '../', 'c:\\', 'c:/', '%userprofile%', '$env:userprofile']);

function describeTargets(targets: string[]): string {
  if (targets.length === 0) return 'targets read from a pipe or computed at run time';
  const shown = targets.slice(0, 3).map((t) => quoteForReason(t, 60)).join(', ');
  const more = targets.length > 3 ? ` and ${targets.length - 3} more` : '';
  const broad = targets.some((t) => CATASTROPHIC.has(t.toLowerCase()));
  return `${shown}${more}${broad ? ' (a home, root, current or wildcard directory)' : ''}`;
}

function hasGlob(t: string): boolean {
  return /[*?[]/.test(t);
}

function psParam(a: string, full: string, min: number): boolean {
  const p = a.toLowerCase().split(':')[0] ?? '';
  return p.length >= min && full.startsWith(p);
}

function rmHit(c: SimpleCommand): Hit | null {
  let endOpts = false;
  const opts: string[] = [];
  const targets: string[] = [];
  for (const a of c.args) {
    if (!endOpts && a === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && isOption(a)) opts.push(a);
    else targets.push(a);
  }
  const recursive = opts.some((o) => /^-[a-zA-Z]*[rR]/.test(o) && !o.startsWith('--')) || opts.includes('--recursive');
  const force = opts.some((o) => /^-[a-zA-Z]*f/.test(o) && !o.startsWith('--')) || opts.includes('--force');
  const glob = targets.some(hasGlob);
  const noRoot = opts.includes('--no-preserve-root');
  const bulk = c.bulk || (c.pipeIn && targets.length === 0);
  if (!(recursive || force || glob || bulk || noRoot)) return null;
  const kinds = [recursive ? 'recursive' : '', force ? 'forced' : '', glob ? 'wildcard' : '', bulk ? `bulk (via ${c.via.filter((v) => v === 'xargs' || v === 'find' || v === 'parallel').join(', ') || 'a pipe'})` : '']
    .filter((k) => k !== '')
    .join(', ');
  return { rule: 'destructive.recursive-delete', reason: `${kinds} delete of ${describeTargets(targets)}`, targets, allowable: !bulk && !glob };
}

function removeItemHit(c: SimpleCommand): Hit | null {
  let recurse = false;
  let force = false;
  const targets: string[] = [];
  for (const a of c.args) {
    if (a.startsWith('-')) {
      if (psParam(a, '-recurse', 2)) recurse = true;
      else if (psParam(a, '-force', 3)) force = true;
      continue;
    }
    targets.push(a);
  }
  const glob = targets.some(hasGlob);
  const bulk = c.bulk || (c.pipeIn && targets.length === 0);
  if (!(recurse || force || glob || bulk)) return null;
  const kinds = [recurse ? 'recursive' : '', force ? 'forced' : '', glob ? 'wildcard' : '', bulk ? 'piped (bulk)' : ''].filter((k) => k !== '').join(', ');
  return { rule: 'destructive.recursive-delete', reason: `${kinds} Remove-Item of ${describeTargets(targets)}`, targets, allowable: !bulk && !glob };
}

function cmdDelHit(c: SimpleCommand): Hit | null {
  const flags = c.args.filter((a) => a.startsWith('/')).join('').toLowerCase();
  const targets = c.args.filter((a) => !/^\/[a-z]/i.test(a));
  const sub = /\/s/.test(flags);
  const quiet = /\/q/.test(flags);
  const force = /\/f/.test(flags);
  const glob = targets.some(hasGlob);
  if (!(sub || quiet || force || glob || c.bulk)) return null;
  const kinds = [sub ? 'recursive (/s)' : '', quiet ? 'unconfirmed (/q)' : '', force ? 'forced (/f)' : '', glob ? 'wildcard' : ''].filter((k) => k !== '').join(', ');
  return { rule: 'destructive.recursive-delete', reason: `${kinds || 'bulk'} ${c.name} of ${describeTargets(targets)}`, targets, allowable: !glob };
}

function rdHit(c: SimpleCommand): Hit | null {
  if (!c.args.some((a) => /^\/s/i.test(a) || /\/s/i.test(a.startsWith('/') ? a : ''))) return null;
  const targets = c.args.filter((a) => !a.startsWith('/') || a.length > 3);
  return { rule: 'destructive.recursive-delete', reason: `recursive ${c.name} /s of ${describeTargets(targets)}`, targets, allowable: true };
}

const GIT_GLOBAL_WITH_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

export function gitSub(args: string[]): { sub: string; rest: string[] } | null {
  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? '';
    if (GIT_GLOBAL_WITH_ARG.has(a)) {
      i += 2;
      continue;
    }
    if (a.startsWith('-')) {
      i++;
      continue;
    }
    return { sub: a.toLowerCase(), rest: args.slice(i + 1) };
  }
  return null;
}

function shortCluster(a: string, ch: string): boolean {
  return /^-[a-zA-Z]+$/.test(a) && a.slice(1).includes(ch);
}

function gitHit(c: SimpleCommand): Hit | null {
  const g = gitSub(c.args);
  if (!g) return null;
  const { sub, rest } = g;
  if (sub === 'push') {
    const forced = rest.some((a) => shortCluster(a, 'f') || a === '--force' || a.startsWith('--force-with-lease') || a === '--force-if-includes' || a === '--mirror' || a === '--prune');
    const plus = rest.filter((a) => !a.startsWith('-')).some((a) => a.startsWith('+'));
    if (forced || plus) return { rule: 'destructive.git-force-push', reason: 'git push that can overwrite remote history (force, +refspec, --mirror or --prune)', targets: [], allowable: false };
    return null;
  }
  if (sub === 'reset' && rest.some((a) => a === '--hard' || a === '--merge' || a === '--keep')) {
    return { rule: 'destructive.git-reset-hard', reason: 'git reset --hard discards uncommitted work and moves the branch', targets: [], allowable: false };
  }
  if (sub === 'clean' && rest.some((a) => shortCluster(a, 'f') || a === '--force')) {
    return { rule: 'destructive.git-clean', reason: 'git clean -f deletes untracked files (and directories with -d, ignored files with -x)', targets: [], allowable: false };
  }
  if (sub === 'branch') {
    const del = rest.some((a) => shortCluster(a, 'D') || ((shortCluster(a, 'd') || a === '--delete') && rest.some((b) => shortCluster(b, 'f') || b === '--force')));
    if (del) return { rule: 'destructive.git-branch-delete', reason: 'force-deletes a git branch, including unmerged commits', targets: [], allowable: false };
    return null;
  }
  if (sub === 'stash' && (rest[0] === 'drop' || rest[0] === 'clear')) {
    return { rule: 'destructive.git-stash-drop', reason: `git stash ${rest[0]} discards stashed work`, targets: [], allowable: false };
  }
  if (sub === 'checkout' && (rest.includes('-f') || rest.includes('--force') || rest.includes('.') || rest.includes('--'))) {
    return { rule: 'destructive.git-discard', reason: 'git checkout that overwrites uncommitted changes', targets: [], allowable: false };
  }
  if (sub === 'restore' && !rest.includes('--staged') && !rest.includes('-S')) {
    return { rule: 'destructive.git-discard', reason: 'git restore overwrites uncommitted changes in the working tree', targets: [], allowable: false };
  }
  if (sub === 'filter-branch' || sub === 'filter-repo') {
    return { rule: 'destructive.git-rewrite', reason: `git ${sub} rewrites history`, targets: [], allowable: false };
  }
  return null;
}

const DISK_TOOLS = new Set(['wipefs', 'diskpart', 'format-volume', 'clear-disk', 'initialize-disk', 'remove-partition', 'blkdiscard']);

function diskHit(c: SimpleCommand): Hit | null {
  const n = c.name;
  const a = c.args.map((x) => x.toLowerCase());
  if (n.startsWith('mkfs') || n === 'newfs' || n.startsWith('newfs_') || DISK_TOOLS.has(n)) {
    return { rule: 'destructive.disk-format', reason: `${n} formats or erases a disk or partition`, targets: c.args.filter((x) => !x.startsWith('-')), allowable: false };
  }
  if (n === 'format' && c.args.some((x) => /^[a-z]:\\?$/i.test(x))) {
    return { rule: 'destructive.disk-format', reason: 'format erases a drive', targets: c.args, allowable: false };
  }
  if (n === 'diskutil' && a.some((x) => /^(erase|zero|random|secureerase|partitiondisk|reformat|deletecontainer|deletevolume|erasevolume|erasedisk|zerodisk|randomdisk)/.test(x))) {
    return { rule: 'destructive.disk-format', reason: 'diskutil erase or repartition', targets: [], allowable: false };
  }
  if ((n === 'sgdisk' && a.some((x) => x.startsWith('--zap') || x === '-z' || x === '-o')) || (n === 'parted' && a.some((x) => x === 'mklabel' || x === 'rm'))) {
    return { rule: 'destructive.disk-format', reason: `${n} rewrites a partition table`, targets: [], allowable: false };
  }
  if (n === 'dd' && a.some((x) => /^of=\/dev\/(?!null$|stdout$|stderr$)/.test(x))) {
    return { rule: 'destructive.disk-write', reason: 'dd writes straight to a device', targets: [], allowable: false };
  }
  for (const r of c.redirects) {
    if ((r.op.includes('>')) && /^\/dev\/(sd|hd|nvme|disk|rdisk|mmcblk|vd|xvd)/.test(r.target.toLowerCase())) {
      return { rule: 'destructive.disk-write', reason: `output redirected onto a device (${r.target})`, targets: [r.target], allowable: false };
    }
  }
  return null;
}

function otherHit(c: SimpleCommand): Hit | null {
  const n = c.name;
  if (n === 'shred' || n === 'srm' || n === 'wipe') {
    return { rule: 'destructive.shred', reason: `${n} overwrites files so they cannot be recovered`, targets: c.args.filter((x) => !x.startsWith('-')), allowable: false };
  }
  if (n === 'truncate') {
    return { rule: 'destructive.truncate', reason: 'truncate cuts a file to a given size and discards the rest', targets: c.args.filter((x) => !x.startsWith('-')), allowable: false };
  }
  if (n === 'rsync' && c.args.some((x) => x.startsWith('--delete') || x === '--remove-source-files')) {
    return { rule: 'destructive.rsync-delete', reason: 'rsync --delete removes files at the destination that are missing at the source', targets: [], allowable: false };
  }
  if ((n === 'mv' || n === 'move-item' || n === 'move') && c.args.some((x) => x === '/dev/null' || x.toLowerCase() === 'nul' || x.toLowerCase() === '$null')) {
    return { rule: 'destructive.recursive-delete', reason: 'moves files onto the null device', targets: c.args, allowable: false };
  }
  if (n === 'docker' || n === 'podman') {
    const a = c.args.filter((x) => !x.startsWith('-'));
    const joined = a.slice(0, 3).join(' ');
    if (/^(system prune|volume (rm|prune|remove)|image prune|container prune)/.test(joined) || (a[0] === 'compose' && a[1] === 'down' && c.args.some((x) => x === '-v' || x === '--volumes'))) {
      return { rule: 'destructive.docker-prune', reason: `${n} ${joined} deletes containers, images or volumes (volume data is not recoverable)`, targets: [], allowable: false };
    }
  }
  if (n === 'redis-cli' && c.args.some((x) => /^flush(all|db)$/i.test(x))) {
    return { rule: 'destructive.sql-drop', reason: 'redis FLUSHALL/FLUSHDB deletes every key', targets: [], allowable: false };
  }
  return null;
}

function commandHit(c: SimpleCommand): Hit | null {
  const n = c.name;
  if (c.shell === 'powershell' && ['rm', 'del', 'erase', 'rd', 'rmdir', 'ri', 'remove-item'].includes(n)) return removeItemHit(c);
  if (n === 'remove-item' || n === 'ri') return removeItemHit(c);
  if (c.shell === 'cmd' && (n === 'del' || n === 'erase')) return cmdDelHit(c);
  if (c.shell === 'cmd' && (n === 'rd' || n === 'rmdir')) return rdHit(c);
  if (n === 'rm') return rmHit(c);
  if (n === 'del' || n === 'erase') return cmdDelHit(c);
  if ((n === 'rd' || n === 'rmdir') && c.args.some((a) => /^\/s/i.test(a))) return rdHit(c);
  if (n === 'unlink' && c.bulk) return { rule: 'destructive.recursive-delete', reason: 'bulk unlink', targets: [], allowable: false };
  if (n === 'find' && c.args.includes('-delete')) {
    return { rule: 'destructive.recursive-delete', reason: `find -delete under ${describeTargets(c.args.filter((a) => !a.startsWith('-')).slice(0, 1))}`, targets: [], allowable: false };
  }
  if (n === 'git') return gitHit(c);
  return diskHit(c) ?? otherHit(c);
}

const SQL_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /\bdrop\s+(table|database|schema|keyspace)\b/i, what: 'DROP TABLE/DATABASE/SCHEMA' },
  { re: /\btruncate\s+(table\s+)?(only\s+)?[\w."`[\]]+\s*(;|$|["']|\bcascade\b|\brestart\b|\bcontinue\b)/im, what: 'TRUNCATE' },
  { re: /\bdelete\s+from\s+[\w."`[\]]+\s*(;|$|["'])/im, what: 'DELETE without WHERE' },
  { re: /\.drop(Database)?\(\s*\)/, what: 'MongoDB drop()' },
  { re: /\bflushall\b/i, what: 'FLUSHALL' },
];

function isSafeAllowTarget(t: string): boolean {
  if (t === '' || hasGlob(t)) return false;
  if (/^([/\\~$%]|[a-z]:)/i.test(t)) return false;
  return !t.replace(/\\/g, '/').split('/').includes('..');
}

function matchesAllowTarget(t: string, allow: string[]): boolean {
  const clean = t.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return allow.some((p) => {
    const pc = p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    return clean === pc || clean.endsWith(`/${pc}`);
  });
}

export const destructiveGuard: Guard = {
  id: 'destructive',
  isHard: () => false,
  evaluate(ctx: GuardContext): Finding[] {
    const cfg = ctx.bylaws.guards.destructive;
    if (ctx.action.kind !== 'exec' || ctx.parsed === null || cfg.decision === 'allow') return [];
    const out: Finding[] = [];
    for (const c of ctx.parsed.commands) {
      const hit = commandHit(c);
      if (hit === null) continue;
      if (hit.allowable && cfg.allow_targets.length > 0 && hit.targets.length > 0 && hit.targets.every((t) => isSafeAllowTarget(t) && matchesAllowTarget(t, cfg.allow_targets))) continue;
      out.push({ decision: cfg.decision, rule: hit.rule, reason: hit.reason });
    }
    for (const p of SQL_PATTERNS) {
      if (p.re.test(ctx.action.command)) {
        out.push({ decision: cfg.decision, rule: 'destructive.sql-drop', reason: `${p.what} deletes data that cannot be restored without a backup` });
        break;
      }
    }
    return out;
  },
};
