import { homedir } from 'node:os';
import { join } from 'node:path';

export function configDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  const explicit = env['OPENMORALS_HOME'];
  if (explicit !== undefined && explicit !== '') return explicit;
  if (platform === 'win32') {
    const appData = env['APPDATA'];
    return join(appData !== undefined && appData !== '' ? appData : join(home, 'AppData', 'Roaming'), 'openmorals');
  }
  const xdg = env['XDG_CONFIG_HOME'];
  return join(xdg !== undefined && xdg !== '' ? xdg : join(home, '.config'), 'openmorals');
}

export function auditLogPath(dir: string = configDir()): string {
  return join(dir, 'audit.jsonl');
}

export function safeSessionId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
  return cleaned === '' ? 'unknown' : cleaned;
}

export function sessionStatePath(sessionId: string, dir: string = configDir()): string {
  return join(dir, 'sessions', `${safeSessionId(sessionId)}.json`);
}
