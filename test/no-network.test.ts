import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, tempDir } from './helpers.js';

// The promise under test: no openmorals source file outside the optional reviewer makes a network call.
// What this scan does not cover, stated here and in API.md: the dependency's own code, commands openmorals
// runs as child processes (`sandbox run`, the doctor's checks, the plugins starting openmorals), and a call
// built so that no source line names it (a computed property on globalThis, for example).

export interface NetworkHit {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
  readonly text: string;
}

const NET_MODULES = '(?:http|https|http2|net|tls|dgram|dns|dns/promises|undici|ws)';

const PATTERNS: readonly { readonly kind: string; readonly re: RegExp }[] = [
  { kind: 'fetch', re: /\bfetch\s*\(/ },
  { kind: 'network module', re: new RegExp(`(?:\\bfrom|\\bimport|\\brequire\\s*\\(|\\bimport\\s*\\()\\s*['"\`](?:node:)?${NET_MODULES}['"\`]`) },
  { kind: 'network module', re: new RegExp(`['"\`]node:${NET_MODULES}['"\`]`) },
  { kind: 'browser network API', re: /\b(?:WebSocket|EventSource|XMLHttpRequest|sendBeacon)\b/ },
  { kind: 'computed module load', re: /\b(?:import|require)\s*\(\s*(?!['"`])[^)\s]/ },
];

/** Allowed hits. Each names one file and one exact piece of text, so anything else in that file still fails. */
export const ALLOWED: readonly { readonly file: string; readonly text: string; readonly reason: string }[] = [
  { file: 'src/reviewer/http.ts', text: 'await fetch(url, init)', reason: 'the optional reviewer and inbound judge: the one network call, made only when the user-level file turns a reviewer on' },
  { file: 'src/outbound/domain.ts', text: "import { isIP } from 'node:net'", reason: 'isIP only reads a string to tell an address from a name; it opens no socket' },
  { file: 'src/scanner/rules.ts', text: '/\\bXMLHttpRequest\\b|navigator\\.sendBeacon/', reason: 'a pattern the diff scanner uses to find network calls in code it reads; it makes no call' },
];

/** Removes // and block comments, keeping strings, template text and line breaks so line numbers hold. */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i] as string;
    const n = src[i + 1];
    if (quote !== null) {
      out += c;
      if (c === '\\' && i + 1 < src.length) { out += n; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function looksLikeComment(line: string, re: RegExp): boolean {
  const t = line.trimStart();
  if (t.startsWith('*') || t.startsWith('/*')) return true;
  const at = line.search(re);
  const slashes = line.indexOf('//');
  return slashes >= 0 && slashes < at;
}

export function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(?:ts|mts|cts|js|mjs|cjs)$/.test(name)) out.push(p);
    }
  };
  walk(join(root, 'src'));
  return out;
}

export function scanForNetwork(root: string): { files: number; hits: NetworkHit[] } {
  const files = sourceFiles(root);
  const hits: NetworkHit[] = [];
  for (const path of files) {
    const file = relative(root, path).split(sep).join('/');
    const raw = readFileSync(path, 'utf8').split('\n');
    stripComments(raw.join('\n')).split('\n').forEach((text, idx) => {
      const rawLine = raw[idx] ?? '';
      for (const p of PATTERNS) {
        const inCode = p.re.test(text);
        // A hit the comment stripper removed must sit after a // or on a block-comment line; otherwise the
        // stripper misread the line (a quote inside a regular expression, say) and the hit is reported.
        if (!inCode && (!p.re.test(rawLine) || looksLikeComment(rawLine, p.re))) continue;
        const shown = inCode ? text : rawLine;
        if (ALLOWED.some((a) => a.file === file && shown.includes(a.text))) continue;
        hits.push({ file, line: idx + 1, kind: inCode ? p.kind : `${p.kind}, inside what the scan read as a comment`, text: shown.trim() });
        break;
      }
    });
  }
  return { files: files.length, hits };
}

function plant(lines: readonly string[]): string {
  const root = tempDir('no-network');
  mkdirSync(join(root, 'src', 'deep'), { recursive: true });
  writeFileSync(join(root, 'src', 'clean.ts'), "import { join } from 'node:path';\n// fetch('https://example.com') in a comment\nexport const x = join('a', 'b');\n");
  writeFileSync(join(root, 'src', 'deep', 'planted.ts'), lines.join('\n') + '\n');
  return root;
}

describe('no network call outside the optional reviewer', () => {
  it('the real sources have none, apart from the allow-list', () => {
    const { files, hits } = scanForNetwork(REPO_ROOT);
    assert.ok(files >= 150, `the scan read only ${files} source files; it may have lost the source folder`);
    assert.deepEqual(hits, []);
  });

  it('every allow-list entry still matches a line, so a stale entry is noticed', () => {
    for (const a of ALLOWED) {
      const text = stripComments(readFileSync(join(REPO_ROOT, a.file), 'utf8'));
      assert.ok(text.includes(a.text), `${a.file} no longer holds ${a.text}; remove the entry`);
    }
  });

  it('openmorals depends on one package, and it makes no network call', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys((pkg.dependencies ?? {}) as object), ['yaml']);
    for (const k of ['optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']) assert.equal(pkg[k], undefined, k);
  });

  it('sees each way of reaching the network when it is planted in a source file', () => {
    const planted: readonly [string, string][] = [
      ["await fetch('https://example.com');", 'fetch'],
      ['const r = await globalThis.fetch (u);', 'fetch'],
      ["import https from 'node:https';", 'network module'],
      ["import { request } from 'http';", 'network module'],
      ["import * as h2 from 'node:http2';", 'network module'],
      ["import { connect } from 'node:net';", 'network module'],
      ["import tls from 'tls';", 'network module'],
      ["import dgram from 'node:dgram';", 'network module'],
      ["import { resolve4 } from 'node:dns/promises';", 'network module'],
      ["import 'node:https';", 'network module'],
      ["const d = require('dns');", 'network module'],
      ["const n = await import('node:net');", 'network module'],
      ['const mod = "node:https"; void mod;', 'network module'],
      ["import { request } from 'undici';", 'network module'],
      ["new WebSocket('wss://example.com');", 'browser network API'],
      ['const name = "https"; await import(name);', 'computed module load'],
    ];
    for (const [line, kind] of planted) {
      const { hits } = scanForNetwork(plant([line]));
      assert.ok(hits.some((h) => h.kind === kind && h.file === 'src/deep/planted.ts' && h.line === 1), `missed: ${line}`);
    }
  });

  it('an allowed text in another file, or another call in an allowed file, still fails', () => {
    const root = plant(['await fetch(url, init);']);
    assert.equal(scanForNetwork(root).hits.length, 1);
    mkdirSync(join(root, 'src', 'reviewer'), { recursive: true });
    writeFileSync(join(root, 'src', 'reviewer', 'http.ts'), "await fetch(url, init);\nimport { get } from 'node:https';\n");
    assert.deepEqual(scanForNetwork(root).hits.map((h) => h.file + ':' + h.line), ['src/deep/planted.ts:1', 'src/reviewer/http.ts:2']);
  });

  it('a call the comment stripper hides by mistake is still reported', () => {
    const { hits } = scanForNetwork(plant(["const q = /'/; const u = 'a/*'; fetch(u); // '", "const end = '*/';"]));
    assert.ok(hits.some((h) => h.kind.startsWith('fetch') && h.line === 1), JSON.stringify(hits));
  });

  it('a comment that names a call is not a call, and a string after a comment marker inside quotes is kept', () => {
    assert.equal(stripComments("a // fetch(x)\nb /* import 'node:net' */ c"), 'a \nb  c');
    assert.equal(stripComments("const u = 'https://x'; fetch(u)"), "const u = 'https://x'; fetch(u)");
  });
});
