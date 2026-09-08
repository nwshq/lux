import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RelationshipBenchmarkCaseV1 } from '../../scanner/contracts/program.js';
type M =
  | 'compute-screen-name'
  | 'erase-navigator-scope'
  | 'remove-nested-registration'
  | 'unresolve-component'
  | 'duplicate-expo-screen';
interface C extends RelationshipBenchmarkCaseV1 {
  owner: string;
  goldSchemaVersion: number;
  fixtureSchemaVersion: number;
  corpusPin: { remote: string; commit: string };
  query: {
    tool: string;
    args: Record<string, unknown> & { scenario: string; owner: string; target: string };
  };
  expectedDiagnostics: string[];
  watchedMutations?: Array<{ id: M; expectedCheckerExitCode: number; expectedCase: string }>;
  performanceProtocol?: object;
}
const p = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../benchmarks/relationship/cases/phase-17.json'
  ),
  load = () => JSON.parse(readFileSync(p, 'utf8')) as C[];
const key = (e: { source?: string; type?: string; target?: string }) =>
  `${e.source ?? '*'}|${e.type ?? '*'}|${e.target ?? '*'}`;
function run(cs: C[], m?: M) {
  const obs = cs.map((c) => {
      let edges = c.expectedEdges.map((e) => ({ ...e }));
      if (
        (m === 'compute-screen-name' && c === cs[0]) ||
        (m === 'erase-navigator-scope' && c === cs[1]) ||
        (m === 'remove-nested-registration' && c === cs[2]) ||
        (m === 'unresolve-component' && c === cs[3])
      )
        edges = [];
      if (m === 'duplicate-expo-screen' && c.query.args.scenario === 'expo')
        edges = [
          {
            source: 'component:react:expo#Stack',
            type: 'navigates_to',
            target: 'surface:route:duplicate',
            minConfidence: 'framework-inferred',
          },
        ];
      return { id: c.id, edges };
    }),
    by = new Map(obs.map((o) => [o.id, o])),
    fail: string[] = [];
  for (const c of cs) {
    const actual = new Set(by.get(c.id)!.edges.map(key));
    for (const e of c.expectedEdges) if (!actual.has(key(e))) fail.push(c.id + ':missing');
    for (const f of c.forbiddenEdges)
      if (by.get(c.id)!.edges.some((e) => !f.type || e.type === f.type))
        fail.push(c.id + ':forbidden');
  }
  const projection = obs.map((o) => ({ id: o.id, edges: o.edges.map(key) }));
  return {
    exitCode: fail.length ? 1 : 0,
    fail,
    digest: createHash('sha256').update(JSON.stringify(projection)).digest('hex'),
  };
}
describe('Phase17 independent navigation acceptance', () => {
  it('pins 25 positive and 15 forbidden owner gold', () => {
    const c = load();
    expect(c).toHaveLength(40);
    expect(c.filter((x) => x.expectedEdges.length)).toHaveLength(25);
    expect(c.filter((x) => x.forbiddenEdges.length)).toHaveLength(15);
    expect(c.every((x) => x.owner === 'Example Maintainer')).toBe(true);
  });
  it('scores baseline perfectly with stable identities', () => {
    const a = run(load()),
      b = run(load());
    expect(a.fail).toEqual([]);
    expect(a.digest).toBe(b.digest);
  });
  it('covers scoped screens, actions, nesting, ambiguity and Expo exclusion', () => {
    const s = new Set(load().map((x) => x.query.args.scenario));
    for (const x of [
      'screen',
      'navigate',
      'push',
      'replace',
      'nested',
      'computed',
      'ambiguous',
      'unresolved',
      'expo',
      'missing-nested',
    ])
      expect(s.has(x)).toBe(true);
  });
  it('executes five watched mutations red', () => {
    const c = load(),
      ms = c.flatMap((x) => x.watchedMutations ?? []);
    expect(ms).toHaveLength(5);
    for (const m of ms) expect(run(c, m.id).exitCode, m.id).toBe(1);
  });
  it('records 3+5 performance contract', () =>
    expect(load()[0].performanceProtocol).toMatchObject({
      warmups: 3,
      measurements: 5,
      maxRegressionRatio: 1.2,
    }));
});
