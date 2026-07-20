// Evidence formatting layer.
//
// Two output layers:
//   - summarized: a concise text summary suitable for context windows
//   - raw: full EdgeEvidence[] from the DB for inspection flows

import type { EdgeEvidence, StructuralEdge } from '../../db/types.js';

// ---------------------------------------------------------------------------
// Summarized evidence
// ---------------------------------------------------------------------------

/**
 * Build a concise text summary of an edge and its evidence for use in
 * discovery context windows. Default output layer.
 *
 * Format:
 * ```
 * [calls_surface / framework-inferred / 0.90]
 * laravel-http via surface-match: routes/api.php:42 (GET /api/users)
 * ```
 */
export function summarizeEdgeEvidence(edge: StructuralEdge, evidence: EdgeEvidence[]): string {
  const header = `[${edge.edge_type} / ${edge.confidence_class} / ${edge.confidence.toFixed(2)}]`;

  if (evidence.length === 0) {
    const provenance = edge.provenance_summary ? `\n  ${edge.provenance_summary}` : '';
    return `${header}${provenance}`;
  }

  const lines: string[] = [header];

  // Group by resolver
  const byResolver = new Map<string, EdgeEvidence[]>();
  for (const ev of evidence) {
    const existing = byResolver.get(ev.resolver);
    if (existing) {
      existing.push(ev);
    } else {
      byResolver.set(ev.resolver, [ev]);
    }
  }

  for (const [resolver, evs] of byResolver) {
    const kind = evs[0].evidence_kind;
    const locations = evs
      .slice(0, 5)
      .map((e) => {
        const loc = e.line !== undefined ? `${e.file_path}:${e.line}` : e.file_path;
        const note = e.note ? ` (${e.note})` : '';
        return `${loc}${note}`;
      })
      .join(', ');
    const more = evs.length > 5 ? ` +${evs.length - 5} more` : '';
    lines.push(`  ${resolver} via ${kind}: ${locations}${more}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Formatted evidence block for multiple edges
// ---------------------------------------------------------------------------

export interface EdgeWithEvidence {
  edge: StructuralEdge;
  evidence: EdgeEvidence[];
}

/**
 * Build a formatted multi-edge evidence block for a node.
 * Used when surfacing overlay context in discovery flows.
 */
export function formatEdgeBlock(nodeId: string, edgesWithEvidence: EdgeWithEvidence[]): string {
  if (edgesWithEvidence.length === 0) {
    return `No structural relations found for ${nodeId}.`;
  }

  const lines: string[] = [`Structural relations for ${nodeId}:`];
  for (const { edge, evidence } of edgesWithEvidence) {
    const direction =
      edge.source_node_id === nodeId ? `→ ${edge.target_node_id}` : `← ${edge.source_node_id}`;
    lines.push(`\n${direction}`);
    lines.push(summarizeEdgeEvidence(edge, evidence));
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Freshness annotation
// ---------------------------------------------------------------------------

/**
 * Annotate a summarized edge with its freshness status when not fresh.
 * Returns the summary unchanged if the edge is fresh.
 */
export function annotateFreshness(summary: string, edge: StructuralEdge): string {
  if (edge.freshness_status === 'fresh') return summary;

  const warn =
    edge.freshness_status === 'dirty-dependent'
      ? `⚠ dirty-dependent (${edge.dirty_dependency_count} file(s) modified)`
      : edge.freshness_status === 'stale'
        ? '⚠ stale (commit baseline changed)'
        : '⚠ freshness unknown';

  return `${summary}\n  ${warn}`;
}
