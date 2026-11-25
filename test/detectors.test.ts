import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { decideCall, runClaudeCodeHook, toActions } from '../src/adapters/claude-code.js';
import { readAudit } from '../src/audit.js';
import { DEFAULT_BYLAWS, DEFAULT_BYLAWS_YAML, parseBylaws, validateBylaws } from '../src/bylaws.js';
import { MAX_CALL_CONTENT_STEPS, decide, describeAction, detectorTexts, newRuleMeter, ruleCheck } from '../src/engine.js';
import { ACTION_TEXT_MAX_BYTES, rawText, withoutContent } from '../src/inbound/outbound.js';
import { loosenings, tighten } from '../src/packs/compare.js';
import { auditLogPath } from '../src/paths.js';
import { DETECTORS, DETECTOR_NAMES, MAX_DETECTOR_HITS, TEST_CARD_NUMBERS, detectCount, fictionalPhone, ibanValid, luhnValid, namedDetectors, nhsValid, reservedDomain, ssnValid } from '../src/rules/detectors.js';
import type { DetectorName } from '../src/rules/detectors.js';
import { MAX_CONTENT_STEPS } from '../src/rules/pattern.js';
import { EMPTY_MEMORY, recordAction, sessionFindings, taintContext } from '../src/session.js';
import { actionReachesNetwork, traitsOf } from '../src/taint/taint.js';
import type { Action, Bylaws, Rule } from '../src/types.js';
import { EMPTY_STATE } from '../src/types.js';
import { CASE_CWD, loadCaseFiles } from './case-loader.js';
import { REPO_ROOT, tempDir } from './helpers.js';

const CASES_FILE = join(REPO_ROOT, 'cases', 'detectors.cases.yaml');
const FAKE_TOKEN = 'ghp_FAKEfakeFAKEfakeFAKEfake0000';
const MADE_UP_CARD = '4512345678901234';

function rule(over: Partial<Rule> & { match: Rule['match'] }): Rule {
  return { id: 'r', decision: 'deny', reason: 'matched', hard: false, ...over };
}

function bylawsWith(rules: Rule[]): Bylaws {
  const b = JSON.parse(JSON.stringify(DEFAULT_BYLAWS)) as Bylaws;
  b.rules = rules;
  return b;
}

const exec = (command: string): Action => ({ kind: 'exec', command, shell: 'posix', tool: 'Bash' });
const write = (content: string): Action => toActions('Write', { file_path: '/work/app/a.txt', content })[0] as Action;

describe('detectors: the checksum and validity rules', () => {
  it('Luhn, mod-97, SSA validity and NHS modulus 11 on known values', () => {
    assert.equal(luhnValid('4512345678901234'), true);
    assert.equal(luhnValid('4512345678901235'), false);
    assert.equal(ibanValid('GB82WEST12345698765432'), true);
    assert.equal(ibanValid('GB82WEST12345698765433'), false);
    assert.equal(ibanValid('DE89370400440532013000'), true);
    assert.equal(ibanValid('DE8937040044053201300'), false, 'one character short for DE');
    assert.equal(ssnValid('123456789'), true);
    for (const bad of ['000123456', '666123456', '900123456', '999123456', '123006789', '123450000']) assert.equal(ssnValid(bad), false, bad);
    assert.equal(nhsValid('9434765919'), true);
    assert.equal(nhsValid('9000000009'), true);
    assert.equal(nhsValid('9434765918'), false);
    assert.equal(reservedDomain('mail.example.com'), true);
    assert.equal(reservedDomain('x.test'), true);
    assert.equal(reservedDomain('fakeclinic-mail.org'), false);
    assert.equal(fictionalPhone('14155550123'), true);
    assert.equal(fictionalPhone('442079460958'), true);
    assert.equal(fictionalPhone('14155552671'), false);
  });
  it('every published test card number passes Luhn (so the list, not the checksum, is what keeps it quiet) and does not fire', () => {
    assert.ok(TEST_CARD_NUMBERS.size >= 150, String(TEST_CARD_NUMBERS.size));
    for (const n of TEST_CARD_NUMBERS) {
      assert.equal(luhnValid(n), true, n);
      assert.equal(detectCount('card-number', `card ${n} ok`), 0, n);
    }
  });
  it('every detector has a row in its table of what fires, what does not and what it misses', () => {
    assert.deepEqual(DETECTORS.map((d) => d.name), [...DETECTOR_NAMES]);
    for (const d of DETECTORS) for (const k of ['fires', 'doesNotFire', 'misses'] as const) assert.ok(d[k].length > 20, `${d.name}.${k}`);
  });
});

