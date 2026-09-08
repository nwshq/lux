import type { SourceDiagnosticV1 } from '../../contracts/program.js';
import { reactComponentId } from '../../identity/program-identity.js';
import { frameworkEdge } from '../../react/edge-factory.js';
import type { FrameworkNodeV1 } from '../../react/types.js';
import { discoverExpoRoutes } from './file-routes.js';
import { extractExpoDestinations } from './navigation.js';
import type {
  ExpoRouteV1,
  ExpoRouterAnalyzerV1,
  ExpoRouterInputV1,
  ExpoRouterResultV1,
} from './types.js';

export class ExpoRouterAnalyzer implements ExpoRouterAnalyzerV1 {
  analyze(input: ExpoRouterInputV1): Promise<ExpoRouterResultV1> {
    const discovered = discoverExpoRoutes(input);
    const sources = input.sources ?? new Map<string, string>();
    const destinations = discovered.routes.flatMap((route) => {
      const source = sources.get(route.filePath);
      return source
        ? extractExpoDestinations(route.filePath, source, discovered.routes).destinations
        : [];
    });
    const diagnostics: SourceDiagnosticV1[] = [
      ...discovered.diagnostics,
      ...discovered.routes.flatMap((route) => {
        const source = sources.get(route.filePath);
        return source
          ? extractExpoDestinations(route.filePath, source, discovered.routes).diagnostics
          : [];
      }),
    ];
    const nodes = discovered.routes.map(routeNode);
    const edges = [];
    for (const route of discovered.routes) {
      const component = reactComponentId(route.filePath, 'default');
      edges.push(
        frameworkEdge({
          resolver: 'expo-router',
          edgeType: 'handled_by',
          sourceNodeId: route.id,
          targetNodeId: component,
          sourceLanguage: 'expo',
          targetLanguage: language(route.filePath),
          confidence: 0.95,
          confidenceClass: 'framework-inferred',
          evidenceKind: 'expo-file-route',
          locations: [route.location],
        })
      );
      for (const layoutPath of route.layouts)
        edges.push(
          frameworkEdge({
            resolver: 'expo-router',
            edgeType: 'renders_component',
            sourceNodeId: reactComponentId(layoutPath, 'default'),
            targetNodeId: component,
            sourceLanguage: language(layoutPath),
            targetLanguage: language(route.filePath),
            confidence: 0.95,
            confidenceClass: 'framework-inferred',
            evidenceKind: 'expo-layout-lineage',
            locations: [{ filePath: layoutPath, line: 1, column: 0 }, route.location],
          })
        );
    }
    for (const destination of destinations) {
      const owner = discovered.routes.find(
        (route) => route.filePath === destination.location.filePath
      );
      const target = discovered.routes.find(
        (route) => route.kind === 'route' && route.canonicalPath === destination.pathname
      );
      if (owner && target)
        edges.push(
          frameworkEdge({
            resolver: 'expo-router',
            edgeType: 'navigates_to',
            sourceNodeId: reactComponentId(owner.filePath, 'default'),
            targetNodeId: target.id,
            sourceLanguage: language(owner.filePath),
            targetLanguage: 'expo',
            confidence: 0.95,
            confidenceClass: 'framework-inferred',
            evidenceKind: `expo-${destination.source}`,
            locations: [destination.location, target.location],
          })
        );
    }
    return Promise.resolve({
      routes: discovered.routes,
      destinations,
      nodes: nodes.sort((a, b) => a.id.localeCompare(b.id)),
      edges: edges.sort((a, b) => a.id.localeCompare(b.id)),
      dependencies: [...new Set([...input.files, ...input.project.fingerprintInputs])].sort(),
      diagnostics: diagnostics.sort(
        (a, b) =>
          (a.location?.filePath ?? '').localeCompare(b.location?.filePath ?? '') ||
          (a.location?.line ?? 0) - (b.location?.line ?? 0) ||
          a.code.localeCompare(b.code)
      ),
    });
  }
}
function routeNode(route: ExpoRouteV1): FrameworkNodeV1 {
  return {
    id: route.id,
    type: 'capability-surface',
    name: route.canonicalPath,
    filePath: route.filePath,
    languageId: language(route.filePath),
    metadata: {
      framework: 'expo-router',
      filePath: route.filePath,
      groups: route.groups,
      params: route.params,
      layouts: route.layouts,
      kind: route.kind,
    },
  };
}
function language(path: string): 'typescript' | 'javascript' {
  return /\.[cm]?tsx?$/u.test(path) ? 'typescript' : 'javascript';
}
