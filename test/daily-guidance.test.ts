import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { decideCall, runClaudeCodeHook, toActions } from '../src/adapters/claude-code.js';
import { DEFAULT_BYLAWS, effectiveBylaws, overFloor, parseBylaws, resolveBylaws, stringifyBylaws, validateBylaws } from '../src/bylaws.js';
import { caseBylaws } from '../src/eval/cases.js';
import { BUILTIN_GUARDS } from '../src/engine.js';
import { makeWhere } from '../src/guard.js';
import {
  callActivities,
  DAILY_ACTIVITIES,
  DESCRIPTION_MAX_CHARS,
  firstActivityText,
  readDailyPrinciples,
  REFERENCE_MAX_CHARS,
  renderRepoFiles,
  renderRisksReference,
  RISKS,
  shippedDaily,
  SKILL_BODY_MAX_CHARS,
  skillBody,
  skillFile,
  TIER0_MAX_CHARS,
  tierZero,
} from '../src/guidance/index.js';
import { loosenings } from '../src/packs/compare.js';
import { formatPackSummary, packSummary, readPackText } from '../src/packs/load.js';
import { GUARD_NAMES, type Principle } from '../src/packs/schema.js';
import { loadCaseFiles } from './case-loader.js';
import { REPO_ROOT, tempDir, withOpenmoralsOnPath } from './helpers.js';

/** 0.29.0: daily guidance tiers. Every text here is advice for the agent; none of it may change a decision. */

const CLI = join(REPO_ROOT, 'dist', 'src', 'cli.js');

/** The checks that are not in BUILTIN_GUARDS because they run on the session or on tool results: they exist as code all the same. */
const SESSION_CHECKS = ['inbound', 'taint', 'loop'];
const EXISTING_GUARDS = new Set([...BUILTIN_GUARDS.map((g) => g.id), ...SESSION_CHECKS]);

function dailyText(): string {
  const t = readPackText('daily');
  assert.ok(t.ok, t.ok ? '' : t.error);
  return t.text;
}

function principles(): Principle[] {
  const d = shippedDaily();
  assert.ok(d.ok, d.ok ? '' : d.error);
  return d.principles;
}

/** Every text the agent may be given: tier 0, each SKILL.md, each first-activity message, the reference list. */
function modelTexts(): { name: string; text: string }[] {
  const p = principles();
  const t0 = tierZero(p);
  assert.ok(t0.ok, t0.ok ? '' : t0.error);
  return [
    { name: 'tier 0', text: t0.text },
    ...DAILY_ACTIVITIES.map((a) => ({ name: `${a.skill}/SKILL.md`, text: skillFile(p, a) })),
    ...DAILY_ACTIVITIES.map((a) => ({ name: `first activity ${a.id}`, text: firstActivityText(p, [a.id]) ?? '' })),
    { name: 'references/risks.md', text: renderRisksReference() },
  ];
}

