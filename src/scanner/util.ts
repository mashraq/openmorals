import type { FileKind } from "./types.js";

export const LINE_BREAK = /\r\n|\r|\n|\u2028|\u2029/;

export function splitLines(text: string): string[] {
  return text.split(LINE_BREAK);
}

export function lineOfIndex(text: string, index: number): number {
  let line = 1;
  const re = /\r\n|\r|\n|\u2028|\u2029/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && m.index < index) {
    line++;
  }
  return line;
}

export function findLine(text: string, needle: string): number | null {
  if (needle.length === 0) return null;
  const escaped = JSON.stringify(needle).slice(1, -1);
  let idx = text.indexOf(escaped);
  if (idx < 0) idx = text.indexOf(needle);
  return idx < 0 ? null : lineOfIndex(text, idx);
}

export function lineText(text: string, line: number | null): string {
  if (line === null) return "";
  return splitLines(text)[line - 1] ?? "";
}

export const PROSE_KINDS: ReadonlySet<FileKind> = new Set<FileKind>(["skill-md", "markdown", "text"]);

export function isProse(kind: FileKind): boolean {
  return PROSE_KINDS.has(kind);
}

export function parseJsonLoose(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    const stripped = text
      .replace(/^\ufeff/, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/,(\s*[}\]])/g, "$1");
    try {
      return { ok: true, value: JSON.parse(stripped) as unknown };
    } catch {
      return { ok: false };
    }
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

export function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export function fencedLineFlags(lines: readonly string[]): boolean[] {
  const out: boolean[] = [];
  let inFence = false;
  for (const l of lines) {
    const isFence = /^\s*(```|~~~)/.test(l);
    if (isFence) {
      out.push(true);
      inFence = !inFence;
    } else {
      out.push(inFence);
    }
  }
  return out;
}
