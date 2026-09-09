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
      new URL('../../../benchmarks/relationship/cases/phase-24.json', import.meta.url),
      'utf8'
    )
  ) as C[];
describe('Phase24 Actions acceptance', () => {
  it('has 30 positive and20 forbidden', () => {
    const c = load();
    expect(c.filter((x) => x.expectedEdges.length)).toHaveLength(30);
    expect(c.filter((x) => x.forbiddenEdges.length)).toHaveLength(20);
  });
  it('covers static lineage and hostility', () => {
    const s = new Set(load().map((x) => x.scenario));
    for (const x of [
      'needs',
      'remote-action',
      'local-action',
      'reusable',
      'run-script',
      'upload',
      'download',
      'custom-tag',
      'expression',
      'traversal',
      'shell',
      'execute',
    ])
      expect(s.has(x)).toBe(true);
  });
  it('has five watched controls', () =>
    expect(load().flatMap((x) => x.watchedMutations ?? [])).toHaveLength(5));
});