describe('daily guidance: the pack', () => {
  it('loads, and splits its principles into checked and advice only, each guidance line marked one or the other', () => {
    const s = packSummary(dailyText(), 'daily');
    assert.ok(s.ok, s.ok ? '' : s.error);
    assert.ok(s.checked.length >= 10 && s.advisory.length >= 8, `${s.checked.length} checked, ${s.advisory.length} advice only`);
    for (const p of s.principles) {
      assert.ok(p.guidance !== undefined, `${p.id} carries a guidance line`);
      assert.ok((p.checked_by !== undefined) !== (p.advisory !== undefined), p.id);
    }
    for (const a of ['always', 'documents', 'forms', 'email-and-links'] as const) assert.ok(s.principles.some((p) => (p.activities ?? []).includes(a)), a);
  });

  it('names only guards that exist, listed in the pack at the defaults (no rule of its own, no new check)', () => {
    const raw = parseYaml(dailyText()) as { guards: Record<string, unknown>; rules?: unknown[] };
    assert.equal(raw.rules, undefined);
    for (const p of principles()) for (const g of p.checked_by ?? []) {
      assert.ok(EXISTING_GUARDS.has(g), `${p.id}: ${g} is not a guard openmorals has`);
      assert.ok(GUARD_NAMES.includes(g) && g in raw.guards, `${p.id}: ${g} is listed under guards:`);
    }
  });

  it('decides exactly as the defaults: nothing looser and nothing stricter', () => {
    const l = parseBylaws(dailyText(), 'daily');
    assert.ok(l.ok, l.ok ? '' : l.error);
    assert.deepEqual(loosenings(l.bylaws, DEFAULT_BYLAWS), []);
    assert.deepEqual(loosenings(DEFAULT_BYLAWS, l.bylaws), []);
    assert.deepEqual(l.bylaws.rules, []);
    assert.equal(l.bylaws.guidance, undefined, 'the pack does not switch the first-activity option on');
  });

  it('laid over every case row as a project file: identical on every row judged under the defaults, never looser on any row', () => {
    const raw = parseYaml(dailyText()) as unknown;
    const rank = { allow: 0, ask: 1, deny: 2 } as const;
    let onDefaults = 0;
    let raised = 0;
    for (const f of loadCaseFiles()) {
      f.cases.forEach((c, i) => {
        const base = caseBylaws(c, `${f.file}[${i}]`);
        const floor = effectiveBylaws(base);
        const over = overFloor(validateBylaws(raw, 'pack:daily', floor, true), floor, base.source);
        assert.ok(over.ok, `${f.file}[${i}]: ${over.ok ? '' : over.error}`);
        const a = decideCall(c.tool, c.actions, base, c.state, undefined, c.where);
        const b = decideCall(c.tool, c.actions, over, c.state, undefined, c.where);
        assert.ok(rank[b.decision] >= rank[a.decision], `${f.file}[${i}] ${c.label}: ${a.decision} -> ${b.decision}`);
        if (c.bylaws === null && c.project === null) {
          assert.deepEqual([b.decision, b.rule, b.reason], [a.decision, a.rule, a.reason], `${f.file}[${i}] ${c.label}`);
          onDefaults++;
        } else if (b.decision !== a.decision) raised++;
      });
    }
    assert.ok(onDefaults > 600, `${onDefaults} rows on the defaults`);
    assert.ok(raised > 0, 'a row with a looser policy of its own is raised back to the defaults (the pack lists its guards at the defaults)');
  });
});

describe('daily guidance: measured sizes against the fixed bounds', () => {
  it('the bounds are the fixed ones (tier 0 900 characters, a skill description 160)', () => {
    assert.equal(TIER0_MAX_CHARS, 900);
    assert.equal(DESCRIPTION_MAX_CHARS, 160);
  });
  it('tier 0, markers included, is at most 900 characters', () => {
    const t0 = tierZero(principles());
    assert.ok(t0.ok, t0.ok ? '' : t0.error);
    assert.ok(t0.text.length <= TIER0_MAX_CHARS, `${t0.text.length}`);
  });
  it('a tier 0 over 900 characters is refused, not written', () => {
    const long: Principle[] = [...principles(), ...Array.from({ length: 4 }, (_, i) => ({ id: `x${i}`, advisory: 'x', guidance: 'y'.repeat(250), activities: ['always' as const] }))];
    const t0 = tierZero(long);
    assert.equal(t0.ok, false);
  });
  for (const a of DAILY_ACTIVITIES) {
    it(`${a.skill}: description at most 160 characters, body and first-activity message at most ${SKILL_BODY_MAX_CHARS}`, () => {
      assert.ok(a.description.length <= DESCRIPTION_MAX_CHARS, `${a.description.length}`);
      assert.ok(skillBody(principles(), a).length <= SKILL_BODY_MAX_CHARS, `${skillBody(principles(), a).length}`);
      const first = firstActivityText(principles(), [a.id]) ?? '';
      assert.ok(first.length > 0 && first.length <= SKILL_BODY_MAX_CHARS, `${first.length}`);
    });
  }
  it(`the risk list the forms and email skills point to is at most ${REFERENCE_MAX_CHARS} characters and has the 29 rows`, () => {
    assert.ok(renderRisksReference().length <= REFERENCE_MAX_CHARS);
    assert.equal(RISKS.length, 29);
    assert.deepEqual(RISKS.map((r) => r.n), Array.from({ length: 29 }, (_, i) => i + 1));
  });
});

