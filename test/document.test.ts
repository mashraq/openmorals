import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { decideCall, runClaudeCodeHook, toActions } from '../src/adapters/claude-code.js';
import { codexActions } from '../src/adapters/codex/index.js';
import { geminiActions } from '../src/adapters/gemini-cli/index.js';
import { opencodePermissionActions, opencodeToolActions } from '../src/adapters/opencode/index.js';
import { openclawToolActions } from '../src/adapters/openclaw/index.js';
import { DEFAULT_BYLAWS, DEFAULT_BYLAWS_YAML, parseBylaws, resolveBylaws, validateBylaws } from '../src/bylaws.js';
import { BUILTIN_GUARDS, decide } from '../src/engine.js';
import { CASE_CWD, CASE_HOME, caseFiles } from '../src/eval/cases.js';
import type { Where } from '../src/guard.js';
import { makeWhere, probeFile } from '../src/guard.js';
import { countHeadings, documentGuard } from '../src/guards/document.js';
import { loosenings } from '../src/packs/compare.js';
import { storedAction } from '../src/session.js';
import { withoutContent } from '../src/inbound/outbound.js';
import type { Action, Verdict } from '../src/types.js';
import { EMPTY_STATE } from '../src/types.js';
import { loadCaseFiles } from './case-loader.js';
import { tempDir } from './helpers.js';

const GUIDE = '## Section\n\nA paragraph of the guide that carries real content for a reader.\n\n'.repeat(30);
const NOTES = 'Meeting notes: decisions taken, owners named, dates agreed.\n'.repeat(40);

function whereWith(files: Record<string, unknown>): Where {
  const f = caseFiles(files, CASE_CWD, CASE_HOME);
  assert.ok(f.ok, f.ok ? '' : f.error);
  return makeWhere({ home: CASE_HOME, cwd: CASE_CWD, configDir: `${CASE_HOME}/.config/openmorals`, realpath: (p) => p, exists: () => true, readFile: f.value }, {});
}

/** The built-in guards but the delete guard (0.21.0), which judges a delete of any file: these rows are the document guard's. */
const WITHOUT_DELETE = BUILTIN_GUARDS.filter((g) => g.id !== 'delete');

/** The document guard on its own: the delete guard dropped and switched off (0.22.0: with it on, a document the trash can take, a move into a temp folder and an overwrite are its). */
function judge(actions: readonly Action[], files: Record<string, unknown>, bylaws: unknown = null): Verdict {
  const raw = (bylaws ?? { version: 1 }) as { guards?: Record<string, unknown> };
  const load = validateBylaws({ ...raw, guards: { delete: { decision: 'allow' }, ...(raw.guards ?? {}) } });
  return decideCall(actions[0]?.tool ?? 'x', actions, load, EMPTY_STATE, WITHOUT_DELETE, whereWith(files));
}

function patch(body: string): string {
  return `*** Begin Patch\n${body}*** End Patch\n`;
}

const removeTwentyLines = Array.from({ length: 20 }, () => '-Meeting notes: decisions taken, owners named, dates agreed.\n').join('');

