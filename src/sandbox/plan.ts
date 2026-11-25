import type { Bylaws, BylawsLoad } from '../types.js';
import { isAbsoluteFor, isFilesystemRoot, isInside, normalizeFor, pathApi, resolveConfigured, unsafePathChar } from './paths.js';
import { renderBwrapArgs, renderSeatbelt, renderSrtSettings, renderWindowsPlan } from './render.js';
import { expandProtectedPaths, validateSandboxSection } from './section.js';
import type { DenyRead, NetworkPolicy, PlanOptions, SandboxPlan, SandboxPlatform, SandboxPolicy } from './types.js';

export { validateSandboxSection } from './section.js';

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
export const PROTECTED_IN_ROOT: readonly string[] = ['.git/hooks', '.git/config', 'openmorals.yaml', 'openmorals.yml', '.claude/settings.json', '.claude/settings.local.json', '.codex/hooks.json', '.codex/config.toml', '.gemini/settings.json', '.opencode/plugins', 'opencode.json', 'opencode.jsonc', '.openclaw/plugins', 'openclaw.json'];

const DEFAULT_TMP: Record<SandboxPlatform, string[]> = {
  darwin: ['/private/tmp', '/private/var/tmp'],
  linux: ['/tmp'],
  win32: [],
};


/** What each runner does with `sandbox.write.protected_paths`, said plainly in the plan. */
function protectedNotes(platform: SandboxPlatform, patterns: number, found: number, searched: boolean, linked: readonly string[]): string[] {
  const out: string[] = [];
  if (platform === 'darwin') {
    out.push(`protected paths: ${patterns} pattern(s) from sandbox.write.protected_paths are read-only by pattern in the seatbelt profile (writes, new files, removals and renames into them are denied)${searched ? `; ${found} existing match(es) found, whose parent folders cannot be renamed or removed` : '; existing matches were not searched, so a parent folder of a protected path can still be renamed'}`);
  } else if (platform === 'linux') {
    out.push(`protected paths: bubblewrap binds concrete paths only: the ${found} protected path(s) found now are read-only; a file created later under a protected pattern, or a renamed parent folder, is not covered${searched ? '' : ' (existing matches were not searched)'}; not run on Linux`);
  } else {
    out.push(`protected paths: written into the Windows plan for the ${found} path(s) found now; not enforced on Windows`);
  }
  if (platform !== 'win32') out.push('the srt settings carry the protected paths found now (literal paths), not the patterns');
  if (linked.length > 0) out.push(`${linked.length} protected file(s) have another hard link; a write through the other name is not stopped: ${linked.slice(0, 5).join(', ')}${linked.length > 5 ? ', ...' : ''}`);
  return out;
}

export function isSandboxPlatform(p: string): p is SandboxPlatform {
  return p === 'darwin' || p === 'linux' || p === 'win32';
}

/**
 * The error for a bylaws load that is not ok. No plan is made from the defaults: since 0.17.0 the file can ask for
 * more protection than the defaults give (`sandbox.write.protected_paths`), and a plan without it would say
 * "enforced" while a setting that was asked for is silently absent.
 */
export function invalidBylawsError(load: { source: string; error: string }): string {
  const first = load.error.split('; ')[0] ?? load.error;
  return `the bylaws file ${load.source} is invalid (${first}); no sandbox plan is made from the defaults, so a setting you asked for cannot silently drop out; run openmorals validate`;
}

function bylawsOf(input: Bylaws | BylawsLoad): { ok: true; bylaws: Bylaws; sandbox: unknown } | { ok: false; error: string } {
  if ('ok' in input) {
    if (!input.ok) return { ok: false, error: invalidBylawsError(input) };
    return { ok: true, bylaws: input.bylaws, sandbox: (input.bylaws as Bylaws & { sandbox?: unknown }).sandbox };
  }
  return { ok: true, bylaws: input, sandbox: (input as Bylaws & { sandbox?: unknown }).sandbox };
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
  const loaded = bylawsOf(bylawsIn);
  if (!loaded.ok) return fail(platform, loaded.error);
  const { bylaws, sandbox } = loaded;

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
  const protectedGlobs = expandProtectedPaths(sec.section.protectedPaths ?? []);
  if (protectedGlobs.length > 0) {
    const found: string[] = [];
    for (const f of opts.protectedFound ?? []) {
      const e = checkPath(f, 'a protected path');
      if (e !== null) return fail(platform, e);
      if (!isAbsoluteFor(f, platform)) return fail(platform, `protected path '${f}' must be absolute`);
      const abs = normalizeFor(f, platform);
      if (!isInside(abs, root, platform) || abs === root) return fail(platform, `protected path '${f}' is not inside the project root`);
      if (!found.includes(abs)) found.push(abs);
    }
    const ancestors: string[] = [];
    for (const f of found) {
      for (let d = api.dirname(f); d !== root && isInside(d, root, platform) && d !== api.dirname(d); d = api.dirname(d)) if (!ancestors.includes(d)) ancestors.push(d);
    }
    policy.protectedGlobs = protectedGlobs;
    policy.protectedFound = found;
    policy.protectedAncestors = ancestors;
    notes.push(...protectedNotes(platform, protectedGlobs.length, found.length, opts.protectedFound !== undefined, opts.protectedLinked ?? []));
  }
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
