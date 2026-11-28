import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as yamlParse } from 'yaml';
import { describe, it } from 'node:test';
import { DEFAULT_BYLAWS, DEFAULT_BYLAWS_YAML, parseBylaws, validateBylaws } from '../src/bylaws.js';
import { addPackCommand, MERGE_KINDS, planPackAdd, type MergeKind } from '../src/packs/add.js';
import { loosenings } from '../src/packs/compare.js';
import { REPO_ROOT, tempDir, withOpenmoralsOnPath } from './helpers.js';

// 0.45.0: `openmorals packs add NAME` merges one bundled pack into an existing project file and can only tighten.
// Nothing here touches the network; every file is written under a temporary folder.

const PACKS_DIR = join(REPO_ROOT, 'packs');
const PACKS = readdirSync(PACKS_DIR).filter((f) => f.endsWith('.yaml')).map((f) => f.slice(0, -'.yaml'.length)).sort();
const packText = (n: string): string => readFileSync(join(PACKS_DIR, `${n}.yaml`), 'utf8');
const CLI = join(REPO_ROOT, 'dist', 'src', 'cli.js');

/** A hand-written strict file: most decisions deny, small limits, no exemptions, extra protected entries. */
const STRICT = `# A strict file, written by hand.
version: 1
guards:
  destructive:
    decision: deny   # never without asking
    allow_targets: []
  online-delete: { decision: deny }
  secrets: { read: deny, write: deny, send: deny, hard: true }
  self-protect: { decision: deny }
  budget:
    tool_calls: { soft: 50, hard: 100, step: 10 }
    tokens: { soft: 100000, hard: 200000, step: 50000 }
    cost: { soft: 1, hard: 2, step: 1 }
    transcript: true
    agent_tool_calls: { soft: 10, hard: 20, step: 5 }
    spawns: { soft: 2, hard: 4, step: 1 }
    fanout: 2
  loop: { decision: deny }
  taint:
    decision: deny
    trusted_hosts: []
    private_paths: [secret/, "*.pem"]
  inbound: { enabled: true, decision: deny, max_bytes: 8388608 }
  document: { decision: deny, shrink_percent: 1, min_removed_bytes: 0, extensions: [md, txt], exclude: [] }
  outbound: { credential: deny, lookalike: deny, ip_host: deny, dangerous_target: deny, link_mismatch: deny, recipient: deny, lookalike_credential: deny, code_relay: deny, code_minutes: 60 }
  delete: { decision: deny, steer: trash }
  replace: { steer: keep }
  packages: { decision: deny }
  learn: { decision: deny, tokens: 100 }
  unknown-tools: { decision: deny, allow: [] }
rules:
  - id: own-deny-curl
    match: { command: "\\\\bcurl\\\\b" }
    decision: deny
    reason: No curl here.
audit:
  enabled: true
reviewer:
  on_escalate: deny
sandbox:
  network: { allow_hosts: [] }
  write: { allow: [] }
  read: { deny: [~/private] }
merge:
  review_free: []
  always_review: [src/**]
  boundary_paths: [api/**]
defer: true
protect: [mybank.example]
`;

