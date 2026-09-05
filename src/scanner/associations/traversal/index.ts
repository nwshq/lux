import type { StructuralNode } from '../../../db/types.js';
import {
  CONFIDENCE_RANK,
  DEFAULT_TRACE_OPTIONS,
  dispatchTerminusFor,
  dispatchTerminusForEdge,
} from '../trace.js';
import type {
  StructuralGraphReader,
  TraceOptionsV2,
  TraversalDirection,
  TraversalEdgeV1,
  TraversalFreshnessStats,
  TraversalNodeV1,
  TraversalOptions,
  TraversalResultV1,
  TraversedStructuralEdge,
} from './types.js';

export type {
  StructuralGraphReader,
  TraceOptionsV2,
  TraversalDirection,
  TraversalDispatchInfo,
  TraversalEdgeV1,
  TraversalFreshness,
  TraversalFreshnessStats,
  TraversalNodeV1,
  TraversalOptions,
  TraversalResultV1,
  TraversalStepV1,
  TraversalTerminusReason,
  TraversedDispatchInfo,
  TraversedStructuralEdge,
} from './types.js';

export const DEFAULT_TRAVERSAL_OPTIONS: TraceOptionsV2 = {
  direction: 'outgoing',
  ...DEFAULT_TRACE_OPTIONS,
};

/**
 * Return graph edges adjacent in the requested traversal direction. The stored
 * source and target are deliberately left canonical; only `traversed` changes.
 */
export function edgesFor(
  graph: StructuralGraphReader,
  nodeId: string,
  direction: TraversalDirection
): TraversedStructuralEdge[] {
  const forward =
    direction === 'incoming'
      ? []
      : graph
          .getOutgoingStructuralEdges(nodeId)
          .map((edge): TraversedStructuralEdge => ({ ...edge, traversed: 'forward' }));
  const reverse =
    direction === 'outgoing'
      ? []
      : graph
          .getIncomingStructuralEdges(nodeId)
          .map((edge): TraversedStructuralEdge => ({ ...edge, traversed: 'reverse' }));

  return [...forward, ...reverse].sort((a, b) =>
    `${a.id}:${a.traversed}`.localeCompare(`${b.id}:${b.traversed}`)
  );
}

/** Return the node reached by walking an edge in its annotated direction. */
export function adjacentNode(edge: TraversedStructuralEdge): string {
  return edge.traversed === 'forward' ? edge.target_node_id : edge.source_node_id;
}

/**
 * A stored edge is eligible once in each traversal direction. This key also
 * prevents self-loops and both-direction cycles from emitting duplicates.
 */
export function traversalKey(edge: TraversedStructuralEdge): string {
  return `${edge.id}\0${edge.traversed}`;
}

function labelFor(node: StructuralNode | null, id: string): string {
  return node?.qualified_name ?? node?.symbol_name ?? id;
}

function isExternal(node: StructuralNode | null): boolean {
  return node !== null && (node.origin ?? 'local') !== 'local';
}

function assertOptions(options: TraceOptionsV2): void {
  if (!['outgoing', 'incoming', 'both'].includes(options.direction)) {
    throw new RangeError(`Unsupported traversal direction: ${String(options.direction)}`);
  }
  for (const [name, value, minimum] of [
    ['maxDepth', options.maxDepth, 0],
    ['maxNodes', options.maxNodes, 1],
    ['maxFanout', options.maxFanout, 0],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new RangeError(`${name} must be a safe integer >= ${minimum}`);
    }
  }
  if (!(options.minConfidenceClass in CONFIDENCE_RANK)) {
    throw new RangeError(`Unsupported confidence class: ${String(options.minConfidenceClass)}`);
  }
}

function initialFreshness(): TraversalFreshnessStats {
  return { fresh: 0, stale: 0, dirtyDependent: 0, unknown: 0 };
}

function recordFreshness(stats: TraversalFreshnessStats, edge: TraversedStructuralEdge): void {
  switch (edge.freshness_status) {
    case 'fresh':
      stats.fresh++;
      return;
    case 'stale':
      stats.stale++;
      return;
    case 'dirty-dependent':
      stats.dirtyDependent++;
      return;
    case 'unknown':
      stats.unknown++;
      return;
  }
}

/**
 * Breadth-first traversal over Lux's current canonical structural graph.
 *
 * All requested directions share one frontier and one set of depth, node, and
 * per-node fanout limits. Nodes are admitted once by ID. Stored edges remain in
 * canonical source-to-target form and may be emitted once per traversed
 * direction. Freshness is reported, never silently used as an exclusion.
 */
