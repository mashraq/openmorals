import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { decideCall, runClaudeCodeHook, toActions } from '../src/adapters/claude-code.js';
import { codexActions } from '../src/adapters/codex/index.js';
import { geminiActions } from '../src/adapters/gemini-cli/index.js';
import { openclawToolActions } from '../src/adapters/openclaw/index.js';
import { opencodePermissionActions, opencodeToolActions } from '../src/adapters/opencode/index.js';
import { readAudit } from '../src/audit.js';
import { DEFAULT_BYLAWS, DEFAULT_BYLAWS_YAML, cloneBylaws, parseBylaws, validateBylaws } from '../src/bylaws.js';
import { actionTexts, decide, ruleOutcome, unknownNote } from '../src/engine.js';
import { ACTION_TEXT_MAX_BYTES, withoutContent } from '../src/inbound/outbound.js';
import type { ContentHost } from '../src/inbound/outbound.js';
import { loosenings, tighten } from '../src/packs/compare.js';
import { auditLogPath } from '../src/paths.js';
import { MAX_CONTENT_PATTERN_CHARS, MAX_CONTENT_STEPS, compileContentPattern } from '../src/rules/pattern.js';
import { EMPTY_MEMORY, recordAction, taintContext } from '../src/session.js';
import type { Action, Bylaws, Decision, Rule } from '../src/types.js';
import { EMPTY_STATE } from '../src/types.js';
import { CASE_CWD, loadCaseFiles } from './case-loader.js';
import { REPO_ROOT, tempDir } from './helpers.js';

interface Big {
  bytes: number;
  needle?: string;
  at?: 'head' | 'middle' | 'tail';
  kind?: 'ab';
}

interface Row {
  name: string;
  host: ContentHost;
  tool: string;
  input: Record<string, unknown>;
  derived?: string[];
  rules: string[];
  big?: Big;
  expect: Decision;
  rule?: string;
  reason?: 'cut' | 'steps' | 'match';
}

const ROWS_FILE = join(REPO_ROOT, 'cases', 'content-rules.rows.yaml');
const DOC = parse(readFileSync(ROWS_FILE, 'utf8')) as { rules: Record<string, unknown>; rows: Row[] };
const HOSTS: readonly ContentHost[] = ['claude-code', 'codex', 'gemini-cli', 'opencode', 'openclaw'];
const CUT_NOTE = 'over the 262,144-byte cap and was cut';
const STEPS_NOTE = 'needed more steps than allowed';

function mapped(host: ContentHost, tool: string, input: Record<string, unknown>, derived: readonly string[] = []): Action[] {
  switch (host) {
    case 'claude-code':
      return toActions(tool, input);
    case 'codex':
      return codexActions(tool, input).actions;
    case 'gemini-cli':
      return geminiActions(tool, input).actions;
    case 'opencode':
      return opencodeToolActions(tool, input).actions;
    case 'openclaw':
      return openclawToolActions(tool, input, derived).actions;
  }
}

function filler(bytes: number, kind?: 'ab'): string {
  if (kind === 'ab') {
    let seed = 7;
    let s = '';
    const chunk: string[] = [];
    for (let i = 0; i < bytes; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      chunk.push((seed >> 8) & 1 ? 'a' : 'b');
      if (chunk.length === 4096) {
        s += chunk.join('');
        chunk.length = 0;
      }
    }
    return s + chunk.join('');
  }
  const line = 'lorem ipsum dolor sit amet\n';
  return line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes);
}

function bigText(b: Big): string {
  let s = filler(b.bytes, b.kind);
  if (b.needle !== undefined) {
    const n = b.needle;
    const pos = b.at === 'head' ? 0 : b.at === 'tail' ? b.bytes - n.length - 1 : Math.floor(b.bytes / 2);
    s = `${s.slice(0, pos)}${n}${s.slice(pos + n.length)}`;
  }
  return s;
}

function fill(v: unknown, big: Big | undefined): unknown {
  if (big === undefined) return v;
  if (v === '@@BIG@@') return bigText(big);
  if (typeof v === 'string' && v.includes('@@BIGPLUS@@')) return v.replace('@@BIGPLUS@@', bigText(big).split('\n').map((l) => `+${l}`).join('\n'));
  if (Array.isArray(v)) return v.map((x) => fill(x, big));
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, big)]));
  return v;
}

function bylawsFor(names: readonly string[]): Bylaws {
  const load = validateBylaws({ version: 1, rules: names.map((n) => DOC.rules[n]) }, ROWS_FILE);
  assert.ok(load.ok, load.ok ? '' : load.error);
  return load.bylaws;
}

