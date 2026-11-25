import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { decideCall, runClaudeCodeHook } from '../src/adapters/claude-code.js';
import { chainAudit, makeAuditRecord, readAudit } from '../src/audit.js';
import { verifyAuditText } from '../src/audit-verify.js';
import { DEFAULT_BYLAWS, parseBylaws, resolveBylaws, stringifyBylaws, validateBylaws } from '../src/bylaws.js';
import { caseBylaws } from '../src/eval/cases.js';
import { renderGuidance } from '../src/guidance/render.js';
import { formatPackSummary, loadPack, packSummary, PACK_NAMES, readPackText } from '../src/packs/load.js';
import { guardSwitchedOff, GUARD_NAMES, MAX_DISCLAIMER_CHARS, readPrinciples } from '../src/packs/schema.js';
import { auditLogPath } from '../src/paths.js';
import type { BylawsLoad } from '../src/types.js';
import { loadCaseFiles } from './case-loader.js';
import { REPO_ROOT, tempDir } from './helpers.js';

/** U10 (0.25.0): a pack's principles are checked by the loader, shown by `packs show`, and change no decision. */

const CLI = join(REPO_ROOT, 'dist', 'src', 'cli.js');

const GOOD = `# pack: example - asks before a push; two principles checked, one advice only.
version: 1
guards:
  secrets: { send: deny }
rules:
  - id: ask-before-push
    match: { command: "\\\\bgit\\\\s+push\\\\b" }
    decision: ask
    reason: Pushing publishes your work.
principles:
  - id: confidentiality
    source: https://example.org/confidentiality
    checked_by: [secrets]
  - id: publish-with-consent
    checked_by: [ask-before-push]
  - id: least-privilege
    advisory: Give the agent only the access the task needs.
disclaimer: Not compliance. This pack asks before a few actions; it does not make the work safe.
`;

/** A strict-like pack whose only fault is one principle: its deny of destructive commands must stay in force. */
function strictWith(principles: string): string {
  return `version: 1\nguards:\n  destructive: { decision: deny }\n${principles}`;
}

const NEITHER = 'principles:\n  - id: do-no-harm\n    source: https://example.org/harm\n';
const UNKNOWN_RULE = 'principles:\n  - id: p\n    checked_by: [no-such-rule]\n';

/** Each rejection, the file text, and the message that names it. */
const INVALID: { name: string; text: string; error: RegExp }[] = [
  { name: 'neither checked_by nor advisory', text: strictWith(NEITHER), error: /principles\[0\]: principle do-no-harm says neither what checks it/ },
  { name: 'a checked_by id that is no rule or guard of the file', text: strictWith(UNKNOWN_RULE), error: /principles\[0\]\.checked_by: "no-such-rule" is not a rule or guard in this file: no rule or guard of this file has that id/ },
  { name: 'a guard name the file does not list under guards', text: strictWith('principles:\n  - id: p\n    checked_by: [secrets]\n'), error: /"secrets" is not a rule or guard in this file: the guard secrets is not listed under this file's guards/ },
  { name: 'a guard the file switches off', text: 'version: 1\nguards:\n  destructive: { decision: allow }\nprinciples:\n  - id: p\n    checked_by: [destructive]\n', error: /destructive is a guard this file switches off, so it checks nothing/ },
  { name: 'both checked_by and advisory', text: strictWith('principles:\n  - id: p\n    checked_by: [destructive]\n    advisory: also this\n'), error: /principle p has both checked_by and advisory/ },
  { name: 'an empty checked_by', text: strictWith('principles:\n  - id: p\n    checked_by: []\n'), error: /principles\[0\]\.checked_by: must be a non-empty list/ },
  { name: 'principles not a list', text: strictWith('principles: { id: p }\n'), error: /principles: must be a list/ },
  { name: 'an unknown key in a principle', text: strictWith('principles:\n  - id: p\n    advisory: x\n    claims: all\n'), error: /principles\[0\]\.claims: unknown key/ },
  { name: 'a duplicate principle id', text: strictWith('principles:\n  - id: p\n    advisory: x\n  - id: p\n    advisory: y\n'), error: /principles\[1\]\.id: duplicate id p/ },
  { name: 'a source that is not a web address', text: strictWith('principles:\n  - id: p\n    source: see the handbook\n    advisory: x\n'), error: /principles\[0\]\.source: must be an http or https address/ },
  { name: 'an empty advisory', text: strictWith('principles:\n  - id: p\n    advisory: "  "\n'), error: /principles\[0\]\.advisory: must not be empty/ },
  { name: 'a disclaimer that is not text', text: strictWith('disclaimer: [not, text]\n'), error: /disclaimer: must be a text/ },
  { name: 'an empty disclaimer', text: strictWith('disclaimer: ""\n'), error: /disclaimer: must not be empty/ },
  { name: 'a disclaimer over the length cap', text: strictWith(`disclaimer: "${'x'.repeat(MAX_DISCLAIMER_CHARS + 1)}"\n`), error: /disclaimer: must be at most 2000 characters/ },
  { name: 'a disclaimer with a control character', text: strictWith('disclaimer: "fine\\u0007bell"\n'), error: /disclaimer: must not hold control characters/ },
];

function packsDir(files: Record<string, string>): string {
  const dir = tempDir('principles-packs');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, `${name}.yaml`), text);
  return dir;
}

