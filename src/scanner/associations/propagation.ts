// Symbolic propagation: expand from known capability surfaces outward.
//
// Propagation runs after detectors have established surface nodes and
// explicit boundary edges. Each pass starts from a surface and uses
// structural and LSP evidence to link:
//
//   provider-side:  surface → controller class → request validator → response resource
//   consumer-side:  surface → wrapper function → hook → component
//   artifact-side:  surface → generated client artifact → callable symbol
//
// Propagation only emits edges when it can find supporting structural
// evidence (LSP symbol data, file naming, or import patterns). It does
// NOT infer by convention alone when symbol truth exists.

import type { LuxDatabase } from '../../db/index.js';
import type { StructuralNode } from '../../db/types.js';
import type { AssociationContext } from './types.js';
import { AssociationEngine } from './engine.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PropagationResult {
  providerEdgesAdded: number;
  consumerEdgesAdded: number;
  artifactEdgesAdded: number;
}

/**
 * Run all propagation passes for the detected surfaces in the given context.
 *
 * @param db - Database holding surfaces, nodes, and existing edges.
 * @param context - AssociationContext from the overlay rebuild.
 * @returns Counts of edges added per propagation type.
 */
export async function propagateSurfaces(
  db: LuxDatabase,
  context: AssociationContext
): Promise<PropagationResult> {
  const surfaces = db.getCapabilitySurfaces();
  if (surfaces.length === 0) {
    return { providerEdgesAdded: 0, consumerEdgesAdded: 0, artifactEdgesAdded: 0 };
  }

  let providerEdgesAdded = 0;
  let consumerEdgesAdded = 0;
  let artifactEdgesAdded = 0;

  for (const surface of surfaces) {
    providerEdgesAdded += runProviderPropagation(db, surface, context);
    consumerEdgesAdded += runConsumerPropagation(db, surface, context);
    artifactEdgesAdded += runArtifactPropagation(db, surface, context);
  }

  return { providerEdgesAdded, consumerEdgesAdded, artifactEdgesAdded };
}

// ---------------------------------------------------------------------------
// Provider-side propagation
// ---------------------------------------------------------------------------

/**
 * Expand from a surface's explicit provider (via handled_by) to:
 *   - request validator symbols (classes passed to $request->validated() or FormRequest subtypes)
 *   - response resource symbols (classes used in JsonResource::collection or new XResource())
 *
 * Only emits edges when the controller symbol exists in the DB and LSP
 * enrichment data is available to confirm symbol relationships.
 */
function runProviderPropagation(
  db: LuxDatabase,
  surface: StructuralNode,
  context: AssociationContext
): number {
  const surfaceCtx = db.getSurfaceCenteredContext(surface.id);
  if (!surfaceCtx) return 0;

  const handledByEdges = surfaceCtx.edges.filter((e) => e.edge.edge_type === 'handled_by');
  if (handledByEdges.length === 0) return 0;

  let added = 0;
  const now = Math.floor(Date.now() / 1000);

  for (const { edge } of handledByEdges) {
    const controllerNodeId = edge.target_node_id;
    const controllerNode = db.getStructuralNode(controllerNodeId);
    if (!controllerNode) continue;

    // Look for request and response symbols in the same file as the controller
    const controllerFilePath = controllerNode.file_path;
    if (!controllerFilePath) continue;

    const siblingsInFile = findSymbolsLinkedToController(
      controllerFilePath,
      context
    );

    for (const sibling of siblingsInFile) {
      const siblingNodeId = `symbol:php:${sibling.qualifiedName}`;
      const existingNode = db.getStructuralNode(siblingNodeId);
      if (!existingNode) continue;

      const edgeType = sibling.role === 'request' ? 'validates_with' : 'returns_contract';
      const edgeId = `${controllerNodeId}→${siblingNodeId}:${edgeType}:propagated`;
      const propEdge = {
        id: edgeId,
        edgeType: edgeType as 'validates_with' | 'returns_contract',
        sourceNodeId: controllerNodeId,
        targetNodeId: siblingNodeId,
        sourceLanguage: 'php',
        targetLanguage: 'php',
        confidence: 0.75,
        confidenceClass: 'framework-inferred' as const,
        provenance: {
          resolver: 'propagation:provider',
          evidenceKind: 'symbol-sibling-in-controller-file',
          evidenceLocations: [
            { filePath: controllerFilePath, note: `${sibling.role}: ${sibling.qualifiedName}` },
          ],
          extractedAt: now,
        },
      };

      AssociationEngine.persistEdges(db, [propEdge]);
      added++;
    }
  }

  return added;
}

