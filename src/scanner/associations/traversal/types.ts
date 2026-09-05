import type {
  ConfidenceClass,
  EdgeType,
  FreshnessStatus,
  StructuralEdge,
  StructuralNode,
} from '../../../db/types.js';

/** Direction in which the canonical, directed structural graph is walked. */
export type TraversalDirection = 'outgoing' | 'incoming' | 'both';

/** Frozen Phase 2 traversal contract. */
export interface TraceOptionsV2 {
  direction: TraversalDirection;
  maxDepth: number;
  maxNodes: number;
  maxFanout: number;
  edgeTypes: EdgeType[];
  minConfidenceClass: ConfidenceClass;
  includeExternal: boolean;
}

/** A stored edge plus the direction in which this walk encountered it. */
export interface TraversedStructuralEdge extends StructuralEdge {
  traversed: 'forward' | 'reverse';
}

export interface TraversalStepV1 {
  nodeId: string;
  depth: number;
}

/** Why traversal did not continue in at least one requested direction at a node. */
export type TraversalTerminusReason =
  'leaf' | 'depth-limit' | 'node-budget' | 'fanout-cap' | 'dynamic-dispatch-boundary';

export interface TraversalDispatchInfo {
  dispatchKind: 'job' | 'event' | 'queue' | 'container' | 'pipeline';
  reentryDeferred: true;
  via: 'catalog-symbol' | 'dispatch-edge';
  note: string;
}

/**
 * Dispatch metadata belongs to the canonical stored edge. `boundary` is true
 * only when that edge was walked in its forward/control-flow direction.
 */
export interface TraversedDispatchInfo extends TraversalDispatchInfo {
  traversed: TraversedStructuralEdge['traversed'];
  boundary: boolean;
}

export interface TraversalNodeV1 {
  id: string;
  label: string;
  languageId?: string;
  filePath?: string;
  depth: number;
  external: boolean;
  terminus?: TraversalTerminusReason;
  dispatch?: TraversalDispatchInfo;
}

/**
 * The canonical source/target fields are never reversed. Consumers use
 * `traversed` (or adjacentNode) to render the direction of the walk.
 */
export interface TraversalEdgeV1 extends TraversedStructuralEdge {
  /** True when the adjacent node had already been admitted to this traversal. */
  revisit: boolean;
  /** Present when the stored edge describes a dynamic dispatch boundary. */
  dispatch?: TraversedDispatchInfo;
}

export interface TraversalFreshnessStats {
  fresh: number;
  stale: number;
  dirtyDependent: number;
  unknown: number;
}

export interface TraversalResultV1 {
  startId: string;
  options: TraceOptionsV2;
  nodes: TraversalNodeV1[];
  edges: TraversalEdgeV1[];
  stats: {
    nodeCount: number;
    edgeCount: number;
    externalCount: number;
    maxDepthReached: number;
    dispatchBoundaries: number;
    freshness: TraversalFreshnessStats;
    truncated: boolean;
  };
}

/** LuxDatabase's read surface, kept narrow so federation can provide a view. */
export interface StructuralGraphReader {
  getStructuralNode(id: string): StructuralNode | null;
  getOutgoingStructuralEdges(nodeId: string): StructuralEdge[];
  getIncomingStructuralEdges(nodeId: string): StructuralEdge[];
}

export type TraversalOptions = Partial<TraceOptionsV2>;

export type TraversalFreshness = FreshnessStatus;