function cli(args: string[], cwd: string, home: string): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd, env: { ...process.env, OPENMORALS_HOME: home, OPENMORALS_UNATTENDED: '' } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('the loader: a principle must say what checks it, or that it is advice only', () => {
  it('a pack with checked and advice-only principles and a disclaimer loads, and its summary splits them', () => {
    const load = parseBylaws(GOOD, 'pack:example');
    assert.ok(load.ok, load.ok ? '' : load.error);
    assert.deepEqual(load.bylaws.disclaimers, ['Not compliance. This pack asks before a few actions; it does not make the work safe.']);
    const s = packSummary(GOOD, 'example.yaml');
    assert.ok(s.ok, s.ok ? '' : s.error);
    assert.deepEqual(s.checked.map((p) => [p.id, p.checked_by]), [['confidentiality', ['secrets']], ['publish-with-consent', ['ask-before-push']]]);
    assert.deepEqual(s.advisory.map((p) => p.id), ['least-privilege']);
    const text = formatPackSummary(s, 'example');
    assert.match(text, /^checked \(2\): /m);
    assert.match(text, /^ {2}confidentiality: by secrets \(https:\/\/example\.org\/confidentiality\)$/m);
    assert.match(text, /^advice only, not checked \(1\): text for you; no rule or guard enforces it, and the agent is not held to it$/m);
    assert.match(text, /^ {2}least-privilege: Give the agent only the access the task needs\.$/m);
    assert.match(text, /^disclaimer:\n {2}Not compliance\./m);
  });
  for (const c of INVALID) {
    it(`rejects ${c.name}, at load, at validate and in packs show`, () => {
      const v = parseBylaws(c.text, 'pack:bad');
      assert.equal(v.ok, false, `${c.name} was accepted`);
      if (!v.ok) assert.match(v.error, c.error);
      const dir = packsDir({ bad: c.text });
      const l = loadPack('bad', dir);
      assert.equal(l.ok, false);
      if (!l.ok) assert.match(l.error, c.error);
      const s = packSummary(c.text, 'bad.yaml');
      assert.equal(s.ok, false);
      if (!s.ok) assert.match(s.error, c.error);
    });
  }
  it('names a guard that is listed and on, for every guard name', () => {
    for (const g of GUARD_NAMES) {
      const on: Record<string, unknown> = { replace: { steer: 'keep' }, budget: { tool_calls: { soft: 10, hard: 20, step: 5 } } };
      const r = validateBylaws({ version: 1, guards: { [g]: on[g] ?? {} }, principles: [{ id: 'p', checked_by: [g] }] });
      assert.ok(r.ok, `${g}: ${r.ok ? '' : r.error}`);
    }
  });
  it('knows when each guard is switched off', () => {
    const off: Record<string, unknown> = {
      destructive: { decision: 'allow' },
      'online-delete': { decision: 'allow' },
      secrets: { read: 'allow', write: 'allow', send: 'allow' },
      'self-protect': { decision: 'allow' },
      budget: { tool_calls: { soft: 0, hard: 0, step: 0 }, tokens: { soft: 0, hard: 0, step: 0 } },
      loop: { decision: 'allow' },
      taint: { decision: 'allow' },
      inbound: { enabled: false },
      document: { decision: 'allow' },
      delete: { decision: 'allow' },
      replace: { steer: 'off' },
    };
    for (const [g, cfg] of Object.entries(off)) {
      const r = validateBylaws({ version: 1, guards: { [g]: cfg } });
      assert.ok(r.ok, `${g}: ${r.ok ? '' : r.error}`);
      assert.equal(guardSwitchedOff(g, r.bylaws), true, g);
      assert.equal(guardSwitchedOff(g, DEFAULT_BYLAWS), g === 'replace', `${g} in the defaults`);
    }
    assert.equal(guardSwitchedOff('outbound', DEFAULT_BYLAWS), false);
    assert.equal(guardSwitchedOff('no-such-guard', DEFAULT_BYLAWS), true);
  });
  it('a project file is checked against its own rules, not the rules of the file it is read over', () => {
    const user = parseBylaws('version: 1\nrules:\n  - { id: user-rule, match: { command: x }, decision: ask, reason: r }\n', 'user');
    assert.ok(user.ok);
    const p = validateBylaws({ version: 1, principles: [{ id: 'p', checked_by: ['user-rule'] }] }, 'project', user.bylaws, true);
    assert.equal(p.ok, false);
  });
  it('a policy with disclaimers is written back as a file that validates, with the texts kept', () => {
    const one = parseBylaws(GOOD);
    assert.ok(one.ok);
    const back = parseBylaws(stringifyBylaws(one.bylaws));
    assert.ok(back.ok, back.ok ? '' : back.error);
    assert.deepEqual(back.bylaws.disclaimers, one.bylaws.disclaimers);
    const two = validateBylaws({ version: 1, disclaimer: 'From the project.' }, 'project', one.bylaws, true);
    assert.ok(two.ok);
    assert.equal(two.bylaws.disclaimers?.length, 2);
    const joined = parseBylaws(stringifyBylaws(two.bylaws));
    assert.ok(joined.ok, joined.ok ? '' : joined.error);
    assert.match(joined.bylaws.disclaimers?.[0] ?? '', /safe\.\n\nFrom the project\.$/);
    assert.ok(!stringifyBylaws(DEFAULT_BYLAWS).includes('disclaimer'));
  });
  it('readPrinciples reports nothing for a file with neither block', () => {
    assert.deepEqual(readPrinciples({ version: 1 }, DEFAULT_BYLAWS), { principles: [], disclaimer: null, errors: [] });
  });
});

