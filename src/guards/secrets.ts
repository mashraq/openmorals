import type { Finding, Guard, GuardContext } from '../guard.js';
import { normalizePath, quoteForReason } from '../guard.js';
import { reachesNetwork } from '../network.js';
import type { SimpleCommand } from '../shell.js';

const SENSITIVE: { re: RegExp; label: string }[] = [
  { re: /(^|\/)\.env(\.[^/]+)?$/, label: 'an environment file' },
  { re: /(^|\/)\.envrc$/, label: 'a direnv file' },
  { re: /(^|\/)\.ssh(\/|$)/, label: 'the SSH directory' },
  { re: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/, label: 'an SSH private key' },
  { re: /(^|\/)\.aws\/(credentials|sso\/cache|cli\/cache)/, label: 'AWS credentials' },
  { re: /(^|\/)\.(netrc|_netrc|npmrc|pypirc|git-credentials|vault-token|pgpass|my\.cnf)$/, label: 'a credentials file' },
  { re: /(^|\/)_netrc$/, label: 'a credentials file' },
  { re: /(^|\/)\.docker\/config\.json$/, label: 'Docker registry credentials' },
  { re: /(^|\/)\.kube\/config$/, label: 'Kubernetes credentials' },
  { re: /(^|\/)\.config\/gcloud(\/|$)|application_default_credentials\.json$/, label: 'Google Cloud credentials' },
  { re: /(^|\/)\.azure(\/|$)/, label: 'Azure credentials' },
  { re: /(^|\/)\.gnupg(\/|$)/, label: 'the GnuPG keyring' },
  { re: /(^|\/)\.password-store(\/|$)/, label: 'a password store' },
  { re: /\.(pem|key|p12|pfx|jks|keystore|ppk|kdbx)$/, label: 'a key or certificate store' },
  { re: /(^|\/)credentials(\.json|\.ya?ml|\.toml)?$/, label: 'a credentials file' },
  { re: /(^|\/)secrets?\.(ya?ml|json|toml|env)$/, label: 'a secrets file' },
  { re: /(^|\/)terraform\.tfstate(\.backup)?$/, label: 'Terraform state (holds secrets in clear text)' },
];

const NOT_SENSITIVE = [/\.env\.(example|sample|template|dist)$/, /\.pub$/, /(^|\/)known_hosts(\.old)?$/, /(^|\/)\.ssh\/config$/];

export function sensitiveLabel(path: string): string | null {
  const p = normalizePath(path).replace(/^["']|["']$/g, '').replace(/\*+$/, '');
  if (p === '') return null;
  if (NOT_SENSITIVE.some((re) => re.test(p))) return null;
  for (const s of SENSITIVE) if (s.re.test(p)) return s.label;
  return null;
}

const SECRET_VAR = /\$\{?([A-Za-z_][A-Za-z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIAL)[A-Za-z0-9_]*)\}?|\$env:([A-Za-z_][A-Za-z0-9_]*(SECRET|TOKEN|PASSWORD|API_?KEY|ACCESS_?KEY)[A-Za-z0-9_]*)/i;

function candidates(word: string): string[] {
  const out = [word];
  for (const part of word.split(/[=@,]/)) if (part !== '' && part !== word) out.push(part);
  for (const part of word.split(/[\s'"`(),;=@<>|&{}[\]]+/)) if (part !== '' && part !== word && !out.includes(part)) out.push(part);
  return out;
}

interface Refs {
  reads: string[];
  writes: string[];
  vars: string[];
  envDump: boolean;
  network: boolean;
}

function collect(commands: SimpleCommand[]): Refs {
  const refs: Refs = { reads: [], writes: [], vars: [], envDump: false, network: false };
  for (const c of commands) {
    if (reachesNetwork(c)) refs.network = true;
    const n = c.name;
    if ((n === 'env' || n === 'printenv' || n === 'export' || (n === 'set' && c.shell === 'posix')) && c.args.filter((a) => !a.startsWith('-')).length === 0) refs.envDump = true;
    if ((n === 'get-childitem' || n === 'gci' || n === 'dir' || n === 'ls') && c.args.some((a) => /^env:\\?$/i.test(a))) refs.envDump = true;
    if (n === 'set' && c.shell === 'cmd' && c.args.length === 0) refs.envDump = true;
    const words = [n, ...c.args];
    for (const w of words) {
      const m = SECRET_VAR.exec(w);
      if (m) refs.vars.push(m[1] ?? m[3] ?? w);
      for (const cand of candidates(w)) {
        const label = sensitiveLabel(cand);
        if (label !== null) {
          refs.reads.push(`${cand} (${label})`);
          break;
        }
      }
    }
    for (const r of c.redirects) {
      const label = sensitiveLabel(r.target);
      if (label === null) continue;
      if (r.op.includes('<')) refs.reads.push(`${r.target} (${label})`);
      else refs.writes.push(`${r.target} (${label})`);
    }
  }
  return refs;
}

export const secretsGuard: Guard = {
  id: 'secrets',
  isHard: (b) => b.guards.secrets.hard,
  evaluate(ctx: GuardContext): Finding[] {
    const cfg = ctx.bylaws.guards.secrets;
    const a = ctx.action;
    const out: Finding[] = [];
    if (a.kind === 'read' || a.kind === 'write') {
      const label = sensitiveLabel(a.path);
      if (label === null) return [];
      if (a.kind === 'read') out.push({ decision: cfg.read, rule: 'secrets.read', reason: `${a.tool} reads ${label} (${quoteForReason(a.path, 60)})` });
      else out.push({ decision: cfg.write, rule: 'secrets.write', reason: `${a.tool} changes ${label} (${quoteForReason(a.path, 60)})` });
      return out.filter((f) => f.decision !== 'allow');
    }
    if (a.kind === 'fetch') {
      if (/^file:/i.test(a.url)) {
        const label = sensitiveLabel(a.url.replace(/^file:\/*/i, '/'));
        if (label !== null) out.push({ decision: cfg.read, rule: 'secrets.read', reason: `fetches ${label} through a file: URL` });
      }
      return out.filter((f) => f.decision !== 'allow');
    }
    if (a.kind !== 'exec' || ctx.parsed === null) return [];
    const refs = collect(ctx.parsed.commands);
    const secretish = refs.reads.length > 0 || refs.vars.length > 0 || refs.envDump;
    if (secretish && refs.network) {
      const what = refs.reads[0] ?? (refs.vars[0] !== undefined ? `the variable ${refs.vars[0]}` : 'the whole environment');
      out.push({ decision: cfg.send, rule: 'secrets.send', reason: `a command line that reads ${what} also talks to the network` });
    } else {
      if (refs.reads.length > 0) out.push({ decision: cfg.read, rule: 'secrets.read', reason: `reads ${refs.reads[0] ?? ''}` });
      if (refs.vars.length > 0) out.push({ decision: cfg.read, rule: 'secrets.read', reason: `prints or uses the secret variable ${refs.vars[0] ?? ''}` });
    }
    if (refs.writes.length > 0) out.push({ decision: cfg.write, rule: 'secrets.write', reason: `writes to ${refs.writes[0] ?? ''}` });
    return out.filter((f) => f.decision !== 'allow');
  },
};
