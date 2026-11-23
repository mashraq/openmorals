import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { configDir, sessionStatePath } from './paths.js';
import type { SessionMemory } from './session.js';
import { EMPTY_MEMORY, parseMemory } from './session.js';
import type { SessionState } from './types.js';
import { EMPTY_STATE } from './types.js';

export interface StoredSession extends SessionState, SessionMemory {
  session: string;
  updated: string;
}

export interface LoadedSession {
  state: SessionState;
  memory: SessionMemory;
}

function nonNegInt(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function counters(o: Record<string, unknown>): SessionState {
  return { toolCalls: nonNegInt(o['toolCalls']), tokens: nonNegInt(o['tokens']), prevTokens: nonNegInt(o['prevTokens']) };
}

export function loadSession(sessionId: string, dir: string = configDir()): LoadedSession {
  let text: string;
  try {
    text = readFileSync(sessionStatePath(sessionId, dir), 'utf8');
  } catch {
    return { state: { ...EMPTY_STATE }, memory: EMPTY_MEMORY };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = { taint: 'unreadable' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) raw = { taint: 'unreadable' };
  const o = raw as Record<string, unknown>;
  return { state: counters(o), memory: parseMemory(o) };
}

export function loadSessionState(sessionId: string, dir: string = configDir()): SessionState {
  return loadSession(sessionId, dir).state;
}

export function saveSession(sessionId: string, state: SessionState, memory: SessionMemory, dir: string = configDir(), now: Date = new Date()): void {
  const file = sessionStatePath(sessionId, dir);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const body: StoredSession = { session: sessionId, ...state, history: memory.history, taint: memory.taint, updated: now.toISOString() };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export function saveSessionState(sessionId: string, state: SessionState, dir: string = configDir(), now: Date = new Date()): void {
  saveSession(sessionId, state, loadSession(sessionId, dir).memory, dir, now);
}

export function countToolCall(state: SessionState): SessionState {
  return { toolCalls: state.toolCalls + 1, tokens: state.tokens, prevTokens: state.tokens };
}

export function addTokens(state: SessionState, tokens: number): SessionState {
  const t = Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0;
  return { toolCalls: state.toolCalls, tokens: state.tokens + t, prevTokens: state.tokens };
}
