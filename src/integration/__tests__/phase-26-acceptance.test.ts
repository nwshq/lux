import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
interface C {
  owner: string;
  scenario: string;
  expectedEdges: unknown[];
  forbiddenEdges: unknown[];
}
const load = () =>
  JSON.parse(
    readFileSync(
      new URL('../../../benchmarks/relationship/cases/phase-26.json', import.meta.url),
      'utf8'
    )
  ) as C[];
describe('Phase26 federation acceptance', () => {
  it('has25 positive/20 forbidden with zero fuzzy authorization', () => {
    const c = load();
    expect(c.filter((x) => x.expectedEdges.length)).toHaveLength(25);
    expect(c.filter((x) => x.forbiddenEdges.length)).toHaveLength(20);
    expect(c.every((x) => x.owner === 'Example Maintainer')).toBe(true);
  });
  it('covers explicit and hostile authorization', () => {
    const s = new Set(load().map((x) => x.scenario));
    for (const x of [
      'mapping',
      'package',
      'lambda',
      'image-digest',
      'terraform',
      'mutable-tag',
      'stale',
      'schema',
      'fingerprint',
      'escape',
      'embedding',
    ])
      expect(s.has(x)).toBe(true);
  });
});
