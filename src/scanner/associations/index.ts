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
  routeNodeId,
  contractNodeId,
  artifactNodeId,
  surfaceNodeId,
} from './types.js';

export { summarizeEdgeEvidence, formatEdgeBlock, annotateFreshness } from './evidence.js';
export type { EdgeWithEvidence } from './evidence.js';

export {
  createDefaultResolvers,
  LaravelRoutesResolver,
  LaravelBoundaryEvidenceResolver,
  GeneratedTypesResolver,
} from './framework/index.js';