/** The packs shipped before U10; the packs of U11 (0.26.0) carry principles and are tested in packs-wave1.test.ts. */
const PACKS_WITHOUT_PRINCIPLES = ['solo-dev', 'strict', 'ci-unattended', 'production-ops', 'beginner', 'test-lock'];

describe('the shipped packs load unchanged', () => {
  it('every shipped pack is either one of the earlier packs or carries principles', () => {
    for (const name of PACK_NAMES) {
      const t = readPackText(name);
      assert.ok(t.ok);
      const s = packSummary(t.text, t.file);
      assert.ok(s.ok, s.ok ? '' : s.error);
      assert.equal(PACKS_WITHOUT_PRINCIPLES.includes(name), s.checked.length + s.advisory.length === 0, name);
    }
  });
  for (const name of PACKS_WITHOUT_PRINCIPLES) {
    it(`${name} loads, and its summary shows no principles and no disclaimer (U10 adds none to existing packs)`, () => {
      const l = loadPack(name);
      assert.ok(l.ok, l.ok ? '' : l.error);
      assert.equal(l.bylaws.disclaimers, undefined);
      const t = readPackText(name);
      assert.ok(t.ok);
      const s = packSummary(t.text, t.file);
      assert.ok(s.ok);
      assert.equal(s.checked.length + s.advisory.length, 0);
      assert.equal(s.disclaimer, null);
    });
  }
});

