import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scoreCohort } from '../validate.js';
import type { RelationshipBenchmarkCaseV1 } from '../../../src/scanner/contracts/program.js';
describe('Tranche3 promotion scorer', () => {
  for (const corpus of ['auctic-mobile', 'example-workspace', 'example-dashboard'])
    it(`${corpus} passes its own fixed denominator`, () => {
      const cases = JSON.parse(
          readFileSync(new URL(`../cases/${corpus}-tranche-3.json`, import.meta.url), 'utf8')
        ) as RelationshipBenchmarkCaseV1[],
        observed = new Map(
          cases.map((c) => [
            c.id,
            c.expectedEdges.map((e) => ({
              source: e.source,
              type: e.type,
              target: e.target,
              confidenceClass: e.minConfidence,
            })),
          ])
        );
      const score = scoreCohort(cases, observed, {
        precision: 0.95,
        recall: 0.9,
        minPositive: 30,
        minForbidden: 15,
      });
      expect(score.passed, score.failures.join(',')).toBe(true);
      expect(score.precision).toBe(1);
      expect(score.recall).toBe(1);
    });
});
