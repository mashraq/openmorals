import { DEFAULT_BYLAWS } from '../bylaws.js';
import type { Bylaws, BylawsLoad } from '../types.js';
import { isAbsoluteFor, isFilesystemRoot, isInside, normalizeFor, pathApi, resolveConfigured, unsafePathChar } from './paths.js';
import { renderBwrapArgs, renderSeatbelt, renderSrtSettings, renderWindowsPlan } from './render.js';
import type { DenyRead, NetworkPolicy, PlanOptions, SandboxPlan, SandboxPlatform, SandboxPolicy, SandboxSection } from './types.js';

/** Home-relative credential locations denied for reading (mirrors the secrets guard's list). */
export const HOME_SECRET_PATHS: readonly { rel: string; kind: 'dir' | 'file'; why: string }[] = [
  { rel: '.ssh', kind: 'dir', why: 'SSH keys' },
  { rel: '.aws', kind: 'dir', why: 'AWS credentials' },
  { rel: '.gnupg', kind: 'dir', why: 'GnuPG keyring' },
  { rel: '.config/gcloud', kind: 'dir', why: 'Google Cloud credentials' },
  { rel: '.azure', kind: 'dir', why: 'Azure credentials' },
  { rel: '.password-store', kind: 'dir', why: 'password store' },
  { rel: '.kube/config', kind: 'file', why: 'Kubernetes credentials' },
  { rel: '.docker/config.json', kind: 'file', why: 'Docker registry credentials' },
  { rel: '.netrc', kind: 'file', why: 'credentials file' },
  { rel: '_netrc', kind: 'file', why: 'credentials file' },
  { rel: '.npmrc', kind: 'file', why: 'credentials file' },
  { rel: '.pypirc', kind: 'file', why: 'credentials file' },
  { rel: '.git-credentials', kind: 'file', why: 'credentials file' },
  { rel: '.vault-token', kind: 'file', why: 'credentials file' },
  { rel: '.pgpass', kind: 'file', why: 'credentials file' },
  { rel: '.my.cnf', kind: 'file', why: 'credentials file' },
];

/** File names denied anywhere. Literal names, or `*.ext` / `.env.*` suffix forms. */
export const SECRET_FILE_NAMES: readonly string[] = [
  '.env',
  '.env.*',
  '.envrc',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_ecdsa_sk',
  'id_ed25519_sk',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.jks',
  '*.keystore',
  '*.ppk',
  '*.kdbx',
  'terraform.tfstate',
  'terraform.tfstate.backup',
];

/** Paths inside the project root that stay read-only, so a sandboxed command cannot loosen its own rules or plant a hook. */
export const PROTECTED_IN_ROOT: readonly string[] = ['.git/hooks', '.git/config', 'openmorals.yaml', 'openmorals.yml', '.claude/settings.json', '.claude/settings.local.json'];

const DEFAULT_TMP: Record<SandboxPlatform, string[]> = {
  darwin: ['/private/tmp', '/private/var/tmp'],
  linux: ['/tmp'],
  win32: [],
};

const HOST_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

export function isSandboxPlatform(p: string): p is SandboxPlatform {
  return p === 'darwin' || p === 'linux' || p === 'win32';
}

function stringList(v: unknown, where: string, errors: string[]): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    errors.push(`${where}: must be a list of strings`);
    return [];
  }
  return v as string[];
}

function onlyKeys(o: Record<string, unknown>, keys: string[], where: string, errors: string[]): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) errors.push(`${where}.${k}: unknown key`);
}

function obj(v: unknown, where: string, errors: string[]): Record<string, unknown> | null {
  if (v === undefined) return null;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    errors.push(`${where}: must be a mapping`);
    return null;
  }
  return v as Record<string, unknown>;
}

