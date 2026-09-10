import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
interface C {
  capability: string;
  owner: string;
  expectedEdges: unknown[];
  forbiddenEdges: unknown[];
}
const load = () =>
  JSON.parse(
    readFileSync(
      new URL('../../../benchmarks/relationship/cases/phase-23.json', import.meta.url),
      'utf8'
    )
  ) as C[];
describe('Phase23 Terraform graph acceptance', () => {
  it('has 15 positive and10 forbidden in every semantic family', () => {
    const c = load();
    for (const f of [
      'declaration',
      'resource-data',
      'variable-local',
      'output',
      'provider',
      'local-module',
      'remote-state',
    ]) {
      const x = c.filter((i) => i.capability === f);
      expect(x.filter((i) => i.expectedEdges.length)).toHaveLength(15);
      expect(x.filter((i) => i.forbiddenEdges.length)).toHaveLength(10);
    }
  });
  it('pins owner gold', () =>
    expect(load().every((x) => x.owner === 'Example Maintainer')).toBe(true));
});

describe('Phase23 owner-approved real minima', () => {
  for (const [corpus, positive] of Object.entries({
    'example-infrastructure': 20,
    'example-rds-clusters': 20,
    'example-service-alpha': 9,
    'example-service-beta': 9,
  })) {
    it(`${corpus} uses its executable source-truth denominator`, () => {
      const rows = JSON.parse(
        readFileSync(
          new URL(
            `../../../benchmarks/relationship/cases/${corpus}-phase-23.json`,
            import.meta.url
          ),
          'utf8'
        )
      ) as Array<{
        owner: string;
        sourceTruthId: string;
        expectedEdges: unknown[];
        forbiddenEdges: unknown[];
      }>;
      expect(rows.filter((row) => row.expectedEdges.length)).toHaveLength(positive);
      expect(rows.filter((row) => row.forbiddenEdges.length)).toHaveLength(10);
      expect(new Set(rows.map((row) => row.sourceTruthId)).size).toBe(rows.length);
      expect(rows.every((row) => row.owner === 'Example Maintainer')).toBe(true);
    });
  }
});