export function traverseStructuralGraph(
  graph: StructuralGraphReader,
  startId: string,
  options: TraversalOptions = {}
): TraversalResultV1 {
  const opts: TraceOptionsV2 = {
    ...DEFAULT_TRAVERSAL_OPTIONS,
    ...options,
    edgeTypes: options.edgeTypes ?? DEFAULT_TRAVERSAL_OPTIONS.edgeTypes,
  };
  assertOptions(opts);

  const edgeTypes = new Set(opts.edgeTypes);
  const minimumConfidence = CONFIDENCE_RANK[opts.minConfidenceClass];
  const nodesById = new Map<string, TraversalNodeV1>();
  const nodeCache = new Map<string, StructuralNode | null>();
  const emittedEdges = new Set<string>();
  const expanded = new Set<string>();
  const edges: TraversalEdgeV1[] = [];
  const freshness = initialFreshness();
  let maxDepthReached = 0;
  let nodeBudgetHit = false;

  const loadNode = (id: string): StructuralNode | null => {
    const cached = nodeCache.get(id);
    if (cached !== undefined || nodeCache.has(id)) return cached ?? null;
    const node = graph.getStructuralNode(id);
    nodeCache.set(id, node);
    return node;
  };

  const admitNode = (id: string, depth: number): TraversalNodeV1 => {
    const existing = nodesById.get(id);
    if (existing) return existing;
    const raw = loadNode(id);
    const node: TraversalNodeV1 = {
      id,
      label: labelFor(raw, id),
      languageId: raw?.language_id,
      filePath: raw?.file_path,
      depth,
      external: isExternal(raw),
    };
    nodesById.set(id, node);
    maxDepthReached = Math.max(maxDepthReached, depth);
    return node;
  };

  const start = admitNode(startId, 0);
  let frontier: string[] = [startId];

  const startDispatch = dispatchTerminusFor(loadNode(startId) ?? {});
  if (startDispatch) {
    start.dispatch = startDispatch;
    if (opts.direction === 'outgoing') {
      start.terminus = 'dynamic-dispatch-boundary';
      frontier = [];
    }
  }

  if (opts.maxDepth === 0 && frontier.length > 0) {
    start.terminus = 'depth-limit';
    frontier = [];
  }

  for (let depth = 1; depth <= opts.maxDepth && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];

    for (const currentId of frontier) {
      if (nodeBudgetHit) break;
      const current = nodesById.get(currentId)!;
      expanded.add(currentId);

      // A catalogued dispatch symbol stops only canonical forward continuation.
      // Inverse lookup must still be able to find its callers.
      const catalogDispatch = dispatchTerminusFor(loadNode(currentId) ?? {});
      const effectiveDirection: TraversalDirection =
        catalogDispatch && opts.direction === 'both' ? 'incoming' : opts.direction;

      const candidates = edgesFor(graph, currentId, effectiveDirection).filter(
        (edge) =>
          edgeTypes.has(edge.edge_type) &&
          CONFIDENCE_RANK[edge.confidence_class] >= minimumConfidence &&
          !emittedEdges.has(traversalKey(edge))
      );
      const capped = candidates.length > opts.maxFanout;
      const walked = capped ? candidates.slice(0, opts.maxFanout) : candidates;
      if (capped) current.terminus = 'fanout-cap';

      for (const edge of walked) {
        const edgeKey = traversalKey(edge);
        const adjacentId = adjacentNode(edge);
        const adjacentRaw = loadNode(adjacentId);
        if (!opts.includeExternal && isExternal(adjacentRaw)) continue;

        const existing = nodesById.get(adjacentId);
        if (!existing && nodesById.size >= opts.maxNodes) {
          current.terminus = 'node-budget';
          nodeBudgetHit = true;
          break;
        }

        const adjacent = existing ?? admitNode(adjacentId, depth);
        // A dispatch relationship can be explicit in the edge type or implicit
        // in the canonical target being catalogued framework machinery. In
        // either case the annotation stays about the stored source → target;
        // reverse traversal never turns it into a forward continuation.
        const dispatch =
          dispatchTerminusForEdge(edge.edge_type) ??
          dispatchTerminusFor(loadNode(edge.target_node_id) ?? {});
        const traversedDispatch = dispatch
          ? { ...dispatch, traversed: edge.traversed, boundary: edge.traversed === 'forward' }
          : undefined;

        edges.push({ ...edge, revisit: existing !== undefined, dispatch: traversedDispatch });
        emittedEdges.add(edgeKey);
        recordFreshness(freshness, edge);

        if (existing) continue;

        // Dispatch edges describe their canonical edge even in reverse, but only
        // a forward walk reaches (and stops at) the runtime re-entry boundary.
        const boundary = edge.traversed === 'forward' ? dispatch : null;
        if (boundary) {
          adjacent.dispatch = boundary;
          adjacent.terminus = 'dynamic-dispatch-boundary';
          continue;
        }

        if (depth === opts.maxDepth) {
          adjacent.terminus = 'depth-limit';
        } else {
          nextFrontier.push(adjacentId);
        }
      }
    }

    frontier = nextFrontier;
  }

  // Preserve the legacy trace convention: expanded natural leaves have no
  // terminus. `leaf` is reserved for an admitted node that was never expanded
  // and was not stopped by an explicit boundary/limit.
  for (const node of nodesById.values()) {
    if (!node.terminus && !expanded.has(node.id) && node.depth < opts.maxDepth) {
      node.terminus = 'leaf';
    }
  }

  const nodes = [...nodesById.values()].sort(
    (a, b) => a.depth - b.depth || a.id.localeCompare(b.id)
  );
  const truncated = nodes.some(
    (node) =>
      node.terminus === 'depth-limit' ||
      node.terminus === 'node-budget' ||
      node.terminus === 'fanout-cap'
  );

  return {
    startId,
    options: opts,
    nodes,
    edges,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      externalCount: nodes.filter((node) => node.external).length,
      maxDepthReached,
      dispatchBoundaries: nodes.filter((node) => node.terminus === 'dynamic-dispatch-boundary')
        .length,
      freshness,
      truncated,
    },
  };
}

/** Concise alias for integration adapters. */
export const traverseFrom = traverseStructuralGraph;