/** Strict validation of the sandbox section; unknown keys are errors. */
export function validateSandboxSection(raw: unknown): { ok: true; section: Required<{ hosts: string[]; write: string[]; denyRead: string[] }> } | { ok: false; error: string } {
  const errors: string[] = [];
  const top = obj(raw, 'sandbox', errors);
  let hosts: string[] = [];
  let write: string[] = [];
  let denyRead: string[] = [];
  if (top !== null) {
    onlyKeys(top, ['network', 'write', 'read'], 'sandbox', errors);
    const net = obj(top['network'], 'sandbox.network', errors);
    if (net !== null) {
      onlyKeys(net, ['allow_hosts'], 'sandbox.network', errors);
      hosts = stringList(net['allow_hosts'], 'sandbox.network.allow_hosts', errors).map((h) => h.trim().toLowerCase());
      for (const h of hosts) if (!HOST_RE.test(h) || h.length > 253) errors.push(`sandbox.network.allow_hosts: '${h}' is not a host name (IP addresses and a bare * are not accepted)`);
    }
    const w = obj(top['write'], 'sandbox.write', errors);
    if (w !== null) {
      onlyKeys(w, ['allow'], 'sandbox.write', errors);
      write = stringList(w['allow'], 'sandbox.write.allow', errors);
    }
    const r = obj(top['read'], 'sandbox.read', errors);
    if (r !== null) {
      onlyKeys(r, ['deny'], 'sandbox.read', errors);
      denyRead = stringList(r['deny'], 'sandbox.read.deny', errors);
    }
  }
  if (errors.length > 0) return { ok: false, error: errors.join('; ') };
  return { ok: true, section: { hosts: [...new Set(hosts)], write, denyRead } };
}

function bylawsOf(input: Bylaws | BylawsLoad): { bylaws: Bylaws; sandbox: unknown; note: string | null } {
  if ('ok' in input) {
    if (!input.ok) return { bylaws: DEFAULT_BYLAWS, sandbox: undefined, note: `bylaws invalid (${input.error}); planned from the defaults, network off` };
    return { bylaws: input.bylaws, sandbox: (input.bylaws as Bylaws & { sandbox?: unknown }).sandbox, note: null };
  }
  return { bylaws: input, sandbox: (input as Bylaws & { sandbox?: unknown }).sandbox, note: null };
}

function fail(platform: string, error: string): SandboxPlan {
  return { ok: false, platform, error };
}

/**
 * Turns the bylaws into an OS sandbox plan. Pure: no file system, environment or clock access;
 * everything machine-specific comes in through `opts`. Default-deny writes outside the project
 * root and temp, deny reads of credential locations, network off unless hosts are listed (and
 * even then only the srt settings can carry a host list; see notes).
 */
