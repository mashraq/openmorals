import { chmodSync, constants as fsConstants, copyFileSync, existsSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isAlias, isMap, isScalar, isSeq, parse as parseYaml, parseDocument, stringify, type Node as YamlNode, type Scalar, type YAMLMap, type YAMLSeq } from 'yaml';
import { BYLAWS_FILENAMES, cloneBylaws, DEFAULT_BYLAWS, findBylaws, parseBylaws, validateBylaws } from '../bylaws.js';
import { defaultDeleteBylaws } from '../guards/delete.js';
import { matchesAllowTarget } from '../guards/destructive.js';
import { defaultDocumentBylaws } from '../guards/document.js';
import { defaultLearnBylaws } from '../guards/learn.js';
import { defaultOutboundBylaws } from '../outbound/guard.js';
import { configDir } from '../paths.js';
import { DEFAULT_FANOUT, defaultSpawns } from '../tokens/agents.js';
import type { Bylaws, Decision, DeleteSteer, Limit, ReplaceSteer } from '../types.js';
import { decisionRank, replaceRank, steerRank } from '../types.js';
import { loosenings } from './compare.js';
import { listPacks, loadPack, readPackText } from './load.js';
import { GUARD_NAMES, readPrinciples, type Principle } from './schema.js';

/**
 * How `openmorals packs add` (0.45.0) merges one setting of a bundled pack into a project file. Every merge keeps the
 * stricter of the two values, so the result is never looser than the file was:
 * - `decision`: the higher of allow < ask < deny.
 * - `on`: true when either is true (the setting is a check that true switches on).
 * - `limit`: per field (soft, hard, step) the lower non-zero number, 0 being no limit; soft is then held at most hard.
 * - `cap`: one number where 0 is no limit and lower is stricter.
 * - `min` / `max`: the lower / the higher number.
 * - `delete-steer`, `replace-steer`: the higher rank (trash over ask; keep over off).
 * - `permit`: a list of exemptions; only the file's entries the pack also exempts are kept.
 * - `restrict`: a list of protected things; the pack's entries are added.
 * - `rules`, `principles`: the pack's are added; an id in both refuses unless the two are the same.
 * - `disclaimer`: added, or put after the file's own with a blank line.
 * - `version`: must be the same.
 * - `user-level`: a setting only the user-level file may set; a pack naming one is refused.
 * A setting of a pack that is not in this table is refused, never copied.
 */
export type MergeKind = 'version' | 'decision' | 'on' | 'limit' | 'cap' | 'min' | 'max' | 'delete-steer' | 'replace-steer' | 'permit' | 'restrict' | 'rules' | 'principles' | 'disclaimer' | 'user-level';

/** Every setting of the `openmorals.yaml` schema, by its path, and how a pack's value of it is merged. */
export const MERGE_KINDS: Readonly<Record<string, MergeKind>> = Object.freeze({
  version: 'version',
  'guards.destructive.decision': 'decision',
  'guards.destructive.allow_targets': 'permit',
  'guards.online-delete.decision': 'decision',
  'guards.secrets.read': 'decision',
  'guards.secrets.write': 'decision',
  'guards.secrets.send': 'decision',
  'guards.secrets.hard': 'on',
  'guards.self-protect.decision': 'decision',
  'guards.budget.tool_calls': 'limit',
  'guards.budget.tokens': 'limit',
  'guards.budget.cost': 'limit',
  'guards.budget.prices': 'user-level',
  'guards.budget.transcript': 'on',
  'guards.budget.agent_tool_calls': 'limit',
  'guards.budget.spawns': 'limit',
  'guards.budget.fanout': 'cap',
  'guards.loop.decision': 'decision',
  'guards.taint.decision': 'decision',
  'guards.taint.trusted_hosts': 'permit',
  'guards.taint.private_paths': 'restrict',
  'guards.inbound.enabled': 'on',
  'guards.inbound.decision': 'decision',
  'guards.inbound.notify': 'user-level',
  'guards.inbound.max_bytes': 'max',
  'guards.inbound.judge': 'user-level',
  'guards.document.decision': 'decision',
  'guards.document.shrink_percent': 'min',
  'guards.document.min_removed_bytes': 'min',
  'guards.document.extensions': 'restrict',
  'guards.document.exclude': 'permit',
  'guards.outbound.credential': 'decision',
  'guards.outbound.lookalike': 'decision',
  'guards.outbound.ip_host': 'decision',
  'guards.outbound.dangerous_target': 'decision',
  'guards.outbound.link_mismatch': 'decision',
  'guards.outbound.recipient': 'decision',
  'guards.outbound.lookalike_credential': 'decision',
  'guards.outbound.code_relay': 'decision',
  'guards.outbound.code_minutes': 'max',
  'guards.delete.decision': 'decision',
  'guards.delete.steer': 'delete-steer',
  'guards.replace.steer': 'replace-steer',
  'guards.packages.decision': 'decision',
  'guards.learn.decision': 'decision',
  'guards.learn.tokens': 'cap',
  'guards.unknown-tools.decision': 'decision',
  'guards.unknown-tools.allow': 'permit',
  rules: 'rules',
  'audit.enabled': 'on',
  'reviewer.enabled': 'user-level',
  'reviewer.provider': 'user-level',
  'reviewer.model': 'user-level',
  'reviewer.api_key_env': 'user-level',
  'reviewer.timeout_ms': 'user-level',
  'reviewer.on_escalate': 'decision',
  'reviewer.base_url': 'user-level',
  'reviewer.auth': 'user-level',
  'reviewer.compat': 'user-level',
  'sandbox.network.allow_hosts': 'permit',
  'sandbox.write.allow': 'permit',
  'sandbox.write.protected_paths': 'user-level',
  'sandbox.read.deny': 'restrict',
  'merge.review_free': 'permit',
  'merge.always_review': 'restrict',
  'merge.boundary_paths': 'restrict',
  defer: 'on',
  sites: 'user-level',
  data_classes: 'user-level',
  protect: 'restrict',
  principles: 'principles',
  disclaimer: 'disclaimer',
  'guidance.first_activity': 'user-level',
});

