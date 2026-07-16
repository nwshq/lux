// Multi-hop, cycle-safe, depth-bounded cross-boundary call tracer (ADR-5).
//
// Single canonical module (CANONICAL-DECISIONS §5): consolidates the trace
// result model, the dispatch-terminus catalog, and the traversal engine into one
// file. This is the *consumer* of the merged structural graph the pack/merge
// phases produce — it walks the graph, it does not build it.
//
// A trace is an annotated DAG rooted at one start symbol. Nodes carry an
// `external` flag (ADR-3 vendor-pack provenance) and, when not expanded, a
// `terminus` reason. Edges carry the confidence/provenance of the
// structural_edges row they were walked from. The walk expands forward via edges
// where source_node_id = current, following each to its target_node_id.
//
// Semantics of the two motivating call classes (exploration §Problem Statement):
//   - Synchronous framework call (REQ-1): behaviour lives in vendor, so the walk
//     simply reaches the resolving in-vendor method and continues to its leaves.
//   - Dynamic-dispatch call (REQ-2): the walk reaches the dispatch machinery and
//     STOPS with a 'dynamic-dispatch-boundary' terminus + reentryDeferred marker;
//     the app-side re-entry is the named follow-up, so we annotate, never
//     silently dead-end.
//
// The walk uses an in-memory frontier BFS over the existing indexed 1-hop
// outgoing-edge query (idx_structural_edges_source) with a JS visited-Set for
// O(1) global cycle-safety (REQ-8), bounded three ways — maxDepth / maxNodes /
// maxFanout — so it never runs away through framework internals. External
// detection reuses the shared LuxDatabase.isExternalNode predicate (ADR-3).

import { LuxDatabase } from '../../db/index.js';
import type { ConfidenceClass, EdgeType, StructuralNode } from '../../db/types.js';

// ---------------------------------------------------------------------------
// Result model (ADR-5 / REQ-1, REQ-2, REQ-7, REQ-8)
// ---------------------------------------------------------------------------

/** Why a node was not expanded further (only set on frontier/leaf nodes). */
export type TerminusReason =
  /** No outgoing edges within the active edge-type / confidence filter. */
  | 'leaf'
  /** `maxDepth` reached before this node could be expanded. */
  | 'depth-limit'
  /** Global `maxNodes` budget exhausted before this node could be expanded. */
  | 'node-budget'
  /** Per-node `maxFanout` cap truncated this node's out-edges. */
  | 'fanout-cap'
  /**
   * Reached the framework dispatch machinery (REQ-2). The app-side re-entry
   * (`$job->handle()`, the listener) is the deferred follow-up exploration —
   * this substrate marks the attach point and stops, it does NOT dead-end
   * silently. See DispatchTerminusInfo.
   */
  | 'dynamic-dispatch-boundary';

/** Structured detail attached when `terminus === 'dynamic-dispatch-boundary'`. */
export interface DispatchTerminusInfo {
  /** Machinery kind recognised (informs the future re-entry exploration). */
  dispatchKind: 'job' | 'event' | 'queue' | 'container' | 'pipeline';
  /** True — the app-side continuation is out of scope for this substrate. */
  reentryDeferred: true;
  /** How the terminus was recognised: a catalog FQN match or a dispatch edge. */
  via: 'catalog-symbol' | 'dispatch-edge';
  /** Human-readable note surfaced in CLI/MCP output. */
  note: string;
}

/** A node in the trace DAG. */
export interface TraceNode {
  /** structural_nodes.id (e.g. `symbol:php:Illuminate\\...\\Model::save`). */
  id: string;
  /** Display label (qualified_name ?? symbol_name ?? id). */
  label: string;
  languageId?: string;
  filePath?: string;
  /** BFS depth from the start node (start = 0). */
  depth: number;
  /** True when the node originates from a vendor pack (ADR-3 provenance). */
  external: boolean;
  /** Set iff the node was not expanded. */
  terminus?: TerminusReason;
  /** Present iff terminus === 'dynamic-dispatch-boundary'. */
  dispatch?: DispatchTerminusInfo;
}

/** A walked edge in the trace DAG. */
export interface TraceEdge {
  /** structural_edges.id. */
  id: string;
  sourceId: string;
  targetId: string;
  edgeType: EdgeType;
  confidence: number;
  confidenceClass: ConfidenceClass;
  /** True when this edge closes a cycle (target already visited). */
  revisit: boolean;
}

export interface TraceResult {
  startId: string;
  /** Options actually applied (after defaults). */
  options: Required<TraceOptions>;
  nodes: TraceNode[];
  edges: TraceEdge[];
  stats: {
    nodeCount: number;
    edgeCount: number;
    externalCount: number;
    maxDepthReached: number;
    dispatchBoundaries: number;
    truncated: boolean; // any node-budget / fanout-cap / depth-limit terminus
  };
}

