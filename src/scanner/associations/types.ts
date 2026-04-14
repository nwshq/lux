// Association engine types: contexts, edges, resolvers, and node identity helpers.
//
// These types are the public contract for the cross-language overlay.
// They parallel the DB types in src/db/types.ts but carry richer in-memory
// provenance data before persistence.

import type { StructuralNode, EdgeType, ConfidenceClass } from '../../db/types.js';

// Re-export node type alias for convenience
export type { StructuralNodeType, EdgeType, ConfidenceClass, FreshnessStatus } from '../../db/types.js';

// ---------------------------------------------------------------------------
// Association context
// ---------------------------------------------------------------------------

/** All information an AssociationResolver needs to produce edges. */
export interface AssociationContext {
  /** Absolute path to the repository root. */
  rootPath: string;
  /** Structural nodes already known for this workspace. */
  nodes: StructuralNode[];
  /** Lightweight index entries — file path, language, and metadata. */
  entries: Array<{
    filePath: string;
    languageId?: string;
    metadata?: Record<string, unknown>;
  }>;
  /** Current HEAD commit hash, if available. */
  currentCommit?: string;
  /** Relative file paths that are currently dirty in the working tree. */
  dirtyFiles: string[];
}

// ---------------------------------------------------------------------------
// In-memory structural relation edge (pre-persistence)
// ---------------------------------------------------------------------------

/** Provenance record attached to a structural relation edge. */
export interface EdgeProvenance {
  /** Name of the resolver that produced this edge. */
  resolver: string;
  /** Kind of evidence (e.g. 'route-match', 'generated-type', 'manifest-entry'). */
  evidenceKind: string;
  /** Source locations supporting this edge. */
  evidenceLocations: Array<{ filePath: string; line?: number; note?: string }>;
  /** Epoch seconds when the evidence was extracted. */
  extractedAt: number;
}

/** A cross-language relation produced by an AssociationResolver. */
export interface StructuralRelationEdge {
  /** Stable unique identifier for this edge. */
  id: string;
  /** Relation kind. */
  edgeType: EdgeType;
  /** Source node ID. */
  sourceNodeId: string;
  /** Target node ID. */
  targetNodeId: string;
  /** Language of the source node, if known. */
  sourceLanguage?: string;
  /** Language of the target node, if known. */
  targetLanguage?: string;
  /** Confidence score in [0, 1]. */
  confidence: number;
  /** Confidence class. Heuristic edges are excluded from default retrieval. */
  confidenceClass: ConfidenceClass;
  /** Full provenance record. */
  provenance: EdgeProvenance;
}

// ---------------------------------------------------------------------------
// Resolver contract
// ---------------------------------------------------------------------------

/**
 * Contract for cross-language association resolvers.
 *
 * Each resolver inspects the indexed knowledge of a workspace and emits
 * structural relation edges. Resolvers are stateless — all context is
 * provided via AssociationContext.
 */
export interface AssociationResolver {
  /** Stable unique name (e.g. 'laravel-routes', 'generated-types'). */
  readonly name: string;

  /**
   * Return true if this resolver can meaningfully run against the given context.
   * A resolver that requires PHP routes, for example, should return false
   * for TypeScript-only workspaces.
   */
  supports(context: AssociationContext): boolean;

  /**
   * Produce structural relation edges from the given context.
   * Should not throw — return [] on error to allow other resolvers to proceed.
   */
  resolve(context: AssociationContext): Promise<StructuralRelationEdge[]>;
}

// ---------------------------------------------------------------------------
// Capability surface node
// ---------------------------------------------------------------------------

/**
 * Metadata stored inside a capability-surface StructuralNode.
 * Serialized as JSON in structural_nodes.metadata.
 */
export interface CapabilitySurfaceMetadata {
  /** Transport type (e.g. "http", "event", "cli"). */
  transport: string;
  /** HTTP method (for HTTP surfaces). */
  method?: string;
  /** Canonical path (for HTTP surfaces). */
  path?: string;
  /** Optional explicit route name assigned in the declaration. */
  routeName?: string;
  /** Optional aliases (e.g. parameterized variants, named routes). */
  aliases?: string[];
  /** Explicit provider reference if named in the declaration. */
  explicitProvider?: string;
}

/**
 * A normalized capability surface node ready for DB persistence.
 * Extends StructuralNode with well-typed surface metadata.
 */
export interface CapabilitySurfaceNode {
  id: string;
  /** Canonical handle (e.g. "GET /api/invoices"). Stored as symbol_name. */
  handle: string;
  /** Transport label (e.g. "http"). Stored as language_id. */
  transport: string;
  /** File where the surface is declared (relative path). */
  file_path?: string;
  /** Extra metadata needed for propagation. */
  metadata: CapabilitySurfaceMetadata;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Node ID builders
// ---------------------------------------------------------------------------

/** Build a stable file node ID from a relative path. */
export function fileNodeId(relativeFilePath: string): string {
  return `file:${relativeFilePath}`;
}

/** Build a stable PHP symbol node ID. */
export function phpSymbolNodeId(qualifiedName: string): string {
  return `symbol:php:${qualifiedName}`;
}

/** Build a stable TypeScript/JavaScript symbol node ID. */
export function tsSymbolNodeId(relativeFilePath: string, symbolName: string): string {
  return `symbol:ts:${relativeFilePath}#${symbolName}`;
}

/** Build a route node ID from an HTTP method and path. */
export function routeNodeId(method: string, path: string): string {
  return `route:${method.toUpperCase()}:${path}`;
}

/** Build a contract node ID. Prefers explicit schema name if provided. */
export function contractNodeId(schemaName?: string, routeKey?: string): string {
  if (schemaName) return `contract:schema:${schemaName}`;
  if (routeKey) return `contract:route:${routeKey}`;
  return `contract:synthetic:${Math.random().toString(36).slice(2)}`;
}

/** Build an artifact node ID from a descriptor (e.g. type bundle path). */
export function artifactNodeId(descriptor: string): string {
  return `artifact:${descriptor}`;
}

/**
 * Build a stable HTTP capability-surface node ID.
 *
 * Format: `surface:http:METHOD:/canonical/path`
 *
 * @param method - HTTP verb in any case (will be uppercased).
 * @param path - The canonical route path (e.g. "/api/invoices").
 */
export function httpSurfaceNodeId(method: string, path: string): string {
  return `surface:http:${method.toUpperCase()}:${path}`;
}

/**
 * Build a generic capability-surface node ID for non-HTTP transports.
 *
 * Format: `surface:{transport}:{handle}`
 */
export function surfaceNodeId(transport: string, handle: string): string {
  return `surface:${transport}:${handle}`;
}