type Obj = Record<string, unknown>;
type Path = readonly string[];

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** One change to the file, applied to its text and, for the check, to its parsed value. */
export interface Edit {
  path: Path;
  op: 'set' | 'append';
  value: unknown;
}

/** What `planPackAdd` decided. `changes` are lines for the person; `text` is the new file (equal to the old when nothing changes). */
export type PackAddPlan =
  | { ok: true; text: string; changes: string[] }
  | { ok: false; error: string; fields: string[] };

const YAML_OPTIONS = { strict: true, uniqueKeys: true, maxAliasCount: 50 } as const;

/** The policy with every optional section filled the way `loosenings` reads an absent one. */
function filled(b: Bylaws): Bylaws {
  const c = cloneBylaws(b);
  const g = c.guards;
  g.budget.cost ??= { soft: 0, hard: 0, step: 100 };
  g.budget.agent_tool_calls ??= { soft: 0, hard: 0, step: 100 };
  g.budget.spawns ??= defaultSpawns();
  g.budget.fanout ??= DEFAULT_FANOUT;
  g.budget.transcript ??= true;
  g.taint.private_paths ??= [];
  g.document ??= defaultDocumentBylaws();
  g.delete ??= defaultDeleteBylaws();
  g.outbound ??= defaultOutboundBylaws();
  g.replace ??= { steer: 'off' };
  g.packages ??= { decision: 'ask' };
  g.learn ??= defaultLearnBylaws();
  g['unknown-tools'] = { decision: g['unknown-tools']?.decision ?? 'ask', allow: [...(g['unknown-tools']?.allow ?? [])] };
  c.merge = { review_free: [...(c.merge?.review_free ?? [])], always_review: [...(c.merge?.always_review ?? [])], boundary_paths: [...(c.merge?.boundary_paths ?? [])] };
  c.defer ??= false;
  c.project_protect ??= [];
  return c;
}

/** A setting's value in a filled policy. `protect` of a project file is read into `project_protect`. */
function valueAt(b: Bylaws, path: string): unknown {
  let cur: unknown = b;
  for (const k of (path === 'protect' ? 'project_protect' : path).split('.')) cur = isObj(cur) ? cur[k] : undefined;
  return cur;
}

function stricterCount(a: number, b: number): number {
  if (a === 0) return b;
  if (b === 0) return a;
  return Math.min(a, b);
}

function permits(path: string, x: string, list: readonly string[]): boolean {
  if (path === 'guards.destructive.allow_targets') return matchesAllowTarget(x, list);
  if (path === 'guards.taint.trusted_hosts' || path === 'sandbox.network.allow_hosts') return list.some((y) => y.toLowerCase() === x.toLowerCase());
  return list.includes(x);
}

