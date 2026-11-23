import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { configDir, sessionStatePath } from './paths.js';
import type { SessionState } from './types.js';
import { EMPTY_STATE } from './types.js';

export interface StoredSession extends SessionState {
  session: string;
  updated: string;
}

function nonNegInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

export function loadSessionState(sessionId: string, dir: string = configDir()): SessionState {
  try {
    const raw: unknown = JSON.parse(readFileSync(sessionStatePath(sessionId, dir), 'utf8'));
    if (typeof raw !== 'object' || raw === null) return { ...EMPTY_STATE };
    const o = raw as Record<string, unknown>;
    return { toolCalls: nonNegInt(o['toolCalls']), tokens: nonNegInt(o['tokens']), prevTokens: nonNegInt(o['prevTokens']) };
  } catch {
    return { ...EMPTY_STATE };
  }
}

export function saveSessionState(sessionId: string, state: SessionState, dir: string = configDir(), now: Date = new Date()): void {
  const file = sessionStatePath(sessionId, dir);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const body: StoredSession = { session: sessionId, ...state, updated: now.toISOString() };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export function countToolCall(state: SessionState): SessionState {
  return { toolCalls: state.toolCalls + 1, tokens: state.tokens, prevTokens: state.tokens };
}

export function addTokens(state: SessionState, tokens: number): SessionState {
  const t = Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0;
  return { toolCalls: state.toolCalls, tokens: state.tokens + t, prevTokens: state.tokens };
}