// ---------------------------------------------------------------------------
// Consumer-side propagation
// ---------------------------------------------------------------------------

/**
 * Expand from a surface to TypeScript/JavaScript wrapper symbols and hooks
 * that reference the surface's path or route name.
 *
 * Matches by looking for TS/JS entries whose content contains the surface's
 * canonical path, and whose symbols export functions that wrap the call.
 */
function runConsumerPropagation(
  db: LuxDatabase,
  surface: StructuralNode,
  context: AssociationContext
): number {
  const meta = parseSurfaceMeta(surface);
  if (!meta.path) return 0;

  let added = 0;
  const now = Math.floor(Date.now() / 1000);
  const surfaceId = surface.id;

  const tsEntries = context.entries.filter(
    (e) => e.languageId === 'typescript' || e.languageId === 'javascript'
  );

  for (const entry of tsEntries) {
    const content = (entry.metadata?.content as string | undefined) ?? '';
    if (!content || !content.includes(meta.path)) continue;

    // Look for exported wrapper symbols mentioning the path or route name
    const wrapperSymbols = extractWrapperSymbols(content, entry.filePath, meta.path, meta.routeName);

    for (const wrapper of wrapperSymbols) {
      const wrapperNodeId = `symbol:ts:${entry.filePath}#${wrapper.name}`;
      const existingNode = db.getStructuralNode(wrapperNodeId);
      if (!existingNode) continue;

      const edgeId = `${wrapperNodeId}→${surfaceId}:calls_surface:propagated`;
      const propEdge = {
        id: edgeId,
        edgeType: 'calls_surface' as const,
        sourceNodeId: wrapperNodeId,
        targetNodeId: surfaceId,
        sourceLanguage: 'typescript',
        confidence: 0.7,
        confidenceClass: 'framework-inferred' as const,
        provenance: {
          resolver: 'propagation:consumer',
          evidenceKind: 'wrapper-symbol-path-reference',
          evidenceLocations: [
            { filePath: entry.filePath, line: wrapper.line, note: `references ${meta.path}` },
          ],
          extractedAt: now,
        },
      };

      AssociationEngine.persistEdges(db, [propEdge]);
      added++;
    }
  }

  return added;
}

// ---------------------------------------------------------------------------
// Artifact-side propagation
// ---------------------------------------------------------------------------

/**
 * Expand from a surface to generated client artifacts that reference the surface's path.
 *
 * Targets: openapi-*.ts, *.client.ts, generated/*.ts patterns.
 * Emits derived_from from artifact file node to the surface.
 */
