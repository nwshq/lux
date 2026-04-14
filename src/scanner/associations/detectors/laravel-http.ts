// LaravelHttpSurfaceDetector — HTTP capability declaration detector.
//
// Detects HTTP capability surfaces from Laravel route declarations.
//
// Emits:
//   - capability-surface nodes for each detected HTTP route
//   - declares_surface edge from the declaring file to each surface
//   - handled_by edge from surface to controller symbol ONLY when the
//     declaration explicitly names the controller and method
//
// Handles route groups:
//   - Route::prefix('api')->group(function () { ... })
//   - Route::group(['prefix' => 'admin'], function () { ... })
//   - Arbitrarily nested groups, composing canonical external paths
//
// Does NOT:
//   - infer controllers through naming conventions
//   - resolve consumer-side chains
//   - attach contracts or artifacts (those belong to propagation)

import type { AssociationContext, CapabilitySurfaceNode, StructuralRelationEdge } from '../types.js';
import { httpSurfaceNodeId, fileNodeId, phpSymbolNodeId } from '../types.js';
import type { CapabilitySurfaceDetector, DetectedSurfaceBatch } from './types.js';
import { emptyBatch } from './types.js';

// ---------------------------------------------------------------------------
// Regex patterns — route declarations (applied to already-scoped content)
// ---------------------------------------------------------------------------

/**
 * Matches: Route::get('/path', [Controller::class, 'method'])
 * Capture groups: 1=method, 2=path, 3=controller, 4=action
 */
