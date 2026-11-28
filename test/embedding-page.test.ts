import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { REPO_ROOT } from './helpers.js';

// 0.44.1: docs/embedding.md shows where a program can call the check. Each code block on the page is a file under
// test/fixtures/embedding/, byte for byte. The TypeScript ones are type-checked against the package's own built
// types (the SDK's types come from a labelled stand-in), and the loop you write yourself is run in a temporary
// config folder. The Python one is run by python/tests/test_embedding_page.py. No framework is installed, nothing
// here opens a connection or calls a model. The fixtures folder is left out of tsconfig.json, so the build does not
// compile it and nothing in it can reach dist/.

const PAGE = join(REPO_ROOT, 'docs', 'embedding.md');
const FIXTURES = join(REPO_ROOT, 'test', 'fixtures', 'embedding');
const STAND_IN = 'claude-agent-sdk.stand-in.d.ts';

export interface PageBlock {
  fixture: string | null;
  lang: string;
  body: string;
}

/**
 * Every code block of a Markdown page, with the fixture its marker line names (or null when there is none): fences
 * of backticks or tildes, and indented blocks (4 spaces or a tab after a blank line), which never have a marker.
 */
export function pageBlocks(text: string): PageBlock[] {
  const lines = text.split('\n');
  const out: PageBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^( {4}|\t)/.test(line) && (lines[i - 1] ?? '').trim() === '') {
      let end = i;
      while (end < lines.length && (/^( {4}|\t)/.test(lines[end] ?? '') || (lines[end] ?? '').trim() === '')) end++;
      out.push({ fixture: null, lang: 'indented', body: lines.slice(i, end).map((l) => `${l}\n`).join('') });
      i = end - 1;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!open) continue;
    const fence = open[1] ?? '```';
    const close = new RegExp(`^ {0,3}${fence[0] === '~' ? '~' : '`'}{${fence.length},}\\s*$`);
    let end = i + 1;
    while (end < lines.length && !close.test(lines[end] ?? '')) end++;
    assert.ok(end < lines.length, `an unclosed code block at line ${i + 1}`);
    const marker = /^<!-- fixture: test\/fixtures\/embedding\/([\w.-]+) -->$/.exec(lines[i - 1] ?? '');
    out.push({ fixture: marker?.[1] ?? null, lang: (open[2] ?? '').trim(), body: lines.slice(i + 1, end).map((l) => `${l}\n`).join('') });
    i = end;
  }
  return out;
}