/** A hand-written loose file: most checks off, large exemptions, no limits. */
const LOOSE = `# A loose file, written by hand.
version: 1
guards:
  destructive:
    decision: allow
    allow_targets: [dist, build, coverage, node_modules, tmp, .cache]
  online-delete:
    decision: allow
  secrets:
    read: allow
    write: allow
    send: ask
    hard: false
  self-protect:
    decision: allow   # a machine nobody else uses
  budget:
    tool_calls: { soft: 0, hard: 0, step: 100 }
    tokens: { soft: 0, hard: 0, step: 100 }
    transcript: false
    fanout: 0
  loop: { decision: allow }
  taint:
    decision: allow
    trusted_hosts: [example.com, .github.com]
  inbound:
    enabled: false
    decision: allow
    max_bytes: 4096
  document:
    decision: allow
    shrink_percent: 100
    min_removed_bytes: 1048576
    exclude: [docs/generated/**, node_modules]
  outbound: {credential: allow, lookalike: allow, ip_host: allow, dangerous_target: allow, link_mismatch: allow, recipient: allow, lookalike_credential: ask, code_relay: ask, code_minutes: 1}
  delete:
    decision: allow
    steer: ask
  packages:
    decision: allow
  learn:
    decision: allow
    tokens: 0
  unknown-tools:
    decision: allow
    allow: [my_tool]
rules: []
audit:
  enabled: false
sandbox:
  network:
    allow_hosts: [packages.example.org, "*.github.com"]
  write:
    allow: [~/scratch]
  read:
    deny: []
merge:
  review_free: [tighten-only, reproduced]
`;

const FILES: readonly [string, string][] = [['the default file', DEFAULT_BYLAWS_YAML], ['a strict file', STRICT], ['a loose file', LOOSE]];

function load(text: string) {
  const l = parseBylaws(text, 'openmorals.yaml', DEFAULT_BYLAWS, true);
  assert.ok(l.ok, l.ok ? '' : l.error);
  return l.bylaws;
}

/** The pairs of shipped packs that refuse, because both have a principle of the same id with other text. */
const CLASHING_PAIRS = new Set(['health-data+privacy', 'privacy+health-data', 'information-security+privacy', 'privacy+information-security']);

/** Every path of the schema, found by asking the validator: a key whose mapping value draws "unknown key (allowed: ...)" is a section. */
function schemaPaths(): { leaves: string[]; sections: string[] } {
  const leaves: string[] = [];
  const sections: string[] = [];
  const probeAt = (path: string[]): string[] | null => {
    const raw: Record<string, unknown> = { version: 1 };
    let cur = raw;
    for (const k of path) {
      const next: Record<string, unknown> = {};
      cur[k] = next;
      cur = next;
    }
    cur['__probe__'] = 1;
    const r = validateBylaws(raw, 'probe', DEFAULT_BYLAWS, false);
    assert.equal(r.ok, false);
    const where = [...path, '__probe__'].join('.');
    const msg = r.ok ? '' : r.error.split('; ').find((m) => m.startsWith(`${where}: `));
    if (msg === undefined || !msg.includes('unknown key')) return null;
    const m = /: unknown key \(allowed: (.*)\)$/.exec(msg);
    assert.ok(m !== null, `the validator names no allowed keys at ${where} (${msg}), so the schema cannot be enumerated there`);
    return (m[1] ?? '').split(', ');
  };
  const walk = (path: string[]): void => {
    const keys = probeAt(path);
    if (keys === null) {
      leaves.push(path.join('.'));
      return;
    }
    if (path.length > 0) sections.push(path.join('.'));
    for (const k of keys) walk([...path, k]);
  };
  walk([]);
  return { leaves, sections };
}

describe('packs add: the merge table covers the schema (0.45.0)', () => {
  const { leaves, sections } = schemaPaths();
  it('finds the schema by asking the validator, not from a list in this test', () => {
    assert.ok(leaves.length >= 90, `only ${leaves.length} settings found`);
    for (const p of ['guards.secrets.read', 'guards.budget.tool_calls.soft', 'sandbox.read.deny', 'reviewer.compat.token_param', 'data_classes.email.sites', 'principles', 'rules']) assert.ok(leaves.includes(p), p);
  });
  it('gives every setting of the schema a merge kind, itself or through the section it is in', () => {
    const missing = leaves.filter((l) => !Object.keys(MERGE_KINDS).some((k) => l === k || l.startsWith(`${k}.`)));
    assert.deepEqual(missing, []);
  });
  it('names no path the schema does not have, and never a path inside another entry', () => {
    const all = new Set([...leaves, ...sections]);
    for (const k of Object.keys(MERGE_KINDS)) {
      assert.ok(all.has(k), `${k} is not in the schema`);
      assert.ok(!Object.keys(MERGE_KINDS).some((o) => o !== k && k.startsWith(`${o}.`)), `${k} is inside another entry`);
    }
  });
});

