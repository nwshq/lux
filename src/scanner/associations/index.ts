// Cross-language structural association module.
//
// Public API surface for the overlay engine, types, and evidence formatting.

export { AssociationEngine } from './engine.js';
export type { AssociationEngineOptions, AssociationEngineResult } from './engine.js';

export type {
  AssociationContext,
  AssociationResolver,
  StructuralRelationEdge,
  EdgeProvenance,
  StructuralNodeType,
  EdgeType,
  ConfidenceClass,
  FreshnessStatus,
} from './types.js';

export {
  fileNodeId,
  phpSymbolNodeId,
  tsSymbolNodeId,
  contractNodeId,
  surfaceNodeId,
} from './types.js';

export { summarizeEdgeEvidence, formatEdgeBlock, annotateFreshness } from './evidence.js';
export type { EdgeWithEvidence } from './evidence.js';

export {
  createDefaultResolvers,
  LaravelBoundaryEvidenceResolver,
} from './framework/index.js';

export {
  createDefaultOperationalExtractors,
  formatFileOperationalBoundaryBlock,
  formatOperationalNeighborhoodSummary,
  getOperationalBoundaryHandlers,
  getOperationalDispatchSourcesForJob,
  getOperationalDispatchedJobs,
  getOperationalEventListeners,
  getOperationalUpstreamTriggers,
  getTrustAwareOperationalNeighborhood,
  runOperationalExtractors,
} from './operational/index.js';
export type {
  BoundaryHandlerLink,
  OperationalBoundaryDescriptor,
  OperationalBoundaryHandlersResult,
  OperationalContractDescriptor,
  OperationalDispatchSource,
  OperationalDispatchSourcesResult,
  OperationalDispatchedJob,
  OperationalDispatchedJobsResult,
  OperationalEventListener,
  OperationalEventListenersResult,
  OperationalNeighborhoodEdge,
  OperationalNeighborhoodNode,
  OperationalNeighborhoodResult,
  OperationalEdgeDescriptor,
  OperationalExtractionBatch,
  OperationalExtractionResult,
  OperationalExtractor,
  OperationalHandlerDescriptor,
  OperationalUpstreamTrigger,
  OperationalUpstreamTriggersResult,
} from './operational/index.js';