describe('document guard: every host whose write tools say what they replace', () => {
  const rows: { host: string; actions: () => Action[]; files: Record<string, unknown>; expect: string; rule?: string }[] = [
    { host: 'codex', actions: () => codexActions('apply_patch', { command: patch(`*** Update File: notes.txt\n@@\n${removeTwentyLines}+Kept one line.\n`) }).actions, files: { 'notes.txt': NOTES }, expect: 'ask', rule: 'document.shrink' },
    { host: 'codex', actions: () => codexActions('apply_patch', { command: patch('*** Update File: notes.txt\n@@\n-Meeting notes: decisions taken, owners named, dates agreed.\n+Meeting notes: decisions taken, owners named, dates agreed and written down.\n') }).actions, files: { 'notes.txt': NOTES }, expect: 'allow' },
    { host: 'codex', actions: () => codexActions('apply_patch', { command: patch('*** Delete File: docs/guide.md\n') }).actions, files: { 'docs/guide.md': GUIDE }, expect: 'ask', rule: 'document.delete' },
    { host: 'codex', actions: () => codexActions('apply_patch', { command: patch('*** Delete File: src/old.ts\n') }).actions, files: { 'src/old.ts': 'export {};\n' }, expect: 'allow' },
    { host: 'codex', actions: () => codexActions('apply_patch', { command: patch('*** Add File: docs/guide.md\n+# Guide\n') }).actions, files: { 'docs/guide.md': GUIDE }, expect: 'ask', rule: 'document.shrink' },
    { host: 'codex', actions: () => codexActions('apply_patch', { command: patch('*** Update File: docs/guide.md\n@@\n-## Section\n+Section\n') }).actions, files: { 'docs/guide.md': GUIDE }, expect: 'ask', rule: 'document.heading' },
    { host: 'codex', actions: () => codexActions('apply_patch', { command: patch('*** Update File: docs/a.md\n*** Move to: docs/guide.md\n@@\n+x\n') }).actions, files: { 'docs/a.md': '# A\n', 'docs/guide.md': GUIDE }, expect: 'ask', rule: 'document.unknown' },
    { host: 'gemini-cli', actions: () => geminiActions('write_file', { file_path: '/work/app/docs/guide.md', content: '' }).actions, files: { 'docs/guide.md': GUIDE }, expect: 'ask', rule: 'document.empty' },
    { host: 'gemini-cli', actions: () => geminiActions('replace', { file_path: '/work/app/notes.txt', old_string: 'Meeting notes: decisions taken, owners named, dates agreed.\n', new_string: '', allow_multiple: true }).actions, files: { 'notes.txt': NOTES }, expect: 'ask', rule: 'document.empty' },
    { host: 'gemini-cli', actions: () => geminiActions('replace', { file_path: '/work/app/notes.txt', old_string: 'dates agreed', new_string: 'dates fixed' }).actions, files: { 'notes.txt': NOTES }, expect: 'allow' },
    { host: 'gemini-cli', actions: () => geminiActions('replace', { file_path: '/work/app/notes.txt', old_string: 'x', new_string: 'y', allow_multiple: 'yes' }).actions, files: { 'notes.txt': NOTES }, expect: 'ask', rule: 'document.unknown' },
    { host: 'opencode', actions: () => opencodeToolActions('write', { filePath: '/work/app/docs/guide.md', content: '## Section\n' }).actions, files: { 'docs/guide.md': GUIDE }, expect: 'ask', rule: 'document.shrink' },
    { host: 'opencode', actions: () => opencodeToolActions('edit', { filePath: '/work/app/docs/guide.md', oldString: '## Section\n\n', newString: '', replaceAll: true }).actions, files: { 'docs/guide.md': GUIDE }, expect: 'ask', rule: 'document.heading' },
    { host: 'opencode', actions: () => opencodeToolActions('edit', { filePath: '/work/app/docs/guide.md', oldString: 'real content', newString: 'useful content' }).actions, files: { 'docs/guide.md': GUIDE }, expect: 'allow' },
    { host: 'opencode', actions: () => opencodeToolActions('patch', { patchText: patch('*** Delete File: notes.txt\n') }).actions, files: { 'notes.txt': NOTES }, expect: 'ask', rule: 'document.delete' },
    { host: 'opencode', actions: () => opencodePermissionActions('edit', ['/work/app/docs/guide.md']).actions, files: { 'docs/guide.md': GUIDE }, expect: 'ask', rule: 'document.unknown' },
    { host: 'opencode', actions: () => opencodePermissionActions('edit', ['/work/app/docs/new.md']).actions, files: {}, expect: 'allow' },
    { host: 'openclaw', actions: () => openclawToolActions('write', { path: '/work/app/docs/guide.md', content: '' }, []).actions, files: { 'docs/guide.md': GUIDE }, expect: 'ask', rule: 'document.empty' },
    { host: 'openclaw', actions: () => openclawToolActions('edit', { path: '/work/app/docs/guide.md', edits: [{ a: 'x', b: 'y' }] }, []).actions, files: { 'docs/guide.md': GUIDE }, expect: 'ask', rule: 'document.unknown' },
    { host: 'openclaw', actions: () => openclawToolActions('apply_patch', { input: patch('*** Delete File: docs/guide.md\n') }, ['docs/guide.md']).actions, files: { 'docs/guide.md': GUIDE }, expect: 'ask', rule: 'document.delete' },
    { host: 'openclaw', actions: () => openclawToolActions('apply_patch', { input: patch('*** Update File: docs/x.md\n@@\n+y\n') }, ['docs/guide.md']).actions, files: { 'docs/guide.md': GUIDE }, expect: 'ask', rule: 'document.unknown' },
    { host: 'claude-code', actions: () => toActions('NotebookEdit', { notebook_path: '/work/app/n.ipynb', new_source: '' }), files: { 'n.ipynb': '{}' }, expect: 'allow' },
    { host: 'claude-code', actions: () => toActions('MultiEdit', { file_path: '/work/app/docs/guide.md', edits: [{ text: 'x' }] }), files: { 'docs/guide.md': GUIDE }, expect: 'ask', rule: 'document.unknown' },
  ];
  for (const r of rows) {
    it(`${r.host}: ${JSON.stringify(r.actions().map((a) => withoutContent(a)))} -> ${r.expect} ${r.rule ?? ''}`, () => {
      const v = judge(r.actions(), r.files);
      assert.equal(v.decision, r.expect, `${v.rule}: ${v.reason}`);
      if (r.rule !== undefined) assert.equal(v.rule, r.rule, v.reason);
    });
  }
});