/** The stricter of the file's value `f` and the pack's `p` for a setting of this kind; null for a kind merged elsewhere. */
export function mergeValue(kind: MergeKind, path: string, f: unknown, p: unknown): unknown {
  switch (kind) {
    case 'decision':
      return decisionRank(p as Decision) > decisionRank(f as Decision) ? p : f;
    case 'on':
      return f === true || p === true;
    case 'limit': {
      const a = f as Limit;
      const b = p as Limit;
      const out: Limit = { soft: stricterCount(a.soft, b.soft), hard: stricterCount(a.hard, b.hard), step: stricterCount(a.step, b.step) };
      if (out.hard > 0 && out.soft > out.hard) out.soft = out.hard;
      return out;
    }
    case 'cap':
      return stricterCount(f as number, p as number);
    case 'min':
      return Math.min(f as number, p as number);
    case 'max':
      return Math.max(f as number, p as number);
    case 'delete-steer':
      return steerRank(p as DeleteSteer) > steerRank(f as DeleteSteer) ? p : f;
    case 'replace-steer':
      return replaceRank(p as ReplaceSteer) > replaceRank(f as ReplaceSteer) ? p : f;
    case 'permit':
      return (f as string[]).filter((x) => permits(path, x, p as string[]));
    case 'restrict':
      return [...(f as string[]), ...(p as string[]).filter((x) => !(f as string[]).includes(x))];
    default:
      return null;
  }
}

function shown(v: unknown): string {
  if (Array.isArray(v)) return v.length === 0 ? '(none)' : v.map((x) => String(x)).join(', ');
  return String(v);
}

/** The pack's settings, as paths into MERGE_KINDS; a path the table does not cover goes to `unknown`. */
function packPaths(raw: Obj, prefix: string, kinds: Readonly<Record<string, MergeKind>>, out: string[], unknown: string[]): void {
  for (const k of Object.keys(raw)) {
    const p = prefix === '' ? k : `${prefix}.${k}`;
    if (Object.prototype.hasOwnProperty.call(kinds, p)) {
      out.push(p);
      continue;
    }
    const v = raw[k];
    const inner = Object.keys(kinds).some((x) => x.startsWith(`${p}.`));
    if (inner && isObj(v)) packPaths(v, p, kinds, out, unknown);
    else if (!(inner && v === null)) unknown.push(p);
  }
}

/**
 * Plans adding a pack's text to a project file's text: which settings change, and the new text. Pure: reads and writes
 * nothing. Refuses (ok false) when the file or the pack does not load, when the pack sets a setting `kinds` does not
 * cover or that only the user-level file may set, when a rule or principle id is in both with different content, when
 * the new text would not load, or when it would be looser than the file in any setting `loosenings` compares.
 */