/** The entries of the page: each `### ` section under `## Where to call it`, up to the next `## `. */
export function pageEntries(text: string): { title: string; body: string }[] {
  const start = text.indexOf('\n## Where to call it\n');
  assert.ok(start >= 0, 'the page has no "## Where to call it" section');
  const rest = text.slice(start + 1);
  const next = rest.indexOf('\n## ', 1);
  const section = next < 0 ? rest : rest.slice(0, next);
  return section
    .split(/\n(?=### )/)
    .slice(1)
    .map((s) => ({ title: s.split('\n')[0] ?? '', body: s }));
}

const DATE = /\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}\b/;

/** What an entry lacks: a "Checked:" line with a date, and the "not run live by us" line. */
export function entryProblems(entry: { title: string; body: string }): string[] {
  const out: string[] = [];
  const checked = entry.body.split('\n').find((l) => l.startsWith('Checked: '));
  if (checked === undefined || !DATE.test(checked)) out.push(`${entry.title}: no "Checked:" line with a date`);
  if (!/not run live by us/i.test(entry.body)) out.push(`${entry.title}: no "not run live by us" line`);
  return out;
}

/** Words the page must never put before a framework's name, and claims it must never make. */
export const BANNED: readonly RegExp[] = [
  /\bsupports?\b/i,
  /\bintegrates? with\b/i,
  /\bworks? with\b/i,
  /\bcompatible with\b/i,
  /guards any agent/i,
  /every framework/i,
  /\bpip install\b/i,
  /\bnpm install (-g )?openmorals\b/i,
  /control[\s-]+plane/i,
];

/** Every type error the TypeScript checker finds in the TypeScript fixtures. */
export function fixtureTypeErrors(files: readonly string[]): string[] {
  const prog = ts.createProgram([...files], {
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noImplicitAny: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    skipLibCheck: true,
    types: ['node'],
    typeRoots: [join(REPO_ROOT, 'node_modules', '@types')],
  });
  return ts.getPreEmitDiagnostics(prog).map((d) => {
    const where = d.file && d.start !== undefined ? `${d.file.fileName}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}: ` : '';
    return `${where}${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`;
  });
}

describe('docs/embedding.md (0.44.1)', () => {
  const page = readFileSync(PAGE, 'utf8');
  const blocks = pageBlocks(page);

  it('has a fixture for every code block, byte for byte, and uses every fixture once', () => {
    assert.ok(blocks.length > 0, 'the page has no code block');
    for (const b of blocks) {
      assert.ok(b.fixture !== null, `a ${b.lang} block has no fixture marker line above it:\n${b.body}`);
      assert.equal(b.body, readFileSync(join(FIXTURES, b.fixture), 'utf8'), `the block for ${b.fixture} differs from its fixture`);
    }
    const used = blocks.map((b) => b.fixture).sort();
    const files = readdirSync(FIXTURES).filter((f) => f !== STAND_IN).sort();
    assert.deepEqual(used, files);
  });

  it('sees backtick and tilde fences and indented blocks, so none can sit on the page unpinned', () => {
    const got = pageBlocks('a\n\n```ts\nx\n```\n\n~~~~sh\ny\n~~~\n~~~~\n\n    z\n\tw\n\nb\n');
    assert.deepEqual(got.map((b) => [b.lang, b.body, b.fixture]), [['ts', 'x\n', null], ['sh', 'y\n~~~\n', null], ['indented', '    z\n\tw\n\n', null]]);
  });

  it('has at most three entries, each with a date it was checked and the line "not run live by us"', () => {
    const entries = pageEntries(page);
    assert.ok(entries.length >= 1 && entries.length <= 3, `${entries.length} entries`);
    assert.deepEqual(entries.flatMap(entryProblems), []);
    const frameworks = entries.filter((e) => !/yourself/.test(e.title));
    for (const e of frameworks) assert.match(e.body, /Documentation read: "[^"]+"/, `${e.title}: no documentation page named`);
  });

  it('puts the limits first and uses none of the banned words', () => {
    const first = page.indexOf('\n## ');
    assert.ok(page.slice(first).startsWith('\n## Read this first: what this is, and what it is not\n'));
    for (const w of BANNED) assert.doesNotMatch(page, w);
  });

  it('names the tarball of the package version', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string };
    const names = [...page.matchAll(/openmorals-(\d+\.\d+\.\d+)\.tgz/g)].map((m) => m[1]);
    assert.ok(names.length > 0);
    for (const v of names) assert.equal(v, pkg.version);
  });

  it('the TypeScript fixtures type-check against the built package types and the labelled stand-in', () => {
    const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.ts')).map((f) => join(FIXTURES, f));
    assert.ok(files.length >= 3, files.join(', '));
    assert.match(readFileSync(join(FIXTURES, STAND_IN), 'utf8'), /^\/\/ A STAND-IN, not the real package\./);
    assert.deepEqual(fixtureTypeErrors(files), []);
  });

  it('catches a fixture that names an export the package does not have', () => {
    const dir = mkdtempSync(join(FIXTURES, '..', 'embedding-broken-'));
    try {
      const bad = join(dir, 'bad.ts');
      writeFileSync(bad, readFileSync(join(FIXTURES, 'own-loop.ts'), 'utf8').replace(/\bguardCall\b/g, 'guardCallRenamed'));
      assert.ok(fixtureTypeErrors([bad]).some((e) => /guardCallRenamed/.test(e)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

type ToolCall = { name: string; input: Record<string, unknown> };
type CallTool = (call: ToolCall, run: (call: ToolCall) => Promise<string>, askPerson?: (reason: string) => Promise<boolean>) => Promise<string>;

describe('the loop you write yourself, run (0.44.1)', () => {
  const root = mkdtempSync(join(tmpdir(), 'openmorals-test-embedding-'));
  const saved = { cwd: process.cwd(), env: { ...process.env } };
  let callTool: CallTool;

  before(async () => {
    const src = readFileSync(join(FIXTURES, 'own-loop.ts'), 'utf8');
    const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText;
    const entry = pathToFileURL(join(REPO_ROOT, 'dist', 'src', 'index.js')).href;
    const wired = js.replace('from "openmorals"', `from ${JSON.stringify(entry)}`);
    assert.notEqual(wired, js, 'the loop does not import "openmorals"');
    const file = join(root, 'own-loop.mjs');
    writeFileSync(file, wired);
    process.env['OPENMORALS_HOME'] = join(root, 'config');
    delete process.env['OPENMORALS_UNATTENDED'];
    delete process.env['OPENMORALS_RUN'];
    process.chdir(root);
    callTool = ((await import(pathToFileURL(file).href)) as { callTool: CallTool }).callTool;
  });

  after(() => {
    process.chdir(saved.cwd);
    for (const k of ['OPENMORALS_HOME', 'OPENMORALS_UNATTENDED', 'OPENMORALS_RUN']) {
      if (saved.env[k] === undefined) delete process.env[k];
      else process.env[k] = saved.env[k];
    }
    rmSync(root, { recursive: true, force: true });
  });

  const ran: string[] = [];
  const run = async (c: ToolCall): Promise<string> => {
    ran.push(String(c.input['command']));
    return 'ran';
  };

  it('runs a harmless command', async () => {
    assert.equal(await callTool({ name: 'run_shell', input: { command: 'ls' } }, run), 'ran');
    assert.deepEqual(ran, ['ls']);
  });

  it('does not run rm -rf ~ with nobody to ask, and says why', async () => {
    const r = await callTool({ name: 'run_shell', input: { command: 'rm -rf ~' } }, run);
    assert.match(r, /^not run \(openmorals deny, destructive\.[\w-]+\): /);
    assert.deepEqual(ran, ['ls']);
  });

  it('asks the person, and runs rm -rf ~ only when they say yes', async () => {
    const asked: string[] = [];
    const no = await callTool({ name: 'run_shell', input: { command: 'rm -rf ~' } }, run, async (reason) => (asked.push(reason), false));
    assert.match(no, /^not run \(openmorals ask, destructive\.[\w-]+\): /);
    assert.equal(asked.length, 1);
    assert.deepEqual(ran, ['ls']);
    assert.equal(await callTool({ name: 'run_shell', input: { command: 'rm -rf ~' } }, run, async () => true), 'ran');
    assert.deepEqual(ran, ['ls', 'rm -rf ~']);
  });

  it('does not run a tool it does not know with nobody to ask', async () => {
    const r = await callTool({ name: 'delete_rows', input: { table: 'users' } }, run);
    assert.match(r, /^not run \(openmorals deny, embed\.(unknown-tool|delete-name)\): /);
  });
});
