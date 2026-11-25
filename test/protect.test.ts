import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { decideCall, toActions } from '../src/adapters/claude-code.js';
import { DEFAULT_BYLAWS, DEFAULT_BYLAWS_YAML, MAX_SITES, looseningNote, parseBylaws, resolveBylaws, validateBylaws } from '../src/bylaws.js';
import { BUILTIN_GUARDS } from '../src/engine.js';
import { CASE_CONFIG_DIR, CASE_CWD, CASE_HOME, CASE_NOW, caseBylaws } from '../src/eval/cases.js';
import type { Where } from '../src/guard.js';
import { makeWhere } from '../src/guard.js';
import { listedLookalike } from '../src/outbound/domain.js';
import type { OutboundSketch } from '../src/outbound/memory.js';
import { sketchMemory } from '../src/outbound/memory.js';
import { loosenings } from '../src/packs/compare.js';
import type { BylawsLoad, Verdict } from '../src/types.js';
import { EMPTY_STATE } from '../src/types.js';
import { loadCaseFiles } from './case-loader.js';
import { REPO_ROOT, tempDir } from './helpers.js';

const CLI = join(REPO_ROOT, 'dist', 'src', 'cli.js');

function where(sketch: OutboundSketch | null): Where {
  return makeWhere({ home: CASE_HOME, cwd: CASE_CWD, configDir: CASE_CONFIG_DIR, realpath: (p) => p, exists: () => true, readFile: () => ({ kind: 'missing' }), ...(sketch !== null ? { outbound: { memory: sketchMemory(sketch, CASE_NOW), now: CASE_NOW.getTime() } } : {}) }, {});
}

/** A row's policy: `user` as the user-level file, then `project` read over it as a project file. */
function load(user: unknown, project: unknown = null): Extract<BylawsLoad, { ok: true }> {
  const l = caseBylaws({ bylaws: user, project }, 'protect.test');
  if (!l.ok) assert.fail(l.error);
  return l;
}

function judge(l: BylawsLoad, tool: string, input: Record<string, unknown>, sketch: OutboundSketch | null = null): Verdict {
  return decideCall(tool, toActions(tool, input), l, EMPTY_STATE, BUILTIN_GUARDS, where(sketch));
}

const typePassword = (l: BylawsLoad, page: string): Verdict => judge(l, 'mcp__playwright__browser_type', { element: 'Password', target: 'e5', text: 'fake-Pa55word' }, { page, via: 'other' });
const open = (l: BylawsLoad, url: string): Verdict => judge(l, 'mcp__browser__navigate', { url });

