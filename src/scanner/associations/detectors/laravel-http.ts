// LaravelHttpSurfaceDetector — first HTTP capability declaration detector.
//
// Detects HTTP capability surfaces from Laravel route declarations.
//
// Emits:
//   - capability-surface nodes for each detected HTTP route
//   - declares_surface edge from the declaring file to each surface
//   - handled_by edge from surface to controller symbol ONLY when the
//     declaration explicitly names the controller and method
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
// Regex patterns
// ---------------------------------------------------------------------------

/**
 * Matches: Route::get('/path', [Controller::class, 'method'])
 *          Route::post('/path', [Controller::class, 'method'])
 * Capture groups: 1=method, 2=path, 3=controller (optional), 4=action (optional)
 */
const ROUTE_CONTROLLER_ARRAY = /Route::(get|post|put|patch|delete|any)\(\s*['"]([^'"]+)['"]\s*,\s*\[\s*([A-Za-z_\\]+)::class\s*,\s*['"]([^'"]+)['"]\s*\]/gi;

/**
 * Matches: Route::get('/path', InvokableController::class)
 * Capture groups: 1=method, 2=path, 3=controller
 */
const ROUTE_INVOKABLE = /Route::(get|post|put|patch|delete|any)\(\s*['"]([^'"]+)['"]\s*,\s*([A-Za-z_\\]+)::class\s*\)/gi;

/**
 * Matches: Route::get('/path', function() or Route::get('/path', ...) without explicit controller
 * Used to detect closure routes (no explicit provider).
 */
const ROUTE_CLOSURE = /Route::(get|post|put|patch|delete|any)\(\s*['"]([^'"]+)['"]\s*,\s*function\s*\(/gi;

/**
 * Matches: ->name('route.name') after a Route:: declaration
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
            routeName: route.routeName,
            aliases: route.routeName ? [route.routeName] : undefined,
            explicitProvider: route.controllerQualifiedName,
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
                note: `Route::${route.method}('${route.path}')`,
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
// Internal types and helpers
// ---------------------------------------------------------------------------

interface ParsedRoute {
  method: string;
  path: string;
  line: number;
  /** Fully-qualified controller class name, if explicit. */
  controllerQualifiedName?: string;
  /** Controller method name (e.g. 'index'), if explicit. */
  controllerMethod?: string;
  /** Named route, if declared. */
  routeName?: string;
}

/**
 * Parse all route declarations from PHP file content.
 */
function parseRouteDeclarations(content: string, _filePath: string): ParsedRoute[] {
  const routes: ParsedRoute[] = [];
  const lines = content.split('\n');

  // Helper: get 0-based line number for a char offset
  function lineFor(charIndex: number): number {
    return content.slice(0, charIndex).split('\n').length - 1;
  }

  // Controller array routes: Route::get('/path', [Controller::class, 'method'])
  ROUTE_CONTROLLER_ARRAY.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ROUTE_CONTROLLER_ARRAY.exec(content)) !== null) {
    const lineText = lines[lineFor(m.index)] ?? '';
    routes.push({
      method: m[1].toLowerCase(),
      path: m[2],
      line: lineFor(m.index),
      controllerQualifiedName: m[3],
      controllerMethod: m[4],
      routeName: extractRouteName(lineText),
    });
  }

  // Invokable controller routes: Route::get('/path', Controller::class)
  ROUTE_INVOKABLE.lastIndex = 0;
  while ((m = ROUTE_INVOKABLE.exec(content)) !== null) {
    // Skip if already captured by controller array pattern (same offset range)
    const alreadyCaptured = routes.some(
      (r) => Math.abs(r.line - lineFor(m!.index)) < 2 && r.path === m![2]
    );
    if (alreadyCaptured) continue;

    const lineText = lines[lineFor(m.index)] ?? '';
    routes.push({
      method: m[1].toLowerCase(),
      path: m[2],
      line: lineFor(m.index),
      controllerQualifiedName: m[3],
      controllerMethod: undefined, // invokable — no explicit method
      routeName: extractRouteName(lineText),
    });
  }

  // Closure routes: Route::get('/path', function() — no explicit provider
  ROUTE_CLOSURE.lastIndex = 0;
  while ((m = ROUTE_CLOSURE.exec(content)) !== null) {
    const alreadyCaptured = routes.some(
      (r) => Math.abs(r.line - lineFor(m!.index)) < 2 && r.path === m![2]
    );
    if (alreadyCaptured) continue;

    routes.push({
      method: m[1].toLowerCase(),
      path: m[2],
      line: lineFor(m.index),
    });
  }

  return routes;
}

/**
 * Extract a named route from a line like:
 * Route::get('/path', ...)->name('route.name');
 */
function extractRouteName(lineText: string): string | undefined {
  ROUTE_NAME.lastIndex = 0;
  const m = ROUTE_NAME.exec(lineText);
  return m ? m[1] : undefined;
}

/**
 * Build a PHP symbol node ID for a controller + optional method.
 * Uses the phpSymbolNodeId convention: `symbol:php:QualifiedName`.
 */
function buildProviderSymbolId(qualifiedName: string, method?: string): string {
  if (method) {
    return phpSymbolNodeId(`${qualifiedName}@${method}`);
  }
  return phpSymbolNodeId(qualifiedName);
}

/**
 * Heuristic to identify Laravel route files.
 * Targets routes/api.php, routes/web.php, and any PHP file under a routes/ directory.
 * Works with both absolute and relative paths.
 */
function isRouteFile(filePath: string): boolean {
  return /(^|\/)routes\/.+\.php$/i.test(filePath) || /routes\.php$/i.test(filePath);
}