/** Adds an advisory principle, a checked one per rule and listed guard of the file, and a disclaimer. */
function withPrinciples(raw: unknown): { raw: unknown; checked: number } {
  const o = (raw === null || raw === undefined ? { version: 1 } : JSON.parse(JSON.stringify(typeof raw === 'string' ? parseYaml(raw) : raw))) as Record<string, unknown>;
  const principles: Record<string, unknown>[] = [{ id: 'advice', source: 'https://example.org/advice', advisory: 'Advice for the person only.' }];
  const rules = Array.isArray(o['rules']) ? (o['rules'] as { id?: unknown }[]).filter((r) => typeof r.id === 'string') : [];
  if (rules[0] !== undefined) principles.push({ id: 'by-rule', checked_by: [rules[0].id] });
  const listed = typeof o['guards'] === 'object' && o['guards'] !== null ? Object.keys(o['guards']).filter((g) => GUARD_NAMES.includes(g)) : [];
  const base = { ...o, principles, disclaimer: 'Not compliance; text for the person.' };
  const on = listed.filter((g) => validateBylaws({ ...base, principles: [...principles, { id: 'by-guard', checked_by: [g] }] }).ok);
  if (on.length > 0) principles.push({ id: 'by-guard', checked_by: on });
  return { raw: { ...base, principles }, checked: principles.length - 1 };
}

describe('principles change no decision', () => {
  const files = loadCaseFiles();
  let rows = 0;
  let checked = 0;
  for (const f of files) {
    it(`${f.file}: every row decides the same (decision, rule and reason) with principles and a disclaimer in its file`, () => {
      for (const c of f.cases) {
        const plain = caseBylaws(c, f.file);
        const w = withPrinciples(c.bylaws);
        checked += w.checked;
        const withP = caseBylaws({ bylaws: w.raw, project: c.project === null ? null : withPrinciples(c.project).raw }, f.file);
        assert.ok(withP.ok, `${f.file} ${c.label}: ${withP.ok ? '' : withP.error}`);
        assert.ok(plain.ok);
        if (withP.ok) assert.ok((withP.bylaws.disclaimers ?? []).length > 0);
        const a = decideCall(c.tool, c.actions, plain, c.state, undefined, c.where);
        const b = decideCall(c.tool, c.actions, withP, c.state, undefined, c.where);
        assert.deepEqual(b, a, `${f.file}:${c.line ?? '?'} ${c.label}`);
        rows++;
      }
    });
  }
  it('covered every case file, with checked principles on rules and guards', () => {
    assert.ok(files.length >= 10);
    assert.ok(rows >= 800, `only ${rows} rows`);
    assert.ok(checked >= 100, `only ${checked} checked principles`);
  });
  it('adds nothing to the agent guidance block', () => {
    const plain = parseBylaws('version: 1\nrules:\n  - { id: ask-before-push, match: { command: "git push" }, decision: ask, reason: r }\n');
    const withP = parseBylaws(`version: 1\nrules:\n  - { id: ask-before-push, match: { command: "git push" }, decision: ask, reason: r }\nprinciples:\n  - { id: p, checked_by: [ask-before-push] }\n  - { id: q, advisory: Be kind. }\ndisclaimer: Not compliance.\n`);
    assert.ok(plain.ok && withP.ok);
    assert.equal(renderGuidance(withP.bylaws), renderGuidance(plain.bylaws));
  });
});