const FIRES: Readonly<Record<DetectorName, readonly string[]>> = {
  'secret-token': [`GH=${FAKE_TOKEN}`, 'AKIAFAKEFAKEFAKEFAKE', 'sk-ant-FAKEfakeFAKEfake0000'],
  'card-number': [`pay ${MADE_UP_CARD} now`, 'pay 4512 3456 7890 1234 now', 'pay 4512-3456-7890-1234.', '"card":"4512345678901234"'],
  iban: ['to GB82WEST12345698765432', 'to GB82 WEST 1234 5698 7654 32 today', 'DE89 3704 0044 0532 0130 00'],
  'us-ssn': ['ssn 123-45-6789', '123 45 6789', 'SSN: 123456789', 'social security no 123456789'],
  'nhs-number': ['943 476 5919', '943-476-5919', 'nhs_number=9434765919', '"system":"https://fhir.nhs.uk/Id/nhs-number","value":"9000000009"'],
  email: ['to jane.roe@fakeclinic-mail.org', '<a.b+c@sub.fakeclinic-mail.org>', 'jane.roe@fakeclinic-mail.org.'],
  'phone-e164': ['+4930901820', '+49 30 9018 2034', '+1-415-555-2671', 'tel:+442071234567'],
  'hl7-msh': ['MSH|^~\\&|A|B|C|D|20250101||ADT^A01|1|P|2.5', 'x\rMSH|^~\\&#|A', '"MSH|^~\\&|A"'],
  'fhir-patient': ['{"resourceType": "Patient"}', '{"resourceType":"Patient","id":"t1"}', '<Patient xmlns="http://hl7.org/fhir">'],
};

const QUIET: Readonly<Record<DetectorName, readonly string[]>> = {
  'secret-token': ['GH=<your token>', 'sk-short', 'ghp_short'],
  'card-number': ['pay 4512345678901235 now', 'pay 4242 4242 4242 4242', 'id 19041234567890123', 'v1.4512345678901234', 'x4512345678901234', '+4512345678901234', 'pay 4512 3456-7890 1234'],
  iban: ['to GB82WEST12345698765433', 'to gb82WEST12345698765432', 'to XX82WEST12345698765432', 'DE89 3704 0044 0532 0130'],
  'us-ssn': ['000-12-3456', '666-12-3456', '912-34-5678', '123-00-4567', '123-45-0000', 'order 123456789', '1-123-45-6789-2'],
  'nhs-number': ['943 476 5918', 'built 1764061234', 'order 9434765919'],
  email: ['ops@example.com', 'a@b.test', 'git@github.com:org/repo.git', '@types/node', 'user@localhost', 'pkg@1.2.3'],
  'phone-e164': ['+1 415 555 0123', '+44 20 7946 0958', '+44 7700 900123', '+0123456789', '+1234567', '+12345678901234567', 'a+12345678'],
  'hl7-msh': ['the MSH segment', 'MSH|ab|', 'xMSH|^~\\&|A'],
  'fhir-patient': ['{"resourceType": "Observation"}', 'Patient', '<Patient><id/></Patient>'],
};

describe('detectors: what fires and what does not', () => {
  for (const name of DETECTOR_NAMES) {
    it(`${name} fires on its shape and stays quiet on the near misses`, () => {
      for (const s of FIRES[name]) assert.ok(detectCount(name, s) >= 1, `${name} should fire on ${JSON.stringify(s)}`);
      for (const s of QUIET[name]) assert.equal(detectCount(name, s), 0, `${name} should not fire on ${JSON.stringify(s)}`);
    });
  }
  it('counts are capped at MAX_DETECTOR_HITS', () => {
    assert.equal(detectCount('email', 'jane.roe@fakeclinic-mail.org '.repeat(MAX_DETECTOR_HITS + 5)), MAX_DETECTOR_HITS);
  });
});

