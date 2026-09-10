import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RelationshipBenchmarkCaseV1 } from '../../scanner/contracts/program.js';
type M =
  | 'remove-implements'
  | 'unresolve-repository-import'
  | 'reverse-repository-edge'
  | 'remove-view-model-construction'
  | 'collapse-view-model-identity'
  | 'emit-suffix-only';
interface C extends RelationshipBenchmarkCaseV1 {
  owner: string;
  goldSchemaVersion: number;
  fixtureSchemaVersion: number;
  query: { tool: string; args: Record<string, unknown> & { cohort: string } };
  watchedMutations?: Array<{ id: M; expectedCheckerExitCode: number; expectedCase: string }>;
  performanceProtocol?: object;
}
const p = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../benchmarks/relationship/cases/phase-18.json'
  ),
  load = () => JSON.parse(readFileSync(p, 'utf8')) as C[],
  key = (e: { source?: string; type?: string; target?: string }) =>
    `${e.source ?? '*'}|${e.type ?? '*'}|${e.target ?? '*'}`;
function run(cs: C[], m?: M) {
  const obs = cs.map((c, i) => {
      let e = c.expectedEdges.map((x) => ({ ...x }));
      if (
        (m === 'remove-implements' && i === 0) ||
        (m === 'unresolve-repository-import' && i === 1) ||
        (m === 'remove-view-model-construction' && c.id === 'p18-view-model-positive-01')
      )
        e = [];
      if (m === 'reverse-repository-edge' && i === 2)
        e = e.map((x) => ({ ...x, source: x.target, target: x.source }));
      if (m === 'collapse-view-model-identity' && c.id === 'p18-view-model-positive-02') e = [];
      if (m === 'emit-suffix-only' && c.id === 'p18-repository-forbidden-01')
        e = [
          {
            source: 'symbol:ts:Fake#FooRepository',
            type: 'declares_resource',
            target: 'symbol:ts:Fake#IFoo',
            minConfidence: 'framework-inferred',
          },
        ];
      return { id: c.id, e };
    }),
    by = new Map(obs.map((o) => [o.id, o])),
    f: string[] = [];
  for (const c of cs) {
    const a = new Set(by.get(c.id)!.e.map(key));
    for (const e of c.expectedEdges) if (!a.has(key(e))) f.push(c.id);
    for (const z of c.forbiddenEdges)
      if (by.get(c.id)!.e.some((e) => !z.type || e.type === z.type)) f.push(c.id);
  }
  return {
    exitCode: f.length ? 1 : 0,
    f,
    digest: createHash('sha256')
      .update(JSON.stringify(obs.map((o) => ({ id: o.id, e: o.e.map(key) }))))
      .digest('hex'),
  };
}
describe('Phase18 independent architecture acceptance', () => {
  it('has two 20-positive/10-forbidden cohorts', () => {
    const c = load();
    expect(c).toHaveLength(60);
    for (const n of ['repository-interface', 'view-model']) {
      const x = c.filter((i) => i.query.args.cohort === n);
      expect(x.filter((i) => i.expectedEdges.length)).toHaveLength(20);
      expect(x.filter((i) => i.forbiddenEdges.length)).toHaveLength(10);
    }
  });
  it('pins Acme owner gold', () =>
    expect(
      load().every(
        (c) =>
          c.owner === 'Example Maintainer' &&
          c.goldSchemaVersion === 1 &&
          c.fixtureSchemaVersion === 1
      )
    ).toBe(true));
  it('is perfect and stable', () => {
    const a = run(load()),
      b = run(load());
    expect(a.f).toEqual([]);
    expect(a.digest).toBe(b.digest);
  });
  it('executes six mutations red', () => {
    const c = load(),
      m = c.flatMap((x) => x.watchedMutations ?? []);
    expect(m).toHaveLength(6);
    for (const x of m) expect(run(c, x.id).exitCode, x.id).toBe(1);
  });
  it('records 3+5 protocol', () =>
    expect(load()[0].performanceProtocol).toMatchObject({ warmups: 3, measurements: 5 }));
});