function judgeRow(r: Row, bylaws: Bylaws = bylawsFor(r.rules)): ReturnType<typeof decideCall> {
  const input = fill(r.input, r.big) as Record<string, unknown>;
  return decideCall(r.tool, mapped(r.host, r.tool, input, r.derived), { ok: true, bylaws, source: ROWS_FILE }, EMPTY_STATE);
}

describe('content rules on every host (cases/content-rules.rows.yaml; shapes from documentation, not a live run)', () => {
  it('cover every host with a true and a false write row, and every over-cap branch', () => {
    for (const h of HOSTS) {
      const writes = DOC.rows.filter((r) => r.host === h && r.big === undefined);
      if (h !== 'claude-code') {
        assert.ok(writes.some((r) => r.expect !== 'allow'), `${h}: no row a content rule catches`);
        assert.ok(writes.some((r) => r.expect === 'allow'), `${h}: no row a content rule leaves alone`);
      }
      assert.ok(DOC.rows.some((r) => r.host === h && r.big !== undefined && r.big.bytes > ACTION_TEXT_MAX_BYTES && r.expect === 'deny'), `${h}: no over-cap deny row`);
      assert.ok(DOC.rows.some((r) => r.host === h && r.big !== undefined && r.big.bytes > ACTION_TEXT_MAX_BYTES && r.expect === 'ask'), `${h}: no over-cap ask row`);
    }
    for (const reason of ['cut', 'steps', 'match'] as const) assert.ok(DOC.rows.some((r) => r.reason === reason), `no ${reason} row`);
    assert.ok(DOC.rows.some((r) => r.big !== undefined && r.big.bytes <= ACTION_TEXT_MAX_BYTES && r.expect === 'allow'), 'no under-cap control row');
  });
  for (const r of DOC.rows) {
    it(`${r.host}: ${r.name}`, () => {
      const v = judgeRow(r);
      assert.equal(v.decision, r.expect, `got ${v.decision} [${v.rule}] ${v.reason}`);
      if (r.rule !== undefined) assert.equal(v.rule, r.rule, v.reason);
      if (r.reason === 'cut') assert.ok(v.reason.includes(CUT_NOTE), v.reason);
      if (r.reason === 'steps') assert.ok(v.reason.includes(STEPS_NOTE), v.reason);
      if (r.reason === 'match') assert.ok(!v.reason.includes(CUT_NOTE) && !v.reason.includes(STEPS_NOTE), v.reason);
      if (r.expect !== 'allow') {
        const none = judgeRow(r, cloneBylaws(DEFAULT_BYLAWS));
        assert.notEqual(none.rule, r.rule, 'the row is caught without its content rule, so it proves nothing about the rule');
      }
    });
  }
  it('every write mapping that has a content field carries it (a mapping that drops it fails here)', () => {
    const cases: [ContentHost, string, Record<string, unknown>][] = [
      ['claude-code', 'Write', { file_path: '/w/a', content: 'C1' }],
      ['claude-code', 'Edit', { file_path: '/w/a', old_string: 'o', new_string: 'C1' }],
      ['claude-code', 'MultiEdit', { file_path: '/w/a', edits: [{ old_string: 'o', new_string: 'C1' }] }],
      ['claude-code', 'NotebookEdit', { notebook_path: '/w/a.ipynb', new_source: 'C1' }],
      ['codex', 'apply_patch', { command: '*** Begin Patch\n*** Add File: a\n+C1\n*** End Patch' }],
      ['gemini-cli', 'write_file', { file_path: '/w/a', content: 'C1' }],
      ['gemini-cli', 'replace', { file_path: '/w/a', old_string: 'o', new_string: 'C1' }],
      ['opencode', 'write', { filePath: '/w/a', content: 'C1' }],
      ['opencode', 'edit', { filePath: '/w/a', oldString: 'o', newString: 'C1' }],
      ['opencode', 'multiedit', { filePath: '/w/a', edits: [{ oldString: 'o', newString: 'C1' }] }],
      ['opencode', 'apply_patch', { patchText: '*** Begin Patch\n*** Add File: a\n+C1\n*** End Patch' }],
      ['openclaw', 'write', { path: '/w/a', content: 'C1' }],
      ['openclaw', 'edit', { path: '/w/a', edits: [{ oldText: 'o', newText: 'C1' }] }],
      ['openclaw', 'apply_patch', { input: '*** Begin Patch\n*** Add File: a\n+C1\n*** End Patch' }],
    ];
    for (const [h, tool, input] of cases) {
      const acts = mapped(h, tool, input);
      assert.equal(acts.length, 1, `${h} ${tool}`);
      const a = acts[0];
      assert.ok(a !== undefined && a.kind === 'write', `${h} ${tool}`);
      assert.ok(a.content !== undefined && a.content.text.includes('C1'), `${h} ${tool}: no content carried`);
      assert.equal(a.content.cut, false);
    }
    const edit = toActions('Edit', { file_path: '/w/a', old_string: 'OLD-TEXT', new_string: 'NEW-TEXT' })[0];
    assert.ok(edit !== undefined && edit.kind === 'write' && edit.content?.text === 'NEW-TEXT', 'Edit content is new_string only');
  });
  it('content the host does not give is not invented: an opencode V2 permission edit, a patch delete, a write with no content field', () => {
    for (const a of opencodePermissionActions('edit', ['/w/a']).actions) assert.equal(a.kind === 'write' ? a.content : undefined, undefined);
    const del = codexActions('apply_patch', { command: '*** Begin Patch\n*** Delete File: a\n*** End Patch' }).actions[0];
    assert.ok(del !== undefined && del.kind === 'write' && del.content === undefined);
    const w = toActions('Write', { file_path: '/w/a' })[0];
    assert.ok(w !== undefined && w.kind === 'write' && w.content === undefined);
    const rule = bylawsFor(['key']).rules[0] as Rule;
    assert.equal(ruleOutcome(rule, w, null), null, 'no content: a content rule does not apply');
  });
  it('a content rule reads write content, arguments and messages, never a command, a read or a fetch (use match.command or match.path there)', () => {
    const rule = bylawsFor(['key']).rules[0] as Rule;
    const exec: Action = { kind: 'exec', command: 'echo "-----BEGIN RSA PRIVATE KEY-----" > k.pem', shell: 'posix', tool: 'Bash' };
    assert.deepEqual(actionTexts(exec), []);
    assert.equal(ruleOutcome(rule, exec, null), null);
    assert.equal(ruleOutcome(rule, { kind: 'read', path: '-----BEGIN RSA PRIVATE KEY-----', tool: 'Read' }, null), null);
    assert.equal(ruleOutcome(rule, { kind: 'fetch', url: 'https://x.example.test/-----BEGIN RSA PRIVATE KEY-----', tool: 'WebFetch' }, null), null);
  });
  it('arguments and messages are matched after redaction (0.14.0), so a token in an MCP argument is not seen; write content is not redacted', () => {
    const b = validateBylaws({ version: 1, rules: [{ id: 'no-token', match: { content: 'ghp_[a-z0-9]{20,}' }, decision: 'deny' }] });
    assert.ok(b.ok);
    const mcp = decideCall('mcp__github__create_issue', toActions('mcp__github__create_issue', { body: 'ghp_FAKEfakeFAKEfakeFAKEfake0000' }), b, EMPTY_STATE);
    assert.equal(mcp.decision, 'allow', mcp.reason);
    const write = decideCall('Write', toActions('Write', { file_path: '/work/app/a.txt', content: 'ghp_FAKEfakeFAKEfakeFAKEfake0000' }), b, EMPTY_STATE);
    assert.equal(write.decision, 'deny');
  });
  it('the over-cap note names the cap the content is cut at', () => {
    assert.ok(unknownNote({ id: 'x', match: { content: 'x' }, decision: 'deny', reason: 'r', hard: false }, 'cut').includes(`${ACTION_TEXT_MAX_BYTES.toLocaleString('en-US')}-byte cap`));
  });
});
describe('content patterns: refused at load, matched in linear time', () => {
  const bad: [string, RegExp][] = [
    ['(a)\\1', /backreferences are not supported/],
    ['(?<n>a)\\k<n>', /backreferences are not supported/],
    ['(?=secret)', /lookahead and lookbehind are not supported/],
    ['(?<!x)y', /lookahead and lookbehind are not supported/],
    ['\\p{L}', /property escapes/],
    ['a{1001}', /repeat count over 1000/],
    ['(a{1000}){1000}', /too large once its repeats are expanded/],
    ['x'.repeat(MAX_CONTENT_PATTERN_CHARS + 1), /at most 1024 characters/],
    ['[z-a]', /invalid regular expression/],
    ['a**', /invalid regular expression/],
    ['(', /invalid regular expression/],
    ['\\e', /escape \\e is not supported/],
    ['\\01', /octal escapes/],
  ];
  for (const [p, want] of bad) {
    it(`refuses ${JSON.stringify(p.slice(0, 24))} at load, naming the field`, () => {
      const load = validateBylaws({ version: 1, rules: [{ id: 'r', match: { content: p }, decision: 'deny' }] });
      assert.equal(load.ok, false);
      assert.ok(!load.ok && load.error.includes('rules[0].match.content'), load.ok ? '' : load.error);
      assert.match(load.ok ? '' : load.error, want);
    });
  }
  it('refuses an empty or non-string pattern and accepts a rule with content alone', () => {
    for (const v of ['', 3, ['x']]) assert.equal(validateBylaws({ version: 1, rules: [{ id: 'r', match: { content: v }, decision: 'ask' }] }).ok, false);
    const ok = validateBylaws({ version: 1, rules: [{ id: 'r', match: { content: 'x' }, decision: 'ask' }] });
    assert.ok(ok.ok && ok.bylaws.rules[0]?.match.content === 'x');
  });
  it('the commented example rule in the default bylaws template is a valid content rule', () => {
    const m = /match: \{ content: "([^"]+)" \}/.exec(DEFAULT_BYLAWS_YAML);
    assert.ok(m !== null && m[1] !== undefined);
    const load = parseBylaws(`version: 1\nrules:\n  - id: example\n    match: { content: "${m[1]}" }\n    decision: deny\n`);
    assert.ok(load.ok, load.ok ? '' : load.error);
    assert.equal(ruleOutcome(load.bylaws.rules[0] as Rule, toActions('Write', { file_path: '/w/k', content: '-----BEGIN OPENSSH PRIVATE KEY-----' })[0] as Action, null), 'match');
  });
  it('gives the same answer as the native engine (flags im) on seeded random patterns and inputs', () => {
    let seed = 12345;
    const rnd = (k: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % k;
    };
    const atoms = ['a', 'b', 'A', 'B', '.', '\\w', '\\W', '\\d', '\\s', '\\S', '[ab]', '[^a]', '[a-c]', '[A-B]', '[\\d_]', '\\n', 'x', '_', '1', ' ', 'é', 'É', '\\.', '[-a]', '[]', '[^]'];
    const asserts = ['^', '$', '\\b', '\\B'];
    const quants = ['*', '+', '?', '{2}', '{1,3}', '{0,2}', '*?', '{2,}', '+?'];
    const gen = (d: number): string => {
      const r = rnd(10);
      if (d > 3 || r < 4) return atoms[rnd(atoms.length)] ?? 'a';
      if (r < 5) return asserts[rnd(asserts.length)] ?? '^';
      if (r < 7) return `(${gen(d + 1)})${quants[rnd(quants.length)] ?? '*'}`;
      if (r < 8) return `${gen(d + 1)}|${gen(d + 1)}`;
      return `(?:${gen(d + 1)}${gen(d + 1)})`;
    };
    const alpha = ['a', 'b', 'A', 'B', 'x', '1', '_', ' ', '\n', 'é', 'É', '-', '.'];
    let checked = 0;
    for (let i = 0; i < 1500; i++) {
      const p = gen(0) + (rnd(2) === 1 ? gen(0) : '');
      let re: RegExp;
      try {
        re = new RegExp(p, 'im');
      } catch {
        continue;
      }
      const c = compileContentPattern(p);
      assert.ok(c.ok, `${p}: ${c.ok ? '' : c.error}`);
      for (let j = 0; j < 20; j++) {
        let s = '';
        const len = rnd(12);
        for (let k = 0; k < len; k++) s += alpha[rnd(alpha.length)] ?? 'a';
        assert.equal(c.pattern.search(s), re.test(s), `${JSON.stringify(p)} on ${JSON.stringify(s)}`);
        checked++;
      }
    }
    assert.ok(checked > 20000, String(checked));
  });
  it('ordinary and backtracking-prone patterns search 256 KB in well under a second; a pattern that blows up gives up instead of running long', () => {
    const n = ACTION_TEXT_MAX_BYTES;
    const texts = ['a'.repeat(n), 'a1'.repeat(n / 2), 'const value = compute(alpha, beta); // note\n'.repeat(Math.floor(n / 44)), `password${' '.repeat(n - 8)}`];
    for (const p of ['a.*b', '(a+)+b', '(a|aa)*b', '\\w+@', '.*.*.*x', '[^x]*y', 'AKIA[0-9A-Z]{16}', 'password\\s*=', '[a-z]{0,100}q', '(\\w{0,20}\\d){0,20}Z']) {
      const c = compileContentPattern(p);
      assert.ok(c.ok);
      for (const t of texts) {
        const start = performance.now();
        const found = c.pattern.search(t);
        const ms = performance.now() - start;
        assert.notEqual(found, null, `${p} ran out of steps on ordinary text`);
        if (t.startsWith('aaaa')) assert.equal(found, false, p);
        assert.ok(ms < 1000, `${p}: ${ms.toFixed(0)} ms on ${t.length} characters`);
      }
    }
    let ab = '';
    let seed = 7;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      ab += (seed >> 8) & 1 ? 'a' : 'b';
    }
    for (const p of ['a.{0,1000}c', '(a|b)*a(a|b){200}c']) {
      const c = compileContentPattern(p);
      assert.ok(c.ok);
      const start = performance.now();
      assert.equal(c.pattern.search(ab), null, `${p} should run out of its ${MAX_CONTENT_STEPS} steps`);
      const ms = performance.now() - start;
      assert.ok(ms < 3000, `${p}: ${ms.toFixed(0)} ms before giving up`);
      assert.equal(c.pattern.search(ab, Number.MAX_SAFE_INTEGER) === null, false, 'with no step limit the search completes');
    }
  });
  it('a rule whose pattern cannot be compiled (bylaws built without validation) fails closed', () => {
    const b = cloneBylaws(DEFAULT_BYLAWS);
    b.rules = [{ id: 'broken', match: { content: '(a)\\1' }, decision: 'deny', reason: 'r', hard: false }];
    const w: Action = { kind: 'write', path: '/work/app/a', tool: 'Write', content: { text: 'aa', bytes: 2, cut: false } };
    assert.equal(decide(w, b, EMPTY_STATE).rule, 'rules.broken.error');
    assert.equal(decide(w, b, EMPTY_STATE).decision, 'ask');
    (b.rules[0] as Rule).hard = true;
    assert.equal(decide(w, b, EMPTY_STATE).decision, 'deny');
  });
});