export function planPackAdd(fileText: string, fileSource: string, packText: string, packName: string, kinds: Readonly<Record<string, MergeKind>> = MERGE_KINDS): PackAddPlan {
  const refuse = (error: string, fields: string[] = []): PackAddPlan => ({ ok: false, error, fields });
  const fileLoad = parseBylaws(fileText, fileSource, DEFAULT_BYLAWS, true);
  if (!fileLoad.ok) return refuse(`${fileSource} is invalid (${fileLoad.error}); it was left untouched`);
  const packLoad = parseBylaws(packText, `pack:${packName}`);
  if (!packLoad.ok) return refuse(`the ${packName} pack is invalid (${packLoad.error})`);
  const fileRaw = parseYaml(fileText, YAML_OPTIONS) as unknown;
  const packRaw = parseYaml(packText, YAML_OPTIONS) as unknown;
  if (!isObj(fileRaw) || !isObj(packRaw)) return refuse('a file or pack that is not a mapping cannot be merged');
  const overFile = validateBylaws(packRaw, `pack:${packName}`, fileLoad.bylaws, true);
  if (!overFile.ok) return refuse(`the ${packName} pack does not load over ${fileSource} (${overFile.error})`);
  const fileB = filled(fileLoad.bylaws);
  const packB = filled(overFile.bylaws);

  const paths: string[] = [];
  const unknown: string[] = [];
  packPaths(packRaw, '', kinds, paths, unknown);
  if (unknown.length > 0) return refuse(`the ${packName} pack sets ${unknown.join(', ')}, which this command does not know how to merge, so it changes nothing; copy the setting by hand if you want it`, unknown);
  const userLevel = paths.filter((p) => kinds[p] === 'user-level');
  if (userLevel.length > 0) return refuse(`the ${packName} pack sets ${userLevel.join(', ')}, which only your user-level file can set; this command changes the project file only`, userLevel);

  const edits: Edit[] = [];
  const changes: string[] = [];
  const clashes: string[] = [];
  for (const p of paths) {
    const kind = kinds[p] as MergeKind;
    if (kind === 'rules' || kind === 'principles' || kind === 'disclaimer') continue;
    if (kind === 'version') {
      if (fileRaw['version'] !== packRaw['version']) return refuse(`the ${packName} pack is version ${shown(packRaw['version'])} and the file is version ${shown(fileRaw['version'])}`, ['version']);
      continue;
    }
    const f = valueAt(fileB, p);
    const merged = mergeValue(kind, p, f, valueAt(packB, p));
    if (isDeepStrictEqual(merged, f)) continue;
    if (kind === 'limit') {
      for (const k of ['soft', 'hard', 'step'] as const) {
        const now = (merged as Limit)[k];
        const was = (f as Limit)[k];
        if (now === was) continue;
        edits.push({ path: [...p.split('.'), k], op: 'set', value: now });
        changes.push(`${p}.${k}: ${was} -> ${now}`);
      }
      continue;
    }
    const yamlPath = p.split('.');
    edits.push({ path: yamlPath, op: 'set', value: merged });
    if (kind === 'permit') changes.push(`${p}: no longer exempt: ${shown((f as string[]).filter((x) => !(merged as string[]).includes(x)))}`);
    else if (kind === 'restrict') changes.push(`${p}: added ${shown((merged as string[]).filter((x) => !(f as string[]).includes(x)))}`);
    else changes.push(`${p}: ${shown(f)} -> ${shown(merged)}`);
  }

  const fileRules = new Map(fileLoad.bylaws.rules.map((r) => [r.id, r]));
  const rawRules = Array.isArray(packRaw['rules']) ? (packRaw['rules'] as unknown[]) : [];
  const addedRules: unknown[] = [];
  const addedIds: string[] = [];
  for (const raw of rawRules) {
    const id = isObj(raw) ? raw['id'] : undefined;
    const rule = overFile.bylaws.rules.find((r) => r.id === id);
    if (rule === undefined) return refuse(`a rule of the ${packName} pack could not be matched to its id`);
    const have = fileRules.get(rule.id);
    if (have === undefined) {
      addedRules.push(raw);
      addedIds.push(rule.id);
    } else if (!isDeepStrictEqual(have, rule)) clashes.push(`rules.${rule.id}`);
  }
  if (addedRules.length > 0) {
    edits.push({ path: ['rules'], op: 'append', value: addedRules });
    changes.push(`rules: added ${addedIds.join(', ')}`);
  }

  const fileP = readPrinciples(fileRaw, fileLoad.bylaws);
  const packP = readPrinciples(packRaw, overFile.bylaws);
  const rawPrinciples = Array.isArray(packRaw['principles']) ? (packRaw['principles'] as unknown[]) : [];
  const addedPrinciples: unknown[] = [];
  const added: Principle[] = [];
  for (const raw of rawPrinciples) {
    const id = isObj(raw) ? raw['id'] : undefined;
    const pr = packP.principles.find((x) => x.id === id);
    if (pr === undefined) return refuse(`a principle of the ${packName} pack could not be matched to its id`);
    const have = fileP.principles.find((x) => x.id === pr.id);
    if (have === undefined) {
      addedPrinciples.push(raw);
      added.push(pr);
    } else if (!isDeepStrictEqual(have, pr)) clashes.push(`principles.${pr.id}`);
  }
  if (clashes.length > 0) return refuse(`the file and the ${packName} pack both have ${clashes.join(', ')}, with different content; nothing is replaced, so nothing was changed. Rename or remove your own one first if you want the pack's`, clashes);
  if (addedPrinciples.length > 0) {
    edits.push({ path: ['principles'], op: 'append', value: addedPrinciples });
    changes.push(`principles: added ${added.length} (${added.filter((x) => x.checked_by !== undefined).length} checked, ${added.filter((x) => x.advisory !== undefined).length} advice only)`);
    const ruleIds = new Set([...fileLoad.bylaws.rules.map((r) => r.id), ...addedIds]);
    const fileGuards = isObj(fileRaw['guards']) ? Object.keys(fileRaw['guards']) : [];
    const named = [...new Set(added.flatMap((x) => x.checked_by ?? []).filter((x) => !ruleIds.has(x) && GUARD_NAMES.includes(x)))];
    for (const g of named) {
      if (fileGuards.includes(g) || edits.some((e) => e.path[0] === 'guards' && e.path[1] === g)) continue;
      edits.push({ path: ['guards', g], op: 'set', value: {} });
      changes.push(`guards.${g}: listed, so the pack's principles can name it (no setting changes)`);
    }
  }

  if (packP.disclaimer !== null) {
    const fd = fileP.disclaimer;
    if (fd === null) {
      edits.push({ path: ['disclaimer'], op: 'set', value: packP.disclaimer });
      changes.push("disclaimer: added the pack's");
    } else if (!fd.includes(packP.disclaimer)) {
      edits.push({ path: ['disclaimer'], op: 'set', value: `${fd}\n\n${packP.disclaimer}` });
      changes.push("disclaimer: the pack's added after yours");
    }
  }

  if (edits.length === 0) return { ok: true, text: fileText, changes: [] };

  let text: string;
  try {
    text = applyEdits(fileText, edits);
  } catch (e: unknown) {
    return refuse(`${fileSource} could not be changed safely (${e instanceof Error ? e.message : String(e)}); it was left untouched`);
  }
  const expected = JSON.parse(JSON.stringify(fileRaw)) as Obj;
  for (const e of edits) applyToValue(expected, e);
  let got: unknown;
  try {
    got = parseYaml(text, YAML_OPTIONS) as unknown;
  } catch (e: unknown) {
    return refuse(`the changed file would not parse (${e instanceof Error ? e.message.split('\n')[0] ?? '' : String(e)}); it was left untouched`);
  }
  if (!isDeepStrictEqual(got, expected)) return refuse(`the changed text of ${fileSource} would not say exactly what was planned; it was left untouched`);
  const after = parseBylaws(text, fileSource, DEFAULT_BYLAWS, true);
  if (!after.ok) return refuse(`with the ${packName} pack added, ${fileSource} would not load (${after.error}); it was left untouched`);
  const looser = loosenings(after.bylaws, fileLoad.bylaws);
  if (looser.length > 0) {
    const fields = [...new Set(looser.map((l) => l.field))];
    return refuse(`adding the ${packName} pack would loosen ${fields.join(', ')}; nothing was written`, fields);
  }
  const lost = fileP.principles.filter((x) => !readPrinciples(got as Obj, after.bylaws).principles.some((y) => isDeepStrictEqual(x, y)));
  if (lost.length > 0) return refuse(`adding the ${packName} pack would drop principles ${lost.map((x) => x.id).join(', ')}; nothing was written`);
  return { ok: true, text, changes };
}

