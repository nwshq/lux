import type { LuxDatabase } from '../../src/db/index.js';
import type { RelationshipBenchmarkCaseV1 } from '../../src/scanner/contracts/program.js';
import type { ObservedEdgeV1 } from './validate.js';
export function observePersistedCases(
  db: LuxDatabase,
  cases: readonly RelationshipBenchmarkCaseV1[]
): ReadonlyMap<string, readonly ObservedEdgeV1[]> {
  const result = new Map<string, ObservedEdgeV1[]>();
  for (const c of cases) {
    const nodes = new Set(
      c.expectedEdges
        .map((e) => e.source)
        .concat(c.forbiddenEdges.flatMap((e) => (e.source ? [e.source] : [])))
    );
    const rows = new Map<string, ObservedEdgeV1>();
    for (const id of nodes)
      for (const e of db.getStructuralEdgesForNode(id)) {
        const row = {
            source: e.source_node_id,
            type: e.edge_type,
            target: e.target_node_id,
            confidenceClass: e.confidence_class,
          },
          key = `${row.source}|${row.type}|${row.target}`;
        rows.set(key, row);
      }
    result.set(c.id, [...rows.values()]);
  }
  return result;
}
