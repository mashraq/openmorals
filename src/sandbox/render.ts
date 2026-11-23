import type { PathKind, SandboxPolicy, SrtSettings, WindowsPlan } from './types.js';

/** Device files a normal command writes to; everything else under /dev stays write-denied. */
const DEV_WRITABLE_LITERALS = ['/dev/null', '/dev/zero', '/dev/tty', '/dev/dtracehelper', '/dev/stdout', '/dev/stderr'];
const DEV_WRITABLE_REGEXES = ['^/dev/fd/[0-9]+$', '^/dev/ttys[0-9]+$'];

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** One Seatbelt regex per file-name pattern, without alternation. */
export function nameToRegex(name: string): string {
  if (name.startsWith('*.')) return `${escapeRegex(name.slice(1))}$`;
  if (name.endsWith('.*')) return `/${escapeRegex(name.slice(0, -1))}[^/]+$`;
  return `/${escapeRegex(name)}$`;
}

function q(p: string): string {
  return `"${p}"`;
}

/** Seatbelt (SBPL) profile text for sandbox-exec. Paths were checked to hold no quote, backslash or control character. */
export function renderSeatbelt(policy: SandboxPolicy): string {
  const lines: string[] = ['(version 1)', '(allow default)', ';; writes only inside the project root, temp and listed paths', '(deny file-write*', '  (require-all'];
  for (const w of policy.writable) lines.push(`    (require-not (subpath ${q(w)}))`);
  for (const d of DEV_WRITABLE_LITERALS) lines.push(`    (require-not (literal ${q(d)}))`);
  for (const r of DEV_WRITABLE_REGEXES) lines.push(`    (require-not (regex #${q(r)}))`);
  lines[lines.length - 1] = `${lines[lines.length - 1] ?? ''}))`;
  if (policy.denyWrite.length > 0) {
    lines.push(';; self-protection inside the project', '(deny file-write*');
    for (const p of policy.denyWrite) lines.push(`  (subpath ${q(p)})`);
    lines[lines.length - 1] = `${lines[lines.length - 1] ?? ''})`;
  }
  const reads = policy.denyRead.map((d) => `  (subpath ${q(d.path)})`).concat(policy.denyReadNames.map((n) => `  (regex #${q(nameToRegex(n))})`));
  if (reads.length > 0) {
    lines.push(';; credential locations and secret-looking files', '(deny file-read*', ...reads);
    lines[lines.length - 1] = `${lines[lines.length - 1] ?? ''})`;
  }
  lines.push(';; network off (Seatbelt cannot filter by host name)', '(deny network*)');
  return `${lines.join('\n')}\n`;
}

/**
 * bubblewrap arguments up to (not including) the `--` and the command. With a probe, missing
 * paths are skipped and the real kind is used; without one, every path is bound as planned
 * and bwrap fails (closed) on a missing one.
 */
export function renderBwrapArgs(policy: SandboxPolicy, probe?: (p: string) => PathKind): string[] {
  const args = ['--die-with-parent', '--new-session', '--unshare-all', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc'];
  for (const w of policy.writable) args.push('--bind', w, w);
  for (const p of policy.denyWrite) {
    if (probe !== undefined && probe(p) === 'missing') continue;
    args.push('--ro-bind', p, p);
  }
  for (const d of policy.denyRead) {
    const kind = probe === undefined ? d.kind : probe(d.path);
    if (kind === 'missing') continue;
    if (kind === 'dir') args.push('--tmpfs', d.path, '--remount-ro', d.path);
    else args.push('--ro-bind', '/dev/null', d.path);
  }
  args.push('--chdir', policy.projectRoot);
  return args;
}

/** Settings for Anthropic's sandbox runtime (`srt --settings <file>`), shape per its README. */
export function renderSrtSettings(policy: SandboxPolicy): SrtSettings {
  return {
    network: { allowedDomains: policy.network.mode === 'hosts' ? [...policy.network.hosts] : [], deniedDomains: [] },
    filesystem: {
      denyRead: [...policy.denyRead.map((d) => d.path), ...policy.denyReadNames.map((n) => `${policy.projectRoot}/**/${n}`)],
      allowRead: [],
      allowWrite: [...policy.writable],
      denyWrite: [...policy.denyWrite],
    },
  };
}

/** A documented plan for Windows, modelled on Codex's published design. Not enforced by openmorals. */
export function renderWindowsPlan(policy: SandboxPolicy): WindowsPlan {
  return {
    design: 'Run the command as a dedicated local user with a write-restricted token whose capability SID has write ACLs only on the writable paths; deny-read ACEs on credential paths; an outbound-block firewall rule for that user.',
    steps: [
      'create (once) a local standard user reserved for sandboxed commands',
      ...policy.writable.map((w) => `grant the sandbox capability SID modify rights on ${w}`),
      ...policy.denyWrite.map((p) => `deny the sandbox capability SID write on ${p}`),
      ...policy.denyRead.map((d) => `deny the sandbox user read on ${d.path} (${d.why})`),
      policy.network.mode === 'off' ? 'block all outbound traffic for the sandbox user' : `block outbound traffic for the sandbox user except through a proxy allowing ${policy.network.hosts.join(', ')}`,
      'start the command with CreateProcessAsUser and a restricted token; never fall back to the current user',
    ],
  };
}
