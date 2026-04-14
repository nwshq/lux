// Surface-centered retrieval helpers.
//
// Assembles a FeaturePath from the structural overlay around a capability surface:
//
//   consumers → [bridge] → surface → provider → validator / response contract / artifact
//
// Two output layers:
//   - compact: a single-line human-readable path for QA and discovery
//   - block:   a multi-line formatted summary with node IDs and confidence
//
// Retrieval uses only the DB — no re-parsing. Evidence is available but optional.

import type { LuxDatabase } from '../../db/index.js';
import type { StructuralNode } from '../../db/types.js';

// ---------------------------------------------------------------------------
// FeaturePath
// ---------------------------------------------------------------------------

/**
 * A surface-centered feature path assembled from overlay edges.
 *
 * All arrays may be empty — partial paths are valid and useful.
 */
export interface FeaturePath {
  /** The capability-surface node at the center. */
  surface: StructuralNode;
  /** Nodes that call this surface (calls_surface source side). */
  consumers: StructuralNode[];
  /** Nodes that handle this surface (handled_by target side). */
  providers: StructuralNode[];
  /** Request validator nodes linked to the primary provider (validates_with). */
  validators: StructuralNode[];
  /** Response contract nodes linked to the primary provider (returns_contract). */
  responseContracts: StructuralNode[];
  /** Generated artifact file nodes derived from this surface (derived_from source side). */
  artifacts: StructuralNode[];
  /** The file that declares this surface (declares_surface source side). */
  declaringFile: StructuralNode | null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assemble a FeaturePath for the given surface node ID.
 *
 * Returns null if the surface does not exist in the DB.
 */
export function getSurfaceFeaturePath(db: LuxDatabase, surfaceId: string): FeaturePath | null {
  const ctx = db.getSurfaceCenteredContext(surfaceId);
  if (!ctx) return null;

  const { surface, edges } = ctx;
  const path: FeaturePath = {
    surface,
    consumers: [],
    providers: [],
    validators: [],
    responseContracts: [],
    artifacts: [],
    declaringFile: null,
  };

  for (const { edge } of edges) {
    if (edge.edge_type === 'handled_by' && edge.source_node_id === surfaceId) {
      const node = db.getStructuralNode(edge.target_node_id);
      if (node) path.providers.push(node);
    } else if (edge.edge_type === 'calls_surface' && edge.target_node_id === surfaceId) {
      const node = db.getStructuralNode(edge.source_node_id);
      if (node) path.consumers.push(node);
    } else if (edge.edge_type === 'derived_from' && edge.target_node_id === surfaceId) {
      const node = db.getStructuralNode(edge.source_node_id);
      if (node) path.artifacts.push(node);
    } else if (edge.edge_type === 'declares_surface' && edge.target_node_id === surfaceId) {
      if (!path.declaringFile) {
        path.declaringFile = db.getStructuralNode(edge.source_node_id) ?? null;
      }
    }
  }

  // Expand provider edges to find validators and response contracts.
  // Only inspects the primary provider to keep the path compact.
  for (const provider of path.providers.slice(0, 1)) {
    const providerEdges = db.getRelatedEdgesWithEvidence(provider.id);
    for (const { edge } of providerEdges) {
      if (edge.edge_type === 'validates_with' && edge.source_node_id === provider.id) {
        const node = db.getStructuralNode(edge.target_node_id);
        if (node) path.validators.push(node);
      } else if (edge.edge_type === 'returns_contract' && edge.source_node_id === provider.id) {
        const node = db.getStructuralNode(edge.target_node_id);
        if (node) path.responseContracts.push(node);
      }
    }
  }

  return path;
}

/**
 * Assemble feature paths for all surfaces declared in a given file.
 *
 * @param db - Database to query.
 * @param filePath - Relative file path (as stored in node IDs, e.g. "routes/api.php").
 */
export function getFeaturePathsForFile(db: LuxDatabase, filePath: string): FeaturePath[] {
  const surfaces = db.getCapabilitySurfaces();
  const results: FeaturePath[] = [];

  for (const surface of surfaces) {
    if (surface.file_path !== filePath) continue;
    const path = getSurfaceFeaturePath(db, surface.id);
    if (path) results.push(path);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Compact feature-path formatter
// ---------------------------------------------------------------------------

/**
 * Format a FeaturePath as a single-line compact summary.
 *
 * Output format (arrows indicate direction of call/dependency):
 * ```
 * consumer → surface → provider → contract
 * ```
 *
 * Tokens use `symbol_name` for readability where available, falling back to node ID.
 */
export function formatFeaturePath(path: FeaturePath): string {
  const parts: string[] = [];

  // Left side: consumers (at most 2 shown)
  for (const c of path.consumers.slice(0, 2)) {
    parts.push(shortLabel(c));
  }
  if (path.consumers.length > 2) {
    parts.push(`+${path.consumers.length - 2} more`);
  }

  // Center: surface
  parts.push(shortLabel(path.surface));

  // Right side: provider → validator/contract
  for (const p of path.providers.slice(0, 1)) {
    parts.push(shortLabel(p));
  }

  for (const v of path.validators.slice(0, 1)) {
    parts.push(shortLabel(v));
  }

  for (const r of path.responseContracts.slice(0, 1)) {
    parts.push(shortLabel(r));
  }

  // Artifact(s) shown at the end
  for (const a of path.artifacts.slice(0, 1)) {
    parts.push(shortLabel(a));
  }

  return parts.join(' → ');
}

// ---------------------------------------------------------------------------
// Block formatter (multi-line, for context injection)
// ---------------------------------------------------------------------------

/**
 * Format a FeaturePath as a multi-line block suitable for injection into
 * expert discovery context. Includes node IDs, roles, and a compact path line.
 */
export function formatFeaturePathBlock(path: FeaturePath): string {
  const lines: string[] = [];
  const meta = parseSurfaceMeta(path.surface);
  const handle = path.surface.symbol_name ?? path.surface.id;

  lines.push(`Surface: ${handle}`);
  if (meta.routeName) {
    lines.push(`  Route name: ${meta.routeName}`);
  }

  if (path.declaringFile) {
    lines.push(`  Declared in: ${path.declaringFile.file_path ?? path.declaringFile.id}`);
  }

  if (path.providers.length > 0) {
    lines.push(`  Provider(s): ${path.providers.map(shortLabel).join(', ')}`);
  }

  if (path.validators.length > 0) {
    lines.push(`  Validates with: ${path.validators.map(shortLabel).join(', ')}`);
  }

  if (path.responseContracts.length > 0) {
    lines.push(`  Returns: ${path.responseContracts.map(shortLabel).join(', ')}`);
  }

  if (path.consumers.length > 0) {
    lines.push(`  Consumer(s): ${path.consumers.map(shortLabel).join(', ')}`);
  }

  if (path.artifacts.length > 0) {
    lines.push(`  Artifact(s): ${path.artifacts.map(shortLabel).join(', ')}`);
  }

  const compact = formatFeaturePath(path);
  if (compact) {
    lines.push(`  Path: ${compact}`);
  }

  return lines.join('\n');
}

/**
 * Format all feature paths for a file as a block for overlay context injection.
 * Returns null if no surfaces are associated with this file.
 */
export function formatFileFeaturePathBlock(db: LuxDatabase, filePath: string): string | null {
  const paths = getFeaturePathsForFile(db, filePath);
  if (paths.length === 0) return null;

  const blocks = paths.map((p) => formatFeaturePathBlock(p));
  return blocks.join('\n\n');
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

interface SurfaceMeta {
  routeName?: string;
}

function parseSurfaceMeta(surface: StructuralNode): SurfaceMeta {
  try {
    return JSON.parse(surface.metadata ?? '{}') as SurfaceMeta;
  } catch {
    return {};
  }
}

/**
 * Return a short display label for a structural node.
 * Uses symbol_name when available; falls back to the last segment of the node ID.
 */
function shortLabel(node: StructuralNode): string {
  if (node.symbol_name) return node.symbol_name;

  // Extract the meaningful part of the node ID
  const id = node.id;
  const lastColon = id.lastIndexOf(':');
  return lastColon >= 0 ? id.slice(lastColon + 1) : id;
}