describe('document guard: what it cannot judge, it asks about', () => {
  const big = 'word '.repeat(60000);
  it('a whole-file write over the 262,144-byte cap that removes nothing asks, because the text was cut', () => {
    const v = judge(toActions('Write', { file_path: '/work/app/big.md', content: `${big}tail\n` }), { 'big.md': `${big}\n` });
    assert.equal(v.decision, 'ask');
    assert.equal(v.rule, 'document.unknown');
    assert.match(v.reason, /cut/);
  });
  it('the shrink is judged on the exact size even when the text was cut', () => {
    const v = judge(toActions('Write', { file_path: '/work/app/big.txt', content: big }), { 'big.txt': { bytes: 1000000 } });
    assert.equal(v.rule, 'document.shrink');
  });
  it('a heading check on a document over the bytes read asks', () => {
    const v = judge(toActions('Write', { file_path: '/work/app/big.md', content: 'word '.repeat(50000) }), { 'big.md': { bytes: 300000 } });
    assert.equal(v.rule, 'document.unknown');
    assert.match(v.reason, /over the 262,144 bytes openmorals reads/);
  });
  it('an unreadable file asks on a write, on rm and never allows', () => {
    for (const a of [toActions('Write', { file_path: '/work/app/docs/guide.md', content: 'x' }), toActions('Bash', { command: 'rm docs/guide.md' })]) {
      const v = judge(a, { 'docs/guide.md': { error: 'EACCES' } });
      assert.equal(v.decision, 'ask', v.reason);
      assert.equal(v.rule, 'document.unreadable');
    }
  });
  it('a guard that throws asks (document.error), it never allows', () => {
    const where = { ...whereWith({}), readFile: () => { throw new Error('boom'); } };
    const v = decide(toActions('Write', { file_path: '/work/app/docs/guide.md', content: '' })[0] as Action, DEFAULT_BYLAWS, EMPTY_STATE, BUILTIN_GUARDS, where);
    assert.equal(v.decision, 'ask');
    assert.equal(v.rule, 'document.error');
  });
  it('a policy object without the document section still gets the guard with its defaults', () => {
    const b = JSON.parse(JSON.stringify(DEFAULT_BYLAWS)) as typeof DEFAULT_BYLAWS;
    delete b.guards.document;
    const v = decide(toActions('Write', { file_path: '/work/app/docs/guide.md', content: '' })[0] as Action, b, EMPTY_STATE, BUILTIN_GUARDS, whereWith({ 'docs/guide.md': GUIDE }));
    assert.equal(v.rule, 'document.empty');
  });
  it('an invalid bylaws file: the defaults apply, so the guard still asks', () => {
    const load = parseBylaws('version: 1\nguards:\n  document: { shrink_percent: 0 }\n');
    assert.equal(load.ok, false);
    const v = decideCall('Write', toActions('Write', { file_path: '/work/app/docs/guide.md', content: '' }), load, EMPTY_STATE, BUILTIN_GUARDS, whereWith({ 'docs/guide.md': GUIDE }));
    assert.equal(v.decision, 'ask');
    assert.equal(v.rule, 'document.empty');
    assert.match(v.reason, /bylaws file .* is invalid/);
  });
});

