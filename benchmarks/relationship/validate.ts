import type { RelationshipBenchmarkCaseV1 } from '../../src/scanner/contracts/program.js';
export interface ObservedEdgeV1 {
  source: string;
  type: string;
  target: string;
  confidenceClass: string;
}
export interface CohortScoreV1 {
  corpus: string;
  capability: string;
  expectedPositive: number;
  returned: number;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  forbiddenMatched: number;
  duplicateEdges: number;
  danglingTargets: number;
  precision: number;
  recall: number;
  passed: boolean;
  failures: string[];
}
const key = (e: { source?: string; type?: string; target?: string }) =>
  `${e.source ?? '*'}|${e.type ?? '*'}|${e.target ?? '*'}`;
export function scoreCohort(
  cases: readonly RelationshipBenchmarkCaseV1[],
  observed: ReadonlyMap<string, readonly ObservedEdgeV1[]>,
  thresholds: { precision: number; recall: number; minPositive: number; minForbidden: number }
): CohortScoreV1 {
  const failures: string[] = [],
    expectedPositive = cases.flatMap((c) => c.expectedEdges).length,
    forbidden = cases.flatMap((c) => c.forbiddenEdges).length;
  let returned = 0,
    truePositive = 0,
    forbiddenMatched = 0,
    duplicates = 0;
  for (const c of cases) {
    const rows = observed.get(c.id) ?? [],
      keys = rows.map(key);
    returned += rows.length;
    duplicates += rows.length - new Set(keys).size;
    const set = new Set(keys);
    truePositive += c.expectedEdges.filter((e) => set.has(key(e))).length;
    forbiddenMatched += c.forbiddenEdges.filter((f) =>
      rows.some(
        (e) =>
          (!f.source || f.source === e.source) &&
          (!f.type || f.type === e.type) &&
          (!f.target || f.target === e.target)
      )
    ).length;
  }
  const falseNegative = expectedPositive - truePositive,
    falsePositive = Math.max(0, returned - truePositive) + forbiddenMatched + duplicates,
    precision = truePositive + falsePositive ? truePositive / (truePositive + falsePositive) : 0,
    recall = expectedPositive ? truePositive / expectedPositive : 0;
  if (expectedPositive < thresholds.minPositive) failures.push('insufficient positives');
  if (forbidden < thresholds.minForbidden) failures.push('insufficient forbiddens');
  if (precision < thresholds.precision) failures.push('precision');
  if (recall < thresholds.recall) failures.push('recall');
  if (duplicates) failures.push('duplicates');
  return {
    corpus: cases[0]?.corpus ?? '',
    capability: cases[0]?.capability ?? '',
    expectedPositive,
    returned,
    truePositive,
    falsePositive,
    falseNegative,
    forbiddenMatched,
    duplicateEdges: duplicates,
    danglingTargets: 0,
    precision,
    recall,
    passed: failures.length === 0,
    failures,
  };
}
