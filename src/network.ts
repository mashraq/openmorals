import type { SimpleCommand } from './shell.js';

export const NETWORK_COMMANDS: ReadonlySet<string> = new Set([
  'curl', 'wget', 'nc', 'ncat', 'netcat', 'socat', 'telnet', 'ftp', 'sftp', 'scp', 'ssh', 'http', 'https', 'xh', 'xhs', 'httpie',
  'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'aria2c', 'mail', 'mailx', 'sendmail', 'mutt', 'send-mailmessage',
  'rclone', 'smbclient', 'tftp', 'lftp', 'gsutil', 'nslookup', 'dig', 'host', 'ping', 'certutil', 'bitsadmin', 'start-bitstransfer',
]);

const CLOUD_CLIS: ReadonlySet<string> = new Set(['aws', 'gcloud', 'az', 'kubectl', 'heroku', 'vercel', 'netlify', 'fly', 'flyctl']);
const GIT_REMOTE = new Set(['push', 'fetch', 'pull', 'clone', 'ls-remote', 'send-email', 'request-pull']);
const INTERPRETERS = new Set(['python', 'python3', 'node', 'deno', 'bun', 'ruby', 'perl', 'php']);

export function reachesNetwork(c: SimpleCommand): boolean {
  const n = c.name;
  const a0 = c.args[0];
  if (NETWORK_COMMANDS.has(n)) return true;
  if (n === 'git' && c.args.some((a) => GIT_REMOTE.has(a))) return true;
  if ((n === 'npm' || n === 'pnpm' || n === 'yarn') && c.args.includes('publish')) return true;
  if ((n === 'gh' || n === 'glab') && a0 !== undefined && a0 !== 'help' && a0 !== '--version') return true;
  if (CLOUD_CLIS.has(n)) return true;
  if (n === 'docker' && (a0 === 'push' || a0 === 'login' || a0 === 'pull')) return true;
  if (n === 'rsync' && c.args.some((a) => /^[^/\\]*[^:\\/]:/.test(a) && !/^[a-z]:[\\/]/i.test(a))) return true;
  if (n === 'openssl' && c.args.includes('s_client')) return true;
  if (INTERPRETERS.has(n) && c.args.some((a) => /\b(urllib|requests|http\.client|socket|fetch\(|net\/http|LWP|fsockopen|curl_|https?:\/\/)/.test(a))) return true;
  return c.args.some((a) => /\/dev\/(tcp|udp)\//.test(a)) || c.redirects.some((r) => /\/dev\/(tcp|udp)\//.test(r.target));
}