describe('document guard: settings', () => {
  it('the commented default file holds the section, and it parses to the defaults', () => {
    assert.match(DEFAULT_BYLAWS_YAML, /\n {2}document:\n/);
    const r = parseBylaws(DEFAULT_BYLAWS_YAML);
    assert.ok(r.ok);
    assert.deepEqual(r.bylaws.guards.document, DEFAULT_BYLAWS.guards.document);
    assert.equal(DEFAULT_BYLAWS.guards.document?.shrink_percent, 25);
    assert.equal(DEFAULT_BYLAWS.guards.document?.decision, 'ask');
  });
  it('refuses bad values with the reason', () => {
    for (const [yaml, re] of [
      ['shrink_percent: 0', /shrink_percent: must be a whole number from 1 to 100/],
      ['shrink_percent: 101', /shrink_percent/],
      ['shrink_percent: 2.5', /shrink_percent/],
      ['min_removed_bytes: -1', /min_removed_bytes/],
      ['extensions: [.md]', /extensions: must be a list of file name extensions/],
      ['extensions: [MD]', /extensions/],
      ['exclude: [/abs/**]', /exclude: "\/abs\/\*\*" must be relative/],
      ['decision: maybe', /decision: must be allow, ask or deny/],
      ['other: 1', /unknown key \(allowed: decision, shrink_percent, min_removed_bytes, extensions, exclude\)/],
    ] as const) {
      const r = parseBylaws(`version: 1\nguards:\n  document: { ${yaml} }\n`);
      assert.equal(r.ok, false, yaml);
      if (!r.ok) assert.match(r.error, re, yaml);
    }
  });
  it('the settings change what is asked: a lower share asks sooner, allow switches it off, a new extension counts', () => {
    const cut = toActions('Write', { file_path: '/work/app/notes.txt', content: NOTES.slice(0, Math.floor(NOTES.length * 0.85)) });
    assert.equal(judge(cut, { 'notes.txt': NOTES }).decision, 'allow');
    assert.equal(judge(cut, { 'notes.txt': NOTES }, { version: 1, guards: { document: { shrink_percent: 10, min_removed_bytes: 100 } } }).rule, 'document.shrink');
    const empty = toActions('Write', { file_path: '/work/app/docs/guide.md', content: '' });
    assert.equal(judge(empty, { 'docs/guide.md': GUIDE }, { version: 1, guards: { document: { decision: 'allow' } } }).decision, 'allow');
    assert.equal(judge(empty, { 'docs/guide.md': GUIDE }, { version: 1, guards: { document: { decision: 'deny' } } }).decision, 'deny');
    const log = toActions('Bash', { command: 'rm notes.log' });
    assert.equal(judge(log, { 'notes.log': NOTES }).decision, 'allow');
    assert.equal(judge(log, { 'notes.log': NOTES }, { version: 1, guards: { document: { extensions: ['log'] } } }).rule, 'document.delete');
    assert.equal(judge(empty, { 'docs/guide.md': GUIDE }, { version: 1, guards: { document: { exclude: ['docs/**'] } } }).decision, 'allow');
  });
  it('with destructive switched off, the document guard asks on a forced delete of a document', () => {
    const v = judge(toActions('Bash', { command: 'rm -f docs/guide.md' }), { 'docs/guide.md': GUIDE }, { version: 1, guards: { destructive: { decision: 'allow' } } });
    assert.equal(v.rule, 'document.delete');
  });
  it('a project file can tighten and never loosen (ADR 0010); each loosening is listed', () => {
    const home = tempDir('doc-home');
    const cwd = tempDir('doc-cwd');
    writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\nguards:\n  document: { shrink_percent: 20, min_removed_bytes: 256 }\n');
    writeFileSync(join(cwd, 'openmorals.yaml'), 'version: 1\nguards:\n  document: { decision: allow, shrink_percent: 90, min_removed_bytes: 100000, extensions: [md], exclude: [docs, node_modules] }\n');
    const r = resolveBylaws(cwd, { OPENMORALS_HOME: home });
    assert.ok(r.ok);
    const d = r.bylaws.guards.document;
    assert.equal(d?.decision, 'ask');
    assert.equal(d?.shrink_percent, 20);
    assert.equal(d?.min_removed_bytes, 256);
    assert.deepEqual(d?.exclude, ['node_modules']);
    assert.ok(d?.extensions.includes('txt') && d.extensions.includes('docx'));
    const fields = (r.ignored ?? []).map((l) => l.field);
    for (const f of ['guards.document.decision', 'guards.document.shrink_percent', 'guards.document.min_removed_bytes', 'guards.document.extensions', 'guards.document.exclude']) assert.ok(fields.includes(f), `${f} in ${fields.join(', ')}`);
    const tight = tempDir('doc-cwd2');
    writeFileSync(join(tight, 'openmorals.yaml'), 'version: 1\nguards:\n  document: { decision: deny, shrink_percent: 5, min_removed_bytes: 0, exclude: [] }\n');
    const t = resolveBylaws(tight, { OPENMORALS_HOME: home });
    assert.ok(t.ok);
    assert.deepEqual([t.bylaws.guards.document?.decision, t.bylaws.guards.document?.shrink_percent, t.bylaws.guards.document?.min_removed_bytes, t.bylaws.guards.document?.exclude], ['deny', 5, 0, []]);
    assert.deepEqual(t.bylaws.guards.document?.extensions, DEFAULT_BYLAWS.guards.document?.extensions);
    assert.deepEqual(t.ignored?.filter((l) => l.field.startsWith('guards.document')) ?? [], []);
  });
  it('loosenings() names every document setting a pack would loosen', () => {
    const c = JSON.parse(JSON.stringify(DEFAULT_BYLAWS)) as typeof DEFAULT_BYLAWS;
    c.guards.document = { decision: 'allow', shrink_percent: 50, min_removed_bytes: 4096, extensions: ['md'], exclude: ['docs'] };
    const fields = [...new Set(loosenings(c, DEFAULT_BYLAWS).map((l) => l.field))].sort();
    assert.deepEqual(fields, ['guards.document.decision', 'guards.document.exclude', 'guards.document.extensions', 'guards.document.min_removed_bytes', 'guards.document.shrink_percent']);
  });
});

