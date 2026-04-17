// Laravel routes resolver.
//
// Detects cross-language bridges between Laravel PHP routes and
// TypeScript/JavaScript frontend consumers.
//
// Bridges detected in this round:
//   - named route → controller action  (maps_route_to_consumer)
//   - route helper usage → route name  (calls_endpoint)
//   - API callsite → route manifest entry  (calls_endpoint)

import type { AssociationContext, AssociationResolver, StructuralRelationEdge } from '../types.js';
import { routeNodeId, fileNodeId } from '../types.js';

// ---------------------------------------------------------------------------
// Heuristics and patterns
// ---------------------------------------------------------------------------

/** Patterns that suggest a TypeScript file consumes a Laravel API route. */
const API_CALL_PATTERNS = [
  /axios\.(get|post|put|patch|delete)\(['"`](\/api\/[^'"`]+)/gi,
  /fetch\(['"`](\/api\/[^'"`]+)/gi,
  /useFetch\(['"`](\/api\/[^'"`]+)/gi,
  /useQuery\([^,]+,\s*['"`](\/api\/[^'"`]+)/gi,
];

/** Pattern to detect PHP route definitions. */
const PHP_ROUTE_PATTERN = /Route::(get|post|put|patch|delete|any)\(['"]([^'"]+)['"]/gi;

// ---------------------------------------------------------------------------
// LaravelRoutesResolver
// ---------------------------------------------------------------------------

export class LaravelRoutesResolver implements AssociationResolver {
  readonly name = 'laravel-routes';

  supports(context: AssociationContext): boolean {
    // Applicable if the workspace has PHP files and TypeScript/JavaScript files
    const hasPhp = context.entries.some((e) => e.languageId === 'php');
    const hasTs = context.entries.some(
      (e) => e.languageId === 'typescript' || e.languageId === 'javascript'
    );
    return hasPhp && hasTs;
  }

  resolve(context: AssociationContext): Promise<StructuralRelationEdge[]> {
    const edges: StructuralRelationEdge[] = [];
    const now = Math.floor(Date.now() / 1000);

    // 1. Extract PHP route definitions
    const phpRoutes = extractPhpRoutes(context);

    // 2. Find TypeScript/JS API callsites and match against PHP routes
    const tsCallsites = extractTsApiCallsites(context);

    for (const callsite of tsCallsites) {
      const matchedRoute = findMatchingRoute(callsite.apiPath, phpRoutes);
      if (!matchedRoute) continue;

      const edgeId = `${callsite.fileId}→${matchedRoute.routeNodeId}:calls_endpoint`;
      edges.push({
        id: edgeId,
        edgeType: 'calls_endpoint',
        sourceNodeId: callsite.fileId,
        targetNodeId: matchedRoute.routeNodeId,
        sourceLanguage: callsite.language,
        targetLanguage: 'php',
        confidence: matchedRoute.confidence,
        confidenceClass: matchedRoute.confidence >= 0.8 ? 'framework-inferred' : 'heuristic',
        provenance: {
          resolver: this.name,
          evidenceKind: 'api-callsite-to-route',
          evidenceLocations: [
            {
              filePath: callsite.filePath,
              line: callsite.line,
              note: `${callsite.method.toUpperCase()} ${callsite.apiPath}`,
            },
            {
              filePath: matchedRoute.filePath,
              line: matchedRoute.line,
              note: `Route::${matchedRoute.method}('${matchedRoute.path}')`,
            },
          ],
          extractedAt: now,
        },
      });
    }

    return Promise.resolve(edges);
  }
}

// ---------------------------------------------------------------------------
// Internal extraction helpers
// ---------------------------------------------------------------------------

interface PhpRoute {
  routeNodeId: string;
  method: string;
  path: string;
  filePath: string;
  line: number;
  confidence: number;
}

interface TsCallsite {
  fileId: string;
  filePath: string;
  language: string;
  method: string;
  apiPath: string;
  line: number;
}

function extractPhpRoutes(context: AssociationContext): PhpRoute[] {
  const routes: PhpRoute[] = [];

  const phpEntries = context.entries.filter((e) => e.languageId === 'php');

  for (const entry of phpEntries) {
    const content = (entry.metadata?.content as string | undefined) ?? '';
    if (!content) continue;

    // Reset lastIndex for global regex
    PHP_ROUTE_PATTERN.lastIndex = 0;
    const lines = content.split('\n');

    let match: RegExpExecArray | null;
    while ((match = PHP_ROUTE_PATTERN.exec(content)) !== null) {
      const method = match[1].toLowerCase();
      const path = match[2];
      const charIndex = match.index;
      const line = content.slice(0, charIndex).split('\n').length - 1;

      routes.push({
        routeNodeId: routeNodeId(method, path),
        method,
        path,
        filePath: entry.filePath,
        line,
        confidence: 0.9,
      });

      // Avoid unused variable warning
      void lines;
    }
  }

  return routes;
}

function extractTsApiCallsites(context: AssociationContext): TsCallsite[] {
  const callsites: TsCallsite[] = [];

  const tsEntries = context.entries.filter(
    (e) => e.languageId === 'typescript' || e.languageId === 'javascript'
  );

  for (const entry of tsEntries) {
    const content = (entry.metadata?.content as string | undefined) ?? '';
    if (!content) continue;

    for (const pattern of API_CALL_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = pattern.exec(content)) !== null) {
        const method = match[1] ?? 'get';
        const apiPath = match[2];
        const line = content.slice(0, match.index).split('\n').length - 1;

        callsites.push({
          fileId: fileNodeId(toRelative(entry.filePath, context.rootPath)),
          filePath: entry.filePath,
          language: entry.languageId ?? 'typescript',
          method,
          apiPath,
          line,
        });
      }
    }
  }

  return callsites;
}

function findMatchingRoute(
  apiPath: string,
  routes: PhpRoute[]
): PhpRoute | null {
  // Exact match first
  const exact = routes.find((r) => r.path === apiPath);
  if (exact) return exact;

  // Prefix match (handle route parameters like /api/users/{id})
  const normalized = apiPath.replace(/\/\d+/g, '/{id}');
  const paramMatch = routes.find((r) => r.path === normalized || r.path.startsWith(apiPath));
  return paramMatch ?? null;
}

function toRelative(absolutePath: string, rootPath: string): string {
  if (absolutePath.startsWith(rootPath + '/')) {
    return absolutePath.slice(rootPath.length + 1);
  }
  return absolutePath;
}
