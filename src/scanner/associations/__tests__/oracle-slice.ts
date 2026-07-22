// The equivalence-oracle divergence slice + contract comparator (spec 14 Parts A/B).
//
// The slice is deliberately wider than the naive one: cross-file edges carry SOURCE-side evidence,
// so an under-produced inbound edge C→A cites C ∉ F and is invisible to a slice keyed only on
// nodes ∈ F ∪ evidence ∈ F. The third slice set — edges whose target is a symbol declared in F —
// is what lets the oracle SEE the under-production the whole-batch + reverse-import design prevents.

import type { LuxDatabase } from '../../../db/index.js';
import type { StructuralEdge, StructuralNode } from '../../../db/types.js';

/** A canonical, order-independent edge tuple (identity + endpoints + kind + confidence class). */
export interface EdgeTuple {
  id: string;
  source: string;
  target: string;
  type: string;
  confidenceClass: string;
}

export interface DivergenceSlice {
  nodeIds: Set<string>;
  freshEdges: Map<string, EdgeTuple>; // keyed by edge id
  staleEdges: Map<string, EdgeTuple>;
}

function tuple(e: StructuralEdge): EdgeTuple {
  return {
    id: e.id,
    source: e.source_node_id,
    target: e.target_node_id,
    type: e.edge_type,
    confidenceClass: e.confidence_class,
  };
}

/**
 * The divergence-sensitive slice for a changed-file set F (Decision 6). The edge slice is the union
 * of THREE sets — the third (target-side inbound) is essential:
 *   1. edges touching a node declared in F (source OR target in F's nodes),
 *   2. edges whose recorded evidence cites F,
 *   3. edges whose target_node_id is a symbol declared in F (the target-side inbound set).
 * Partitioned by freshness so the contract can compare the `fresh` set exactly while tolerating the
 * per-fixture enumerated `stale` residuals.
 */
export function collectDivergenceSlice(db: LuxDatabase, F: string[]): DivergenceSlice {
  const nodes: StructuralNode[] = db.getStructuralNodesForFilePaths(F);
  const nodeIds = new Set(nodes.map((n) => n.id));
  const symbolIds = nodes.filter((n) => n.node_type === 'symbol').map((n) => n.id);

  const edges = new Map<string, StructuralEdge>();
  const add = (e: StructuralEdge) => edges.set(e.id, e);

  // 1. edges touching F's nodes (both directions).
  for (const id of nodeIds) {
    for (const e of db.getStructuralEdgesForNode(id)) add(e);
  }
  // 2. evidence-cites-F.
  for (const e of db.getEvidenceEdgesForFilePaths(F)) add(e);
  // 3. target-side inbound — edges whose target is a symbol declared in F (Decision 6).
  for (const s of symbolIds) {
    for (const e of db.getIncomingStructuralEdges(s)) add(e);
  }

  const freshEdges = new Map<string, EdgeTuple>();
  const staleEdges = new Map<string, EdgeTuple>();
  for (const e of edges.values()) {
    if (e.freshness_status === 'fresh') freshEdges.set(e.id, tuple(e));
    else if (e.freshness_status === 'stale') staleEdges.set(e.id, tuple(e));
    // dirty-dependent is transient (in-flight); a settled overlay has none in the slice.
  }
  return { nodeIds, freshEdges, staleEdges };
}

export interface OracleVerdict {
  ok: boolean;
  missingFresh: EdgeTuple[]; // in full, absent/not-fresh in scoped — the under-production bug
  extraFresh: EdgeTuple[]; // fresh in scoped, absent in full — the over-production bug
  unexpectedStale: EdgeTuple[]; // stale in scoped beyond the fixture's enumeration
  nodeDiff: { missing: string[]; extra: string[] };
  /** Direct-probe results OUTSIDE the slice (Decision 5 orphans). Populated by the runner only for
   *  fixtures with `expectOrphanStale` — compareSlices leaves them empty (the slice can't see them). */
  missingStaleOrphan: string[]; // orphan inbound edge id DELETED instead of kept — the Decision-5 bug
  orphanNotStale: string[]; // orphan inbound edge kept but NOT marked `stale`
}

/**
 * The correctness contract (Decision 6): the scoped `fresh` slice is id-and-tuple identical to the
 * full-rebuild `fresh` slice, and every scoped `stale` edge is in the fixture's enumerated expected
 * set. A stale edge counts as divergence ONLY when it is outside that enumeration. The
 * orphan-outside-slice residual (Decision 5) is verified separately by the runner's direct probe.
 */
export function compareSlices(
  full: DivergenceSlice,
  scoped: DivergenceSlice,
  expectedStaleIds: Set<string>
): OracleVerdict {
  const missingFresh: EdgeTuple[] = [];
  const extraFresh: EdgeTuple[] = [];
  for (const [id, t] of full.freshEdges) {
    const s = scoped.freshEdges.get(id);
    if (!s || !sameTuple(s, t)) missingFresh.push(t);
  }
  for (const [id, t] of scoped.freshEdges) {
    if (!full.freshEdges.has(id)) extraFresh.push(t);
  }
  const unexpectedStale = [...scoped.staleEdges.values()].filter(
    (t) => !expectedStaleIds.has(t.id)
  );
  const missingNodes = [...full.nodeIds].filter((n) => !scoped.nodeIds.has(n));
  const extraNodes = [...scoped.nodeIds].filter((n) => !full.nodeIds.has(n));
  return {
    ok:
      missingFresh.length === 0 &&
      extraFresh.length === 0 &&
      unexpectedStale.length === 0 &&
      missingNodes.length === 0 &&
      extraNodes.length === 0,
    missingFresh,
    extraFresh,
    unexpectedStale,
    nodeDiff: { missing: missingNodes, extra: extraNodes },
    missingStaleOrphan: [],
    orphanNotStale: [],
  };
}

function sameTuple(a: EdgeTuple, b: EdgeTuple): boolean {
  return (
    a.source === b.source &&
    a.target === b.target &&
    a.type === b.type &&
    a.confidenceClass === b.confidenceClass
  );
}
