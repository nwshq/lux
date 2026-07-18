import type { LuxDatabase } from '../../db/index.js';
import type { StructuralNode } from '../../db/types.js';

/**
 * Ownership of an HTTP surface's handler relative to the app/kernel boundary
 * (E1 cross-repo shared-kernel resolution). Computed over a merged overlay where
 * a first-party shared kernel and the consuming app are both app-source.
 */
export type OwnershipLabel = 'kernel-owned' | 'client-override' | 'client-gap' | 'external';

/**
 * Classify a handler edge from its target FQCN node-id and the target node (or
 * null if absent). `App\*` is the consuming app's namespace (Laravel convention).
 *   - present `App\*`                         → client-override (the app handles it)
 *   - present non-`App\*`, project-local      → kernel-owned (promoted kernel source)
 *   - present non-`App\*`, vendor-pack origin → external (third-party controller,
 *                                               e.g. Fortify/Jetstream/Nova)
 *   - absent `App\*`                          → client-gap (route the client doesn't implement)
 *   - absent non-`App\*`                      → external (unresolved third-party)
 */
export function classifyOwnership(
  targetNodeId: string,
  node: StructuralNode | null
): OwnershipLabel {
  const isApp = /^symbol:php:App\\/.test(targetNodeId);
  if (node) {
    if (isApp) return 'client-override';
    // origin defaults to 'local'; a merged vendor-pack node is third-party.
    return (node.origin ?? 'local') === 'local' ? 'kernel-owned' : 'external';
  }
  return isApp ? 'client-gap' : 'external';
}

export interface OwnershipSummary {
  classified: number;
  counts: Record<OwnershipLabel, number>;
}

/**
 * Post-overlay pass: label every `handled_by` edge from an HTTP surface with its
 * {@link OwnershipLabel} and persist it to `structural_edges.ownership`. Runs after
 * the vendor-pack merge so third-party targets are correctly distinguished from
 * genuine client-gaps. Idempotent (a rebuild recomputes from current node state).
 */
export function classifyHandlerOwnership(db: LuxDatabase): OwnershipSummary {
  const counts: Record<OwnershipLabel, number> = {
    'kernel-owned': 0,
    'client-override': 0,
    'client-gap': 0,
    external: 0,
  };
  const edges = db.getHandlerEdgesForOwnership();
  const updates: Array<{ id: string; ownership: string }> = [];
  for (const edge of edges) {
    const label = classifyOwnership(edge.target_node_id, db.getStructuralNode(edge.target_node_id));
    updates.push({ id: edge.id, ownership: label });
    counts[label]++;
  }
  db.setEdgeOwnershipBatch(updates);
  return { classified: edges.length, counts };
}