describe('0.15.0 decides every existing row as 0.14.0 did when no content rule is set', () => {
  const files = loadCaseFiles().filter((f) => f.guard !== 'content-rules' && f.guard !== 'detectors' && f.guard !== 'document' && f.guard !== 'outbound');
  const rows = files.flatMap((f) => f.cases.map((c, i) => ({ f, c, i })));
  it('with and without the carried write content, every guard case row gets the same verdict', () => {
    let carried = 0;
    for (const { f, c, i } of rows) {
      const load = validateBylaws(c.bylaws, `${f.file}#${i + 1}`);
      assert.ok(load.ok);
      assert.ok(!load.bylaws.rules.some((r) => r.match.content !== undefined), `${f.file}#${i + 1} has a content rule`);
      if (c.actions.some((a) => a.kind === 'write' && a.content !== undefined)) carried++;
      assert.deepEqual(decideCall(c.tool, c.actions, load, c.state, undefined, c.where), decideCall(c.tool, c.actions.map(withoutContent), load, c.state, undefined, c.where), `${f.file}#${i + 1}`);
    }
    assert.ok(carried >= 10, `only ${carried} rows carry write content, so the comparison proves little`);
  });
  it('adding a content rule that matches nothing changes no verdict on any row', () => {
    const never = { id: 'never-matches', match: { content: 'zz-never-in-any-row-4471' }, decision: 'deny', reason: 'never' };
    for (const { f, c, i } of rows) {
      const raw = (c.bylaws ?? { version: 1 }) as Record<string, unknown>;
      const plain = validateBylaws(c.bylaws, `${f.file}#${i + 1}`);
      const withRule = validateBylaws({ ...raw, rules: [...((raw['rules'] as unknown[] | undefined) ?? []), never] }, `${f.file}#${i + 1}`);
      assert.ok(plain.ok && withRule.ok, withRule.ok ? '' : withRule.error);
      assert.deepEqual(decideCall(c.tool, c.actions, withRule, c.state, undefined, c.where), decideCall(c.tool, c.actions, plain, c.state, undefined, c.where), `${f.file}#${i + 1}`);
    }
  });
});