describe('protect: the setting', () => {
  it('takes the same host names as sites, refuses a public suffix, and holds at most MAX_SITES per file', () => {
    const ok = parseBylaws('version: 1\nprotect: [MyBank.Example, mybank.example, bücher.example]\n');
    assert.ok(ok.ok, ok.ok ? '' : ok.error);
    assert.deepEqual(ok.bylaws.protect, ['mybank.example', 'xn--bcher-kva.example']);
    for (const bad of ['protect: [co.uk]', 'protect: [https://example.com]', 'protect: ["*.example.com"]', 'protect: [localhost]', 'protect: [203.0.113.7]', 'protect: example.com', 'project_protect: [example.com]']) {
      const p = parseBylaws(`version: 1\n${bad}\n`);
      assert.equal(p.ok, false, bad);
    }
    const co = parseBylaws('version: 1\nprotect: [co.uk]\n');
    assert.match(co.ok ? '' : co.error, /public suffix/);
    const many = Array.from({ length: MAX_SITES + 1 }, (_, i) => `site${i}.example`);
    assert.equal(validateBylaws({ version: 1, protect: many }).ok, false);
    assert.ok(validateBylaws({ version: 1, protect: many.slice(0, MAX_SITES) }).ok);
    assert.ok(validateBylaws({ version: 1, sites: ['co.uk'] }).ok, 'sites keeps its 0.22.0 validation');
  });
  it('is absent by default, and the template still parses to the defaults', () => {
    assert.equal(DEFAULT_BYLAWS.protect, undefined);
    assert.equal(DEFAULT_BYLAWS.project_protect, undefined);
    const p = parseBylaws(DEFAULT_BYLAWS_YAML);
    assert.ok(p.ok);
    assert.deepEqual(p.bylaws, DEFAULT_BYLAWS);
  });
  it('the user file and a project file both add; the project adds into project_protect; nothing is reported as a loosening; a project sites is still ignored', () => {
    const home = tempDir('pr-home');
    const proj = tempDir('pr-proj');
    writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\nsites: [example.com]\nprotect: [mybank.example]\n');
    writeFileSync(join(proj, 'openmorals.yaml'), 'version: 1\nprotect: [team-portal.example, mybank.example, example.com]\n');
    const r = resolveBylaws(proj, { OPENMORALS_HOME: home });
    assert.ok(r.ok, r.ok ? '' : r.error);
    assert.deepEqual(r.bylaws.sites, ['example.com']);
    assert.deepEqual(r.bylaws.protect, ['mybank.example']);
    assert.deepEqual(r.bylaws.project_protect, ['team-portal.example'], 'an entry already yours is not added again');
    assert.deepEqual(r.ignored, []);
    assert.equal(looseningNote(r), null);
    writeFileSync(join(proj, 'openmorals.yaml'), 'version: 1\nsites: [team-portal.example]\nprotect: []\n');
    const s = resolveBylaws(proj, { OPENMORALS_HOME: home });
    assert.ok(s.ok, s.ok ? '' : s.error);
    assert.deepEqual(s.bylaws.sites, ['example.com']);
    assert.deepEqual(s.bylaws.protect, ['mybank.example'], 'a project cannot remove one of yours');
    assert.equal(s.bylaws.project_protect, undefined);
    assert.deepEqual((s.ignored ?? []).map((l) => l.field), ['sites']);
  });
  it('an invalid project protect list fails closed on the user floor, and an invalid user file on the defaults', () => {
    const home = tempDir('pr-ih');
    const proj = tempDir('pr-ip');
    writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\nprotect: [mybank.example]\n');
    writeFileSync(join(proj, 'openmorals.yaml'), 'version: 1\nprotect: [co.uk]\n');
    const r = resolveBylaws(proj, { OPENMORALS_HOME: home });
    assert.equal(r.ok, false);
    assert.deepEqual(r.ok ? null : r.floor?.protect, ['mybank.example']);
    assert.equal(typePassword(r, 'https://myb4nk.example/').decision, 'deny', 'the user floor still refuses the look-alike');
    writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\nprotect: [mybank.example, "bad host"]\n');
    writeFileSync(join(proj, 'openmorals.yaml'), 'version: 1\n');
    const u = resolveBylaws(proj, { OPENMORALS_HOME: home });
    assert.equal(u.ok, false);
    assert.equal(typePassword(u, 'https://myb4nk.example/').decision, 'ask', 'unreadable list: asked, never allowed');
  });
  it('loosenings(): a list missing an entry of the baseline is looser; a longer one is not', () => {
    const base = load({ version: 1, protect: ['mybank.example', 'team-portal.example'] }).bylaws;
    const shorter = load({ version: 1, protect: ['mybank.example'] }).bylaws;
    const longer = load({ version: 1, protect: ['mybank.example', 'team-portal.example', 'other.example'] }).bylaws;
    assert.deepEqual(loosenings(shorter, base), [{ field: 'protect', candidate: '(missing)', baseline: 'team-portal.example' }]);
    assert.deepEqual(loosenings(longer, base), []);
    assert.deepEqual(loosenings(base, DEFAULT_BYLAWS), []);
  });
  it('a project file can already refuse every unlisted password (credential: deny) and add deny rules: protect gives it no new power to refuse', () => {
    const l = load({ version: 1 }, { version: 1, guards: { outbound: { credential: 'deny' } } });
    assert.equal(l.ok && l.bylaws.guards.outbound?.credential, 'deny');
    assert.deepEqual(l.ok ? l.ignored : null, []);
    assert.equal(typePassword(l, 'https://signin.example.org/').decision, 'deny');
  });
});

describe('protect: proof 1, a protect entry never lets a credential or recipient through unasked (the exemptions read sites only)', () => {
  for (const [name, l] of [
    ['your protect list', load({ version: 1, protect: ['mybank.example'] })],
    ["a project's protect list", load({ version: 1 }, { version: 1, protect: ['mybank.example'] })],
  ] as const) {
    it(`${name}: a password typed into the protected site itself asks`, () => {
      const v = typePassword(l, 'https://mybank.example/login');
      assert.equal(v.decision, 'ask');
      assert.equal(v.rule, 'outbound.credential');
      assert.match(v.reason, /not a site in your sites list/);
    });
    it(`${name}: a blind copy to an address at the protected site asks`, () => {
      const v = judge(l, 'mcp__mail__send_email', { to: 'alice@example.org', bcc: 'drop@mybank.example', subject: 'x', body: 'y' });
      assert.equal(v.decision, 'ask');
      assert.equal(v.rule, 'outbound.recipient');
    });
  }
  it('the same site in sites goes through unasked (the exemption is sites)', () => {
    assert.equal(typePassword(load({ version: 1, sites: ['mybank.example'] }), 'https://mybank.example/login').decision, 'allow');
  });
});