describe('daily guidance: docs/daily.md states the measured sizes', () => {
  it('every size in its cost table is the one measured from the shipped text', () => {
    const doc = readFileSync(join(REPO_ROOT, 'docs', 'daily.md'), 'utf8');
    const p = principles();
    const t0 = tierZero(p);
    assert.ok(t0.ok);
    const n = (x: number): string => x.toLocaleString('en-US');
    const row = (label: string, chars: number): void => {
      assert.ok(doc.includes(`| ${label} | ${n(chars)} | ${n(Math.ceil(chars / 4))} |`), `docs/daily.md: ${label} ${chars}`);
    };
    row('tier 0 block, markers included', t0.text.length);
    for (const a of DAILY_ACTIVITIES) {
      row(`\`${a.skill}\` description`, a.description.length);
      row(`\`${a.skill}\` body`, skillBody(p, a).length);
    }
    row('first-activity message, documents', (firstActivityText(p, ['documents']) ?? '').length);
    row('first-activity message, forms', (firstActivityText(p, ['forms']) ?? '').length);
    row('first-activity message, email and links', (firstActivityText(p, ['email-and-links']) ?? '').length);
    row('`references/risks.md`', renderRisksReference().length);
  });
});

describe('daily guidance: what the agent reads claims nothing and advises on nothing licensed', () => {
  for (const t of modelTexts()) {
    it(`${t.name}: no claim or denial of enforcement`, () => {
      assert.doesNotMatch(t.text, /\bopenmorals (checks|blocks|enforces|stops|asks|refuses|denies|will)\b|\benforc|\bguarantee|\bnot checked\b|\badvice only\b|\bis checked\b/i);
    });
    it(`${t.name}: no medical, legal or financial advice`, () => {
      assert.doesNotMatch(t.text, /\b(diagnos\w*|symptom\w*|medication|dosage|prescri\w*|therapy|invest\w*|tax(es)?|loan|mortgage|lawyer|attorney|legal|lawsuit|contract|financial advice)\b/i);
    });
    it(`${t.name}: no machine-specific text`, () => {
      assert.doesNotMatch(t.text, /\/Users\/|\/home\/[a-z]|[A-Z]:\\\\Users|@[a-z0-9-]+\.[a-z]{2,}/i);
    });
  }
});

describe('daily guidance: generated files', () => {
  it('skills/ and docs/daily-risks.md match their sources (run node scripts/render-daily.mjs after a change)', () => {
    for (const f of renderRepoFiles(principles())) {
      const file = join(REPO_ROOT, ...f.path.split('/'));
      assert.ok(existsSync(file), `${f.path} is missing`);
      assert.equal(readFileSync(file, 'utf8'), f.text, `${f.path} is stale`);
    }
  });

  it('every skill README is the human-facing header: advice only, not checked, and every checked_by names a guard that exists', () => {
    const files = renderRepoFiles(principles()).filter((f) => f.path.endsWith('/README.md'));
    assert.equal(files.length, 3);
    for (const f of files) {
      assert.match(f.text, /\*\*Advice only, not checked\.\*\*/);
      const named = [...f.text.matchAll(/checked by: ([a-z, -]+) \|/g)].flatMap((m) => (m[1] ?? '').split(', '));
      assert.ok(named.length > 0, f.path);
      for (const g of named) assert.ok(EXISTING_GUARDS.has(g), `${f.path}: ${g}`);
    }
    const doc = renderRepoFiles(principles()).find((f) => f.path === 'docs/daily-risks.md');
    assert.ok(doc !== undefined);
    for (const r of RISKS) for (const g of r.by) assert.ok(EXISTING_GUARDS.has(g) && GUARD_NAMES.includes(g), `risk ${r.n}: ${g}`);
  });

  it('each SKILL.md has front matter whose name is its folder and whose description is the short text', () => {
    for (const a of DAILY_ACTIVITIES) {
      const text = skillFile(principles(), a);
      const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
      assert.ok(m !== null);
      const fm = parseYaml(m[1] ?? '') as { name: string; description: string };
      assert.deepEqual(fm, { name: a.skill, description: a.description });
      assert.equal(/^[a-z0-9-]{1,64}$/.test(a.skill), true);
    }
  });
});