const ROUTE_CONTROLLER_ARRAY = /Route::(get|post|put|patch|delete|any)\(\s*['"]([^'"]+)['"]\s*,\s*\[\s*([A-Za-z_\\]+)::class\s*,\s*['"]([^'"]+)['"]\s*\]/gi;

/**
 * Matches: Route::get('/path', InvokableController::class)
 * Capture groups: 1=method, 2=path, 3=controller
 */
const ROUTE_INVOKABLE = /Route::(get|post|put|patch|delete|any)\(\s*['"]([^'"]+)['"]\s*,\s*([A-Za-z_\\]+)::class\s*\)/gi;

/**
 * Matches: Route::get('/path', function()
 * Capture groups: 1=method, 2=path
 */
const ROUTE_CLOSURE = /Route::(get|post|put|patch|delete|any)\(\s*['"]([^'"]+)['"]\s*,\s*function\s*\(/gi;

/**
 * Matches: ->name('route.name')
 */
const ROUTE_NAME = /->name\(\s*['"]([^'"]+)['"]\s*\)/g;

// ---------------------------------------------------------------------------
// LaravelHttpSurfaceDetector
// ---------------------------------------------------------------------------

export class LaravelHttpSurfaceDetector implements CapabilitySurfaceDetector {
  readonly name = 'laravel-http-surfaces';

  supports(context: AssociationContext): boolean {
    return context.entries.some(
      (e) => e.languageId === 'php' && isRouteFile(e.filePath)
    );
  }

  async detect(context: AssociationContext): Promise<DetectedSurfaceBatch> {
    try {
      return this.detectSync(context);
    } catch {
      return emptyBatch();
    }
  }

  private detectSync(context: AssociationContext): DetectedSurfaceBatch {
    const surfaces: CapabilitySurfaceNode[] = [];
    const edges: StructuralRelationEdge[] = [];
    const now = Math.floor(Date.now() / 1000);

    const routeEntries = context.entries.filter(
      (e) => e.languageId === 'php' && isRouteFile(e.filePath)
    );

    for (const entry of routeEntries) {
      const content = (entry.metadata?.content as string | undefined) ?? '';
      if (!content) continue;

      const fileId = fileNodeId(entry.filePath);
      const detectedRoutes = parseRouteDeclarations(content, entry.filePath);

      for (const route of detectedRoutes) {
        const surfaceId = httpSurfaceNodeId(route.method, route.path);
        const handle = `${route.method.toUpperCase()} ${route.path}`;

        const surfaceNode: CapabilitySurfaceNode = {
          id: surfaceId,
          handle,
          transport: 'http',
          file_path: entry.filePath,
          metadata: {
            transport: 'http',
            method: route.method.toUpperCase(),
            path: route.path,
            localFragment: route.localFragment,
            routeName: route.routeName,
            aliases: route.routeName ? [route.routeName] : undefined,
            explicitProvider: route.controllerQualifiedName,
            controllerMethod: route.controllerMethod,
            declarationLineage: route.declarationLineage.length > 0
              ? route.declarationLineage
              : undefined,
          },
          updated_at: now,
        };
        surfaces.push(surfaceNode);

        // declares_surface: route file → surface
        const declEdgeId = `${fileId}→${surfaceId}:declares_surface`;
        edges.push({
          id: declEdgeId,
          edgeType: 'declares_surface',
          sourceNodeId: fileId,
          targetNodeId: surfaceId,
          sourceLanguage: 'php',
          confidence: 0.95,
          confidenceClass: 'framework-inferred',
          provenance: {
            resolver: this.name,
            evidenceKind: 'route-declaration',
            evidenceLocations: [
              {
                filePath: entry.filePath,
                line: route.line,
                note: `Route::${route.method}('${route.localFragment}')${
                  route.declarationLineage.length > 0
                    ? ` [group: ${route.declarationLineage.join(' / ')}]`
                    : ''
                }`,
              },
            ],
            extractedAt: now,
          },
        });

        // handled_by: surface → controller symbol (only when explicitly declared)
        if (route.controllerQualifiedName) {
          const providerSymbolId = buildProviderSymbolId(
            route.controllerQualifiedName,
            route.controllerMethod
          );
          const handledEdgeId = `${surfaceId}→${providerSymbolId}:handled_by`;
          edges.push({
            id: handledEdgeId,
            edgeType: 'handled_by',
            sourceNodeId: surfaceId,
            targetNodeId: providerSymbolId,
            targetLanguage: 'php',
            confidence: 0.95,
            confidenceClass: 'framework-inferred',
            provenance: {
              resolver: this.name,
              evidenceKind: 'explicit-controller-reference',
              evidenceLocations: [
                {
                  filePath: entry.filePath,
                  line: route.line,
                  note: route.controllerMethod
                    ? `[${route.controllerQualifiedName}::class, '${route.controllerMethod}']`
                    : `${route.controllerQualifiedName}::class`,
                },
              ],
              extractedAt: now,
            },
          });
        }
      }
    }

    return { surfaces, edges };
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ParsedRoute {
  method: string;
  /** Fully composed canonical external path (includes group prefixes). */
  path: string;
  /** Local path fragment as written in the declaration. */
  localFragment: string;
  line: number;
  /** Fully-qualified controller class name, if explicit. */
  controllerQualifiedName?: string;
  /** Controller method name (e.g. 'index'), if explicit. */
  controllerMethod?: string;
  /** Named route, if declared. */
  routeName?: string;
  /** Ancestor group prefixes, outermost first. */
  declarationLineage: string[];
}

interface GroupBlock {
  /** The prefix contributed by this group (may be empty string). */
  prefix: string;
  /** Character index of first char inside the opening '{'. */
  innerStart: number;
  /** Character index just before the closing '}'. */
  innerEnd: number;
}

// ---------------------------------------------------------------------------
// Public parser entry point
// ---------------------------------------------------------------------------

/**
 * Parse all route declarations from PHP file content, handling nested route groups.
 */
function parseRouteDeclarations(content: string, _filePath: string): ParsedRoute[] {
  return parseBlockContent(content, [], 0, content);
}

// ---------------------------------------------------------------------------
// Recursive block parser
// ---------------------------------------------------------------------------

/**
 * Recursively parse a block of PHP content for route declarations.
 *
 * @param block - The content of this block (may be a group interior).
 * @param prefixStack - Accumulated group prefixes from ancestor groups.
 * @param blockOffset - Character offset of `block` within the root content.
 * @param rootContent - The full file content (used for line number calculation).
 */
function parseBlockContent(
  block: string,
  prefixStack: string[],
  blockOffset: number,
  rootContent: string
): ParsedRoute[] {
  const routes: ParsedRoute[] = [];

  // 1. Find top-level group blocks within this block
  const topLevelGroups = findTopLevelGroupBlocks(block);

  // 2. Mask group interiors so route regexes don't match inside them
  const masked = maskGroupInteriors(block, topLevelGroups);

  // 3. Parse direct routes from masked content
  routes.push(
    ...parseDirectRoutes(masked, prefixStack, blockOffset, rootContent)
  );

  // 4. Recurse into each group block with the composed prefix stack
  for (const group of topLevelGroups) {
    const innerBlock = block.slice(group.innerStart, group.innerEnd);
    const newPrefixStack =
      group.prefix ? [...prefixStack, group.prefix] : [...prefixStack];
    const innerRoutes = parseBlockContent(
      innerBlock,
      newPrefixStack,
      blockOffset + group.innerStart,
      rootContent
    );
    routes.push(...innerRoutes);
  }

  return routes;
}

// ---------------------------------------------------------------------------
// Group block detection
// ---------------------------------------------------------------------------

/**
 * Find all top-level group blocks in a content string.
 * "Top-level" means not inside another group block found in this call.
 * Nested groups are returned when `parseBlockContent` recurses.
 */
function findTopLevelGroupBlocks(content: string): GroupBlock[] {
  const blocks: GroupBlock[] = [];
  let pos = 0;

  while (pos < content.length) {
    const opener = findNextGroupOpener(content, pos);
    if (!opener) break;

    // Find the opening brace after the 'function ...' part
    const bracePos = content.indexOf('{', opener.chainEndPos);
    if (bracePos < 0) break;

    // Find the matching closing brace
    const closePos = findMatchingBrace(content, bracePos);
    if (closePos < 0) break;

    blocks.push({
      prefix: opener.prefix,
      innerStart: bracePos + 1,
      innerEnd: closePos,
    });

    // Skip past the entire group block to avoid re-matching inner groups
    pos = closePos + 1;
  }

  return blocks;
}

interface GroupOpenerResult {
  /** Start position of the Route:: chain (or the ->group for chain openers). */
  openerPos: number;
  /** Position immediately after the 'function (...)' or 'function()' token. */
  chainEndPos: number;
  /** The prefix string extracted from the group declaration. */
  prefix: string;
}

/**
 * Find the next group opener starting at `fromPos`.
 * Handles two patterns:
 *   A) Route::...->prefix('x')->...->group(function () { ... })
 *   B) Route::group(['prefix' => 'x'], function () { ... })
 */
function findNextGroupOpener(content: string, fromPos: number): GroupOpenerResult | null {
  // Pattern A: any ->group(function
  const CHAIN_GROUP_RE = /->group\s*\(\s*function\s*\([^)]*\)\s*(?:use\s*\([^)]*\)\s*)?/g;
  CHAIN_GROUP_RE.lastIndex = fromPos;

  // Pattern B: Route::group([...options...], function
  const DIRECT_GROUP_RE = /Route::group\s*\(\s*\[([^\]]*)\]\s*,\s*function\s*\([^)]*\)\s*(?:use\s*\([^)]*\)\s*)?/g;
  DIRECT_GROUP_RE.lastIndex = fromPos;

  const chainMatch = CHAIN_GROUP_RE.exec(content);
  const directMatch = DIRECT_GROUP_RE.exec(content);

  const useChain =
    chainMatch !== null &&
    (directMatch === null || chainMatch.index <= directMatch.index);

  if (useChain && chainMatch) {
    const prefix = extractPrefixFromChainBefore(content, chainMatch.index);
    return {
      openerPos: chainMatch.index,
      chainEndPos: chainMatch.index + chainMatch[0].length,
      prefix,
    };
  }

  if (directMatch) {
    const prefix = extractPrefixFromArrayOptions(directMatch[1]);
    return {
      openerPos: directMatch.index,
      chainEndPos: directMatch.index + directMatch[0].length,
      prefix,
    };
  }

  return null;
}

/**
 * Scan backward from `beforePos` in `content` to find a ->prefix('...')
 * in the Route:: chain that precedes a ->group( call.
 *
 * Scans back up to 500 characters to find the relevant Route:: chain.
 */
function extractPrefixFromChainBefore(content: string, beforePos: number): string {
  const SCAN_BACK = 500;
  const start = Math.max(0, beforePos - SCAN_BACK);
  const chunk = content.slice(start, beforePos);

  // Find the last Route:: in the chunk — that starts the chain
  const routeIdx = chunk.lastIndexOf('Route::');
  const chainText = routeIdx >= 0 ? chunk.slice(routeIdx) : chunk;

  // Look for ::prefix('...') or ->prefix('...') in the chain
  const prefixMatch = /(?:^|->|::)prefix\s*\(\s*['"]([^'"]*)['"]\s*\)/.exec(chainText);
  if (prefixMatch) return normalizePathFragment(prefixMatch[1]);

  return '';
}

/**
 * Extract a 'prefix' value from a Route::group options array string.
 * Input example: `'prefix' => 'admin', 'middleware' => ['auth']`
 */
function extractPrefixFromArrayOptions(optionsText: string): string {
  const match = /['"]prefix['"]\s*=>\s*['"]([^'"]+)['"]/.exec(optionsText);
  return match ? normalizePathFragment(match[1]) : '';
}

/**
 * Find the position of the closing brace matching the '{' at `openPos`.
 * Returns -1 if no match is found.
 */
function findMatchingBrace(content: string, openPos: number): number {
  let depth = 1;
  let i = openPos + 1;

  while (i < content.length && depth > 0) {
    const ch = content[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }

  return depth === 0 ? i - 1 : -1;
}

/**
 * Replace the interior of each group block with spaces, preserving character positions.
 * This prevents route regexes from matching routes inside nested groups at the
 * current level (they will be handled by the recursive pass instead).
 */
function maskGroupInteriors(content: string, groups: GroupBlock[]): string {
  if (groups.length === 0) return content;

  const chars = content.split('');
  for (const g of groups) {
    for (let i = g.innerStart; i < g.innerEnd && i < chars.length; i++) {
      chars[i] = ' ';
    }
  }
  return chars.join('');
}

// ---------------------------------------------------------------------------
// Direct route extraction
// ---------------------------------------------------------------------------

/**
 * Apply the three route declaration regexes to already-scoped/masked content.
 *
 * @param masked - Content with group interiors blanked out.
 * @param prefixStack - Current group prefix stack (outermost first).
 * @param blockOffset - Character offset of `masked` within root content.
 * @param rootContent - Full file content (for line calculation).
 */
function parseDirectRoutes(
  masked: string,
  prefixStack: string[],
  blockOffset: number,
  rootContent: string
): ParsedRoute[] {
  const routes: ParsedRoute[] = [];

  function lineFor(localCharIndex: number): number {
    const absIndex = blockOffset + localCharIndex;
    return rootContent.slice(0, absIndex).split('\n').length - 1;
  }

  function routeNameFor(localIndex: number): string | undefined {
    const lineText = rootContent.split('\n')[lineFor(localIndex)] ?? '';
    ROUTE_NAME.lastIndex = 0;
    const m = ROUTE_NAME.exec(lineText);
    return m ? m[1] : undefined;
  }

  function composedPath(localFragment: string): string {
    return composeCanonicalPath(prefixStack, localFragment);
  }

  // Controller array routes
  ROUTE_CONTROLLER_ARRAY.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ROUTE_CONTROLLER_ARRAY.exec(masked)) !== null) {
    const fragment = m[2];
    routes.push({
      method: m[1].toLowerCase(),
      path: composedPath(fragment),
      localFragment: fragment,
      line: lineFor(m.index),
      controllerQualifiedName: m[3],
      controllerMethod: m[4],
      routeName: routeNameFor(m.index),
      declarationLineage: [...prefixStack],
    });
  }

  // Invokable controller routes
  ROUTE_INVOKABLE.lastIndex = 0;
  while ((m = ROUTE_INVOKABLE.exec(masked)) !== null) {
    const fragment = m[2];
    const lineNum = lineFor(m.index);
    const alreadyCaptured = routes.some(
      (r) => Math.abs(r.line - lineNum) < 2 && r.localFragment === fragment
    );
    if (alreadyCaptured) continue;

    routes.push({
      method: m[1].toLowerCase(),
      path: composedPath(fragment),
      localFragment: fragment,
      line: lineNum,
      controllerQualifiedName: m[3],
      controllerMethod: undefined,
      routeName: routeNameFor(m.index),
      declarationLineage: [...prefixStack],
    });
  }

  // Closure routes
  ROUTE_CLOSURE.lastIndex = 0;
  while ((m = ROUTE_CLOSURE.exec(masked)) !== null) {
    const fragment = m[2];
    const lineNum = lineFor(m.index);
    const alreadyCaptured = routes.some(
      (r) => Math.abs(r.line - lineNum) < 2 && r.localFragment === fragment
    );
    if (alreadyCaptured) continue;

    routes.push({
      method: m[1].toLowerCase(),
      path: composedPath(fragment),
      localFragment: fragment,
      line: lineNum,
      declarationLineage: [...prefixStack],
    });
  }

  return routes;
}

// ---------------------------------------------------------------------------
// Path composition helpers
// ---------------------------------------------------------------------------

/**
 * Compose a canonical external path from a group prefix stack and a local fragment.
 *
 * Rules:
 *   - Prefixes are joined in order, each separated by '/'
 *   - Leading slashes are normalized (exactly one at the start of the full path)
 *   - Trailing slashes are stripped unless the path is just '/'
 */
function composeCanonicalPath(prefixStack: string[], localFragment: string): string {
  const segments = [...prefixStack, localFragment]
    .map((s) => normalizePathFragment(s))
    .filter((s) => s.length > 0);

  if (segments.length === 0) return '/';

  const joined = segments.join('/').replace(/\/+/g, '/');
  const withLeading = joined.startsWith('/') ? joined : '/' + joined;
  return withLeading.length > 1 && withLeading.endsWith('/')
    ? withLeading.slice(0, -1)
    : withLeading;
}

/**
 * Strip leading and trailing slashes from a path fragment for consistent joining.
 */
function normalizePathFragment(fragment: string): string {
  return fragment.replace(/^\/+|\/+$/g, '');
}

// ---------------------------------------------------------------------------
// Existing helpers
// ---------------------------------------------------------------------------

/**
 * Build a PHP symbol node ID for a controller.
 *
 * Always targets the class-level node (e.g. `symbol:php:CalendarController`)
 * so `handled_by` edges resolve to nodes that the materializer actually
 * persists.  The specific method is preserved in surface metadata
 * (`controllerMethod`) and edge provenance for propagation use.
 */
function buildProviderSymbolId(qualifiedName: string, _method?: string): string {
  return phpSymbolNodeId(qualifiedName);
}

/**
 * Heuristic to identify Laravel route files.
 */
function isRouteFile(filePath: string): boolean {
  return /(^|\/)routes\/.+\.php$/i.test(filePath) || /routes\.php$/i.test(filePath);
}
