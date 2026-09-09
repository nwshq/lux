import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
interface C {
  owner: string;
  scenario: string;
  expectedEdges: unknown[];
  forbiddenEdges: unknown[];
  watchedMutations?: unknown[];
}
const load = () =>
  JSON.parse(
    readFileSync(
      new URL('../../../benchmarks/relationship/cases/phase-25.json', import.meta.url),
      'utf8'
    )
  ) as C[];
describe('Phase25 container acceptance', () => {
  it('has30 positive/20 forbidden', () => {
    const c = load();
    expect(c.filter((x) => x.expectedEdges.length)).toHaveLength(30);
    expect(c.filter((x) => x.forbiddenEdges.length)).toHaveLength(20);
  });
  it('covers static and hostile laws', () => {
    const s = new Set(load().map((x) => x.scenario));
    for (const x of [
      'stage',
      'image',
      'copy',
      'context',
      'depends-list',
      'depends-map',
      'interpolation',
      'remote-add',
      'glob',
      'traversal',
      'env-read',
      'execute',
    ])
      expect(s.has(x)).toBe(true);
  });
  it('has six mutations', () =>
    expect(load().flatMap((x) => x.watchedMutations ?? [])).toHaveLength(6));
});