describe('daily guidance: removal (a principle whose checked_by rule was deleted is not rendered)', () => {
  /** The daily pack with one rule added and a principle checked by it, so the rule can be deleted. */
  function withRule(keepRule: boolean): string {
    const raw = parseYaml(dailyText()) as Record<string, unknown> & { principles: Record<string, unknown>[] };
    if (keepRule) raw['rules'] = [{ id: 'ask-mail-forwarding', match: { tool: 'forward' }, decision: 'ask', reason: 'This changes where mail goes.' }];
    raw.principles = [...raw.principles, { id: 'mail-forwarding-asks', checked_by: ['ask-mail-forwarding'], guidance: 'Ask before changing where mail is forwarded.', activities: ['always'] }];
    return stringifyYaml(raw);
  }
  it('with the rule the principle renders into tier 0', () => {
    const d = readDailyPrinciples(withRule(true), 'with-rule');
    assert.ok(d.ok, d.ok ? '' : d.error);
    const t0 = tierZero(d.principles);
    assert.ok(t0.ok && t0.text.includes('Ask before changing where mail is forwarded.'));
  });
  it('with the rule deleted, nothing is rendered and the reason names the missing rule', () => {
    const d = readDailyPrinciples(withRule(false), 'rule-deleted');
    assert.equal(d.ok, false);
    assert.match(d.ok ? '' : d.error, /ask-mail-forwarding.*is not a rule or guard in this file/);
  });
  it('a guidance line without activities, an unknown activity, or a backquote is invalid', () => {
    const bad = (p: Record<string, unknown>): boolean => {
      const raw = parseYaml(dailyText()) as { principles: Record<string, unknown>[] };
      raw.principles = [...raw.principles, { id: 'bad', advisory: 'x', ...p }];
      return readDailyPrinciples(stringifyYaml(raw), 'bad').ok;
    };
    assert.equal(bad({ guidance: 'Do this.' }), false);
    assert.equal(bad({ activities: ['always'] }), false);
    assert.equal(bad({ guidance: 'Do this.', activities: ['shopping'] }), false);
    assert.equal(bad({ guidance: 'Run `rm`.', activities: ['always'] }), false);
    assert.equal(bad({ guidance: 'Do this.', activities: ['always'] }), true);
  });
});

describe('daily guidance: packs show', () => {
  it('prints which principles are checked and which are advice only, and that the guidance is advice only, not checked', () => {
    const s = packSummary(dailyText(), 'daily');
    assert.ok(s.ok);
    const text = formatPackSummary(s, 'daily');
    assert.match(text, /advice only, not checked \(12\)/);
    assert.match(text, /guidance for the agent \(25 lines\): advice only, not checked/);
    assert.match(text, /always on: 6 lines; skills: documents 7, forms 6, email-and-links 7/);
  });
  it('a pack without guidance lines prints no guidance section (earlier packs unchanged)', () => {
    const t = readPackText('outward-actions');
    assert.ok(t.ok);
    const s = packSummary(t.text, t.file);
    assert.ok(s.ok);
    assert.doesNotMatch(formatPackSummary(s, 'outward-actions'), /guidance for the agent/);
  });
});