describe('detectors: time at the 262,144-byte cap, adversarial input included', () => {
  const fill = (unit: string): string => unit.repeat(Math.ceil(ACTION_TEXT_MAX_BYTES / unit.length)).slice(0, ACTION_TEXT_MAX_BYTES);
  const inputs = ['a', ' ', '4', '4111 ', '1 ', 'DE12', 'GB82 WEST ', '212-45-', 'ssn nhs 212456789 ', '@', 'a@', '+', '+1 2 ', 'MSH', '\nMSH|', '"resourceType"', '<Patient ', 'sk-', 'ghp_', 'AKIA'].map(fill);
  for (const name of DETECTOR_NAMES) {
    it(`${name}: each of ${inputs.length} inputs at the cap in under 250 ms`, () => {
      for (const s of inputs) {
        const t0 = process.hrtime.bigint();
        detectCount(name, s);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        assert.ok(ms < 250, `${name} took ${ms.toFixed(1)} ms on ${JSON.stringify(s.slice(0, 12))} x ${s.length}`);
      }
    });
  }
  it('a rule naming all nine detectors judges a write at the cap in under 1 s', () => {
    const b = bylawsWith([rule({ id: 'all', decision: 'ask', match: { detector: [...DETECTOR_NAMES] } })]);
    const text = fill('const total = items.reduce((a, b) => a + b.price * 1.2, 0); // 2025-11-25 id=48213\n');
    const t0 = process.hrtime.bigint();
    const v = decide(write(text), b, EMPTY_STATE);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.equal(v.decision, 'allow', v.reason);
    assert.ok(ms < 1000, `${ms} ms`);
  });
});

describe('detector rules in the engine', () => {
  it('detectors are off unless a rule names one: the defaults name none, and a call full of detector hits is allowed by them', () => {
    assert.ok(DEFAULT_BYLAWS.rules.every((r) => r.match.detector === undefined));
    const all = [...Object.values(FIRES).flat()].join('\n');
    assert.equal(decide(write(all), DEFAULT_BYLAWS, EMPTY_STATE).decision, 'allow');
    const mcp = toActions('mcp__notes__save', { text: all });
    assert.equal(decideCall('mcp__notes__save', mcp, { ok: true, bylaws: DEFAULT_BYLAWS, source: 'd' }, EMPTY_STATE).decision, 'allow');
  });
  it('the reason names the detector and a count, never the value', () => {
    const b = bylawsWith([rule({ id: 'no-ids', reason: 'No identifiers.', match: { detector: ['card-number', 'us-ssn'] } })]);
    const v = decide(write(`a ${MADE_UP_CARD} b 4512 3456 7890 1234 c 123-45-6789`), b, EMPTY_STATE);
    assert.equal(v.decision, 'deny');
    assert.equal(v.reason, 'No identifiers. (found by card-number: 2, us-ssn: 1)');
  });
  it('detectors read the command line, the URL, write content and the raw arguments; nothing for a read', () => {
    const r = rule({ match: { detector: 'card-number' } });
    for (const a of [exec(`echo ${MADE_UP_CARD}`), { kind: 'fetch', url: `https://pay.example.test/?c=${MADE_UP_CARD}`, tool: 'WebFetch' } as Action, write(MADE_UP_CARD), ...toActions('mcp__x__y', { card: MADE_UP_CARD })]) {
      assert.equal(ruleCheck(r, a, null).outcome, 'match', JSON.stringify(a.kind));
    }
    assert.deepEqual(detectorTexts({ kind: 'read', path: `/work/${MADE_UP_CARD}`, tool: 'Read' }), []);
  });
  it('the raw arguments see what redaction removes; the redacted arguments do not', () => {
    const a = toActions('mcp__notes__save', { text: `use ${FAKE_TOKEN}`, password: 'hunter2-FAKE' })[0] as Extract<Action, { kind: 'other' }>;
    assert.ok(a.args !== undefined && !a.args.text.includes(FAKE_TOKEN));
    assert.ok(a.raw !== undefined && a.raw.text.includes(FAKE_TOKEN));
    const r = rule({ match: { detector: 'secret-token' } });
    assert.equal(ruleCheck(r, a, null).outcome, 'match');
    const noRaw: Action = { kind: 'other', tool: a.tool, args: a.args };
    assert.equal(ruleCheck(r, noRaw, null).outcome, null, 'over the redacted arguments alone the token is gone');
  });
  it('raw text holds every key, string and number, one per line; it is cut (fail closed) when the walk stops early', () => {
    const t = rawText({ to: 'x', n: 4512345678901234, nested: { list: ['a', 7] } });
    assert.deepEqual(t?.text.split('\n'), ['to', 'x', 'n', String(4512345678901234), 'nested', 'list', 'a', '7']);
    assert.equal(t?.cut, false);
    let deep: unknown = 'end';
    for (let i = 0; i < 20; i++) deep = { k: deep };
    assert.equal(rawText({ deep })?.cut, true);
  });
});

