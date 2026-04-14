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
 *   - request validator symbols (FormRequest subtypes in method signatures)
 *   - response resource symbols (JsonResource / DTO in return expressions)
 *
 * Uses two evidence paths — LSP type hierarchy when available, PHP content
 * regex analysis otherwise — then resolves DB nodes by qualified name with
 * a short-name fallback to handle both indexed formats.
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

    const controllerFilePath = controllerNode.file_path;
    if (!controllerFilePath) continue;

    const candidates = findSymbolsLinkedToController(controllerFilePath, context);

    for (const candidate of candidates) {
      // Resolve DB node: try qualified name first, then short name
      const resolved = resolvePhpSymbolNode(db, candidate.qualifiedName);
      if (!resolved) continue;

      const edgeType = candidate.role === 'request' ? 'validates_with' : 'returns_contract';
      const edgeId = `${controllerNodeId}→${resolved.nodeId}:${edgeType}:propagated`;
      const propEdge = {
        id: edgeId,
        edgeType: edgeType as 'validates_with' | 'returns_contract',
        sourceNodeId: controllerNodeId,
        targetNodeId: resolved.nodeId,
        sourceLanguage: 'php',
        targetLanguage: 'php',
        confidence: 0.75,
        confidenceClass: 'framework-inferred' as const,
        provenance: {
          resolver: 'propagation:provider',
          evidenceKind: candidate.evidenceKind,
          evidenceLocations: [
            { filePath: controllerFilePath, note: `${candidate.role}: ${candidate.qualifiedName}` },
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
 * Two-stage approach:
 *   Stage A: candidate generation — find exported functions enclosing the path string.
 *   Stage B: transport proof — require at least one transport-shaped callsite (fetch,
 *            axios, HTTP method, React Query) in the function body window before emitting.
 *
 * Paths shorter than 4 non-slash characters are too generic to match reliably and
 * are skipped. Dynamic segments like {id} are stripped before searching so that
 * the static skeleton of the path drives matching.
 */
function runConsumerPropagation(
  db: LuxDatabase,
  surface: StructuralNode,
  context: AssociationContext
): number {
  const meta = parseSurfaceMeta(surface);
  if (!meta.path) return 0;

  // Guard: skip paths whose static skeleton is too short to be meaningful
  const staticSkeleton = meta.path.replace(/\{[^}]+\}/g, '').replace(/\/+/g, '/');
  if (staticSkeleton.replace(/^\//, '').length < 4) return 0;

  // Use stripped path for content matching to avoid dynamic-segment false-positives
  const searchPath = staticSkeleton;

  let added = 0;
  const now = Math.floor(Date.now() / 1000);
  const surfaceId = surface.id;

  const tsEntries = context.entries.filter(
    (e) => e.languageId === 'typescript' || e.languageId === 'javascript'
  );

  for (const entry of tsEntries) {
    const content = (entry.metadata?.content as string | undefined) ?? '';
    if (!content || !content.includes(searchPath)) continue;

    const lines = content.split('\n');

    // Stage A: find exported functions enclosing the path string
    const candidates = extractConsumerCandidates(lines, searchPath);

    for (const candidate of candidates) {
      // Stage B: require a transport-shaped callsite in the function body
      if (!hasTransportCallsite(lines, candidate.startLine)) continue;

      const wrapperNodeId = `symbol:ts:${entry.filePath}#${candidate.name}`;
      const existingNode = db.getStructuralNode(wrapperNodeId);
      if (!existingNode) continue;

      const edgeId = `${wrapperNodeId}→${surfaceId}:calls_surface:propagated`;
      const propEdge = {
        id: edgeId,
        edgeType: 'calls_surface' as const,
        sourceNodeId: wrapperNodeId,
        targetNodeId: surfaceId,
        sourceLanguage: 'typescript',
        confidence: 0.75,
        confidenceClass: 'framework-inferred' as const,
        provenance: {
          resolver: 'propagation:consumer',
          evidenceKind: 'transport-proven-wrapper-path-reference',
          evidenceLocations: [
            { filePath: entry.filePath, line: candidate.startLine, note: `references ${meta.path}` },
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
 * Uses explicit role classification — only `generated-client` and `schema-derived`
 * files receive `derived_from` edges.  Handwritten wrappers and ordinary service
 * files are skipped here; real wrappers are captured by consumer propagation.
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

  const tsEntries = context.entries.filter(
    (e) => e.languageId === 'typescript' || e.languageId === 'javascript'
  );

  for (const entry of tsEntries) {
    const content = (entry.metadata?.content as string | undefined) ?? '';

    const role = classifyArtifactRole(entry.filePath, content);
    if (role === 'handwritten-wrapper' || role === 'ordinary-service') continue;

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
        evidenceKind: `artifact-role:${role}`,
        evidenceLocations: [
          { filePath: entry.filePath, note: `${role} artifact references ${meta.path}` },
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
  evidenceKind: string;
}

/**
 * Combine LSP type-hierarchy evidence with PHP content regex analysis to find
 * request-validator and response-resource symbols linked to a controller.
 *
 * LSP path: reads `typeHierarchy` from enrichment metadata.
 * PHP path: extracts typed parameters from method signatures and resource
 *           classes from return expressions; resolves short names via `use` imports.
 */
function findSymbolsLinkedToController(
  controllerFilePath: string,
  context: AssociationContext
): SymbolWithRole[] {
  const results: SymbolWithRole[] = [];

  const entry = context.entries.find((e) => e.filePath === controllerFilePath);
  if (!entry) return results;

  // ── Path 1: LSP type hierarchy ──────────────────────────────────────────────
  const lsp = (entry.metadata?.lsp as Record<string, unknown> | undefined);
  if (lsp) {
    const typeHierarchy = (lsp.typeHierarchy as Array<{ name: string; supertypes?: Array<{ name: string }> }> | undefined);
    if (typeHierarchy) {
      for (const sym of typeHierarchy) {
        const supers = sym.supertypes?.map((s) => s.name) ?? [];
        if (supers.some((s) => s.includes('FormRequest'))) {
          results.push({ qualifiedName: sym.name, role: 'request', evidenceKind: 'lsp-type-hierarchy' });
        } else if (supers.some((s) => s.includes('JsonResource') || s.includes('Resource'))) {
          results.push({ qualifiedName: sym.name, role: 'response', evidenceKind: 'lsp-type-hierarchy' });
        }
      }
    }
  }

  // ── Path 2: PHP content analysis ────────────────────────────────────────────
  const content = (entry.metadata?.content as string | undefined) ?? '';
  if (content) {
    for (const candidate of findSymbolsViaPhpContent(content)) {
      if (!results.some((r) => r.qualifiedName === candidate.qualifiedName)) {
        results.push(candidate);
      }
    }
  }

  return results;
}

/** PHP name segments → short name. */
function phpShortName(name: string): string {
  return name.split('\\').pop()!;
}

/**
 * Resolve a PHP symbol name to a DB node, trying the full qualified name first
 * then the trailing short-name segment (handles both indexed formats).
 */
function resolvePhpSymbolNode(
  db: LuxDatabase,
  qualifiedName: string
): { nodeId: string; node: StructuralNode } | null {
  const qualified = `symbol:php:${qualifiedName}`;
  const qNode = db.getStructuralNode(qualified);
  if (qNode) return { nodeId: qualified, node: qNode };

  const short = phpShortName(qualifiedName);
  if (short !== qualifiedName) {
    const shortId = `symbol:php:${short}`;
    const sNode = db.getStructuralNode(shortId);
    if (sNode) return { nodeId: shortId, node: sNode };
  }

  return null;
}

/**
 * Regex-based PHP content analysis.
 *
 * Finds request-validator and response-resource class references from:
 *  1. Method parameter type-hints (e.g. `StoreInvoiceRequest $request`)
 *  2. Return expressions with `new XResource(` or `XResource::collection(`
 *  3. `use` import statements to resolve short names to qualified names.
 *
 * Excludes bare base classes (Request, FormRequest) that are too generic.
 */
function findSymbolsViaPhpContent(content: string): SymbolWithRole[] {
  const results: SymbolWithRole[] = [];

  // Build import map: shortName → qualifiedName
  const importMap = new Map<string, string>();
  const useRe = /^use\s+((?:[A-Za-z][A-Za-z0-9_]*\\)*[A-Za-z][A-Za-z0-9_]*)(?:\s+as\s+(\w+))?;/gm;
  let m: RegExpExecArray | null;
  while ((m = useRe.exec(content)) !== null) {
    const qualified = m[1];
    const alias = m[2];
    const short = alias ?? phpShortName(qualified);
    importMap.set(short, qualified);
  }

  const addCandidate = (shortName: string, role: SymbolWithRole['role'], evidenceKind: string): void => {
    const qualifiedName = importMap.get(shortName) ?? shortName;
    if (!results.some((r) => r.qualifiedName === qualifiedName)) {
      results.push({ qualifiedName, role, evidenceKind });
    }
  };

  // Typed parameters in method signatures ending in Request, Validator, or FormRequest
  // Excludes bare base-class names.
  const paramRe = /([A-Z][A-Za-z0-9_]*(?:Request|Validator|FormRequest))\s+\$\w+/g;
  while ((m = paramRe.exec(content)) !== null) {
    const name = m[1];
    if (name === 'Request' || name === 'FormRequest') continue;
    addCandidate(name, 'request', 'php-typed-parameter');
  }

  // `new XResource(` / `new XResponse(` / `new XDto(` in any expression
  const newInstanceRe = /\bnew\s+([A-Z][A-Za-z0-9_]*(?:Resource|Response|DTO|Dto|Contract))\s*\(/g;
  while ((m = newInstanceRe.exec(content)) !== null) {
    addCandidate(m[1], 'response', 'php-return-constructor');
  }

  // Static factory calls: XResource::collection(...) / XResource::make(...) / XResource::from(...)
  const staticFactoryRe = /([A-Z][A-Za-z0-9_]*(?:Resource|Response|DTO|Dto|Contract))::(?:collection|make|from)\s*\(/g;
  while ((m = staticFactoryRe.exec(content)) !== null) {
    addCandidate(m[1], 'response', 'php-static-factory');
  }

  return results;
}

interface ConsumerCandidate {
  name: string;
  /** Line index (0-based) of the function declaration. */
  startLine: number;
}

/**
 * Stage A — find exported function declarations that enclose a line containing
 * the given path string.  Returns one candidate per distinct function name.
 */
function extractConsumerCandidates(lines: string[], path: string): ConsumerCandidate[] {
  const results: ConsumerCandidate[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(path)) continue;

    // Walk back up to find the containing exported function declaration
    for (let j = i; j >= Math.max(0, i - 15); j--) {
      const fnMatch = /export\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(lines[j]);
      const arrowMatch = /export\s+const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?[(<]/.exec(lines[j]);

      const match = fnMatch ?? arrowMatch;
      if (match) {
        const name = match[1];
        if (!results.some((r) => r.name === name)) {
          results.push({ name, startLine: j });
        }
        break;
      }
    }
  }

  return results;
}

/** Transport-shaped callsite patterns — must appear inside the function body. */
const TRANSPORT_PATTERNS: RegExp[] = [
  /\bfetch\s*\(/,
  /\baxios\s*[.(]/,
  /\.(?:get|post|put|patch|delete)\s*\(\s*['"`]/,
  /\buseQuery\b/,
  /\buseMutation\b/,
  /\buseFetch\b/,
  /\buseInfiniteQuery\b/,
  /\$(?:get|post|put|patch|delete)\s*\(/,
  /\brequest\s*\.\s*(?:get|post|put|patch|delete)\s*\(/,
  /\bhttpClient\s*[.(]/,
  /\bapiClient\s*[.(]/,
];

/**
 * Stage B — scan the function body window (next 50 lines from the declaration)
 * for at least one transport-shaped callsite.  Returns true if any pattern matches.
 */
function hasTransportCallsite(lines: string[], fnStartLine: number): boolean {
  const windowEnd = Math.min(lines.length, fnStartLine + 50);
  for (let k = fnStartLine; k < windowEnd; k++) {
    if (TRANSPORT_PATTERNS.some((re) => re.test(lines[k]))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Artifact role classification
// ---------------------------------------------------------------------------

/**
 * Explicit artifact roles for TS/JS files.
 *
 * - generated-client: strong code-generation evidence (header, /generated/ dir)
 * - schema-derived: structurally downstream of schema/contract generation
 * - handwritten-wrapper: manually written transport wrapper — consumer-side
 * - ordinary-service: general utility/service with no artifact evidence
 */
export type ArtifactRole = 'generated-client' | 'schema-derived' | 'handwritten-wrapper' | 'ordinary-service';

/** Matches generation markers in file headers (first ~1 000 chars). */
const GENERATION_HEADER_RE =
  /(?:@generated|auto[\s-]?generated|generated by|do not edit|auto[\s-]?generated[\s\S]{0,40}do not edit)/i;

/**
 * Classify a TS/JS file into an artifact role using multi-signal evidence.
 *
 * Precedence (highest first):
 *  1. Generation header in file content → generated-client
 *  2. Lives in /generated/ or /__generated__/ directory → generated-client
 *  3. OpenAPI/Swagger naming outside a wrapper directory → schema-derived
 *  4. Wrapper-directory location (api/, services/, hooks/, use-*) → handwritten-wrapper
 *  5. Otherwise → ordinary-service
 */
export function classifyArtifactRole(filePath: string, content: string): ArtifactRole {
  const lower = filePath.toLowerCase();

  // Signal 1: explicit generation marker in the file header
  if (GENERATION_HEADER_RE.test(content.slice(0, 1000))) {
    return 'generated-client';
  }

  // Signal 2: canonical generated-output directory
  if (lower.includes('/generated/') || lower.includes('/__generated__/')) {
    return 'generated-client';
  }

  // Signal 3: OpenAPI / Swagger artifact — strong schema-derivation cue
  const isOpenApiNaming = lower.includes('openapi') || lower.includes('swagger');
  const isInWrapperDir =
    /\/api\/|\/services\/|\/hooks\//.test(lower) || lower.includes('use-');

  if (isOpenApiNaming && !isInWrapperDir) {
    return 'schema-derived';
  }

  // Signal 4: typical wrapper-directory patterns → treat as handwritten wrapper
  // (consumer-side; do NOT receive derived_from edges)
  const isClientSuffix = lower.endsWith('.client.ts') || lower.endsWith('.client.js');
  if (isInWrapperDir || isClientSuffix) {
    return 'handwritten-wrapper';
  }

  return 'ordinary-service';
}