describe('protect: a protect entry or a remembered code never turns the sites check from deny into ask', () => {
  const strictSites = { guards: { outbound: { credential: 'deny', lookalike_credential: 'ask', code_relay: 'ask' } } };
  it('a password into a look-alike of a protected name is refused when credential is deny and lookalike_credential only asks', () => {
    const without = typePassword(load({ version: 1, ...strictSites }), 'https://myb4nk.example/login');
    assert.equal(without.decision, 'deny');
    const withProtect = typePassword(load({ version: 1, ...strictSites, protect: ['mybank.example'] }), 'https://myb4nk.example/login');
    assert.equal(withProtect.decision, 'deny', withProtect.reason);
    assert.equal(withProtect.rule, 'outbound.credential');
  });
  it('a one-time code relayed to a site its message did not name is refused when credential is deny and code_relay only asks', () => {
    const v = judge(load({ version: 1, ...strictSites }), 'mcp__playwright__browser_type', { element: 'Code', target: 'e7', text: '482913' }, { page: 'https://pay.example.org/confirm', via: 'other', codes: [{ code: '482913', named: ['mybank.example'], minutes_ago: 2 }] });
    assert.equal(v.decision, 'deny', v.reason);
  });
  it('with the defaults (lookalike_credential deny, credential ask) the look-alike refusal and its reason are unchanged', () => {
    const v = typePassword(load({ version: 1, protect: ['mybank.example'] }), 'https://myb4nk.example/login');
    assert.equal(v.decision, 'deny');
    assert.equal(v.rule, 'outbound.credential-lookalike');
  });
});

