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
      new URL('../../../benchmarks/relationship/cases/phase-27.json', import.meta.url),
      'utf8'
    )
  ) as C[];
describe('Phase27 Go acceptance', () => {
  it('has35 positive/20 forbidden', () => {
    const c = load();
    expect(c.filter((x) => x.expectedEdges.length)).toHaveLength(35);
    expect(c.filter((x) => x.forbiddenEdges.length)).toHaveLength(20);
  });
  it('covers deterministic and hostile families', () => {
    const s = new Set(load().map((x) => x.scenario));
    for (const x of [
      'module',
      'package',
      'import',
      'external',
      'function',
      'method',
      'type',
      'call',
      'malformed',
      'symlink',
      'replace-escape',
      'conflict',
      'conditional',
      'generated',
    ])
      expect(s.has(x)).toBe(true);
  });
  it('has owner gold', () => expect(load().every((x) => x.owner === 'Example Maintainer')).toBe(true));
});
