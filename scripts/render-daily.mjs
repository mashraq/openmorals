#!/usr/bin/env node
// Writes the files generated from the daily pack and the risk catalogue (0.29.0):
//
//   npm run build && node scripts/render-daily.mjs [--check]
//
// skills/openmorals-{documents,forms,email-and-links}/ (SKILL.md, README.md, references/risks.md) from
// packs/daily.yaml and src/guidance/daily.ts, and docs/daily-risks.md from src/guidance/risks.ts, using the built
// package in dist/. Only files whose text changed are written; nothing is deleted. With --check nothing is written:
// the exit code is 1 when any file is missing or stale (test/daily-guidance.test.ts checks the same).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write('usage: node scripts/render-daily.mjs [--check]\n');
  process.exit(0);
}
const unknown = args.filter((a) => a !== '--check');
if (unknown.length > 0) {
  process.stderr.write(`unknown argument ${unknown[0]}\n`);
  process.exit(64);
}
const check = args.includes('--check');
const g = await import(join(ROOT, 'dist', 'src', 'guidance', 'index.js'));
const daily = g.shippedDaily();
if (!daily.ok) {
  process.stderr.write(`the daily pack is invalid: ${daily.error}\n`);
  process.exit(1);
}
let stale = 0;
for (const f of g.renderRepoFiles(daily.principles)) {
  const file = join(ROOT, ...f.path.split('/'));
  let cur = null;
  try {
    cur = readFileSync(file, 'utf8');
  } catch {
    cur = null;
  }
  if (cur === f.text) continue;
  stale++;
  if (check) {
    process.stdout.write(`stale: ${f.path}\n`);
    continue;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, f.text);
  process.stdout.write(`wrote ${f.path}\n`);
}
if (check && stale > 0) process.exit(1);
process.stdout.write(`${stale === 0 ? 'all generated files are current' : `${stale} file(s) ${check ? 'stale' : 'written'}`}\n`);