function applyToValue(root: Obj, e: Edit): void {
  let cur: Obj = root;
  for (let i = 0; i < e.path.length - 1; i++) {
    const k = e.path[i] as string;
    const next = cur[k];
    if (!isObj(next)) cur[k] = {};
    cur = cur[k] as Obj;
  }
  const last = e.path[e.path.length - 1] as string;
  if (e.op === 'append') cur[last] = [...(Array.isArray(cur[last]) ? (cur[last] as unknown[]) : []), ...(e.value as unknown[])];
  else cur[last] = JSON.parse(JSON.stringify(e.value)) as unknown;
}

// ---- Text edits. The file is changed only at the nodes a change names; every other byte stays as it was. ----

class EditError extends Error {}

function lineStart(t: string, pos: number): number {
  return t.lastIndexOf('\n', pos - 1) + 1;
}

function column(t: string, pos: number): number {
  return pos - lineStart(t, pos);
}

function nextLineStart(t: string, pos: number): number {
  if (pos > 0 && t[pos - 1] === '\n') return pos;
  const i = t.indexOf('\n', pos);
  return i === -1 ? t.length : i + 1;
}

function indent(s: string, n: number): string {
  return s
    .split('\n')
    .map((l) => (l === '' ? l : `${' '.repeat(n)}${l}`))
    .join('\n');
}

function render(v: unknown): string {
  return stringify(v, { lineWidth: 0 });
}

function range(n: YamlNode): [number, number] {
  const r = n.range;
  if (r === undefined || r === null) throw new EditError('a node has no position');
  return [r[0], r[1]];
}