describe('document guard: headings', () => {
  it('counts each syntax and skips code fences', () => {
    assert.equal(countHeadings('# A\n\n```\n# not\n```\n## B\nText\n===\n', 'markdown'), 3);
    assert.equal(countHeadings('---\ntitle: x\n---\n# A\n', 'markdown'), 1);
    assert.equal(countHeadings('- item\n---\n| a |\n|---|\n', 'markdown'), 0);
    assert.equal(countHeadings('Title\n=====\n\nSub\n---\n', 'rst'), 2);
    assert.equal(countHeadings('= Doc\n== Part\ntext\n', 'asciidoc'), 2);
    assert.equal(countHeadings('* One\n** Two\ntext *bold*\n', 'org'), 2);
    assert.equal(countHeadings('\\section{A}\\subsection*{B}\\emph{c}', 'tex'), 2);
    assert.equal(countHeadings('# A\n', null), 0);
  });
});

describe('document guard: nothing of a file is kept', () => {
  it('storedAction and withoutContent drop the change and the content', () => {
    const a = toActions('Edit', { file_path: '/work/app/docs/guide.md', old_string: 'SECRET-OLD-TEXT', new_string: 'SECRET-NEW-TEXT' })[0] as Action;
    assert.ok(a.kind === 'write' && a.change !== undefined);
    for (const s of [storedAction(a), withoutContent(a)]) assert.ok(!JSON.stringify(s).includes('SECRET-'), JSON.stringify(s));
  });
  it('through the Claude Code hook on real files: emptying asks, an ordinary edit is allowed, and no text of the file or the edit reaches the config folder', () => {
    const proj = tempDir('doc-proj');
    const home = tempDir('doc-home');
    mkdirSync(join(proj, 'docs'));
    const text = `# Guide\n\nMARKER-FILE-TEXT\n\n${GUIDE}`;
    writeFileSync(join(proj, 'docs', 'guide.md'), text);
    const env = { OPENMORALS_HOME: home, OPENMORALS_UNATTENDED: '' };
    const ev = (o: Record<string, unknown>): string => JSON.stringify({ session_id: 'doc1', cwd: proj, hook_event_name: 'PreToolUse', ...o });
    const file = join(proj, 'docs', 'guide.md');
    const empty = runClaudeCodeHook(ev({ tool_name: 'Write', tool_input: { file_path: file, content: '' } }), { env });
    assert.equal(empty.verdict.decision, 'ask');
    assert.equal(empty.verdict.rule, 'document.empty');
    const edit = runClaudeCodeHook(ev({ tool_name: 'Edit', tool_input: { file_path: file, old_string: 'MARKER-FILE-TEXT', new_string: 'MARKER-EDIT-TEXT' } }), { env });
    assert.equal(edit.verdict.decision, 'allow', edit.verdict.reason);
    const unattended = runClaudeCodeHook(ev({ tool_name: 'Write', tool_input: { file_path: file, content: '' } }), { env: { ...env, OPENMORALS_UNATTENDED: '1' } });
    assert.equal(unattended.verdict.decision, 'deny');
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(home);
    assert.ok(files.length >= 2, files.join(', '));
    for (const f of files) for (const m of ['MARKER-FILE-TEXT', 'MARKER-EDIT-TEXT', 'A paragraph of the guide']) assert.ok(!readFileSync(f, 'utf8').includes(m), `${f} holds ${m}`);
  });
});