interface Proj {
  project: string;
  home: string;
  env: NodeJS.ProcessEnv;
}

function proj(projectFile: string | null, userFile: string | null = null): Proj {
  const root = tempDir('principles');
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  if (projectFile !== null) writeFileSync(join(project, 'openmorals.yaml'), projectFile);
  if (userFile !== null) writeFileSync(join(home, 'openmorals.yaml'), userFile);
  return { project, home, env: { OPENMORALS_HOME: home } };
}

function bash(p: Proj, command: string, session = 's1'): { stdout: string; decision: string; rule: string; reason: string } {
  const r = runClaudeCodeHook(JSON.stringify({ session_id: session, cwd: p.project, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: `t-${command.length}-${session}` }), { env: p.env });
  return { stdout: r.stdout, decision: r.verdict.decision, rule: r.verdict.rule, reason: r.verdict.reason };
}

describe('through the hook', () => {
  it('a valid pack: the hook answers byte for byte as without principles (nothing reaches the agent)', () => {
    const plainText = GOOD.split('principles:')[0] ?? '';
    for (const cmd of ['ls', 'git push origin main', 'rm -rf build', 'cat .env']) {
      const a = bash(proj(plainText), cmd);
      const b = bash(proj(GOOD), cmd);
      assert.equal(b.stdout, a.stdout, cmd);
    }
  });
  it('an invalid pack as the project file: every call asks, and none of the file\'s other guards is switched off', () => {
    const p = proj(strictWith(NEITHER));
    const load = resolveBylaws(p.project, p.env);
    assert.equal(load.ok, false);
    if (!load.ok) assert.equal(load.keptRest, true);
    const ls = bash(p, 'ls');
    assert.equal(ls.decision, 'ask');
    assert.equal(ls.rule, 'bylaws.invalid');
    assert.match(ls.reason, /principle do-no-harm says neither.*; enforcing its other settings and asking/);
    const rm = bash(p, 'rm -rf build');
    assert.equal(rm.decision, 'deny', `${rm.rule}: ${rm.reason}`);
    assert.match(rm.rule, /^destructive\./);
    const control = bash(proj('version: 1\nguards:\n  destructive: { decision: deny }\n  nonsense: {}\n'), 'rm -rf build');
    assert.equal(control.decision, 'ask', 'any other fault still falls back to the defaults, as before');
  });
  it('an invalid pack as the user-level file: the same, and never looser than the defaults', () => {
    const p = proj(null, `version: 1\nguards:\n  destructive: { decision: deny }\n  secrets: { send: ask }\n${UNKNOWN_RULE}`);
    const load = resolveBylaws(p.project, p.env);
    assert.equal(load.ok, false);
    assert.equal(bash(p, 'rm -rf build').decision, 'deny');
    assert.equal(bash(p, 'ls').rule, 'bylaws.invalid');
    const floor: BylawsLoad = load;
    assert.ok(!floor.ok && floor.floor !== undefined);
    if (!floor.ok && floor.floor !== undefined) assert.equal(floor.floor.guards.secrets.send, DEFAULT_BYLAWS.guards.secrets.send, 'a setting looser than the defaults is held at the defaults');
  });
  it('the disclaimer is written once per session into the audit, and again in a new session', () => {
    const p = proj(GOOD);
    bash(p, 'ls', 's1');
    bash(p, 'pwd', 's1');
    bash(p, 'ls', 's2');
    const log = readAudit(auditLogPath(p.home));
    assert.equal(log.status, 'ok');
    const withD = log.records.filter((r) => r.v === 2 && r.disclaimers !== undefined);
    assert.deepEqual(withD.map((r) => [r.session, r.action]), [['s1', 'ls'], ['s2', 'ls']]);
    assert.deepEqual(withD[0]?.v === 2 ? withD[0].disclaimers : null, ['Not compliance. This pack asks before a few actions; it does not make the work safe.']);
    const text = readFileSync(auditLogPath(p.home), 'utf8');
    const ver = verifyAuditText(text);
    assert.equal(ver.ok, true, JSON.stringify(ver.problems));
    const none = proj('version: 1\n');
    bash(none, 'ls');
    assert.ok(!readFileSync(auditLogPath(none.home), 'utf8').includes('disclaimers'));
  });
});