describe('daily guidance: which activity a call belongs to', () => {
  const proj = tempDir('d7-act');
  const where = makeWhere({ cwd: proj }, {});
  const of = (tool: string, input: Record<string, unknown>): string[] => callActivities(toActions(tool, input), DEFAULT_BYLAWS, where);
  it('documents: a write to a document path, not to code or an excluded folder', () => {
    assert.deepEqual(of('Write', { file_path: 'notes.md', content: 'x' }), ['documents']);
    assert.deepEqual(of('Edit', { file_path: 'report.docx', old_string: 'a', new_string: 'b' }), ['documents']);
    assert.deepEqual(of('Write', { file_path: 'src/app.ts', content: 'x' }), []);
    assert.deepEqual(of('Write', { file_path: 'node_modules/pkg/README.md', content: 'x' }), []);
    assert.deepEqual(of('Read', { file_path: 'notes.md' }), []);
  });
  it('forms: typing into or submitting a form', () => {
    assert.deepEqual(of('mcp__browser__browser_type', { element: 'Name', text: 'Alex' }), ['forms']);
    assert.deepEqual(of('mcp__browser__fill_form', { fields: [{ name: 'email', value: 'a' }] }), ['forms']);
  });
  it('email and links: mail tools, send tools and opening a page; agent messages are none', () => {
    assert.deepEqual(of('mcp__gmail__search_messages', { query: 'invoice' }), ['email-and-links']);
    assert.deepEqual(of('mcp__mail__send', { to: 'a@example.test', body: 'hi' }), ['email-and-links']);
    assert.deepEqual(of('mcp__browser__browser_navigate', { url: 'https://example.test/' }), ['email-and-links']);
    assert.deepEqual(of('SendMessage', { to: 'worker', message: 'go' }), []);
    assert.deepEqual(of('Bash', { command: 'ls' }), []);
    assert.deepEqual(of('WebFetch', { url: 'https://example.test/' }), []);
  });
});

function ev(tool: string, input: Record<string, unknown>, cwd: string, session = 'd7-s1'): string {
  return JSON.stringify({ session_id: session, cwd, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: `toolu_fake_${Math.random().toString(16).slice(2)}` });
}

function hookSetup(prefix: string, userFile: string | null): { env: NodeJS.ProcessEnv; proj: string; home: string } {
  const home = tempDir(`${prefix}-home`);
  const proj = tempDir(`${prefix}-proj`);
  if (userFile !== null) writeFileSync(join(home, 'openmorals.yaml'), userFile);
  return { env: { OPENMORALS_HOME: home, OPENMORALS_UNATTENDED: '' }, proj, home };
}

function context(stdout: string): string | null {
  if (stdout === '') return null;
  const o = JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } };
  return o.hookSpecificOutput?.additionalContext ?? null;
}

const ON = 'version: 1\nguidance:\n  first_activity: true\n';