describe('a project file and content rules (ADR 0010: the user file is a floor)', () => {
  const user = validateBylaws({ version: 1, rules: [{ id: 'no-key', match: { content: 'BEGIN [A-Z ]*PRIVATE KEY' }, decision: 'deny' }] });
  assert.ok(user.ok);
  it('a project may add a content rule; it is kept beside the user rules', () => {
    const proj = validateBylaws({ version: 1, rules: [{ id: 'ask-eval', match: { content: '\\beval\\(' }, decision: 'ask' }] }, 'p', user.bylaws, true);
    assert.ok(proj.ok);
    const t = tighten(proj.bylaws, user.bylaws);
    assert.deepEqual(t.bylaws.rules.map((r) => r.id), ['no-key', 'ask-eval']);
    assert.deepEqual(t.ignored, []);
  });
  it('a project repeating the user rule id with a looser pattern does not replace it: the user rule stays as written', () => {
    const proj = validateBylaws({ version: 1, rules: [{ id: 'no-key', match: { content: 'zz-never' }, decision: 'deny' }] }, 'p', user.bylaws, true);
    assert.ok(proj.ok);
    const t = tighten(proj.bylaws, user.bylaws);
    const kept = t.bylaws.rules.filter((r) => r.id === 'no-key');
    assert.ok(kept.some((r) => r.match.content === 'BEGIN [A-Z ]*PRIVATE KEY'), JSON.stringify(t.bylaws.rules));
    const w = toActions('Write', { file_path: '/work/app/k', content: '-----BEGIN RSA PRIVATE KEY-----' });
    assert.equal(decideCall('Write', w, { ok: true, bylaws: t.bylaws, source: 'p' }, EMPTY_STATE).decision, 'deny');
  });
  it('a team or pack file that changes a content pattern is reported as a loosening', () => {
    const cand = cloneBylaws(user.bylaws);
    (cand.rules[0] as Rule).match = { content: 'zz-never' };
    assert.ok(loosenings(cand, user.bylaws).some((l) => l.field === 'rules.no-key.match.content'), JSON.stringify(loosenings(cand, user.bylaws)));
  });
});

