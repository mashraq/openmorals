import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import ts from 'typescript';
import { REPO_ROOT } from './helpers.js';

// 0.42.0: the shapes API.md "Stability" promises, read from the built type files (dist/src/*.d.ts) by the TypeScript
// checker. A promised field removed, renamed, retyped or made optional fails, and so does a promised literal value
// removed. A new required field on an input type (`Action`, `SessionState`) fails too, since a caller who builds one
// would break. `Bylaws` is promised only as a value passed from `resolveBylaws` to `decide`, so no field of it is here.

/** A field as it is written in the built type file: `name` or `name?`, mapped to its type's text. */
export type Fields = Record<string, string>;

/** What is promised. Changing this before 1.0 needs ADR 0020 changed first. */
export const PROMISED = {
  decisionValues: ['allow', 'ask', 'deny'],
  verdict: { decision: 'Decision', rule: 'string', reason: 'string' } as Fields,
  sessionState: { toolCalls: 'number', tokens: 'number', prevTokens: 'number', 'cost?': 'number', 'prevCost?': 'number' } as Fields,
  action: {
    exec: { kind: "'exec'", command: 'string', shell: 'ShellKind', tool: 'string' },
    read: { kind: "'read'", path: 'string', tool: 'string' },
    write: { kind: "'write'", path: 'string', tool: 'string' },
    fetch: { kind: "'fetch'", url: 'string', tool: 'string' },
    other: { kind: "'other'", tool: 'string' },
  } as Record<string, Fields>,
  shellValues: ['cmd', 'posix', 'powershell'],
  bylawsLoad: {
    true: { ok: 'true', bylaws: 'Bylaws', source: 'string', 'floorSource?': 'string', 'ignored?': 'Loosening[]' },
    false: { ok: 'false', error: 'string', source: 'string', 'floor?': 'Bylaws', 'keptRest?': 'true' },
  } as Record<string, Fields>,
  loosening: { field: 'string', candidate: 'string', baseline: 'string' } as Fields,
};

/** Every way `got` breaks the promise `want`. `input`: a caller builds this type, so a new required field breaks it. */
export function fieldProblems(where: string, want: Fields, got: Fields | undefined, input: boolean): string[] {
  if (!got) return [`${where} is gone`];
  const out: string[] = [];
  for (const [k, t] of Object.entries(want)) {
    const name = k.replace(/\?$/, '');
    const have = Object.keys(got).find((g) => g.replace(/\?$/, '') === name);
    if (have === undefined) out.push(`${where}.${name} is gone`);
    else if (got[have] !== t) out.push(`${where}.${name} is ${got[have]}; promised ${t}`);
    else if (have.endsWith('?') !== k.endsWith('?')) {
      const opt = k.endsWith('?');
      if (input ? opt : !opt) out.push(`${where}.${name} is ${opt ? 'required' : 'optional'}; promised ${opt ? 'optional' : 'required'}`);
    }
  }
  if (input) for (const g of Object.keys(got)) if (!g.endsWith('?') && !(g in want)) out.push(`${where}.${g} is a new required field on an input type`);
  return out;
}

export function valueProblems(where: string, want: readonly string[], got: readonly string[] | undefined): string[] {
  if (!got) return [`${where} is gone`];
  return want.filter((v) => !got.includes(v)).map((v) => `${where} no longer has '${v}'`);
}

interface Shapes {
  decisionValues?: string[];
  verdict?: Fields;
  sessionState?: Fields;
  action: Record<string, Fields>;
  shellValues?: string[];
  bylawsLoad: Record<string, Fields>;
  loosening?: Fields;
}

/** Every way the built shapes break what is promised. */
export function shapeProblems(s: Shapes, p: typeof PROMISED = PROMISED): string[] {
  const out = [...valueProblems('Decision', p.decisionValues, s.decisionValues), ...fieldProblems('Verdict', p.verdict, s.verdict, false), ...fieldProblems('SessionState', p.sessionState, s.sessionState, true)];
  for (const [k, f] of Object.entries(p.action)) out.push(...fieldProblems(`Action '${k}'`, f, s.action[k], true));
  out.push(...valueProblems('Action exec shell', p.shellValues, s.shellValues));
  for (const [k, f] of Object.entries(p.bylawsLoad)) out.push(...fieldProblems(`BylawsLoad ok:${k}`, f, s.bylawsLoad[k], false));
  out.push(...fieldProblems('BylawsLoad ignored[]', p.loosening, s.loosening, false));
  return out;
}