describe('daily guidance: first-activity context from the hook (opt-in)', () => {
  it('is off by default: the defaults carry no guidance setting and an allowed document write prints nothing', () => {
    assert.equal(DEFAULT_BYLAWS.guidance, undefined);
    const { env, proj } = hookSetup('d7-off', null);
    const run = runClaudeCodeHook(ev('Write', { file_path: join(proj, 'notes.md'), content: 'hi' }, proj), { env });
    assert.equal(run.verdict.decision, 'allow');
    assert.equal(run.stdout, '');
  });

  it('off in the user file (first_activity: false) prints exactly what no setting prints', () => {
    const calls: [string, Record<string, unknown>][] = [
      ['Write', { file_path: 'notes.md', content: 'hi' }],
      ['mcp__browser__browser_type', { element: 'Name', text: 'Alex' }],
      ['mcp__gmail__search_messages', { query: 'invoice' }],
      ['Bash', { command: 'ls' }],
    ];
    const a = hookSetup('d7-a', null);
    const b = hookSetup('d7-b', 'version: 1\nguidance:\n  first_activity: false\n');
    for (const [tool, input] of calls) {
      const ra = runClaudeCodeHook(ev(tool, input, a.proj), { env: a.env });
      const rb = runClaudeCodeHook(ev(tool, input, b.proj), { env: b.env });
      assert.equal(rb.stdout, ra.stdout, tool);
      assert.equal(context(ra.stdout), null, tool);
    }
  });

  it('on: a call allowed by the guards but turned into an ask afterwards (the audit log cannot be written) carries no guidance', () => {
    const { env, proj, home } = hookSetup('d7-audit', ON);
    mkdirSync(join(home, 'audit.jsonl'));
    const run = runClaudeCodeHook(ev('Write', { file_path: join(proj, 'notes.md'), content: 'hi' }, proj), { env });
    assert.equal(run.verdict.decision, 'ask');
    assert.equal(run.verdict.rule, 'audit.unwritable');
    assert.equal(context(run.stdout), null);
  });

  it('on: once per activity per session, on the first allowed call of each', () => {
    const { env, proj } = hookSetup('d7-on', ON);
    const p = principles();
    const doc = runClaudeCodeHook(ev('Write', { file_path: join(proj, 'notes.md'), content: 'hi' }, proj), { env });
    assert.equal(doc.verdict.decision, 'allow');
    assert.equal(context(doc.stdout), firstActivityText(p, ['documents']));
    assert.doesNotMatch(doc.stdout, /permissionDecision/);
    const again = runClaudeCodeHook(ev('Edit', { file_path: join(proj, 'notes.md'), old_string: 'hi', new_string: 'hello' }, proj), { env });
    assert.equal(again.stdout, '');
    const form = runClaudeCodeHook(ev('mcp__browser__browser_type', { element: 'Name', text: 'Alex' }, proj), { env });
    assert.equal(context(form.stdout), firstActivityText(p, ['forms']));
    const mail = runClaudeCodeHook(ev('mcp__gmail__search_messages', { query: 'invoice' }, proj), { env });
    assert.equal(context(mail.stdout), firstActivityText(p, ['email-and-links']));
    const mail2 = runClaudeCodeHook(ev('mcp__gmail__search_messages', { query: 'receipt' }, proj), { env });
    assert.equal(mail2.stdout, '');
    const other = runClaudeCodeHook(ev('Write', { file_path: join(proj, 'notes2.md'), content: 'x' }, proj, 'd7-s2'), { env });
    assert.equal(context(other.stdout), firstActivityText(p, ['documents']), 'a new session is guided again');
  });

  it('on: an asked or refused call carries only its reason, and the activity stays unguided until an allowed call', () => {
    const { env, proj } = hookSetup('d7-ask', ON);
    writeFileSync(join(proj, 'notes.md'), 'old text\n');
    const asked = runClaudeCodeHook(ev('Write', { file_path: join(proj, 'notes.md'), content: '' }, proj), { env });
    assert.notEqual(asked.verdict.decision, 'allow');
    assert.equal(context(asked.stdout), null);
    const ok = runClaudeCodeHook(ev('Write', { file_path: join(proj, 'more.md'), content: 'new' }, proj), { env });
    assert.equal(context(ok.stdout), firstActivityText(principles(), ['documents']));
  });

  it('on in a project file only: ignored (it spends the person\'s tokens, so only their own file can switch it on)', () => {
    const { env, proj } = hookSetup('d7-proj', null);
    writeFileSync(join(proj, 'openmorals.yaml'), ON);
    const load = resolveBylaws(proj, env);
    assert.ok(load.ok);
    assert.equal(load.bylaws.guidance, undefined);
    assert.ok((load.ignored ?? []).some((l) => l.field === 'guidance.first_activity'));
    const run = runClaudeCodeHook(ev('Write', { file_path: join(proj, 'notes.md'), content: 'hi' }, proj), { env });
    assert.equal(context(run.stdout), null);
  });

  it('the setting survives a written policy read back (a team file built from it)', () => {
    const l = parseBylaws(ON, 'u');
    assert.ok(l.ok);
    const back = parseBylaws(stringifyBylaws(l.bylaws), 'back');
    assert.ok(back.ok, back.ok ? '' : back.error);
    assert.deepEqual(back.bylaws.guidance, { first_activity: true });
  });
});