describe('detectors fail closed like content rules (cut content, out of steps)', () => {
  const big = (needle: string, at: 'head' | 'middle' | 'none'): string => {
    const filler = 'lorem ipsum dolor sit amet\n'.repeat(12000);
    return at === 'head' ? `${needle}\n${filler}` : at === 'middle' ? `${filler.slice(0, 150000)}${needle}${filler.slice(150000)}` : filler;
  };
  it('over the cap with no hit in the kept text: a deny rule denies, an ask rule asks, both saying the content was cut', () => {
    for (const decision of ['deny', 'ask'] as const) {
      const b = bylawsWith([rule({ id: 'ids', decision, match: { detector: 'card-number' } })]);
      const v = decide(write(big(MADE_UP_CARD, 'middle')), b, EMPTY_STATE);
      assert.equal(v.decision, decision);
      assert.match(v.reason, /over the 262,144-byte cap and was cut/);
      assert.ok(!v.reason.includes(MADE_UP_CARD));
    }
  });
  it('over the cap with a hit in the kept part: a plain match; under the cap with no hit: no match', () => {
    const b = bylawsWith([rule({ id: 'ids', match: { detector: 'card-number' } })]);
    const v = decide(write(big(MADE_UP_CARD, 'head')), b, EMPTY_STATE);
    assert.equal(v.decision, 'deny');
    assert.doesNotMatch(v.reason, /cut/);
    assert.equal(decide(write('lorem ipsum\n'.repeat(1000)), b, EMPTY_STATE).decision, 'allow');
  });
  it('over-cap raw arguments of an MCP call fail closed too', () => {
    const b = bylawsWith([rule({ id: 'tok', match: { detector: 'secret-token' } })]);
    const acts = toActions('mcp__notes__save', { text: big('nothing', 'none') });
    assert.equal(decideCall('mcp__notes__save', acts, { ok: true, bylaws: b, source: 'b' }, EMPTY_STATE).decision, 'deny');
  });
  it('content and detector in one rule: both must hold, and either one unknown makes the rule unknown', () => {
    const r = rule({ match: { content: 'invoice', detector: 'card-number' } });
    assert.equal(ruleCheck(r, write(`invoice ${MADE_UP_CARD}`), null).outcome, 'match');
    assert.equal(ruleCheck(r, write(`receipt ${MADE_UP_CARD}`), null).outcome, null);
    assert.equal(ruleCheck(r, write('invoice 42'), null).outcome, null);
    assert.equal(ruleCheck(r, write(`invoice\n${big('', 'none')}`), null).outcome, 'cut');
  });
  it('one judgement shares a step budget across its content rules: once it is spent, later content rules are unknown without searching', () => {
    let ab = '';
    let seed = 11;
    for (let i = 0; i < 200000; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      ab += (seed >> 16) & 1 ? 'a' : 'b';
    }
    const rules = Array.from({ length: 6 }, (_, i) => rule({ id: `x${i}`, decision: 'ask', match: { content: `a.{0,1000}c${i}` } }));
    const meter = newRuleMeter();
    const outcomes = rules.map((r) => ruleCheck(r, write(ab), null, meter).outcome);
    assert.deepEqual(outcomes, ['steps', 'steps', 'steps', 'steps', 'steps', 'steps']);
    assert.ok(meter.steps <= MAX_CALL_CONTENT_STEPS + MAX_CONTENT_STEPS, String(meter.steps));
    assert.ok(meter.steps >= MAX_CALL_CONTENT_STEPS, String(meter.steps));
    const spent = newRuleMeter();
    spent.steps = MAX_CALL_CONTENT_STEPS;
    assert.equal(ruleCheck(rule({ match: { content: 'zzz' } }), write('short text'), null, spent).outcome, 'steps');
    assert.equal(spent.steps, MAX_CALL_CONTENT_STEPS, 'no search was run');
  });
});