describe('packs add: the result is never looser (0.45.0)', () => {
  it(`counts ${PACKS.length} bundled packs`, () => {
    assert.equal(PACKS.length, 12);
  });
  for (const [label, file] of FILES) {
    const before = load(file);
    for (const a of PACKS) {
      it(`${a} over ${label}: loads, is not looser than before, is at least as strict as the pack, and twice changes nothing`, () => {
        const plan = planPackAdd(file, 'openmorals.yaml', packText(a), a);
        assert.ok(plan.ok, plan.ok ? '' : plan.error);
        const after = load(plan.text);
        assert.deepEqual(loosenings(after, before), []);
        const packOver = validateBylaws(yamlParse(packText(a)) as unknown, a, before, true);
        assert.ok(packOver.ok);
        assert.deepEqual(loosenings(after, packOver.bylaws), [], 'a setting of the pack was not taken where it was stricter');
        const again = planPackAdd(plan.text, 'openmorals.yaml', packText(a), a);
        assert.ok(again.ok);
        assert.deepEqual(again.changes, []);
        assert.equal(again.text, plan.text);
      });
    }
    it(`every ordered pair of packs over ${label}: each step is not looser and loads, apart from the pinned principle clashes`, () => {
      let pairs = 0;
      const refused: string[] = [];
      for (const a of PACKS) {
        const first = planPackAdd(file, 'openmorals.yaml', packText(a), a);
        assert.ok(first.ok);
        const mid = load(first.text);
        for (const b of PACKS) {
          if (a === b) continue;
          pairs++;
          const second = planPackAdd(first.text, 'openmorals.yaml', packText(b), b);
          if (!second.ok) {
            refused.push(`${a}+${b}`);
            assert.ok(second.fields.length > 0 && second.fields.every((f) => f.startsWith('principles.')), `${a}+${b}: ${second.error}`);
            continue;
          }
          const after = load(second.text);
          assert.deepEqual(loosenings(after, mid), [], `${a}+${b}`);
          assert.deepEqual(loosenings(after, before), [], `${a}+${b}`);
        }
      }
      assert.equal(pairs, PACKS.length * (PACKS.length - 1));
      assert.deepEqual(new Set(refused), CLASHING_PAIRS);
    });
  }
});

describe('packs add: what refuses (0.45.0)', () => {
  it('refuses a rule id that is in the file with other content, and changes nothing', () => {
    const file = `version: 1\nrules:\n  - id: ask-before-push\n    match: { command: "\\\\bgit push\\\\b" }\n    decision: ask\n`;
    const plan = planPackAdd(file, 'openmorals.yaml', packText('strict'), 'strict');
    assert.equal(plan.ok, false);
    assert.ok(!plan.ok && plan.fields.includes('rules.ask-before-push'), plan.ok ? '' : plan.error);
  });
  it('adds the rest when the file already has one of the rules exactly', () => {
    const once = planPackAdd(DEFAULT_BYLAWS_YAML, 'f', packText('strict'), 'strict');
    assert.ok(once.ok);
    const rules = parseBylaws(once.text, 'f', DEFAULT_BYLAWS, true);
    assert.ok(rules.ok);
    const file = `version: 1\nrules:\n${yamlRule(rules.bylaws.rules[0])}`;
    const plan = planPackAdd(file, 'f', packText('strict'), 'strict');
    assert.ok(plan.ok, plan.ok ? '' : plan.error);
    assert.ok(plan.changes.some((c) => c.startsWith('rules: added') && !c.includes(rules.bylaws.rules[0]?.id ?? '?')));
  });
  it('refuses a pack setting the merge has no kind for, and copies nothing', () => {
    const kinds: Record<string, MergeKind> = { ...MERGE_KINDS };
    delete kinds['guards.secrets.read'];
    const plan = planPackAdd(DEFAULT_BYLAWS_YAML, 'f', packText('strict'), 'strict', kinds);
    assert.equal(plan.ok, false);
    assert.ok(!plan.ok && plan.fields.includes('guards.secrets.read'), plan.ok ? '' : plan.error);
  });
  it('refuses a setting only the user-level file may set', () => {
    const pack = 'version: 1\nsites: [example.com]\n';
    const plan = planPackAdd(DEFAULT_BYLAWS_YAML, 'f', pack, 'made-up');
    assert.ok(!plan.ok && plan.fields.includes('sites'), plan.ok ? '' : plan.error);
  });
  it('refuses an invalid file', () => {
    for (const bad of ['version: 1\nguards: { destructive: { decision: maybe } }\n', 'version: 1\nrules: [\n', 'guards: {}\n']) {
      const plan = planPackAdd(bad, 'f', packText('strict'), 'strict');
      assert.equal(plan.ok, false, bad);
    }
  });
});

