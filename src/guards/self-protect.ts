import type { Finding, Guard, GuardContext } from '../guard.js';
import { normalizePath, quoteForReason } from '../guard.js';

const PROTECTED = [
  /(^|\/)openmorals\.ya?ml$/,
  /(^|\/)\.claude\/settings(\.local)?\.json$/,
  /(^|\/)openmorals\/(audit\.jsonl|sessions)(\/|$)/,
  /(^|\/)\.openmorals(\/|$)/,
  // the hook and plugin configuration of the other hosts (Codex, Gemini CLI, opencode)
  /(^|\/)\.codex\/(hooks\.json|config\.toml|requirements\.toml)$/,
  /(^|\/)codex\/(hooks\.json|requirements\.toml)$/,
  /(^|\/)\.gemini\/settings\.json$/,
  /(^|\/)gemini-cli\/settings\.json$/,
  /(^|\/)\.?opencode\/plugins?(\/|$)/,
  /(^|\/)opencode\.jsonc?$/,
];

const READ_ONLY = new Set([
  'cat', 'less', 'more', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'bat', 'wc', 'diff', 'ls', 'stat', 'file', 'jq',
  'get-content', 'gc', 'type', 'select-string', 'sls', 'test', '[', 'echo', 'readlink', 'realpath', 'md5sum', 'sha256sum', 'shasum',
]);

const CHANGES_RECORDS = new Set(['init', 'purge']);

export function isProtectedPath(path: string): boolean {
  const p = normalizePath(path).replace(/^["']|["']$/g, '');
  return PROTECTED.some((re) => re.test(p));
}

export const selfProtectGuard: Guard = {
  id: 'self-protect',
  isHard: () => false,
  evaluate(ctx: GuardContext): Finding[] {
    const cfg = ctx.bylaws.guards['self-protect'];
    if (cfg.decision === 'allow') return [];
    const a = ctx.action;
    if (a.kind === 'write') {
      return isProtectedPath(a.path)
        ? [{ decision: cfg.decision, rule: 'self-protect.write', reason: `${a.tool} changes the guard's own configuration or records (${quoteForReason(a.path, 60)})` }]
        : [];
    }
    if (a.kind !== 'exec' || ctx.parsed === null) return [];
    for (const c of ctx.parsed.commands) {
      const redirectHit = c.redirects.find((r) => !r.op.includes('<') && isProtectedPath(r.target));
      if (redirectHit) {
        return [{ decision: cfg.decision, rule: 'self-protect.write', reason: `output is redirected onto ${quoteForReason(redirectHit.target, 60)}, the guard's own configuration or records` }];
      }
      if (c.name === 'openmorals') {
        const sub = c.args.find((x) => !x.startsWith('-'));
        if (sub !== undefined && CHANGES_RECORDS.has(sub)) {
          return [{ decision: cfg.decision, rule: 'self-protect.write', reason: `openmorals ${sub} changes the guard's own configuration, hook settings or trash` }];
        }
        continue;
      }
      if (READ_ONLY.has(c.name) && !c.args.some((x) => x === '-i' || x.startsWith('--in-place'))) continue;
      if (c.name === 'git' && ['diff', 'log', 'show', 'status', 'add', 'commit', 'blame'].includes(c.args.find((x) => !x.startsWith('-')) ?? '')) continue;
      const hit = c.args.find((x) => isProtectedPath(x));
      if (hit !== undefined) {
        return [{ decision: cfg.decision, rule: 'self-protect.write', reason: `${c.name} may change or remove ${quoteForReason(hit, 60)}, the guard's own configuration or records` }];
      }
    }
    return [];
  },
};