const MARKER = 'UNIQUE-WRITE-CONTENT-7730';

function everyFile(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map((f) => join(dir, String(f))).filter((f) => statSync(f).isFile());
}

describe('write content never reaches the audit log or the session files', () => {
  it('a matched content rule is audited by its id and reason, never the text it matched', () => {
    const proj = tempDir('cr-proj');
    const home = tempDir('cr-home');
    writeFileSync(join(proj, 'openmorals.yaml'), 'version: 1\n');
    writeFileSync(join(home, 'openmorals.yaml'), `version: 1\nrules:\n  - id: no-marker\n    match: { content: "${MARKER}" }\n    decision: deny\n    reason: The marker must not be written.\n`);
    const env = { OPENMORALS_HOME: home, OPENMORALS_UNATTENDED: '' };
    const ev = (o: Record<string, unknown>): string => JSON.stringify({ session_id: 'cr1', cwd: proj, hook_event_name: 'PreToolUse', ...o });
    const denied = runClaudeCodeHook(ev({ tool_name: 'Write', tool_input: { file_path: join(proj, 'a.txt'), content: `x ${MARKER} y` } }), { env });
    assert.equal(denied.verdict.decision, 'deny');
    assert.equal(denied.verdict.rule, 'rules.no-marker');
    const allowed = runClaudeCodeHook(ev({ tool_name: 'Edit', tool_input: { file_path: join(proj, 'b.txt'), old_string: MARKER, new_string: 'clean' } }), { env });
    assert.equal(allowed.verdict.decision, 'allow', allowed.verdict.reason);
    const audit = readAudit(auditLogPath(home));
    assert.ok(audit.records.some((r) => r.rule === 'rules.no-marker' && r.reason.includes('The marker must not be written.')), JSON.stringify(audit.records));
    const files = everyFile(home).filter((f) => !f.endsWith('openmorals.yaml'));
    assert.ok(files.length >= 2, files.join(', '));
    for (const f of files) assert.ok(!readFileSync(f, 'utf8').includes(MARKER), `${f} holds the content`);
  });
  it('the session history keeps a write without its content', () => {
    const a = toActions('Write', { file_path: '/work/app/a', content: MARKER })[0] as Action;
    const m = recordAction(EMPTY_MEMORY, a, { decision: 'allow', rule: 'none', reason: '' }, taintContext(CASE_CWD, DEFAULT_BYLAWS), 'id1');
    assert.ok(!JSON.stringify(m).includes(MARKER));
    assert.deepEqual(m.history[0]?.action, { kind: 'write', path: '/work/app/a', tool: 'Write' });
  });
});