describe('match.network: the rule fires only when the taint guard says the action reaches the network', () => {
  const r = rule({ match: { network: true } });
  it('fires on a network command, a fetch and an MCP tool; not on a local command, a read or a write', () => {
    assert.equal(ruleCheck(r, exec('curl https://api.example.test'), null).outcome, 'match');
    assert.equal(ruleCheck(r, { kind: 'fetch', url: 'https://x.example.test', tool: 'WebFetch' }, null).outcome, 'match');
    assert.equal(ruleCheck(r, { kind: 'other', tool: 'mcp__mail__send' }, null).outcome, 'match');
    assert.equal(ruleCheck(r, exec('ls -la'), null).outcome, null);
    assert.equal(ruleCheck(r, { kind: 'read', path: '/work/app/a', tool: 'Read' }, null).outcome, null);
    assert.equal(ruleCheck(r, write('x'), null).outcome, null);
  });
  it('agrees with the taint guard\'s network leg on every action of every case row', () => {
    const ctx = taintContext(CASE_CWD, DEFAULT_BYLAWS);
    let n = 0;
    for (const f of loadCaseFiles()) {
      for (const c of f.cases) {
        for (const a of c.actions) {
          let taintSays: boolean;
          try {
            taintSays = traitsOf(a, ctx).network;
          } catch {
            continue;
          }
          assert.equal(actionReachesNetwork(a), taintSays, `${f.file}: ${c.label}`);
          assert.equal(ruleCheck(r, a, null).outcome === 'match', taintSays, `${f.file}: ${c.label}`);
          n++;
        }
      }
    }
    assert.ok(n >= 400, String(n));
  });
  it('a command the parser throws on is taken to reach the network (fail closed)', () => {
    const broken = { kind: 'exec', command: null, shell: 'posix', tool: 'Bash' } as unknown as Action;
    assert.equal(actionReachesNetwork(broken, null), true);
    assert.equal(ruleCheck(r, broken, null).outcome, 'match');
  });
});