/** The position just after the colon that follows a mapping key. */
function afterColon(t: string, key: YamlNode): number {
  const end = range(key)[1];
  const i = t.indexOf(':', end);
  if (i === -1 || t.slice(end, i).trim() !== '') throw new EditError('a key is not followed by a colon');
  return i + 1;
}

/** Puts `obj` (a mapping) as the block value of `key`, replacing the text from the colon to `end`. */
function asBlockValue(t: string, key: YamlNode, end: number, obj: unknown): string {
  const from = afterColon(t, key);
  const body = indent(render(obj), column(t, range(key)[0]) + 2).replace(/\n$/, '');
  return `${t.slice(0, from)}\n${body}${t.slice(end)}`;
}

function insertIntoMap(t: string, map: YAMLMap, key: YamlNode | null, obj: Obj): string {
  if (!map.flow && map.items.length > 0) {
    const first = map.items[0]?.key as YamlNode;
    const ind = column(t, range(first)[0]);
    let pos = nextLineStart(t, range(map)[1]);
    let pre = '';
    if (pos === t.length && t.length > 0 && !t.endsWith('\n')) pre = '\n';
    if (pos > t.length) pos = t.length;
    return `${t.slice(0, pos)}${pre}${indent(render(obj), ind)}${t.slice(pos)}`;
  }
  if (key === null) throw new EditError('the file is a flow mapping at its top level');
  return asBlockValue(t, key, range(map)[1], { ...(map.toJSON() as Obj), ...obj });
}

function nest(path: Path, value: unknown): Obj {
  let v: unknown = value;
  for (let i = path.length - 1; i >= 0; i--) v = { [path[i] as string]: v };
  return v as Obj;
}

function isNull(n: unknown): n is Scalar {
  return isScalar(n) && n.value === null;
}

function setSeq(t: string, seq: YAMLSeq, key: YamlNode, value: unknown[]): string {
  const [start, end] = range(seq);
  if (seq.flow) return `${t.slice(0, start)}${value.length === 0 ? '[]' : stringify(value, { collectionStyle: 'flow', flowCollectionPadding: false, lineWidth: 0 }).replace(/\n$/, '')}${t.slice(end)}`;
  const contentEnd = t[end - 1] === '\n' ? end - 1 : end;
  if (value.length === 0) return `${t.slice(0, afterColon(t, key))} []${t.slice(contentEnd)}`;
  const old = seq.toJSON() as unknown[];
  const dash = column(t, start);
  const kept: number[] = [];
  let j = 0;
  for (let i = 0; i < old.length; i++) if (j < value.length && isDeepStrictEqual(old[i], value[j])) {
    kept.push(i);
    j++;
  }
  const additions = value.slice(j);
  if (additions.some((x) => old.some((y) => isDeepStrictEqual(x, y)))) throw new EditError('a list would be reordered');
  let out = t;
  if (additions.length > 0) {
    const pos = nextLineStart(out, end);
    out = `${out.slice(0, pos)}${pos === out.length && !out.endsWith('\n') ? '\n' : ''}${indent(render(additions), dash)}${out.slice(pos)}`;
  }
  for (let i = old.length - 1; i >= 0; i--) {
    if (kept.includes(i)) continue;
    const item = seq.items[i] as YamlNode;
    const r = item.range;
    if (r === undefined || r === null) throw new EditError('a list item has no position');
    const ls = lineStart(out, r[0]);
    const before = out.slice(ls, r[0]).trim();
    if (before !== '-') throw new EditError('a list item does not start its own line');
    const le = nextLineStart(out, r[2]);
    out = `${out.slice(0, ls)}${out.slice(le)}`;
  }
  return out;
}

function appendSeq(t: string, seq: YAMLSeq, key: YamlNode, items: unknown[]): string {
  const [start, end] = range(seq);
  if (!seq.flow && seq.items.length > 0) {
    const pos = nextLineStart(t, end);
    return `${t.slice(0, pos)}${pos === t.length && !t.endsWith('\n') ? '\n' : ''}${indent(render(items), column(t, start))}${t.slice(pos)}`;
  }
  const from = afterColon(t, key);
  const body = indent(render([...(seq.toJSON() as unknown[]), ...items]), column(t, range(key)[0]) + 2).replace(/\n$/, '');
  return `${t.slice(0, from)}\n${body}${t.slice(end)}`;
}

