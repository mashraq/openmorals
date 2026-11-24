import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { REPO_ROOT } from './helpers.js';

interface Step {
  uses?: string;
  run?: string;
}
interface Job {
  permissions?: Record<string, string>;
  if?: string;
  needs?: string | string[];
  strategy?: { matrix?: { include?: { target: string }[] } };
  steps: Step[];
}
interface Workflow {
  on: { push?: { tags?: string[]; branches?: string[] }; workflow_dispatch?: unknown };
  permissions: Record<string, string>;
  jobs: Record<string, Job>;
}

function workflowText(name: string): string {
  return readFileSync(join(REPO_ROOT, '.github', 'workflows', name), 'utf8');
}

function load(name: string): Workflow {
  return parse(workflowText(name)) as Workflow;
}

/** The `uses:` lines of a workflow, read line by line whatever the line ending (a Windows checkout may give CRLF). */
function usesLines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => /^\s*-?\s*uses:/.test(l));
}

/** The `uses:` lines that are not pinned to a full commit SHA with a version comment. */
function unpinned(text: string): string[] {
  return usesLines(text)
    .filter((l) => !/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/.test(l))
    .map((l) => l.trim());
}

describe('release workflow', () => {
  const text = workflowText('release.yml');
  const wf = load('release.yml');

  it('runs on a v* tag and by hand, and on nothing else', () => {
    assert.deepEqual(Object.keys(wf.on).sort(), ['push', 'workflow_dispatch']);
    assert.deepEqual(wf.on.push?.tags, ['v*']);
    assert.equal(wf.on.push?.branches, undefined);
  });

  it('reads by default, and only the publish job, only on a tag push, may write', () => {
    assert.deepEqual(wf.permissions, { contents: 'read' });
    for (const [name, job] of Object.entries(wf.jobs)) {
      if (name === 'publish') {
        assert.deepEqual(job.permissions, { contents: 'write' });
        assert.match(job.if ?? '', /github\.event_name == 'push'/);
        assert.match(job.if ?? '', /refs\/tags\/v/);
      } else assert.equal(job.permissions, undefined, name);
    }
  });

  it('builds the five targets', () => {
    const targets = (wf.jobs['build']?.strategy?.matrix?.include ?? []).map((m) => m.target).sort();
    assert.deepEqual(targets, ['linux-arm64', 'linux-x64', 'macos-arm64', 'macos-x64', 'windows-x64']);
  });

  it('runs the verdict comparison and the Python tests on every target before uploading', () => {
    const runs = (wf.jobs['build']?.steps ?? []).map((s) => s.run ?? '').join('\n');
    assert.match(runs, /compare-binary\.mjs/);
    assert.match(runs, /unittest discover -s python\/tests/);
    assert.match(runs, /build_wheel\.py/);
  });

  it('writes SHA256SUMS and checks the tag against package.json', () => {
    const runs = (wf.jobs['checksums']?.steps ?? []).map((s) => s.run ?? '').join('\n');
    assert.match(runs, /sha256sum > SHA256SUMS/);
    assert.match(runs, /package\.json/);
  });

  for (const file of ['release.yml', 'ci.yml']) {
    it(`${file}: every action is pinned to a full commit SHA with its version in a comment`, () => {
      const uses = usesLines(workflowText(file));
      assert.ok(uses.length > 0);
      assert.deepEqual(unpinned(workflowText(file)), []);
    });
    it(`${file}: the pin check reads a CRLF checkout (Windows) the same way`, () => {
      const crlf = workflowText(file).replace(/\r?\n/g, '\r\n');
      assert.equal(usesLines(crlf).length, usesLines(workflowText(file)).length);
      assert.deepEqual(unpinned(crlf), []);
      assert.deepEqual(unpinned('steps:\r\n      - uses: actions/checkout@v4\r\n'), ['- uses: actions/checkout@v4'], 'an unpinned action is still caught');
    });
    it(`${file}: uses no secret but the built-in token`, () => {
      assert.doesNotMatch(workflowText(file), /secrets\./);
    });
  }

  it('hands untrusted strings to the shell through env, never inline', () => {
    for (const job of Object.values(wf.jobs)) for (const s of job.steps) assert.doesNotMatch(s.run ?? '', /\$\{\{\s*github\.(ref_name|ref|head_ref|event)/, s.run ?? '');
    assert.match(text, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  });
});