export interface TraceOptions {
  /** Max hops from the start node. Default 8. */
  maxDepth?: number;
  /** Total distinct nodes to visit before truncating. Default 2000. */
  maxNodes?: number;
  /** Max out-edges expanded per node (guards framework hubs). Default 64. */
  maxFanout?: number;
  /** Edge types to follow. Default ['calls', 'references']. */
  edgeTypes?: EdgeType[];
  /**
   * Lowest confidence class to follow. Default 'framework-inferred'
   * (excludes 'heuristic'). Ordering: proven > artifact-backed >
   * framework-inferred > heuristic.
   */
  minConfidenceClass?: ConfidenceClass;
  /** Follow edges into external (vendor) nodes. Default true — the point. */
  includeExternal?: boolean;
}

/** Confidence-class ordering used by the min-confidence filter. */
export const CONFIDENCE_RANK: Record<ConfidenceClass, number> = {
  proven: 3,
  'artifact-backed': 2,
  'framework-inferred': 1,
  heuristic: 0,
};

export const DEFAULT_TRACE_OPTIONS: Required<TraceOptions> = {
  maxDepth: 8,
  maxNodes: 2000,
  maxFanout: 64,
  edgeTypes: ['calls', 'references'],
  minConfidenceClass: 'framework-inferred',
  includeExternal: true,
};

// ---------------------------------------------------------------------------
// Dispatch-terminus catalog (REQ-2)
// ---------------------------------------------------------------------------
//
// When a trace REACHES one of these vendor symbols — or traverses a dispatch
// edge_type — it has arrived at the point where control leaves the static call
// graph and re-enters app code at runtime through the service container / event
// dispatcher / queue. That app-side re-entry is the deferred follow-up
// exploration (exploration §Non-Goals); this substrate marks the attach point
// and STOPS, so the trace terminates honestly instead of dead-ending silently.
//
// These entries ARE the attach-point surface the re-entry exploration will
// consume — keep them data, not logic.

interface CatalogEntry {
  /** Match against a node's qualified_name (PHP FQN) — exact or `::method`. */
  fqn: string;
  kind: DispatchTerminusInfo['dispatchKind'];
  note: string;
}

/**
 * Known Laravel dispatch machinery. FQNs are matched case-sensitively against
 * `structural_nodes.qualified_name`. The bare global helpers (`dispatch`,
 * `event`) are matched by symbol_name when qualified_name is absent.
 */
export const DISPATCH_TERMINI: CatalogEntry[] = [
  {
    fqn: 'Illuminate\\Foundation\\Bus\\PendingDispatch::__construct',
    kind: 'job',
    note: 'Job queued via dispatch(); handler runs on the queue worker (re-entry deferred).',
  },
  {
    fqn: 'Illuminate\\Bus\\Dispatcher::dispatch',
    kind: 'job',
    note: 'Command/job bus dispatch; handler resolved from the container (re-entry deferred).',
  },
  {
    fqn: 'Illuminate\\Bus\\Dispatcher::dispatchNow',
    kind: 'job',
    note: 'Synchronous bus dispatch; handler resolved from the container (re-entry deferred).',
  },
  {
    fqn: 'Illuminate\\Contracts\\Bus\\Dispatcher::dispatch',
    kind: 'job',
    note: 'Bus contract dispatch (re-entry deferred).',
  },
  {
    fqn: 'Illuminate\\Events\\Dispatcher::dispatch',
    kind: 'event',
    note: 'Event fired; listeners resolved from the container (re-entry deferred).',
  },
  {
    fqn: 'Illuminate\\Contracts\\Events\\Dispatcher::dispatch',
    kind: 'event',
    note: 'Event contract dispatch (re-entry deferred).',
  },
  {
    fqn: 'Illuminate\\Queue\\Queue::push',
    kind: 'queue',
    note: 'Payload pushed to the queue driver; consumed out-of-process (re-entry deferred).',
  },
  {
    fqn: 'Illuminate\\Contracts\\Container\\Container::make',
    kind: 'container',
    note: 'Container resolution; concrete binding is config/runtime-determined (re-entry deferred).',
  },
  {
    // Concrete container: what `textDocument/definition` on `$app->make()` /
    // `app()->make()` actually resolves to (the Contracts entry above is the
    // interface). This is the reachable node on a real merged graph.
    fqn: 'Illuminate\\Container\\Container::make',
    kind: 'container',
    note: 'Container resolution; concrete binding is config/runtime-determined (re-entry deferred).',
  },
  {
    fqn: 'Illuminate\\Foundation\\Application::make',
    kind: 'container',
    note: 'Application (service container) resolution; concrete binding is runtime-determined (re-entry deferred).',
  },
  {
    fqn: 'Illuminate\\Pipeline\\Pipeline::then',
    kind: 'pipeline',
    note: 'Pipeline execution; pipe stack is runtime-composed (re-entry deferred).',
  },
  // Bare global helpers (matched on symbol_name when no FQN):
  {
    fqn: 'dispatch',
    kind: 'job',
    note: 'dispatch() helper; handler runs later (re-entry deferred).',
  },
  { fqn: 'event', kind: 'event', note: 'event() helper; listeners run later (re-entry deferred).' },
];