/** The lines of `a` that a longest common subsequence with `b` does not keep. */
function removedLines(a: readonly string[], b: readonly string[]): string[] {
  const n = a.length;
  const m = b.length;
  const t: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) (t[i] as number[])[j] = a[i] === b[j] ? ((t[i + 1] as number[])[j + 1] as number) + 1 : Math.max((t[i + 1] as number[])[j] as number, (t[i] as number[])[j + 1] as number);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n) {
    if (j < m && a[i] === b[j]) {
      i++;
      j++;
    } else if (j < m && ((t[i] as number[])[j + 1] as number) >= ((t[i + 1] as number[])[j] as number)) j++;
    else out.push(a[i++] as string);
  }
  return out;
}

function yamlRule(r: unknown): string {
  const o = r as { id: string; match: Record<string, unknown>; decision: string; reason: string; hard: boolean };
  return `  - id: ${o.id}\n    match: ${JSON.stringify(o.match)}\n    decision: ${o.decision}\n    reason: ${JSON.stringify(o.reason)}\n${o.hard ? '    hard: true\n' : ''}`;
}

describe('packs add: the text of the file (0.45.0)', () => {
  it('over the commented default file, changes only the lines of the settings it changes and keeps every comment', () => {
    const plan = planPackAdd(DEFAULT_BYLAWS_YAML, 'f', packText('strict'), 'strict');
    assert.ok(plan.ok);
    const before = DEFAULT_BYLAWS_YAML.split('\n');
    const after = plan.text.split('\n');
    const gone = removedLines(before, after).map((l) => l.trim());
    assert.deepEqual(gone, ['decision: ask', 'decision: ask', 'read: ask', 'write: ask', 'decision: ask', 'tool_calls: { soft: 400, hard: 1500, step: 100 }', 'tokens: { soft: 2000000, hard: 5000000, step: 500000 }', 'rules: []']);
    const comments = (lines: string[]): string[] => lines.filter((l) => /^\s*#/.test(l) || / #/.test(l));
    assert.deepEqual(comments(after).filter((l) => comments(before).includes(l)), comments(before).filter((l) => after.includes(l)));
    assert.equal(comments(before).filter((l) => !after.includes(l)).length, 0, 'a comment line was lost');
    const kept = after.filter((l) => before.includes(l));
    assert.ok(kept.length >= before.length - 8);
  });
  it('keeps CRLF line ends and a flow list style', () => {
    const file = 'version: 1\r\n# mine\r\nguards:\r\n  destructive: { decision: allow, allow_targets: [dist, tmp] }   # keep\r\n';
    const plan = planPackAdd(file, 'f', packText('ci-unattended'), 'ci-unattended');
    assert.ok(plan.ok, plan.ok ? '' : plan.error);
    assert.ok(!/[^\r]\n/.test(plan.text), 'a line end lost its CR');
    assert.match(plan.text, /# mine\r\n/);
    assert.match(plan.text, /allow_targets: \[dist\] }   # keep\r\n/);
  });
  it('removes an exemption from a block list without touching the comments around it', () => {
    const file = 'version: 1\nguards:\n  destructive:\n    allow_targets:\n      # build output\n      - dist   # yes\n      - tmp    # scratch\n';
    const plan = planPackAdd(file, 'f', packText('ci-unattended'), 'ci-unattended');
    assert.ok(plan.ok, plan.ok ? '' : plan.error);
    assert.match(plan.text, /# build output\n {6}- dist {3}# yes\n/);
    assert.doesNotMatch(plan.text, /tmp/);
  });
});

describe('packs add: the command (0.45.0)', () => {
  const home = (): string => tempDir('packs-add-home');
  it('writes a backup first, then the new file, keeping its mode; a second run changes nothing and writes no backup', () => {
    const dir = tempDir('packs-add');
    const file = join(dir, 'openmorals.yaml');
    writeFileSync(file, DEFAULT_BYLAWS_YAML);
    chmodSync(file, 0o640);
    const r = addPackCommand({ cwd: dir, name: 'strict', dryRun: false, env: { OPENMORALS_HOME: home() }, now: new Date('2026-11-28T10:00:00Z') });
    assert.equal(r.exitCode, 0, r.stderr.join('\n'));
    assert.equal(r.written, true);
    assert.equal(r.backup, `${file}.openmorals-backup-2026-11-28T10-00-00-000Z`);
    assert.equal(readFileSync(r.backup ?? '', 'utf8'), DEFAULT_BYLAWS_YAML);
    const plan = planPackAdd(DEFAULT_BYLAWS_YAML, file, packText('strict'), 'strict');
    assert.ok(plan.ok);
    assert.equal(readFileSync(file, 'utf8'), plan.text);
    if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o640);
    const files = readdirSync(dir).sort();
    const again = addPackCommand({ cwd: dir, name: 'strict', dryRun: false, env: { OPENMORALS_HOME: home() }, now: new Date('2026-11-28T10:00:01Z') });
    assert.equal(again.exitCode, 0);
    assert.equal(again.written, false);
    assert.match(again.stdout.join('\n'), /already has everything in the strict pack; nothing changed/);
    assert.equal(readFileSync(file, 'utf8'), plan.text);
    assert.deepEqual(readdirSync(dir).sort(), files);
  });
  it('--dry-run prints the changes and writes nothing', () => {
    const dir = tempDir('packs-add-dry');
    const file = join(dir, 'openmorals.yaml');
    writeFileSync(file, DEFAULT_BYLAWS_YAML);
    const r = addPackCommand({ cwd: dir, name: 'test-lock', dryRun: true, env: { OPENMORALS_HOME: home() } });
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout.join('\n'), /would change .*test-lock pack[\s\S]*rules: added[\s\S]*dry run: nothing was written/);
    assert.equal(readFileSync(file, 'utf8'), DEFAULT_BYLAWS_YAML);
    assert.deepEqual(readdirSync(dir), ['openmorals.yaml']);
  });
  it('leaves an invalid file byte for byte as it was, and writes no backup', () => {
    for (const bad of ['version: 1\nguards: { destructive: { decision: maybe } }\n', 'version: 1\nrules: [\n', 'version: 2\n', 'version: 1\nprinciples: [{ id: x }]\n']) {
      const dir = tempDir('packs-add-bad');
      const file = join(dir, 'openmorals.yaml');
      writeFileSync(file, bad);
      const r = addPackCommand({ cwd: dir, name: 'strict', dryRun: false, env: { OPENMORALS_HOME: home() } });
      assert.equal(r.exitCode, 1, bad);
      assert.match(r.stderr.join('\n'), /invalid .*left untouched/);
      assert.equal(readFileSync(file, 'utf8'), bad);
      assert.deepEqual(readdirSync(dir), ['openmorals.yaml']);
    }
  });
  it('refuses where there is no project file, and creates none', () => {
    const dir = tempDir('packs-add-none');
    const r = addPackCommand({ cwd: dir, name: 'strict', dryRun: false, env: { OPENMORALS_HOME: home() } });
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr.join('\n'), /creates none; start one with: openmorals init --pack strict/);
    assert.deepEqual(readdirSync(dir), []);
  });
  it('never changes the user-level file', () => {
    const cfg = home();
    const file = join(cfg, 'openmorals.yaml');
    writeFileSync(file, DEFAULT_BYLAWS_YAML);
    const r = addPackCommand({ cwd: cfg, name: 'strict', dryRun: false, env: { OPENMORALS_HOME: cfg } });
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr.join('\n'), /is your user-level file/);
    assert.equal(readFileSync(file, 'utf8'), DEFAULT_BYLAWS_YAML);
    assert.deepEqual(readdirSync(cfg), ['openmorals.yaml']);
  });
  it('takes only the name of a bundled pack: a path, an address or another name is a usage error that lists the packs', () => {
    const dir = tempDir('packs-add-name');
    writeFileSync(join(dir, 'openmorals.yaml'), DEFAULT_BYLAWS_YAML);
    for (const name of ['nope', './packs/strict.yaml', 'https://example.com/strict.yaml', 'strict.yaml', '../strict', 'C:strict']) {
      const r = addPackCommand({ cwd: dir, name, dryRun: false, env: { OPENMORALS_HOME: home() } });
      assert.equal(r.exitCode, 64, name);
      assert.match(r.stderr.join('\n'), new RegExp(`bundled packs: ${PACKS.join(', ')}`));
      assert.match(r.stderr.join('\n'), /nothing is fetched/);
    }
    assert.equal(readFileSync(join(dir, 'openmorals.yaml'), 'utf8'), DEFAULT_BYLAWS_YAML);
  });
  it('adds to the nearest project file above the folder', () => {
    const dir = tempDir('packs-add-up');
    const sub = join(dir, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(dir, 'openmorals.yaml'), 'version: 1\n');
    const r = addPackCommand({ cwd: sub, name: 'test-lock', dryRun: false, env: { OPENMORALS_HOME: home() } });
    assert.equal(r.exitCode, 0, r.stderr.join('\n'));
    assert.equal(r.file, join(dir, 'openmorals.yaml'));
    assert.match(readFileSync(join(dir, 'openmorals.yaml'), 'utf8'), /^version: 1\nrules:\n {2}- id: /);
  });
  it('the CLI: exit codes 64 for usage, 1 for a refusal, 0 for a change', () => {
    const dir = tempDir('packs-add-cli');
    const cfg = home();
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: dir, env: { ...withOpenmoralsOnPath(), OPENMORALS_HOME: cfg } });
    assert.equal(run('packs', 'add').status, 64);
    assert.equal(run('packs', 'add', 'nope').status, 64);
    assert.equal(run('packs', 'add', 'strict', '--file', 'x').status, 64);
    assert.equal(run('packs', '--dry-run').status, 64);
    assert.equal(run('packs', 'add', 'strict').status, 1);
    writeFileSync(join(dir, 'openmorals.yaml'), DEFAULT_BYLAWS_YAML);
    const dry = run('packs', 'add', 'strict', '--dry-run');
    assert.equal(dry.status, 0);
    assert.equal(readFileSync(join(dir, 'openmorals.yaml'), 'utf8'), DEFAULT_BYLAWS_YAML);
    const r = run('packs', 'add', 'strict');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /guards\.destructive\.decision: ask -> deny/);
    assert.match(r.stdout, /backed up the previous file to /);
    const help = run('packs', '--help');
    assert.match(help.stdout, /openmorals packs add NAME \[--dry-run\]/);
  });
});