function runArtifactPropagation(
  db: LuxDatabase,
  surface: StructuralNode,
  context: AssociationContext
): number {
  const meta = parseSurfaceMeta(surface);
  if (!meta.path) return 0;

  let added = 0;
  const now = Math.floor(Date.now() / 1000);
  const surfaceId = surface.id;

  const artifactEntries = context.entries.filter(
    (e) =>
      (e.languageId === 'typescript' || e.languageId === 'javascript') &&
      isGeneratedArtifact(e.filePath)
  );

  for (const entry of artifactEntries) {
    const content = (entry.metadata?.content as string | undefined) ?? '';
    if (!content || !content.includes(meta.path)) continue;

    const artifactNodeId = `file:${entry.filePath}`;
    const existingNode = db.getStructuralNode(artifactNodeId);
    if (!existingNode) continue;

    const edgeId = `${artifactNodeId}→${surfaceId}:derived_from:propagated`;
    const propEdge = {
      id: edgeId,
      edgeType: 'derived_from' as const,
      sourceNodeId: artifactNodeId,
      targetNodeId: surfaceId,
      sourceLanguage: entry.languageId ?? 'typescript',
      confidence: 0.8,
      confidenceClass: 'artifact-backed' as const,
      provenance: {
        resolver: 'propagation:artifact',
        evidenceKind: 'generated-file-path-reference',
        evidenceLocations: [
          { filePath: entry.filePath, note: `generated artifact references ${meta.path}` },
        ],
        extractedAt: now,
      },
    };

    AssociationEngine.persistEdges(db, [propEdge]);
    added++;
  }

  return added;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface SurfaceMeta {
  transport: string;
  method?: string;
  path?: string;
  routeName?: string;
}

function parseSurfaceMeta(surface: StructuralNode): SurfaceMeta {
  try {
    return JSON.parse(surface.metadata ?? '{}') as SurfaceMeta;
  } catch {
    return { transport: 'http' };
  }
}

interface SymbolWithRole {
  qualifiedName: string;
  role: 'request' | 'response';
}

/**
 * Look for FormRequest or JsonResource subtype symbols in a controller's file
 * using LSP enrichment data.
 */
function findSymbolsLinkedToController(
  controllerFilePath: string,
  context: AssociationContext
): SymbolWithRole[] {
  const results: SymbolWithRole[] = [];

  const entry = context.entries.find((e) => e.filePath === controllerFilePath);
  if (!entry) return results;

  const lsp = (entry.metadata?.lsp as Record<string, unknown> | undefined);
  if (!lsp) return results;

  // Look for symbols in LSP type hierarchy that extend FormRequest or JsonResource
  const typeHierarchy = (lsp.typeHierarchy as Array<{ name: string; supertypes?: Array<{ name: string }> }> | undefined);
  if (!typeHierarchy) return results;

  for (const entry of typeHierarchy) {
    const supers = entry.supertypes?.map((s) => s.name) ?? [];
    if (supers.some((s) => s.includes('FormRequest'))) {
      results.push({ qualifiedName: entry.name, role: 'request' });
    } else if (supers.some((s) => s.includes('JsonResource') || s.includes('Resource'))) {
      results.push({ qualifiedName: entry.name, role: 'response' });
    }
  }

  return results;
}

interface WrapperSymbol {
  name: string;
  line: number;
}

/**
 * Extract exported function names from a TS/JS file that reference the given path.
 * Looks for functions named get*, fetch*, use* that contain the path literal.
 */
function extractWrapperSymbols(
  content: string,
  _filePath: string,
  path: string,
  _routeName?: string
): WrapperSymbol[] {
  const results: WrapperSymbol[] = [];
  const lines = content.split('\n');

  // Find lines containing the path, then walk up to find the enclosing function
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(path)) continue;

    // Walk back up to find the containing function declaration
    for (let j = i; j >= Math.max(0, i - 15); j--) {
      const fnMatch = /export\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/
        .exec(lines[j]);
      const arrowMatch = /export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?\(/.exec(lines[j]);

      const match = fnMatch ?? arrowMatch;
      if (match) {
        const name = match[1];
        if (!results.some((r) => r.name === name)) {
          results.push({ name, line: j });
        }
        break;
      }
    }
  }

  return results;
}

/**
 * Identify generated client artifacts by file naming convention.
 */
function isGeneratedArtifact(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.includes('/generated/') ||
    lower.includes('openapi') ||
    lower.endsWith('.client.ts') ||
    lower.endsWith('.client.js') ||
    lower.includes('-api.ts') ||
    lower.includes('-api.js')
  );
}
