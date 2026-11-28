import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, tempDir } from './helpers.js';

// The promise under test: no openmorals source file outside the optional reviewer makes a network call, and
// only the files pinned below start other programs. It reads the TypeScript sources under src/ and the Python
// sources the pip package ships. Comments are not read, so a match in a comment is not a red; strings are read,
// so a module name in a string is a red until it gets an allow-list entry with a reason.
// What this scan does not cover, stated here and in API.md: the dependency's own code, what a program started from
// a pinned file does (a new program started there shows only in that file's diff), and a call built so that no
// source line names it (a computed property name built from pieces, for example).

export interface NetworkHit {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
  readonly text: string;
}

const NET_MODULES = '(?:http|https|http2|net|tls|dgram|dns|dns/promises|undici|ws)';
/** What loads a module by name: import, require, a dynamic import, and the built-in getter this code base uses. */
const LOADER = String.raw`(?:\bfrom|\bimport|\brequire\s*\(|\bimport\s*\(|\bgetBuiltinModule\s*(?:\?\.)?\s*\()`;

const PATTERNS: readonly { readonly kind: string; readonly re: RegExp }[] = [
  { kind: 'fetch', re: /\bfetch\s*\(/ },
  { kind: 'fetch', re: /\b(?:globalThis|global|window|self)\s*(?:\?\.|\.)\s*fetch\b|\[\s*['"`]fetch['"`]\s*\]|\bfetch\s*(?:\?\.|\.)\s*(?:call|apply|bind)\b|(?:=|\?\?|\|\||\(|,)\s*fetch\s*(?:[;,)]|$)|\{\s*(?:[\w$]+\s*,\s*)*fetch\s*[,}]/ },
  { kind: 'network module', re: new RegExp(`${LOADER}\\s*['"\`](?:node:)?${NET_MODULES}['"\`]`) },
  { kind: 'network module', re: new RegExp(`['"\`]node:${NET_MODULES}['"\`]`) },
  { kind: 'browser network API', re: /\b(?:WebSocket|EventSource|XMLHttpRequest|sendBeacon)\b/ },
  { kind: 'computed module load', re: /\b(?:import|require|getBuiltinModule)\s*(?:\?\.)?\s*\(\s*(?:(?!['"`])[^)\s]|`[^`]*\$\{)/ },
  { kind: 'runtime require', re: /\bcreateRequire\b|\bmodule\s*\.\s*require\b/ },
  { kind: 'child process', re: new RegExp(`${LOADER}\\s*['"\`](?:node:)?child_process['"\`]|['"\`]node:child_process['"\`]`) },
];

/** Allowed hits. Each names one file and one exact piece of text, so anything else in that file still fails. */
export const ALLOWED: readonly { readonly file: string; readonly text: string; readonly reason: string }[] = [
  { file: 'src/reviewer/http.ts', text: 'await fetch(url, init)', reason: 'the optional reviewer and inbound judge: the one network call, made only when the user-level file turns a reviewer on' },
  { file: 'src/outbound/domain.ts', text: "import { isIP } from 'node:net'", reason: 'isIP only reads a string to tell an address from a name; it opens no socket' },
  { file: 'src/scanner/rules.ts', text: '/\\bXMLHttpRequest\\b|navigator\\.sendBeacon/', reason: 'a pattern the diff scanner uses to find network calls in code it reads; it makes no call' },
  // The files that start other programs. A new one fails here and needs an entry with its reason.
  { file: 'src/adapters/opencode/plugin.ts', text: 'import { spawn } from "node:child_process";', reason: 'the plugin opencode loads; it starts only the hook command init wrote' },
  { file: 'src/adapters/openclaw/plugin.ts', text: 'import { spawn } from "node:child_process";', reason: 'the plugin OpenClaw loads; it starts only the hook command init wrote' },
  { file: 'src/doctor/index.ts', text: "import { spawnSync } from 'node:child_process';", reason: "doctor's self-test starts this openmorals with a sample call" },
  { file: 'src/sandbox/run.ts', text: "import { spawn } from 'node:child_process';", reason: 'sandbox run starts the command the user gives it, inside the sandbox' },
  { file: 'src/tests/failfirst-run.ts', text: "import { spawn, spawnSync } from 'node:child_process';", reason: 'runs git with every network protocol off (protocol.allow=never) and the test command the user names' },
  { file: 'python/openmorals/__init__.py', text: 'import subprocess', reason: 'the Python check() starts the openmorals program' },
  { file: 'python/openmorals/_binary.py', text: 'import subprocess', reason: 'the Python entry point starts the openmorals program' },
  { file: 'python/openmorals/_binary.py', text: 'os.execv(binary, [binary] + args)', reason: 'the Python entry point hands its process to the openmorals program' },
];

const PY_NET = '(?:urllib|urllib3|socket|ssl|http|requests|httpx|aiohttp|asyncio|ftplib|smtplib|poplib|imaplib|telnetlib|xmlrpc|websockets?)';
/** Patterns for the Python sources; a line whose first text is `#` is a comment. */
const PY_PATTERNS: readonly { readonly kind: string; readonly re: RegExp }[] = [
  { kind: 'network module', re: new RegExp(`^\\s*(?:import\\s+(?:[\\w.]+(?:\\s+as\\s+\\w+)?\\s*,\\s*)*|from\\s+)${PY_NET}(?![\\w])`) },
  { kind: 'computed module load', re: /\b__import__\s*\(|\bimportlib\b/ },
  { kind: 'child process', re: /^\s*(?:import\s+(?:[\w.]+(?:\s+as\s+\w+)?\s*,\s*)*|from\s+)(?:subprocess|multiprocessing|pty)(?![\w])|\bos\s*\.\s*(?:system|popen|exec\w*|spawn\w*)\s*\(/ },
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

export function pythonFiles(root: string): string[] {
  const dir = join(root, 'python', 'openmorals');
  try {
    return readdirSync(dir).sort().filter((n) => n.endsWith('.py')).map((n) => join(dir, n));
  } catch {
    return [];
  }
}

export function scanPython(root: string): { files: number; hits: NetworkHit[] } {
  const files = pythonFiles(root);
  const hits: NetworkHit[] = [];
  for (const path of files) {
    const file = relative(root, path).split(sep).join('/');
    readFileSync(path, 'utf8').split('\n').forEach((text, idx) => {
      if (text.trimStart().startsWith('#')) return;
      for (const p of PY_PATTERNS) {
        if (!p.re.test(text)) continue;
        if (ALLOWED.some((a) => a.file === file && text.includes(a.text))) continue;
        hits.push({ file, line: idx + 1, kind: p.kind, text: text.trim() });
        break;
      }
    });
  }
  return { files: files.length, hits };
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

  it('the Python sources the pip package ships have none, apart from the allow-list', () => {
    const { files, hits } = scanPython(REPO_ROOT);
    assert.ok(files >= 3, `the scan read only ${files} Python files; it may have lost the folder`);
    assert.deepEqual(hits, []);
  });

  it('every allow-list entry still matches a line, so a stale entry is noticed', () => {
    for (const a of ALLOWED) {
      const raw = readFileSync(join(REPO_ROOT, a.file), 'utf8');
      const text = a.file.endsWith('.py') ? raw : stripComments(raw);
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
      ["process.getBuiltinModule('https').request(u).end();", 'network module'],
      ["const n = process.getBuiltinModule?.('net');", 'network module'],
      ['const m = process.getBuiltinModule?.(name);', 'computed module load'],
      ["const h = createRequire(import.meta.url)('https');", 'runtime require'],
      ["const r = module.require; r('net');", 'runtime require'],
      ['const t = await import(`node:${m}`);', 'computed module load'],
      ['const f = globalThis.fetch; await f(u);', 'fetch'],
      ['const g = window?.fetch;', 'fetch'],
      ["const k = globalThis['fetch'];", 'fetch'],
      ['await fetch.call(null, u);', 'fetch'],
      ['const call = opts.fetch ?? fetch;', 'fetch'],
      ['const { fetch } = globalThis;', 'fetch'],
      ["import { execFileSync } from 'node:child_process';", 'child process'],
      ["const cp = require('child_process');", 'child process'],
      ["const c = process.getBuiltinModule('node:child_process');", 'child process'],
    ];
    for (const [line, kind] of planted) {
      const { hits } = scanForNetwork(plant([line]));
      assert.ok(hits.some((h) => h.kind === kind && h.file === 'src/deep/planted.ts' && h.line === 1), `missed: ${line}`);
    }
  });

  it('sees a network module or a child process in a planted Python file', () => {
    const planted: readonly [string, string][] = [
      ['import urllib.request', 'network module'],
      ['from http.client import HTTPSConnection', 'network module'],
      ['import os, socket', 'network module'],
      ['    import requests as r', 'network module'],
      ["m = __import__('socket')", 'computed module load'],
      ['import importlib', 'computed module load'],
      ['import subprocess', 'child process'],
      ["os.system('curl x')", 'child process'],
    ];
    for (const [line, kind] of planted) {
      const root = tempDir('no-network-py');
      mkdirSync(join(root, 'python', 'openmorals'), { recursive: true });
      writeFileSync(join(root, 'python', 'openmorals', 'planted.py'), `# import socket in a comment\nimport json\n${line}\n`);
      const { hits } = scanPython(root);
      assert.ok(hits.length === 1 && hits[0]?.kind === kind && hits[0].line === 3, `missed: ${line} ${JSON.stringify(hits)}`);
    }
  });

  it('a new file that starts a program fails, though the same text is allowed in a pinned file', () => {
    const root = plant(["import { spawn } from 'node:child_process';"]);
    assert.deepEqual(scanForNetwork(root).hits.map((h) => h.kind), ['child process']);
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
