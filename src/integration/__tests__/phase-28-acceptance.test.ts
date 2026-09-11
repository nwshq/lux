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
      new URL('../../../benchmarks/relationship/cases/phase-28.json', import.meta.url),
      'utf8'
    )
  ) as C[];
describe('Phase28 gopls acceptance', () => {
  it('has20 positive/15 forbidden', () => {
    const c = load();
    expect(c.filter((x) => x.expectedEdges.length)).toHaveLength(20);
    expect(c.filter((x) => x.forbiddenEdges.length)).toHaveLength(15);
  });
  it('covers interface typed calls and failure parity', () => {
    const s = new Set(load().map((x) => x.scenario));
    for (const x of [
      'interface',
      'typed-call',
      'missing',
      'timeout',
      'crash',
      'outside',
      'ambiguous',
    ])
      expect(s.has(x)).toBe(true);
  });
  it('uses neutral owner gold', () =>
    expect(load().every((x) => x.owner === 'Example Maintainer')).toBe(true));
});