describe('chainAudit: the disclaimer goes on one record', () => {
  it('in a batch of records, only the first carries it; a head that has it writes none; changed texts are written again', () => {
    const rec = (action: string) => makeAuditRecord({ source: 'test', session: 's', tool: 'Bash', action, decision: 'allow', rule: 'none', reason: 'r', cwd: null, budget: null });
    const one = chainAudit([rec('a'), rec('b'), rec('c')], { disclaimers: ['Not compliance.'] }, undefined);
    assert.deepEqual(one.records.map((r) => r.disclaimers), [['Not compliance.'], undefined, undefined]);
    assert.match(one.head?.disclaimers ?? '', /^[0-9a-f]{64}$/);
    const two = chainAudit([rec('d')], { disclaimers: ['Not compliance.'] }, one.head);
    assert.equal(two.records[0]?.disclaimers, undefined);
    assert.equal(two.head?.disclaimers, one.head?.disclaimers);
    const three = chainAudit([rec('e')], { disclaimers: ['Not compliance.', 'Another pack.'] }, two.head);
    assert.deepEqual(three.records[0]?.disclaimers, ['Not compliance.', 'Another pack.']);
    const none = chainAudit([rec('f')], {}, three.head);
    assert.equal(none.records[0]?.disclaimers, undefined);
    assert.equal(none.head?.disclaimers, three.head?.disclaimers, 'a call with no disclaimer keeps the digest');
  });
});

describe('openmorals packs show', () => {
  it('prints checked, advice only and the disclaimer; an invalid pack exits 1 with the reason; usage errors exit 64', () => {
    const dir = tempDir('principles-cli');
    const home = tempDir('principles-home');
    writeFileSync(join(dir, 'good.yaml'), GOOD);
    writeFileSync(join(dir, 'bad.yaml'), strictWith(NEITHER));
    const good = cli(['packs', 'show', '--file', 'good.yaml'], dir, home);
    assert.equal(good.code, 0, good.stderr);
    assert.match(good.stdout, /^checked \(2\)/m);
    assert.match(good.stdout, /^advice only, not checked \(1\)/m);
    assert.match(good.stdout, /^ {2}Not compliance\. This pack asks/m);
    const bad = cli(['packs', 'show', '--file', 'bad.yaml'], dir, home);
    assert.equal(bad.code, 1);
    assert.equal(bad.stdout, '');
    assert.match(bad.stderr, /invalid: .*bad\.yaml\n {2}principles\[0\]: principle do-no-harm says neither/);
    const validate = cli(['validate', 'bad.yaml'], dir, home);
    assert.equal(validate.code, 1);
    assert.match(validate.stderr, /the hook still enforces its other settings/);
    const strict = cli(['packs', 'show', 'strict'], dir, home);
    assert.equal(strict.code, 0, strict.stderr);
    assert.match(strict.stdout, /^strict - /);
    assert.match(strict.stdout, /^checked \(0\)[^\n]*\n {2}none$/m);
    assert.match(strict.stdout, /^disclaimer: none$/m);
    assert.equal(cli(['packs', 'show'], dir, home).code, 64);
    assert.equal(cli(['packs', 'show', 'strict', '--file', 'good.yaml'], dir, home).code, 64);
    assert.equal(cli(['packs', 'strict', '--file', 'good.yaml'], dir, home).code, 64);
    assert.equal(cli(['packs', 'show', 'no-such-pack'], dir, home).code, 1);
    assert.equal(cli(['packs', 'a', 'b'], dir, home).code, 64);
  });
});
