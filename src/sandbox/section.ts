// No imports: the bylaws validator uses this too, and importing the planner there would make a cycle.
export const SANDBOX_HOST_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

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
      for (const h of hosts) if (!SANDBOX_HOST_RE.test(h) || h.length > 253) errors.push(`sandbox.network.allow_hosts: '${h}' is not a host name (IP addresses and a bare * are not accepted)`);
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

