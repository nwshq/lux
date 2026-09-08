import type { ProjectResolutionContextV1 } from '../../contracts/program.js';
import { reactComponentId } from '../../identity/program-identity.js';
import { frameworkEdge } from '../../react/edge-factory.js';
import { resolveReactNavigationActions } from './actions.js';
import { resolveReactNavigationNavigators, screenId } from './navigators.js';
import type {
  ReactNavigationFactV1,
  ReactNavigationRelationshipResolverV1,
  ReactNavigationResolutionResultV1,
} from './types.js';

export class ReactNavigationRelationshipResolver implements ReactNavigationRelationshipResolverV1 {
  resolve(
    facts: readonly ReactNavigationFactV1[],
    _project: ProjectResolutionContextV1
  ): Promise<ReactNavigationResolutionResultV1> {
    const graph = resolveReactNavigationNavigators(facts);
    const actions = resolveReactNavigationActions(facts, graph);
    const navigatorByKey = new Map(
      graph.navigators.map((item) => [`${item.filePath}\0${item.localName}`, item])
    );
    const registrationEdges = graph.screens.flatMap((screen) => {
      if (!screen.component) return [];
      const id = screenId(screen, navigatorByKey);
      return [
        frameworkEdge({
          resolver: 'react-navigation-screen',
          edgeType: 'handled_by',
          sourceNodeId: id,
          targetNodeId: reactComponentId(screen.component.filePath, screen.component.exportName),
          sourceLanguage: languageFor(screen.filePath),
          targetLanguage: languageFor(screen.component.filePath),
          confidence: 0.95,
          confidenceClass: 'framework-inferred',
          evidenceKind: 'react-navigation-static-screen',
          locations: [screen.location, screen.component.declaration],
        }),
      ];
    });
    return Promise.resolve({
      nodes: graph.nodes,
      edges: [...registrationEdges, ...actions.edges].sort((a, b) => a.id.localeCompare(b.id)),
      diagnostics: [...graph.diagnostics, ...actions.diagnostics],
    });
  }
}

function languageFor(filePath: string): 'typescript' | 'javascript' {
  return /\.[cm]?tsx?$/u.test(filePath) && !/\.[cm]?jsx?$/u.test(filePath)
    ? 'typescript'
    : 'javascript';
}
