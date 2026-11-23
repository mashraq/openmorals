import type { Finding, Guard, GuardContext } from '../guard.js';
import type { SimpleCommand } from '../shell.js';
import { gitSub } from './destructive.js';

const CLOUD_CLIS = new Set([
  'gh', 'glab', 'aws', 'gcloud', 'gsutil', 'az', 'kubectl', 'oc', 'helm', 'heroku', 'fly', 'flyctl', 'vercel', 'netlify',
  'firebase', 'doctl', 'hcloud', 'linode-cli', 'supabase', 'wrangler', 'railway', 'eksctl', 'pulumi', 'cdk', 'serverless',
  'sls', 'scw', 'ibmcloud', 'oci', 'aliyun', 'render', 'stripe', 'twilio', 'okta', 'auth0', 'tea', 'bq', 'cf', 'nomad', 'vault',
]);

const DELETE_VERB = /^(delete|destroy|remove|rm|rb|terminate|purge|uninstall|unpublish|yank|deregister|drain|del|prune|archive)$|^(delete|terminate|remove|deregister|destroy|purge|drop)-|:(delete|destroy|remove|rm|disable)$/;

const IAC_DESTROY = new Set(['terraform', 'tofu', 'terragrunt', 'pulumi', 'cdk', 'cdktf', 'serverless', 'sls', 'copilot', 'sam']);

const PKG_UNPUBLISH = new Set(['npm', 'pnpm', 'yarn', 'bun', 'cargo', 'gem', 'dotnet', 'nuget', 'twine', 'poetry']);

function psParam(a: string, full: string, min: number): boolean {
  const p = a.toLowerCase().split(':')[0] ?? '';
  return p.length >= min && full.startsWith(p);
}

function httpMethodDelete(c: SimpleCommand): boolean {
  const a = c.args;
  const n = c.name;
  if (n === 'curl') {
    for (let i = 0; i < a.length; i++) {
      const w = a[i] ?? '';
      if ((w === '-X' || w === '--request') && (a[i + 1] ?? '').toUpperCase() === 'DELETE') return true;
      if (/^(-X|--request=)delete$/i.test(w)) return true;
    }
    return false;
  }
  if (n === 'wget') {
    for (let i = 0; i < a.length; i++) {
      const w = a[i] ?? '';
      if (/^--method=delete$/i.test(w) || (w === '--method' && (a[i + 1] ?? '').toUpperCase() === 'DELETE')) return true;
    }
    return false;
  }
  if (n === 'http' || n === 'https' || n === 'xh' || n === 'xhs' || n === 'httpie') {
    return a.some((w) => w.toUpperCase() === 'DELETE');
  }
  if (n === 'invoke-webrequest' || n === 'iwr' || n === 'invoke-restmethod' || n === 'irm') {
    for (let i = 0; i < a.length; i++) {
      const w = a[i] ?? '';
      if (psParam(w, '-method', 3) && (a[i + 1] ?? '').toLowerCase() === 'delete') return true;
      if (/^-method:delete$/i.test(w)) return true;
    }
    return false;
  }
  if ((n === 'gh' || n === 'glab') && a[0] === 'api') {
    for (let i = 0; i < a.length; i++) {
      const w = a[i] ?? '';
      if ((w === '-X' || w === '--method') && (a[i + 1] ?? '').toUpperCase() === 'DELETE') return true;
      if (/^(-X|--method=)delete$/i.test(w)) return true;
    }
  }
  return false;
}

function hit(c: SimpleCommand): { rule: string; reason: string } | null {
  const n = c.name;
  const words = c.args.filter((a) => !a.startsWith('-'));
  if (httpMethodDelete(c)) return { rule: 'online-delete.http-delete', reason: `${n} sends an HTTP DELETE request` };
  if (n === 'git') {
    const g = gitSub(c.args);
    if (g && g.sub === 'push') {
      const del = g.rest.some((a) => a === '--delete' || a === '-d');
      const colon = g.rest.filter((a) => !a.startsWith('-')).some((a) => a.startsWith(':') && a.length > 1);
      if (del || colon) return { rule: 'online-delete.git-remote-delete', reason: 'git push deletes a branch or tag on the remote' };
    }
    return null;
  }
  if (IAC_DESTROY.has(n) && (words.includes('destroy') || c.args.includes('-destroy') || c.args.includes('--destroy') || (n === 'sls' || n === 'serverless') && words.includes('remove'))) {
    return { rule: 'online-delete.infra-destroy', reason: `${n} destroy tears down deployed infrastructure` };
  }
  if (PKG_UNPUBLISH.has(n) && words.some((w) => w === 'unpublish' || w === 'yank' || (w === 'delete' && (n === 'nuget' || n === 'dotnet')))) {
    return { rule: 'online-delete.package-unpublish', reason: `${n} removes a published package version from a registry` };
  }
  if (n === 'aws' && words[0] === 's3' && (words[1] === 'rm' || words[1] === 'rb' || (words[1] === 'sync' && c.args.includes('--delete')))) {
    return { rule: 'online-delete.cloud-delete', reason: `aws s3 ${words[1] ?? ''} deletes objects or buckets` };
  }
  if (CLOUD_CLIS.has(n)) {
    const verb = words.find((w) => DELETE_VERB.test(w.toLowerCase()));
    if (verb !== undefined) return { rule: 'online-delete.cloud-delete', reason: `${n} ${words.slice(0, 3).join(' ')} deletes or tears down an online resource` };
  }
  return null;
}

export const onlineDeleteGuard: Guard = {
  id: 'online-delete',
  isHard: () => false,
  evaluate(ctx: GuardContext): Finding[] {
    const cfg = ctx.bylaws.guards['online-delete'];
    if (ctx.action.kind !== 'exec' || ctx.parsed === null || cfg.decision === 'allow') return [];
    const out: Finding[] = [];
    for (const c of ctx.parsed.commands) {
      const h = hit(c);
      if (h) out.push({ decision: cfg.decision, rule: h.rule, reason: `${h.reason}; it cannot be undone from here` });
    }
    return out;
  },
};
