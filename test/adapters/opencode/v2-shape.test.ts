import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import { pluginSource } from '../../../src/adapters/opencode/index.js';
import { tempDir } from '../../helpers.js';

type Hook = (event: Record<string, unknown>) => unknown;
interface Plugin {
  id: string;
  setup(ctx: unknown): Promise<void>;
}

/** A stand-in for the openmorals command that records each payload and answers with a fixed object. */
function recorder(answer: Record<string, unknown>): { command: string[]; log: string } {
  const dir = tempDir('oc-v2-rec');
  const log = join(dir, 'payloads.jsonl');
  const script = join(dir, 'rec.mjs');
  writeFileSync(script, `import { appendFileSync } from 'node:fs';\nlet s='';process.stdin.on('data',(c)=>s+=c);process.stdin.on('end',()=>{appendFileSync(${JSON.stringify(log)}, s+'\\n');process.stdout.write(${JSON.stringify(JSON.stringify(answer))});});\n`);
  writeFileSync(log, '');
  return { command: [process.execPath, script], log };
}

async function hooksOf(command: readonly string[], directory: string): Promise<Record<string, Hook>> {
  const file = join(tempDir('oc-v2-plugin'), 'openmorals.mjs');
  writeFileSync(file, pluginSource(command));
  const plugin = ((await import(pathToFileURL(file).href)) as { default: Plugin }).default;
  const found: Record<string, Hook> = {};
  await plugin.setup({
    location: { directory },
    tool: { hook: async (name: string, cb: Hook) => void (found[`tool:${name}`] = cb) },
    permission: { hook: async (name: string, cb: Hook) => void (found[`permission:${name}`] = cb) },
    session: { hook: async (name: string, cb: Hook) => void (found[`session:${name}`] = cb) },
  });
  return found;
}

function payloads(log: string): Record<string, unknown>[] {
  return readFileSync(log, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('opencode V2 event shapes (opencode 2.4.1 plugin types)', () => {
  it('execute.before sends the V2 call id (event.id) and session id', async () => {
    const rec = recorder({ decision: 'allow', block: false, effect: 'allow' });
    const proj = tempDir('oc-v2-proj');
    const h = await hooksOf(rec.command, proj);
    await h['tool:execute.before']?.({ tool: 'bash', sessionID: 'ses_1', agent: 'build', messageID: 'msg_1', id: 'call_7', codemode: false, input: { command: 'ls' } });
    const p = payloads(rec.log)[0];
    assert.equal(p?.['callID'], 'call_7');
    assert.equal(p?.['sessionID'], 'ses_1');
    assert.equal(p?.['api'], 'v2');
    assert.deepEqual(p?.['args'], { command: 'ls' });
  });
  it('execute.after reads result.output, result.content (string or text parts) and error.message', async () => {
    const rec = recorder({ decision: 'allow', notice: null });
    const proj = tempDir('oc-v2-proj');
    const h = await hooksOf(rec.command, proj);
    const base = { tool: 'read', sessionID: 'ses_1', agent: 'build', messageID: 'msg_1', codemode: false, input: { filePath: 'a.md' } };
    await h['tool:execute.after']?.({ ...base, id: 'c1', status: 'completed', result: { output: 'from output' } });
    await h['tool:execute.after']?.({ ...base, id: 'c2', status: 'completed', result: { content: 'from content' } });
    await h['tool:execute.after']?.({ ...base, id: 'c3', status: 'completed', result: { content: [{ type: 'text', text: 'part one' }, { type: 'image' }, { type: 'text', text: 'part two' }] } });
    await h['tool:execute.after']?.({ ...base, id: 'c4', status: 'error', error: { message: 'boom' } });
    const p = payloads(rec.log);
    assert.deepEqual(p.map((x) => x['callID']), ['c1', 'c2', 'c3', 'c4']);
    assert.deepEqual(p.map((x) => x['output']), ['from output', 'from content', 'part one\npart two', null]);
    assert.equal(p[3]?.['error'], 'boom');
    assert.equal(p[3]?.['status'], 'error');
  });
  it('a notice is appended to whichever string field held the text, and never to a parts list', async () => {
    const rec = recorder({ decision: 'ask', notice: 'NOTICE' });
    const proj = tempDir('oc-v2-proj');
    const h = await hooksOf(rec.command, proj);
    const base = { tool: 'webfetch', sessionID: 's', agent: 'a', messageID: 'm', codemode: false, input: { url: 'https://docs.example.test' }, status: 'completed' };
    const a: Record<string, unknown> = { ...base, id: 'c1', result: { output: 'page', metadata: { x: 1 } } };
    const b: Record<string, unknown> = { ...base, id: 'c2', result: { content: 'page' } };
    const parts = [{ type: 'text', text: 'page' }];
    const c: Record<string, unknown> = { ...base, id: 'c3', result: { content: parts } };
    for (const e of [a, b, c]) await h['tool:execute.after']?.(e);
    assert.deepEqual(a['result'], { output: 'page\n\nNOTICE', metadata: { x: 1 } });
    assert.deepEqual(b['result'], { content: 'page\n\nNOTICE' });
    assert.deepEqual(c['result'], { content: [{ type: 'text', text: 'page' }] });
  });
});