describe('bylaws: loading detector and network rules and private_paths', () => {
  const load = (rules: unknown, taint?: unknown) => validateBylaws({ version: 1, rules, ...(taint !== undefined ? { guards: { taint } } : {}) });
  it('accepts a name or a list, network: true and globs; the template example loads', () => {
    const ok = load([{ id: 'a', match: { detector: 'iban' }, decision: 'ask' }, { id: 'b', match: { detector: ['email', 'phone-e164'], network: true }, decision: 'deny' }], { private_paths: ['clinical/**', '*.hl7'] });
    assert.ok(ok.ok, ok.ok ? '' : ok.error);
    assert.deepEqual(ok.bylaws.rules[1]?.match, { detector: ['email', 'phone-e164'], network: true });
    assert.deepEqual(ok.bylaws.guards.taint.private_paths, ['clinical/**', '*.hl7']);
    const m = /- id: no-card-numbers-out\n#\s+match: (\{[^\n]+\})/.exec(DEFAULT_BYLAWS_YAML);
    assert.ok(m !== null);
    const t = parseBylaws(`version: 1\nrules:\n  - id: example\n    match: ${m[1]}\n    decision: deny\n`);
    assert.ok(t.ok, t.ok ? '' : t.error);
    assert.equal(DEFAULT_BYLAWS.guards.taint.private_paths, undefined, 'absent by default, so the bylaws digest of a default setup is unchanged');
  });
  it('refuses an unknown detector, an empty list, network: false and a bad glob, each with the reason', () => {
    const cases: [unknown, unknown, RegExp][] = [
      [[{ id: 'a', match: { detector: 'credit-card' }, decision: 'ask' }], undefined, /unknown detector "credit-card" \(known: secret-token, card-number/],
      [[{ id: 'a', match: { detector: [] }, decision: 'ask' }], undefined, /match\.detector: must be a detector name or a list/],
      [[{ id: 'a', match: { network: false }, decision: 'ask' }], undefined, /match\.network: must be true \(leave it out/],
      [[{ id: 'a', match: { detector: 'iban', colour: 'red' }, decision: 'ask' }], undefined, /unknown key \(allowed: tool, command, path, content, detector, network\)/],
      [[], { private_paths: ['/etc/**'] }, /private_paths: "\/etc\/\*\*" must be relative/],
      [[], { private_paths: 'clinical/**' }, /private_paths: must be a list of globs/],
    ];
    for (const [rules, taint, re] of cases) {
      const r = load(rules, taint);
      assert.equal(r.ok, false);
      if (!r.ok) assert.match(r.error, re);
    }
  });
});

describe('a project file and the new settings (ADR 0010: the user file is a floor)', () => {
  const user = validateBylaws({ version: 1, guards: { taint: { private_paths: ['clinical/**'] } }, rules: [{ id: 'no-card-out', match: { detector: 'card-number', network: true }, decision: 'deny' }] });
  assert.ok(user.ok);
  it('a project may add private_paths; it cannot remove the user\'s', () => {
    const proj = validateBylaws({ version: 1, guards: { taint: { private_paths: ['*.hl7'] } } }, 'p', user.bylaws, true);
    assert.ok(proj.ok);
    const t = tighten(proj.bylaws, user.bylaws);
    assert.deepEqual([...(t.bylaws.guards.taint.private_paths ?? [])].sort(), ['*.hl7', 'clinical/**']);
    assert.ok(t.ignored.some((l) => l.field === 'guards.taint.private_paths' && l.baseline === 'clinical/**'), JSON.stringify(t.ignored));
    const empty = validateBylaws({ version: 1, guards: { taint: { private_paths: [] } } }, 'p', user.bylaws, true);
    assert.ok(empty.ok);
    assert.deepEqual(tighten(empty.bylaws, user.bylaws).bylaws.guards.taint.private_paths, ['clinical/**']);
  });
  it('a project repeating a detector rule id with another detector, or without network, keeps the user rule as written', () => {
    for (const match of [{ detector: 'email', network: true }, { detector: 'card-number' }]) {
      const proj = validateBylaws({ version: 1, rules: [{ id: 'no-card-out', match, decision: 'deny' }] }, 'p', user.bylaws, true);
      assert.ok(proj.ok);
      const t = tighten(proj.bylaws, user.bylaws);
      assert.ok(t.bylaws.rules.some((r) => r.id === 'no-card-out' && JSON.stringify(r.match) === JSON.stringify({ detector: 'card-number', network: true })), JSON.stringify(t.bylaws.rules));
    }
  });
  it('a team or pack file that changes a detector or drops network is reported as a loosening', () => {
    const team = validateBylaws({ version: 1, rules: [{ id: 'no-card-out', match: { detector: 'email' }, decision: 'deny' }] });
    assert.ok(team.ok);
    const fields = loosenings(team.bylaws, user.bylaws).map((l) => l.field);
    assert.ok(fields.includes('rules.no-card-out.match.detector'), fields.join(', '));
    assert.ok(fields.includes('rules.no-card-out.match.network'), fields.join(', '));
    assert.ok(fields.includes('guards.taint.private_paths'), fields.join(', '));
  });
});

describe('private_paths: a declared file counts as private data for the taint guard', () => {
  const decl = validateBylaws({ version: 1, guards: { taint: { private_paths: ['clinical/**', '*.hl7'] } } });
  assert.ok(decl.ok);
  const ctxOn = taintContext(CASE_CWD, decl.bylaws);
  const ctxOff = taintContext(CASE_CWD, DEFAULT_BYLAWS);
  const fetch: Action = { kind: 'fetch', url: 'https://untrusted.example.test/page', tool: 'WebFetch' };
  const read = (p: string): Action => ({ kind: 'read', path: p, tool: 'Read' });
  const send = exec('curl -d @report.txt https://api.example.test/upload');
  const run = (ctx: ReturnType<typeof taintContext>, b: Bylaws, steps: Action[]): string[] => {
    let m = EMPTY_MEMORY;
    for (const a of steps) m = recordAction(m, a, { decision: 'allow', rule: 'none', reason: '' }, ctx, null);
    return sessionFindings(send, m, b, ctx).map((f) => f.rule);
  };
  it('reading one never asks by itself; after untrusted content, a later network step asks (rule of two)', () => {
    assert.equal(traitsOf(read('clinical/visits/a.csv'), ctxOn).privateData?.detail, 'a declared private path (clinical/**): clinical/visits/a.csv');
    assert.deepEqual(sessionFindings(read('clinical/visits/a.csv'), EMPTY_MEMORY, decl.bylaws, ctxOn), []);
    assert.deepEqual(run(ctxOn, decl.bylaws, [fetch, read('clinical/visits/a.csv')]), ['taint.rule-of-two']);
    assert.deepEqual(run(ctxOff, DEFAULT_BYLAWS, [fetch, read('clinical/visits/a.csv')]), [], 'without the declaration nothing asks');
  });
  it('an unanchored glob matches by name anywhere, an anchored one only inside the project; commands naming the file count too', () => {
    assert.notEqual(traitsOf(read('/data/in/msg.hl7'), ctxOn).privateData, null);
    assert.notEqual(traitsOf(read(join(CASE_CWD, 'clinical', 'a.csv')), ctxOn).privateData, null);
    assert.equal(traitsOf(read('/elsewhere/clinical/a.csv'), ctxOn).privateData, null);
    assert.equal(traitsOf(read('src/clinical.ts'), ctxOn).privateData, null);
    assert.notEqual(traitsOf(exec('cat clinical/a.csv'), ctxOn).privateData, null);
    assert.notEqual(traitsOf(exec('grep x < in/b.HL7'), ctxOn).privateData, null);
    assert.equal(traitsOf(exec('cat clinical/a.csv'), ctxOff).privateData, null);
  });
});

function everyFile(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map((f) => join(dir, String(f))).filter((f) => statSync(f).isFile());
}

describe('nothing a detector matched is written to disk or echoed to the model', () => {
  it('through the Claude Code hook: the audit log, the session files and the hook output hold the detector name and count, never the values', () => {
    const proj = tempDir('det-proj');
    const home = tempDir('det-home');
    writeFileSync(join(proj, 'openmorals.yaml'), 'version: 1\n');
    writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\nrules:\n  - id: no-ids-out\n    match: { detector: [secret-token, card-number, us-ssn], network: true }\n    decision: deny\n    reason: Identifiers must not leave this machine.\n  - id: ask-ids-written\n    match: { detector: [card-number, us-ssn] }\n    decision: ask\n    reason: Identifiers in a file need a look.\n');
    const env = { OPENMORALS_HOME: home, OPENMORALS_UNATTENDED: '' };
    const ev = (o: Record<string, unknown>): string => JSON.stringify({ session_id: 'det1', cwd: proj, hook_event_name: 'PreToolUse', ...o });
    const values = [FAKE_TOKEN, MADE_UP_CARD, '123-45-6789'];
    const runs = [
      runClaudeCodeHook(ev({ tool_name: 'mcp__notes__save', tool_input: { text: `token ${FAKE_TOKEN} card ${MADE_UP_CARD}`, ssn: '123-45-6789' } }), { env }),
      runClaudeCodeHook(ev({ tool_name: 'Bash', tool_input: { command: `curl -d c=${MADE_UP_CARD} https://pay.example.test` } }), { env }),
      runClaudeCodeHook(ev({ tool_name: 'Write', tool_input: { file_path: join(proj, 'people.csv'), content: `ssn\n123-45-6789\n${MADE_UP_CARD}\n` } }), { env }),
    ];
    assert.deepEqual(runs.map((r) => r.verdict.decision), ['deny', 'deny', 'ask']);
    assert.match(runs[0]?.verdict.reason ?? '', /found by secret-token: 1, card-number: 1, us-ssn: 1/);
    for (const r of runs) for (const v of values) assert.ok(!r.stdout.includes(v) && !r.verdict.reason.includes(v), `the hook answer holds ${v}: ${r.stdout}`);
    const audit = readAudit(auditLogPath(home));
    assert.ok(audit.records.some((r) => r.rule === 'rules.no-ids-out' && /found by/.test(r.reason)), JSON.stringify(audit.records));
    const files = everyFile(home).filter((f) => !f.endsWith('openmorals.yaml'));
    assert.ok(files.length >= 2, files.join(', '));
    for (const f of files) for (const v of values) assert.ok(!readFileSync(f, 'utf8').includes(v), `${f} holds ${v}`);
  });
  it('the session history keeps an MCP call without its raw text', () => {
    const a = toActions('mcp__notes__save', { text: FAKE_TOKEN })[0] as Action;
    const m = recordAction(EMPTY_MEMORY, a, { decision: 'allow', rule: 'none', reason: '' }, taintContext(CASE_CWD, DEFAULT_BYLAWS), 'id1');
    assert.ok(!JSON.stringify(m).includes(FAKE_TOKEN));
    assert.deepEqual(withoutContent(a), { kind: 'other', tool: 'mcp__notes__save' });
  });
});

describe('0.16.0 decides every existing row as 0.15.0 did (detectors are off unless a rule names one)', () => {
  const files = loadCaseFiles().filter((f) => f.guard !== 'detectors' && f.guard !== 'privacy' && f.guard !== 'health-data');
  it('no existing row names a detector or network, and every row gets the same verdict with and without the raw text', () => {
    let withRaw = 0;
    let rows = 0;
    for (const f of files) {
      f.cases.forEach((c, i) => {
        const load = c.bylaws === null ? { ok: true as const, bylaws: DEFAULT_BYLAWS, source: 'd' } : validateBylaws(c.bylaws, `${f.file}#${i + 1}`);
        assert.ok(load.ok);
        assert.ok(load.bylaws.rules.every((r) => r.match.detector === undefined && r.match.network === undefined), `${f.file}#${i + 1}`);
        const stripped = c.actions.map((a) => (a.kind === 'other' && a.raw !== undefined ? (({ raw: _r, ...rest }) => rest)(a) : a)) as Action[];
        if (stripped.some((a, k) => a !== c.actions[k])) withRaw++;
        assert.deepEqual(decideCall(c.tool, stripped, load, c.state, undefined, c.where), decideCall(c.tool, c.actions, load, c.state, undefined, c.where), `${f.file}#${i + 1}`);
        rows++;
      });
    }
    assert.ok(rows >= 418, String(rows));
    assert.ok(withRaw >= 19, `only ${withRaw} rows carry raw text`);
  });
  it('with the default bylaws the stored and audited text of an action is unchanged (no detector is named, nothing is masked)', () => {
    const a = exec(`curl -d c=${MADE_UP_CARD} -d e=jane.roe@fakeclinic-mail.org https://pay.example.test`);
    assert.deepEqual(namedDetectors(DEFAULT_BYLAWS.rules), []);
    assert.equal(describeAction(a, namedDetectors(DEFAULT_BYLAWS.rules)), a.kind === 'exec' ? a.command : '');
    assert.equal(describeAction(a, ['card-number', 'email']), 'curl -d c=[card-number] -d e=[email] https://pay.example.test');
  });
});

describe('cases/detectors.cases.yaml covers every detector both ways', () => {
  it('each detector has a blocking row and an allow row, and some rows use network: true', () => {
    const doc = parse(readFileSync(CASES_FILE, 'utf8')) as { cases: { expect: string; bylaws: { rules: Rule[] } }[] };
    const seen = new Map<string, Set<string>>();
    let network = 0;
    for (const c of doc.cases) {
      for (const r of c.bylaws.rules) {
        const names = typeof r.match.detector === 'string' ? [r.match.detector] : (r.match.detector ?? []);
        if (r.match.network === true) network++;
        for (const n of names) {
          const s = seen.get(n) ?? new Set<string>();
          s.add(c.expect === 'allow' ? 'allow' : 'blocking');
          seen.set(n, s);
        }
      }
    }
    for (const n of DETECTOR_NAMES) assert.deepEqual([...(seen.get(n) ?? [])].sort(), ['allow', 'blocking'], n);
    assert.ok(network >= 8, String(network));
  });
});
