#!/usr/bin/env node
// Proves the single executable gives the same answers as the Node CLI it was built from.
//
//   node scripts/compare-binary.mjs <binary> [--timing N]
//
// Runs every case in cases/*.cases.yaml through both `node dist/src/cli.js` and the
// binary: command cases with `check --json` (and the case's bylaws, if it has any),
// tool cases with `hook claude-code` and a PreToolUse event on stdin. Also compares
// --version, packs, sandbox plan --json, scan --json, validate and eval --json (times aside). Each side gets its
// own empty OPENMORALS_HOME and runs in its own empty folder, so budget state evolves
// the same way on both. Exit code 0 when every stdout and exit code matches, 1 when any
// differs (each difference is printed), 64 on bad arguments.
//
// --timing N: also start each side N times with --version and print the median start
// time in milliseconds (N defaults to 0, no timing).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { normalisePaths } from './compare-paths.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'dist', 'src', 'cli.js');

function usage(msg) {
  process.stderr.write(`compare-binary: ${msg}\nusage: node scripts/compare-binary.mjs <binary> [--timing N]\n`);
  process.exit(64);
}

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write(`${readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1).filter((l) => l.startsWith('//')).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')}\n`);
  process.exit(0);
}
let timing = 0;
const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--timing') {
    timing = Number.parseInt(argv[++i] ?? '', 10);
    if (!Number.isInteger(timing) || timing < 0) usage('--timing needs a whole number');
  } else pos.push(argv[i]);
}
if (pos.length !== 1) usage('give exactly one binary');
const BINARY = resolve(pos[0]);
try {
  statSync(BINARY);
} catch {
  usage(`no file at ${BINARY}`);
}
try {
  statSync(CLI);
} catch {
  usage('dist/src/cli.js is missing; run npm run build first');
}

const scratch = mkdtempSync(join(tmpdir(), 'openmorals-compare-'));
const sides = {
  node: { cmd: process.execPath, pre: [CLI], home: mkdtempSync(join(scratch, 'home-node-')), cwd: mkdtempSync(join(scratch, 'cwd-node-')) },
  binary: { cmd: BINARY, pre: [], home: mkdtempSync(join(scratch, 'home-bin-')), cwd: mkdtempSync(join(scratch, 'cwd-bin-')) },
};

function runSide(side, args, stdin) {
  const env = { ...process.env, OPENMORALS_HOME: side.home };
  delete env.OPENMORALS_UNATTENDED;
  const r = spawnSync(side.cmd, [...side.pre, ...args], { cwd: side.cwd, env, input: stdin ?? '', encoding: 'utf8', timeout: 60_000, windowsHide: true });
  if (r.error !== undefined) return { stdout: '', status: `error: ${r.error.message}` };
  // The two sides run in different folders; a path that names one of them is not a difference.
  // On Windows a folder may also appear JSON-escaped, with forward slashes, or in its 8.3 short form (compare-paths.mjs).
  // The self-protect guard quotes a resolved path in lower case, and a temporary folder's name may hold capitals.
  return { stdout: normalisePaths(r.stdout, [{ dir: side.cwd, token: '<cwd>', extra: [side.cwd.toLowerCase()] }, { dir: side.home, token: '<home>', extra: [side.home.toLowerCase()] }]), status: r.status ?? r.signal };
}

let compared = 0;
const diffs = [];
function compare(label, args, stdin) {
  const a = runSide(sides.node, args, stdin);
  const b = runSide(sides.binary, args, stdin);
  compared++;
  if (a.stdout !== b.stdout || a.status !== b.status) diffs.push({ label, node: a, binary: b });
}

let bylawsSeq = 0;
function bylawsFile(obj) {
  const f = join(scratch, `bylaws-${++bylawsSeq}.yaml`);
  writeFileSync(f, stringify(obj));
  return f;
}