function applyEdit(t: string, e: Edit): string {
  const doc = parseDocument(t, YAML_OPTIONS);
  if (doc.errors.length > 0) throw new EditError(doc.errors[0]?.message.split('\n')[0] ?? 'parse error');
  let node: unknown = doc.contents;
  let key: YamlNode | null = null;
  for (let i = 0; i < e.path.length; i++) {
    const seg = e.path[i] as string;
    const rest = e.path.slice(i);
    if (isAlias(node)) throw new EditError(`an alias is used at ${e.path.slice(0, i).join('.')}`);
    if (isNull(node)) {
      if (key === null) throw new EditError('the file is empty');
      return asBlockValue(t, key, range(node)[1], nest(rest, e.value));
    }
    if (!isMap(node)) throw new EditError(`${e.path.slice(0, i).join('.') || 'the file'} is not a mapping`);
    const pair = node.items.find((it) => isScalar(it.key) && it.key.value === seg);
    if (pair === undefined) return insertIntoMap(t, node, key, nest(rest, e.value));
    key = pair.key as YamlNode;
    node = pair.value;
  }
  if (key === null) throw new EditError('an empty path');
  if (isAlias(node)) throw new EditError(`an alias is used at ${e.path.join('.')}`);
  if (e.op === 'append') {
    if (isNull(node)) return asBlockValue(t, key, range(node)[1], e.value);
    if (!isSeq(node)) throw new EditError(`${e.path.join('.')} is not a list`);
    return appendSeq(t, node, key, e.value as unknown[]);
  }
  if (Array.isArray(e.value)) {
    if (isSeq(node)) return setSeq(t, node, key, e.value);
    if (isNull(node)) return e.value.length === 0 ? `${t.slice(0, afterColon(t, key))} []${t.slice(range(node)[1])}` : asBlockValue(t, key, range(node)[1], e.value);
    throw new EditError(`${e.path.join('.')} is not a list`);
  }
  if (isObj(e.value)) {
    if (isMap(node) || isNull(node)) return t;
    throw new EditError(`${e.path.join('.')} is not a mapping`);
  }
  if (!isScalar(node)) throw new EditError(`${e.path.join('.')} is not a single value`);
  const r = render(e.value).replace(/\n$/, '');
  const [vs, ve] = range(node);
  if (!r.includes('\n') && node.type !== 'BLOCK_LITERAL' && node.type !== 'BLOCK_FOLDED') {
    return vs === ve && t.slice(afterColon(t, key), vs).trim() === '' ? `${t.slice(0, afterColon(t, key))} ${r}${t.slice(ve)}` : `${t.slice(0, vs)}${r}${t.slice(ve)}`;
  }
  const ks = range(key)[0];
  const pairText = indent(render({ [e.path[e.path.length - 1] as string]: e.value }), column(t, ks)).slice(column(t, ks));
  const keepNewline = t[ve - 1] === '\n';
  return `${t.slice(0, ks)}${keepNewline ? pairText : pairText.replace(/\n$/, '')}${t.slice(ve)}`;
}

/** Applies the edits in order to the file text. Line ends (CRLF) and a byte-order mark are kept. */
export function applyEdits(text: string, edits: readonly Edit[]): string {
  const bom = text.startsWith('﻿') ? '﻿' : '';
  const crlf = text.includes('\r\n');
  let t = (bom === '' ? text : text.slice(1)).replace(/\r\n/g, '\n');
  for (const e of edits) t = applyEdit(t, e);
  return `${bom}${crlf ? t.replace(/\n/g, '\r\n') : t}`;
}

// ---- The command. ----

export interface PackAddOptions {
  cwd: string;
  name: string;
  dryRun: boolean;
  env: NodeJS.ProcessEnv;
  now?: Date;
  /** The packs folder (tests); without it the bundled packs. */
  packsDir?: string;
}

/** What `openmorals packs add` did. `exitCode` 0: written, nothing to change or a dry run; 1: refused; 64: usage. */
export interface PackAddResult {
  exitCode: 0 | 1 | 64;
  stdout: string[];
  stderr: string[];
  /** The file that was or would be changed, when one was found. */
  file: string | null;
  written: boolean;
  backup: string | null;
}

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * `openmorals packs add NAME [--dry-run]`: adds one of the bundled packs to the project `openmorals.yaml` that governs
 * `cwd` (the nearest one at or above it). It can only tighten. Nothing is fetched; the user-level file is never written.
 */
