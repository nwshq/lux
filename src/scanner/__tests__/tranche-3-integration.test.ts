import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
interface PromotionCase {
  expectedEdges: unknown[];
  forbiddenEdges: unknown[];
  sourceTruthId: string;
}
describe('Tranche3 integration promotion', () => {
  it('has independently thresholded exact corpora', () => {
    for (const c of ['auctic-mobile', 'example-workspace', 'example-dashboard']) {
      const x = JSON.parse(
        readFileSync(
          new URL(`../../../benchmarks/relationship/cases/${c}-tranche-3.json`, import.meta.url),
          'utf8'
        )
      ) as PromotionCase[];
      expect(x.filter((value) => value.expectedEdges.length)).toHaveLength(30);
      expect(x.filter((value) => value.forbiddenEdges.length)).toHaveLength(15);
      expect(new Set(x.map((value) => value.sourceTruthId)).size).toBe(45);
      expect(x.every((value) => !('controlKind' in value))).toBe(true);
      if (c !== 'auctic-mobile') {
        expect(
          x.every((value) =>
            /^.+:\d+:(?:renders_component|uses_hook|forbidden):/.test(value.sourceTruthId)
          )
        ).toBe(true);
      }
    }
  });
});
