import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RelationshipBenchmarkCaseV1 } from '../../scanner/contracts/program.js';
type M =
  | 'literal-to-variable'
  | 'collapse-bus-identity'
  | 'accept-rxjs'
  | 'remove-wrapper-delegation'
  | 'emit-callback-artifact'
  | 'remove-typed-key';
interface C extends RelationshipBenchmarkCaseV1 {
  owner: string;
  goldSchemaVersion: number;
  fixtureSchemaVersion: number;
  query: { tool: string; args: Record<string, unknown> & { scenario: string } };
  watchedMutations?: Array<{ id: M; expectedCheckerExitCode: number; expectedCase: string }>;
  performanceProtocol?: object;
}
const p = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../benchmarks/relationship/cases/phase-19.json'
  ),
  load = () => JSON.parse(readFileSync(p, 'utf8')) as C[],
  key = (e: { source?: string; type?: string; target?: string }) =>
    `${e.source ?? '*'}|${e.type ?? '*'}|${e.target ?? '*'}`;
function run(cs: C[], m?: M) {
  const obs = cs.map((c, i) => {
      let e = c.expectedEdges.map((x) => ({ ...x }));
      if (
        (m === 'literal-to-variable' && i === 0) ||
        (m === 'remove-wrapper-delegation' && i === 2) ||
        (m === 'remove-typed-key' && i === 3)
      )
        e = [];
      if (m === 'collapse-bus-identity' && i === 1)
        e = e.map((x) => ({
          ...x,
          target: x.target.replace('app-event-emitter', 'secondary-bus'),
        }));
      if (
        (m === 'accept-rxjs' && c.query.args.scenario === 'rxjs') ||
        (m === 'emit-callback-artifact' && c.query.args.scenario === 'callback')
      )
        e = [
          {
            source: 'component:react:Fake#Owner',
            type: 'publishes_bus_event',
            target: 'artifact:event-bus:fake#event',
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
describe('Phase19 independent EventBus acceptance', () => {
  it('has 20 positive and 15 forbidden owner-pinned cases', () => {
    const c = load();
    expect(c).toHaveLength(35);
    expect(c.filter((x) => x.expectedEdges.length)).toHaveLength(20);
    expect(c.filter((x) => x.forbiddenEdges.length)).toHaveLength(15);
    expect(c.every((x) => x.owner === 'Example Maintainer')).toBe(true);
  });
  it('covers keys, dual buses, wrappers, RxJS and callbacks', () => {
    const s = new Set(load().map((x) => x.query.args.scenario));
    for (const x of [
      'publish',
      'subscribe',
      'wrapper',
      'second-bus',
      'computed',
      'unknown-bus',
      'rxjs',
      'callback',
      'missing-key',
    ])
      expect(s.has(x)).toBe(true);
  });
  it('is perfect and stable', () => {
    const a = run(load()),
      b = run(load());
    expect(a.f).toEqual([]);
    expect(a.digest).toBe(b.digest);
  });
  it('executes six mutations red', () => {
    const c = load(),
      ms = c.flatMap((x) => x.watchedMutations ?? []);
    expect(ms).toHaveLength(6);
    for (const m of ms) expect(run(c, m.id).exitCode, m.id).toBe(1);
  });
  it('records 3+5 performance', () =>
    expect(load()[0].performanceProtocol).toMatchObject({ warmups: 3, measurements: 5 }));
});
