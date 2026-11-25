import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { bylawsDigest } from '../../src/audit.js';
import { DEFAULT_BYLAWS, parseBylaws, resolveBylaws } from '../../src/bylaws.js';
import { loosenings } from '../../src/packs/compare.js';
import { tempDir } from '../helpers.js';

function setup(user: string | null, project: string | null): { cwd: string; env: NodeJS.ProcessEnv } {
  const home = tempDir('merge-home');
  const cwd = tempDir('merge-cwd');
  mkdirSync(home, { recursive: true });
  if (user !== null) writeFileSync(join(home, 'openmorals.yaml'), user);
  if (project !== null) writeFileSync(join(cwd, 'openmorals.yaml'), project);
  return { cwd, env: { OPENMORALS_HOME: home } };
}

describe('the merge section of the bylaws', () => {
  it('is absent by default, so the digest of a setup without it is the 0.11.0 one', () => {
    assert.equal(DEFAULT_BYLAWS.merge, undefined);
    assert.equal(bylawsDigest(DEFAULT_BYLAWS), 'd41a1a3f92e3dfc55521cd212dc7429355142145453d7dcf6b21cbe283213f0a');
  });
  it('reads review_free and always_review, and refuses anything else', () => {
    const ok = parseBylaws('version: 1\nmerge:\n  review_free: [tighten-only, reproduced]\n  always_review: [clinical/**]\n');
    assert.ok(ok.ok, ok.ok ? '' : ok.error);
    assert.deepEqual(ok.bylaws.merge, { review_free: ['tighten-only', 'reproduced'], always_review: ['clinical/**'] });
    for (const bad of ['merge:\n  review_free: [docs]\n', 'merge:\n  always_review: [../x]\n', 'merge:\n  auto_merge: true\n', 'merge: [tighten-only]\n', 'merge:\n  review_free: tighten-only\n']) {
      const r = parseBylaws(`version: 1\n${bad}`);
      assert.equal(r.ok, false, bad);
    }
  });
  it('a project file cannot switch a class on: with no user file nothing is review-free, and the attempt is listed', () => {
    const { cwd, env } = setup(null, 'version: 1\nmerge:\n  review_free: [tighten-only]\n');
    const r = resolveBylaws(cwd, env);
    assert.ok(r.ok, r.ok ? '' : r.error);
    assert.deepEqual(r.bylaws.merge?.review_free ?? [], []);
    assert.ok((r.ignored ?? []).some((l) => l.field === 'merge.review_free' && l.candidate === 'tighten-only'));
  });
  it('a project file can switch a user class off and add always_review paths, never drop the user\'s', () => {
    const user = 'version: 1\nmerge:\n  review_free: [tighten-only, reproduced]\n  always_review: [clinical/**]\n';
    const { cwd, env } = setup(user, 'version: 1\nmerge:\n  review_free: [reproduced]\n  always_review: [billing/**]\n');
    const r = resolveBylaws(cwd, env);
    assert.ok(r.ok, r.ok ? '' : r.error);
    assert.deepEqual(r.bylaws.merge?.review_free, ['reproduced']);
    assert.deepEqual([...(r.bylaws.merge?.always_review ?? [])].sort(), ['billing/**', 'clinical/**']);
    assert.ok((r.ignored ?? []).some((l) => l.field === 'merge.always_review' && l.baseline === 'clinical/**'));
  });
  it('a project file that says nothing about merge keeps the user\'s settings', () => {
    const { cwd, env } = setup('version: 1\nmerge:\n  review_free: [tighten-only]\n', 'version: 1\n');
    const r = resolveBylaws(cwd, env);
    assert.ok(r.ok);
    assert.deepEqual(r.bylaws.merge?.review_free, ['tighten-only']);
  });
  it('loosenings() counts switching a class on as looser, and a new always_review path as not', () => {
    const on = parseBylaws('version: 1\nmerge:\n  review_free: [tighten-only]\n');
    const more = parseBylaws('version: 1\nmerge:\n  always_review: [x/**]\n');
    assert.ok(on.ok && more.ok);
    assert.deepEqual(loosenings(on.bylaws, DEFAULT_BYLAWS).map((l) => l.field), ['merge.review_free']);
    assert.deepEqual(loosenings(more.bylaws, DEFAULT_BYLAWS), []);
    assert.deepEqual(loosenings(DEFAULT_BYLAWS, more.bylaws).map((l) => l.field), ['merge.always_review']);
  });
});