/** Edge types that, when traversed, are themselves a dispatch boundary. */
export const DISPATCH_EDGE_TYPES: ReadonlySet<EdgeType> = new Set<EdgeType>([
  'dispatches_job',
  'handles_job',
  'emits_event',
  'listens_event',
  'subscribes_event',
]);

const BY_FQN = new Map(DISPATCH_TERMINI.map((e) => [e.fqn, e]));

/**
 * Return dispatch-terminus info if `node` is framework dispatch machinery, else
 * null. Matches on qualified_name first, then bare symbol_name (global helpers).
 */
export function dispatchTerminusFor(node: {
  qualified_name?: string | null;
  symbol_name?: string | null;
}): DispatchTerminusInfo | null {
  const hit =
    (node.qualified_name ? BY_FQN.get(node.qualified_name) : undefined) ??
    (node.symbol_name ? BY_FQN.get(node.symbol_name) : undefined);
  if (!hit) return null;
  return { dispatchKind: hit.kind, reentryDeferred: true, via: 'catalog-symbol', note: hit.note };
}

/** Dispatch info derived from a dispatch-typed edge (secondary recognition). */
export function dispatchTerminusForEdge(edgeType: EdgeType): DispatchTerminusInfo | null {
  if (!DISPATCH_EDGE_TYPES.has(edgeType)) return null;
  const kind: DispatchTerminusInfo['dispatchKind'] =
    edgeType === 'emits_event' || edgeType === 'listens_event' || edgeType === 'subscribes_event'
      ? 'event'
      : 'job';
  return {
    dispatchKind: kind,
    reentryDeferred: true,
    via: 'dispatch-edge',
    note: `Reached via '${edgeType}' edge; app-side continuation is the deferred re-entry follow-up.`,
  };
}

// ---------------------------------------------------------------------------
// Traversal engine (ADR-5 / REQ-1, REQ-2, REQ-7, REQ-8)
// ---------------------------------------------------------------------------

function labelFor(n: StructuralNode): string {
  return n.qualified_name ?? n.symbol_name ?? n.id;
}

/**
 * Resolve a start symbol to a single node id, or report ambiguity.
 * Callers (CLI/MCP) present candidates when `ambiguous` is returned.
 */
export function resolveStartNode(
  db: LuxDatabase,
  symbol: string
): { nodeId: string } | { ambiguous: StructuralNode[] } | { notFound: true } {
  const direct = db.getStructuralNode(symbol);
  if (direct && direct.node_type === 'symbol') return { nodeId: direct.id };
  const candidates = db.findStructuralSymbolNodes(symbol);
  if (candidates.length === 0) return { notFound: true };
  if (candidates.length === 1) return { nodeId: candidates[0].id };
  // Exact qualified_name / id wins outright over LIKE matches.
  const exact = candidates.filter((c) => c.qualified_name === symbol || c.id === symbol);
  if (exact.length === 1) return { nodeId: exact[0].id };
  return { ambiguous: candidates };
}

/**
 * Trace forward from `startId` over the merged structural graph.
 * `startId` must be a resolved structural_nodes.id (use resolveStartNode first).
 */