/** The promised types as the built entry point declares them, read by the TypeScript checker. */
export function builtShapes(root: string): Shapes {
  const file = join(root, 'dist', 'src', 'index.d.ts');
  const prog = ts.createProgram([file], { noEmit: true, skipLibCheck: true, strict: true });
  const c = prog.getTypeChecker();
  const src = prog.getSourceFile(file);
  const mod = src && c.getSymbolAtLocation(src);
  assert.ok(mod, 'the TypeScript checker could not read dist/src/index.d.ts');
  const exported = new Map(c.getExportsOfModule(mod).map((s) => [s.name, s] as const));
  const typeOf = (name: string): ts.Type | undefined => {
    const s = exported.get(name);
    if (!s) return undefined;
    return c.getDeclaredTypeOfSymbol(s.flags & ts.SymbolFlags.Alias ? c.getAliasedSymbol(s) : s);
  };
  const members = (t: ts.Type): readonly ts.Type[] => (t.isUnion() ? t.types : [t]);
  const typeOfProp = (p: ts.Symbol): ts.Type => c.getTypeOfSymbolAtLocation(p, p.valueDeclaration ?? src);
  const literals = (t: ts.Type | undefined): string[] | undefined =>
    t ? members(t).map((x) => (x.isStringLiteral() ? x.value : c.typeToString(x))).sort() : undefined;
  const fields = (t: ts.Type | undefined): Fields | undefined => {
    if (!t) return undefined;
    const out: Fields = {};
    for (const p of c.getPropertiesOfType(t)) {
      const d = p.valueDeclaration;
      const node = d && (ts.isPropertySignature(d) || ts.isPropertyDeclaration(d)) ? d.type : undefined;
      out[`${p.name}${p.flags & ts.SymbolFlags.Optional ? '?' : ''}`] = node ? node.getText() : c.typeToString(typeOfProp(p));
    }
    return out;
  };
  const byKey = (t: ts.Type | undefined, key: string): Record<string, ts.Type> => {
    const out: Record<string, ts.Type> = {};
    if (!t) return out;
    for (const m of members(t)) {
      const k = c.getPropertyOfType(m, key);
      const v = k && literals(typeOfProp(k));
      if (v && v.length === 1) out[v[0] ?? ''] = m;
    }
    return out;
  };
  const prop = (t: ts.Type | undefined, name: string): ts.Type | undefined => {
    const p = t && c.getPropertyOfType(t, name);
    return p ? c.getNonNullableType(typeOfProp(p)) : undefined;
  };
  const actions = byKey(typeOf('Action'), 'kind');
  const loads = byKey(typeOf('BylawsLoad'), 'ok');
  const ignored = prop(loads['true'], 'ignored');
  const element = ignored && c.isArrayType(ignored) ? c.getTypeArguments(ignored as ts.TypeReference)[0] : undefined;
  return {
    decisionValues: literals(typeOf('Decision')),
    verdict: fields(typeOf('Verdict')),
    sessionState: fields(typeOf('SessionState')),
    action: Object.fromEntries(Object.entries(actions).map(([k, t]) => [k, fields(t) ?? {}])),
    shellValues: literals(prop(actions['exec'], 'shell')),
    bylawsLoad: Object.fromEntries(Object.entries(loads).map(([k, t]) => [k, fields(t) ?? {}])),
    loosening: fields(element),
  };
}

describe('the Stable types keep the shape API.md promises (0.42.0)', () => {
  const built = builtShapes(REPO_ROOT);

  it('the shapes were read', (t) => {
    t.diagnostic(`Action kinds ${Object.keys(built.action).sort().join(', ')}; BylawsLoad ok ${Object.keys(built.bylawsLoad).sort().join(', ')}`);
    assert.deepEqual(Object.keys(built.action).sort(), ['exec', 'fetch', 'other', 'read', 'write']);
    assert.deepEqual(Object.keys(built.bylawsLoad).sort(), ['false', 'true']);
  });

  it('every promised field and value is in the built types', () => {
    assert.deepEqual(shapeProblems(built), []);
  });

  it('the check is not blind: each planted fault is found', () => {
    const copy = (): Shapes => JSON.parse(JSON.stringify(built)) as Shapes;
    const faults: readonly [string, (s: Shapes) => void][] = [
      ['a Verdict field renamed', (s) => { const v = s.verdict!; v['why'] = v['reason']!; delete v['reason']; }],
      ['a Verdict field retyped', (s) => { s.verdict!['rule'] = 'number'; }],
      ['a Verdict field made optional', (s) => { const v = s.verdict!; v['reason?'] = v['reason']!; delete v['reason']; }],
      ['a SessionState field removed', (s) => { delete s.sessionState!['prevTokens']; }],
      ['a required SessionState field added', (s) => { s.sessionState!['turns'] = 'number'; }],
      ['an Action kind removed', (s) => { delete s.action['fetch']; }],
      ['an Action field renamed', (s) => { const a = s.action['exec']!; a['cmd'] = a['command']!; delete a['command']; }],
      ['a required Action field added', (s) => { s.action['read']!['mode'] = 'string'; }],
      ['a shell value removed', (s) => { s.shellValues = ['cmd', 'posix']; }],
      ['a Decision value removed', (s) => { s.decisionValues = ['allow', 'deny']; }],
      ['a BylawsLoad field removed', (s) => { delete s.bylawsLoad['false']!['error']; }],
      ['a Loosening field renamed', (s) => { const l = s.loosening!; l['name'] = l['field']!; delete l['field']; }],
      ['Verdict gone', (s) => { delete s.verdict; }],
    ];
    for (const [name, plant] of faults) {
      const s = copy();
      plant(s);
      assert.ok(shapeProblems(s).length > 0, `not found: ${name}`);
    }
    const s = copy();
    s.verdict!['detail?'] = 'string';
    s.sessionState!['turns?'] = 'number';
    s.action['other']!['args?'] = 'ActionText';
    assert.deepEqual(shapeProblems(s), [], 'an added optional field is not a break');
  });
});