describe('probeFile reads what is on disk, bounded', () => {
  it('missing, folder, small file with text, big file without, unreadable file', () => {
    const d = tempDir('doc-probe');
    writeFileSync(join(d, 'a.md'), 'hello');
    writeFileSync(join(d, 'b.md'), 'x'.repeat(5000));
    writeFileSync(join(d, 'c.md'), 'secret');
    chmodSync(join(d, 'c.md'), 0o000);
    assert.deepEqual(probeFile(join(d, 'none.md'), 100), { kind: 'missing' });
    assert.deepEqual(probeFile(join(d, 'none', 'x.md'), 100), { kind: 'missing' });
    assert.deepEqual(probeFile(d, 100), { kind: 'other' });
    assert.deepEqual(probeFile(join(d, 'a.md'), 100), { kind: 'file', bytes: 5, text: 'hello' });
    assert.deepEqual(probeFile(join(d, 'a.md'), 0), { kind: 'file', bytes: 5 });
    assert.deepEqual(probeFile(join(d, 'b.md'), 100), { kind: 'file', bytes: 5000 });
    const c = probeFile(join(d, 'c.md'), 100);
    if (process.getuid?.() !== 0) assert.deepEqual(c, { kind: 'error', error: 'EACCES' });
    chmodSync(join(d, 'c.md'), 0o600);
  });
});

describe('0.18.0 decides every existing row as 0.17.0 did (the document guard is silent on them)', () => {
  it('every row of every other case file gets the same verdict with and without the document guard', () => {
    const without = BUILTIN_GUARDS.filter((g) => g !== documentGuard);
    let rows = 0;
    for (const f of loadCaseFiles()) {
      if (f.guard === 'document') continue;
      for (const c of f.cases) {
        const load = c.bylaws === null ? DEFAULT_BYLAWS : validateBylaws(c.bylaws);
        const a = decideCall(c.tool, c.actions, load, c.state, BUILTIN_GUARDS, c.where);
        const b = decideCall(c.tool, c.actions, load, c.state, without, c.where);
        assert.deepEqual(a, b, `${f.file}: ${c.label}`);
        rows++;
      }
    }
    assert.ok(rows >= 450, String(rows));
  });
});