export function traceFrom(
  db: LuxDatabase,
  startId: string,
  options: TraceOptions = {}
): TraceResult {
  const opts: Required<TraceOptions> = { ...DEFAULT_TRACE_OPTIONS, ...options };
  const minRank = CONFIDENCE_RANK[opts.minConfidenceClass];
  const edgeTypeSet = new Set(opts.edgeTypes);

  const nodesById = new Map<string, TraceNode>();
  const edges: TraceEdge[] = [];
  const visited = new Set<string>(); // cycle-safety + budget accounting (REQ-8)
  const expanded = new Set<string>(); // nodes whose out-edges were walked
  const nodeCache = new Map<string, StructuralNode | null>();

  const loadNode = (id: string): StructuralNode | null => {
    if (nodeCache.has(id)) return nodeCache.get(id)!;
    const n = db.getStructuralNode(id);
    nodeCache.set(id, n);
    return n;
  };

  const addNode = (id: string, depth: number): TraceNode => {
    let tn = nodesById.get(id);
    if (tn) return tn;
    const raw = loadNode(id);
    tn = {
      id,
      label: raw ? labelFor(raw) : id,
      languageId: raw?.language_id,
      filePath: raw?.file_path,
      depth,
      external: raw ? LuxDatabase.isExternalNode(raw) : false,
    };
    nodesById.set(id, tn);
    return tn;
  };

  // Seed.
  const startRaw = loadNode(startId);
  const start = addNode(startId, 0);
  visited.add(startId);
  let budgetHit = false;
  let maxDepthReached = 0;

  let frontier: string[] = [startId];
  // A node reached but deferred (dispatch terminus) is recorded, not expanded.
  const markDispatchTerminus = (node: TraceNode, info: NonNullable<TraceNode['dispatch']>) => {
    node.terminus = 'dynamic-dispatch-boundary';
    node.dispatch = info;
  };

  // If the start symbol is itself dispatch machinery, it is a terminus at depth 0.
  const startDispatch = startRaw ? dispatchTerminusFor(startRaw) : null;
  if (startDispatch) {
    markDispatchTerminus(start, startDispatch);
    frontier = [];
  }

  for (let depth = 1; depth <= opts.maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];

    for (const sourceId of frontier) {
      if (budgetHit) break;
      expanded.add(sourceId);

      const outEdges = db
        .getOutgoingStructuralEdges(sourceId)
        .filter(
          (e) => edgeTypeSet.has(e.edge_type) && CONFIDENCE_RANK[e.confidence_class] >= minRank
        );

      const capped = outEdges.length > opts.maxFanout;
      const walked = capped ? outEdges.slice(0, opts.maxFanout) : outEdges;
      if (capped) {
        const sn = nodesById.get(sourceId);
        if (sn && !sn.terminus) sn.terminus = 'fanout-cap';
      }

      for (const e of walked) {
        const targetRaw = loadNode(e.target_node_id);
        const targetExternal = targetRaw ? LuxDatabase.isExternalNode(targetRaw) : false;

        // Respect the includeExternal switch (default true — the whole point).
        if (targetExternal && !opts.includeExternal) continue;

        const alreadyVisited = visited.has(e.target_node_id);
        const target = addNode(
          e.target_node_id,
          alreadyVisited ? nodesById.get(e.target_node_id)!.depth : depth
        );

        edges.push({
          id: e.id,
          sourceId: e.source_node_id,
          targetId: e.target_node_id,
          edgeType: e.edge_type,
          confidence: e.confidence,
          confidenceClass: e.confidence_class,
          revisit: alreadyVisited, // closes a cycle (REQ-8)
        });

        if (alreadyVisited) continue; // never re-expand — cycle-safe

        // Budget check BEFORE admitting a new node to the frontier.
        if (visited.size >= opts.maxNodes) {
          target.terminus = 'node-budget';
          budgetHit = true;
          continue;
        }
        visited.add(e.target_node_id);
        maxDepthReached = Math.max(maxDepthReached, depth);

        // REQ-2: dynamic-dispatch terminus — recognise by edge type first, then
        // by the target being catalogued dispatch machinery. Record, don't expand.
        const dispatchInfo =
          dispatchTerminusForEdge(e.edge_type) ??
          (targetRaw ? dispatchTerminusFor(targetRaw) : null);
        if (dispatchInfo) {
          markDispatchTerminus(target, dispatchInfo);
          continue; // stop at the boundary
        }

        nextFrontier.push(e.target_node_id); // REQ-1: keep following into vendor
      }
    }

    frontier = nextFrontier;
    if (budgetHit) break;

    // Nodes still queued when the depth loop ends are depth-limited termini.
    if (depth === opts.maxDepth) {
      for (const id of frontier) {
        const tn = nodesById.get(id);
        if (tn && !tn.terminus) tn.terminus = 'depth-limit';
      }
    }
  }

  // Any admitted node that was never expanded and carries no terminus reached a
  // natural leaf (no outgoing edges within the filter).
  for (const tn of nodesById.values()) {
    if (!tn.terminus && !expanded.has(tn.id)) tn.terminus = 'leaf';
  }

  const nodes = [...nodesById.values()].sort((a, b) => a.depth - b.depth);
  const truncated = nodes.some(
    (n) =>
      n.terminus === 'depth-limit' || n.terminus === 'node-budget' || n.terminus === 'fanout-cap'
  );

  return {
    startId,
    options: opts,
    nodes,
    edges,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      externalCount: nodes.filter((n) => n.external).length,
      maxDepthReached,
      dispatchBoundaries: nodes.filter((n) => n.terminus === 'dynamic-dispatch-boundary').length,
      truncated,
    },
  };
}