describe("protect: proof 2, the person's own word wins over a project's list", () => {
  const user = { version: 1, sites: ['mybank.example'] };
  const hostile = { version: 1, protect: ['myb4nk.example', 'rnybank.example'] };
  it('a site in your sites is never a look-alike of a name a project protects: opening it and typing your password both pass', () => {
    const l = load(user, hostile);
    assert.equal(open(l, 'https://mybank.example/').decision, 'allow');
    assert.equal(open(l, 'https://www.mybank.example/').decision, 'allow');
    assert.equal(typePassword(l, 'https://mybank.example/login').decision, 'allow');
  });
  it('nor is a name sharing the registrable domain of a site you listed', () => {
    const l = load({ version: 1, sites: ['login.mybank.example'] }, { version: 1, protect: ['mybank.examp1e'] });
    assert.equal(open(l, 'https://www.mybank.example/').decision, 'allow');
  });
  it('nor a name in your own protect list (it still asks for a password, as protect does)', () => {
    const l = load({ version: 1, protect: ['mybank.example'] }, hostile);
    assert.equal(open(l, 'https://mybank.example/').decision, 'allow');
    const v = typePassword(l, 'https://mybank.example/login');
    assert.equal(v.decision, 'ask');
    assert.equal(v.rule, 'outbound.credential');
  });
  it('without your own listing, the same site IS judged against the project list (so the rule above is what protects it)', () => {
    const l = load({ version: 1 }, hostile);
    assert.equal(open(l, 'https://mybank.example/').rule, 'outbound.lookalike');
    const v = typePassword(l, 'https://mybank.example/login');
    assert.equal(v.decision, 'deny');
    assert.match(v.reason, /from the project file's protect list/);
  });
  it("a project cannot shield a look-alike of your site by protecting the look-alike's own name", () => {
    for (const p of [['examp1e.com'], ['login.examp1e.com'], ['examp1e.com', 'example.com']]) {
      const l = load({ version: 1, sites: ['example.com'] }, { version: 1, protect: p });
      const v = typePassword(l, 'https://login.examp1e.com/');
      assert.equal(v.decision, 'deny', p.join(','));
      assert.match(v.reason, /looks like example\.com from your sites list/);
    }
    const l = load({ version: 1 }, { version: 1, protect: ['team-portal.example', 'team-p0rtal.example'] });
    assert.equal(typePassword(l, 'https://team-p0rtal.example/').decision, 'deny', 'one added name never shields another');
  });
});

describe('protect: matching and reasons', () => {
  it('listedLookalike with added names: per entry, own names first', () => {
    assert.equal(listedLookalike('examp1e.com', [], ['examp1e.com']), null);
    assert.deepEqual(listedLookalike('examp1e.com', ['example.com'], ['examp1e.com']), { site: 'example.com', how: 'skeleton' });
    assert.deepEqual(listedLookalike('examp1e.com', [], ['examp1e.com', 'example.com']), { site: 'example.com', how: 'skeleton' });
    assert.equal(listedLookalike('mybank.example', ['mybank.example'], ['myb4nk.example']), null);
    assert.equal(listedLookalike('www.mybank.example', ['login.mybank.example'], ['mybank.examp1e']), null);
    assert.deepEqual(listedLookalike('www.mybank.example', [], ['mybank.examp1e']), { site: 'mybank.examp1e', how: 'skeleton' });
    assert.deepEqual(listedLookalike('examp1e.com', ['example.com']), { site: 'example.com', how: 'skeleton' }, 'two-argument calls unchanged');
  });
  it('each reason names the list the name came from; the sites wording is unchanged', () => {
    const l = load({ version: 1, sites: ['example.com'], protect: ['mybank.example'] }, { version: 1, protect: ['team-portal.example'] });
    assert.match(typePassword(l, 'https://examp1e.com/').reason, /looks like example\.com from your sites list but is not it/);
    assert.match(typePassword(l, 'https://myb4nk.example/').reason, /looks like mybank\.example from your protect list but is not it/);
    assert.match(open(l, 'https://team-p0rtal.example/').reason, /looks like team-portal\.example from the project file's protect list but is not it/);
    for (const v of [typePassword(l, 'https://myb4nk.example/'), open(l, 'https://team-p0rtal.example/')]) assert.ok(v.reason.length < 300, String(v.reason.length));
  });
  it('a project-protected look-alike is refused exactly as a sites look-alike is, and the user file can make it ask', () => {
    assert.equal(typePassword(load({ version: 1 }, { version: 1, protect: ['team-portal.example'] }), 'https://team-p0rtal.example/').decision, 'deny');
    assert.equal(typePassword(load({ version: 1, guards: { outbound: { lookalike_credential: 'ask' } } }, { version: 1, protect: ['team-portal.example'] }), 'https://team-p0rtal.example/').decision, 'ask');
  });
});

describe('protect: false alarms on ordinary rows', () => {
  it('every allow row in every case file still allows with a protect list in the user file and another in a project file', () => {
    const extraUser = ['example.com', 'mybank.example', 'acme-tools.example'];
    const extraProject = ['team-portal.example', 'example.org'];
    let rows = 0;
    const flipped: string[] = [];
    for (const f of loadCaseFiles()) {
      for (const c of f.cases) {
        if (c.expect !== 'allow') continue;
        const before = caseBylaws(c, f.file);
        assert.ok(before.ok);
        const user = { ...(typeof c.bylaws === 'object' && c.bylaws !== null ? (c.bylaws as Record<string, unknown>) : { version: 1 }) };
        const own = Array.isArray(user['protect']) ? (user['protect'] as string[]) : [];
        user['protect'] = [...new Set([...own, ...extraUser])];
        const proj = { ...(typeof c.project === 'object' && c.project !== null ? (c.project as Record<string, unknown>) : { version: 1 }) };
        const added = Array.isArray(proj['protect']) ? (proj['protect'] as string[]) : [];
        proj['protect'] = [...new Set([...added, ...extraProject])];
        const after = caseBylaws({ bylaws: user, project: proj }, f.file);
        assert.ok(after.ok, after.ok ? '' : after.error);
        rows++;
        const v = decideCall(c.tool, c.actions, after, c.state, undefined, c.where);
        if (v.decision !== 'allow') flipped.push(`${f.file}: ${c.label.slice(0, 80)} -> ${v.decision} [${v.rule}]`);
      }
    }
    assert.ok(rows >= 247, String(rows));
    assert.deepEqual(flipped, []);
  });
});

describe('protect: validate prints where each name came from', () => {
  it('names the user file and the project file, and prints nothing new without protect', () => {
    const home = tempDir('pr-vh');
    const proj = tempDir('pr-vp');
    writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\nsites: [example.com]\nprotect: [mybank.example]\n');
    writeFileSync(join(proj, 'openmorals.yaml'), 'version: 1\nprotect: [team-portal.example]\n');
    const r = spawnSync(process.execPath, [CLI, 'validate'], { encoding: 'utf8', cwd: proj, env: { ...process.env, OPENMORALS_HOME: home } });
    assert.equal(r.status, 0, r.stderr);
    const line = r.stdout.split('\n').find((x) => x.startsWith('protected from look-alikes:')) ?? '';
    assert.match(line, /example\.com \(sites, .*openmorals\.yaml\)/);
    assert.match(line, /mybank\.example \(protect, .*openmorals\.yaml\)/);
    assert.match(line, /team-portal\.example \(protect, added by .*openmorals\.yaml\)/);
    writeFileSync(join(proj, 'openmorals.yaml'), 'version: 1\n');
    writeFileSync(join(home, 'openmorals.yaml'), 'version: 1\nsites: [example.com]\n');
    const q = spawnSync(process.execPath, [CLI, 'validate'], { encoding: 'utf8', cwd: proj, env: { ...process.env, OPENMORALS_HOME: home } });
    assert.equal(q.status, 0, q.stderr);
    assert.equal(q.stdout.includes('protected from look-alikes'), false);
  });
});