export function addPackCommand(o: PackAddOptions): PackAddResult {
  const res: PackAddResult = { exitCode: 1, stdout: [], stderr: [], file: null, written: false, backup: null };
  const fail = (code: 1 | 64, ...lines: string[]): PackAddResult => {
    res.exitCode = code;
    res.stderr.push(...lines);
    return res;
  };
  const names = listPacks(o.packsDir).map((p) => p.name);
  const list = `bundled packs: ${names.join(', ')}`;
  if (names.length === 0) return fail(1, 'openmorals packs add: no bundled packs were found next to this openmorals; nothing was changed');
  if (/[/\\:]|\.ya?ml$/i.test(o.name)) return fail(64, `openmorals packs add: takes the name of a bundled pack, not a path or an address (got ${JSON.stringify(o.name).slice(0, 80)}); nothing is fetched and nothing was changed`, list);
  if (!names.includes(o.name)) return fail(64, `openmorals packs add: ${JSON.stringify(o.name).slice(0, 80)} is not a bundled pack; nothing is fetched and nothing was changed`, list);
  const file = findBylaws(o.cwd);
  if (file === null) return fail(1, `openmorals packs add: no openmorals.yaml in ${o.cwd} or a folder above it. This command adds to an existing file and creates none; start one with: openmorals init --pack ${o.name}`);
  res.file = file;
  const userDir = configDir(o.env);
  if (BYLAWS_FILENAMES.some((n) => existsSync(join(userDir, n)) && sameFile(join(userDir, n), file))) return fail(1, `openmorals packs add: ${file} is your user-level file; this command changes a project file only, and your user-level file is never changed by it`);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(file);
  } catch (e: unknown) {
    return fail(1, `openmorals packs add: cannot read ${file} (${e instanceof Error ? e.message : String(e)}); nothing was changed`);
  }
  if (!st.isFile()) return fail(1, `openmorals packs add: ${file} is not a regular file (a link or a folder); edit it by hand. Nothing was changed`);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e: unknown) {
    return fail(1, `openmorals packs add: cannot read ${file} (${e instanceof Error ? e.message : String(e)}); nothing was changed`);
  }
  const pack = readPackText(o.name, o.packsDir);
  if (!pack.ok) return fail(1, `openmorals packs add: ${pack.error}; nothing was changed`);
  const packLoad = loadPack(o.name, o.packsDir);
  if (!packLoad.ok) return fail(1, `openmorals packs add: the ${o.name} pack is invalid (${packLoad.error}); nothing was changed`);
  const plan = planPackAdd(text, file, pack.text, o.name);
  if (!plan.ok) return fail(1, `openmorals packs add: ${plan.error}`);
  if (plan.changes.length === 0) {
    res.exitCode = 0;
    res.stdout.push(`${file} already has everything in the ${o.name} pack; nothing changed`);
    return res;
  }
  res.stdout.push(`${o.dryRun ? 'would change' : 'changing'} ${file} with the ${o.name} pack (it can only tighten):`);
  for (const c of plan.changes) res.stdout.push(`  ${c}`);
  if (o.dryRun) {
    res.exitCode = 0;
    res.stdout.push('dry run: nothing was written');
    return res;
  }
  let again: string;
  try {
    again = readFileSync(file, 'utf8');
  } catch (e: unknown) {
    return fail(1, `openmorals packs add: cannot read ${file} again (${e instanceof Error ? e.message : String(e)}); nothing was changed`);
  }
  if (again !== text) return fail(1, `openmorals packs add: ${file} changed while this ran; nothing was written. Run it again`);
  const stamp = (o.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const backup = `${file}.openmorals-backup-${stamp}`;
  try {
    copyFileSync(file, backup, fsConstants.COPYFILE_EXCL);
  } catch (e: unknown) {
    return fail(1, `openmorals packs add: could not write the backup ${backup} (${e instanceof Error ? e.message : String(e)}); nothing was changed`);
  }
  res.backup = backup;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, plan.text, { flag: 'wx', mode: st.mode & 0o777 });
    chmodSync(tmp, st.mode & 0o777);
    renameSync(tmp, file);
  } catch (e: unknown) {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing was left behind, or it cannot be removed; the file itself was not replaced
    }
    return fail(1, `openmorals packs add: could not replace ${file} (${e instanceof Error ? e.message : String(e)}); it was left as it was, and the backup is ${backup}`);
  }
  res.written = true;
  res.exitCode = 0;
  res.stdout.push(`backed up the previous file to ${backup}`);
  res.stdout.push(`added the ${o.name} pack to ${file}`);
  return res;
}