export function planSandbox(bylawsIn: Bylaws | BylawsLoad, platform: string, projectRoot: string, opts: PlanOptions): SandboxPlan {
  if (!isSandboxPlatform(platform)) return fail(platform, `no sandbox for platform '${platform}'; supported: darwin, linux (enforced), win32 (plan only)`);
  const api = pathApi(platform);
  const notes: string[] = [];
  const { bylaws, sandbox, note } = bylawsOf(bylawsIn);
  if (note !== null) notes.push(note);

  const checkPath = (p: string, what: string): string | null => {
    if (typeof p !== 'string' || p.trim() === '') return `${what} is empty`;
    const bad = unsafePathChar(p, platform);
    if (bad !== null) return `${what} contains ${bad}`;
    return null;
  };
  const rootErr = checkPath(projectRoot, 'the project root');
  if (rootErr !== null) return fail(platform, rootErr);
  if (!isAbsoluteFor(projectRoot, platform)) return fail(platform, `the project root must be an absolute ${platform} path, got '${projectRoot}'`);
  const homeErr = checkPath(opts.home, 'the home directory');
  if (homeErr !== null) return fail(platform, homeErr);
  if (!isAbsoluteFor(opts.home, platform)) return fail(platform, `the home directory must be an absolute ${platform} path`);
  const root = normalizeFor(projectRoot, platform);
  const home = normalizeFor(opts.home, platform);
  if (isFilesystemRoot(root, platform)) return fail(platform, 'refusing to make the file system root writable');
  if (isInside(home, root, platform)) return fail(platform, 'refusing a project root that is the home directory or contains it');

  const sec = validateSandboxSection(opts.sandbox ?? sandbox);
  if (!sec.ok) return fail(platform, sec.error);

  const writable: string[] = [];
  const addWritable = (p: string, what: string): string | null => {
    if (isFilesystemRoot(p, platform)) return `${what} '${p}' is the file system root`;
    if (isInside(home, p, platform)) return `${what} '${p}' is the home directory or contains it`;
    if (!writable.some((w) => isInside(p, w, platform))) writable.push(p);
    return null;
  };
  let err = addWritable(root, 'the project root');
  if (err !== null) return fail(platform, err);
  for (const t of opts.tmpDirs ?? DEFAULT_TMP[platform]) {
    const e = checkPath(t, 'a temp directory');
    if (e !== null) return fail(platform, e);
    if (!isAbsoluteFor(t, platform)) return fail(platform, `temp directory '${t}' must be absolute`);
    err = addWritable(normalizeFor(t, platform), 'temp directory');
    if (err !== null) return fail(platform, err);
  }
  for (const w of sec.section.write) {
    const e = checkPath(w, 'a writable path');
    if (e !== null) return fail(platform, e);
    const abs = resolveConfigured(w, root, home, platform);
    if (abs === null) return fail(platform, `writable path '${w}' cannot be resolved (~user and drive-relative forms are not accepted)`);
    err = addWritable(abs, 'writable path');
    if (err !== null) return fail(platform, err);
  }

  const denyRead: DenyRead[] = [];
  if (bylaws.guards.secrets.read === 'allow') notes.push('guards.secrets.read is allow: built-in credential paths are not read-protected');
  else for (const s of HOME_SECRET_PATHS) denyRead.push({ path: normalizeFor(api.join(home, s.rel), platform), kind: s.kind, why: s.why });
  for (const d of sec.section.denyRead) {
    const e = checkPath(d, 'a read-denied path');
    if (e !== null) return fail(platform, e);
    const abs = resolveConfigured(d, root, home, platform);
    if (abs === null) return fail(platform, `read-denied path '${d}' cannot be resolved`);
    if (isFilesystemRoot(abs, platform)) return fail(platform, 'refusing to deny reads of the whole file system');
    denyRead.push({ path: abs, kind: 'dir', why: 'listed in sandbox.read.deny' });
  }
  for (const f of opts.projectSecretFiles ?? []) {
    const abs = resolveConfigured(f, root, home, platform);
    if (abs === null || !isInside(abs, root, platform) || unsafePathChar(abs, platform) !== null) return fail(platform, `project secret file '${f}' is not a path inside the project root`);
    denyRead.push({ path: abs, kind: 'file', why: 'secret-looking file in the project' });
  }
  for (const w of writable) {
    const clash = denyRead.find((d) => isInside(w, d.path, platform));
    if (clash !== undefined) return fail(platform, `writable path '${w}' lies inside a read-denied location '${clash.path}'`);
  }

  const denyWrite = PROTECTED_IN_ROOT.map((rel) => normalizeFor(api.join(root, rel), platform));
  const network: NetworkPolicy = sec.section.hosts.length === 0 ? { mode: 'off' } : { mode: 'hosts', hosts: sec.section.hosts };
  const policy: SandboxPolicy = { projectRoot: root, writable, denyWrite, denyRead, denyReadNames: [...SECRET_FILE_NAMES], network };
  const srt = renderSrtSettings(policy);

  if (platform === 'darwin') {
    if (network.mode === 'hosts') notes.push('sandbox-exec cannot filter by host name: the seatbelt profile keeps the network off; the host list is carried in the srt settings only');
    return { ok: true, platform, enforced: true, tool: 'sandbox-exec', policy, seatbelt: renderSeatbelt(policy), srt, notes };
  }
  if (platform === 'linux') {
    if (network.mode === 'hosts') notes.push('bubblewrap cannot filter by host name: the network namespace stays empty; the host list is carried in the srt settings only');
    if (opts.probe === undefined) notes.push('paths were not probed: bubblewrap fails (closed) if a read-denied or protected path is missing');
    else notes.push('Linux binds concrete paths: a protected or secret path that does not exist when the command starts is not covered');
    return { ok: true, platform, enforced: true, tool: 'bwrap', policy, bwrapArgs: renderBwrapArgs(policy, opts.probe), srt, notes };
  }
  notes.push('Windows: plan only. openmorals does not create users, ACLs or firewall rules, and runSandboxed refuses to run on Windows');
  return { ok: true, platform, enforced: false, tool: null, policy, windows: renderWindowsPlan(policy), notes };
}