function cli(args: string[], cwd: string, home: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd, env: { ...withOpenmoralsOnPath(), OPENMORALS_HOME: home, OPENMORALS_UNATTENDED: '' } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('daily guidance: what init writes', () => {
  const home = tempDir('d7-init-home');
  writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\n');
  it('a plain init and an init with any other pack write no guidance and no skill', () => {
    for (const pack of [null, 'strict', 'information-security', 'outward-actions', 'test-lock']) {
      const dir = tempDir('d7-init-plain');
      const r = cli(['init', dir, ...(pack !== null ? ['--pack', pack] : [])], dir, home);
      assert.equal(r.status, 0, r.stderr);
      for (const f of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', join('.claude', 'skills')]) assert.equal(existsSync(join(dir, f)), false, `${pack ?? 'plain'}: ${f}`);
      assert.doesNotMatch(r.stdout, /guidance/);
    }
  });

  it('init --pack daily writes tier 0 into CLAUDE.md and the three skills, says advice only, and a second run changes nothing', () => {
    const dir = tempDir('d7-init-daily');
    writeFileSync(join(dir, 'CLAUDE.md'), '# My notes\n\nKeep this.\n');
    const r = cli(['init', dir, '--pack', 'daily'], dir, home);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /advice only, not checked/);
    const t0 = tierZero(principles());
    assert.ok(t0.ok);
    const claude = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    assert.ok(claude.startsWith('# My notes\n\nKeep this.\n'));
    assert.ok(claude.includes(t0.text));
    for (const a of DAILY_ACTIVITIES) {
      assert.equal(readFileSync(join(dir, '.claude', 'skills', a.skill, 'SKILL.md'), 'utf8'), skillFile(principles(), a));
      assert.equal(existsSync(join(dir, '.claude', 'skills', a.skill, 'references', 'risks.md')), a.references);
    }
    const again = cli(['init', dir, '--pack', 'daily'], dir, home);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /kept the daily guidance block/);
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), claude);
  });

  it('init --pack daily leaves a skill folder it did not write alone and says so', () => {
    const dir = tempDir('d7-init-foreign');
    mkdirSync(join(dir, '.claude', 'skills', 'openmorals-forms'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'skills', 'openmorals-forms', 'SKILL.md'), 'mine\n');
    const r = cli(['init', dir, '--pack', 'daily'], dir, home);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /was not written by openmorals; it was left as it is/);
    assert.equal(readFileSync(join(dir, '.claude', 'skills', 'openmorals-forms', 'SKILL.md'), 'utf8'), 'mine\n');
  });

  it('init --agent codex --pack daily writes tier 0 into AGENTS.md and no skills', () => {
    const dir = tempDir('d7-init-codex');
    const r = cli(['init', dir, '--agent', 'codex', '--pack', 'daily'], dir, home);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(readFileSync(join(dir, 'AGENTS.md'), 'utf8').includes('## Safety rules (openmorals)'));
    assert.equal(existsSync(join(dir, '.claude', 'skills')), false);
  });

  it('guidance --remove takes the daily block out again, leaving the person\'s text', () => {
    const dir = tempDir('d7-init-remove');
    writeFileSync(join(dir, 'CLAUDE.md'), '# Mine\n');
    assert.equal(cli(['init', dir, '--pack', 'daily'], dir, home).status, 0);
    const r = cli(['guidance', '--file', 'CLAUDE.md', '--remove', '--root', dir], dir, home);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8').includes('openmorals:begin'), false);
    assert.ok(readFileSync(join(dir, 'CLAUDE.md'), 'utf8').includes('# Mine'));
  });
});