let cases = 0;
for (const file of readdirSync(join(ROOT, 'cases')).filter((f) => f.endsWith('.cases.yaml')).sort()) {
  const doc = parse(readFileSync(join(ROOT, 'cases', file), 'utf8'));
  doc.cases.forEach((c, i) => {
    cases++;
    const label = `${file}[${i}]`;
    const bylawsArgs = c.bylaws !== undefined ? ['--bylaws', bylawsFile(c.bylaws)] : [];
    if (typeof c.cmd === 'string') {
      compare(`${label} check ${JSON.stringify(c.cmd).slice(0, 80)}`, ['check', '--json', '--shell', c.shell ?? 'posix', ...bylawsArgs, '--', c.cmd]);
    } else {
      const ev = { session_id: `compare-${file}-${i}`, hook_event_name: 'PreToolUse', tool_name: c.tool, tool_input: c.input };
      compare(`${label} hook ${c.tool}`, ['hook', 'claude-code'], JSON.stringify(ev));
    }
  });
}

compare('--version', ['--version']);
compare('packs', ['packs']);
compare('sandbox plan --json', ['sandbox', 'plan', '--json']);
for (const p of ['darwin', 'linux', 'win32']) compare(`sandbox plan --platform ${p}`, ['sandbox', 'plan', '--json', '--platform', p]);
compare('scan packs', ['scan', join(ROOT, 'packs'), '--json']);
compare('validate default', ['validate']);
compare('hook bad stdin', ['hook', 'claude-code'], 'not json');
// eval: the binary scores its built-in rows, the Node CLI the cases folder. Times and the source name differ by nature;
// every count, rate and wrong row must be the same.
function evalShape(r) {
  try {
    const d = JSON.parse(r.stdout);
    const strip = (x) => ({ ...x, p50Ms: x.p50Ms === null ? null : 'time', p95Ms: x.p95Ms === null ? null : 'time' });
    return { stdout: JSON.stringify({ ...d, source: 'cases', total: strip(d.total), guards: d.guards.map(strip) }), status: r.status };
  } catch {
    return r;
  }
}
{
  const a = evalShape(runSide(sides.node, ['eval', '--json']));
  const b = evalShape(runSide(sides.binary, ['eval', '--json']));
  compared++;
  if (a.stdout !== b.stdout || a.status !== b.status || a.status !== 0) diffs.push({ label: 'eval --json (built-in rows)', node: a, binary: b });
}
for (const pack of ['strict', 'solo-dev', 'ci-unattended', 'production-ops', 'beginner']) {
  compare(`init --pack ${pack}`, ['init', `init-${pack}`, '--pack', pack, '--no-hook']);
  const read = (side) => {
    try {
      return readFileSync(join(side.cwd, `init-${pack}`, 'openmorals.yaml'), 'utf8');
    } catch {
      return null;
    }
  };
  const a = read(sides.node);
  const b = read(sides.binary);
  compared++;
  if (a === null || a !== b) diffs.push({ label: `init --pack ${pack}: written openmorals.yaml`, node: { stdout: a ?? '(missing)', status: '' }, binary: { stdout: b ?? '(missing)', status: '' } });
}

function median(xs) {
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

if (timing > 0) {
  for (const [name, side] of Object.entries(sides)) {
    const times = [];
    for (let i = 0; i < timing; i++) {
      const t = process.hrtime.bigint();
      runSide(side, ['check', 'git status']);
      times.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
    process.stdout.write(`start + check "git status", median of ${timing}: ${name} ${median(times).toFixed(1)} ms\n`);
  }
}

rmSync(scratch, { recursive: true, force: true });
for (const d of diffs.slice(0, 20)) process.stdout.write(`DIFFERENT ${d.label}\n  node   (${d.node.status}): ${d.node.stdout.trim().slice(0, 300)}\n  binary (${d.binary.status}): ${d.binary.stdout.trim().slice(0, 300)}\n`);
process.stdout.write(`${compared} comparisons (${cases} guard cases), ${diffs.length} different\n`);
process.exit(diffs.length === 0 ? 0 : 1);
