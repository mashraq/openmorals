export type SandboxPlatform = 'darwin' | 'linux' | 'win32';

export type SandboxTool = 'sandbox-exec' | 'bwrap';

export type PathKind = 'dir' | 'file' | 'missing';

/**
 * Optional `sandbox` section. The core bylaws schema does not have it yet (see docs/sandbox.md,
 * "Wiring needed"); until it does, it comes from PlanOptions.sandbox.
 */
export interface SandboxSection {
  network?: { allow_hosts?: string[] };
  write?: { allow?: string[] };
  read?: { deny?: string[] };
}

export interface PlanOptions {
  /** The user's home directory for the target platform (absolute, real path). */
  home: string;
  /** Writable temp directories. Defaults: darwin /private/tmp and /private/var/tmp; linux /tmp (as a private tmpfs); win32 none. */
  tmpDirs?: string[];
  /** Overrides the bylaws' sandbox section. */
  sandbox?: SandboxSection;
  /** What exists on disk; used for the Linux bubblewrap arguments, which bind concrete paths only. */
  probe?: (absPath: string) => PathKind;
  /** Secret-looking files found inside the project (Linux only; macOS matches them by pattern). */
  projectSecretFiles?: string[];
}

export interface DenyRead {
  path: string;
  kind: 'dir' | 'file';
  why: string;
}

export type NetworkPolicy = { mode: 'off' } | { mode: 'hosts'; hosts: string[] };

/** The platform-neutral result of reading the bylaws. */
export interface SandboxPolicy {
  projectRoot: string;
  writable: string[];
  /** Paths inside a writable area that stay read-only (self-protection). */
  denyWrite: string[];
  denyRead: DenyRead[];
  /** File-name patterns denied anywhere (enforced as regexes on macOS; as found files on Linux). */
  denyReadNames: string[];
  network: NetworkPolicy;
}

export interface SrtSettings {
  network: { allowedDomains: string[]; deniedDomains: string[] };
  filesystem: { denyRead: string[]; allowRead: string[]; allowWrite: string[]; denyWrite: string[] };
}

export interface WindowsPlan {
  design: string;
  steps: string[];
}

export type SandboxPlan =
  | { ok: true; platform: 'darwin'; enforced: true; tool: 'sandbox-exec'; policy: SandboxPolicy; seatbelt: string; srt: SrtSettings; notes: string[] }
  | { ok: true; platform: 'linux'; enforced: true; tool: 'bwrap'; policy: SandboxPolicy; bwrapArgs: string[]; srt: SrtSettings; notes: string[] }
  | { ok: true; platform: 'win32'; enforced: false; tool: null; policy: SandboxPolicy; windows: WindowsPlan; notes: string[] }
  | { ok: false; platform: string; error: string };
