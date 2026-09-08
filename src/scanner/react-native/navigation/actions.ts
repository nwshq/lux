import { reactComponentId } from '../../identity/program-identity.js';
import { frameworkEdge } from '../../react/edge-factory.js';
import type { SourceDiagnosticV1 } from '../../contracts/program.js';
import type { ReactNavigationGraphV1 } from './navigators.js';
import { screenId } from './navigators.js';
import type {
  NavigationComponentV1,
  ReactNavigationActionFactV1,
  ReactNavigationFactV1,
  ReactNavigationNavigatorFactV1,
  ReactNavigationScreenFactV1,
} from './types.js';

export interface ReactNavigationActionResolutionV1 {
  edges: ReturnType<typeof frameworkEdge>[];
  diagnostics: SourceDiagnosticV1[];
}

/** Resolve static actions only when navigator scope identifies one exact screen path. */
export function resolveReactNavigationActions(
  facts: readonly ReactNavigationFactV1[],
  graph: ReactNavigationGraphV1
): ReactNavigationActionResolutionV1 {
  const diagnostics: SourceDiagnosticV1[] = [];
  const navigatorByKey = new Map(
    graph.navigators.map((item) => [`${item.filePath}\0${item.localName}`, item])
  );
  const grouped = new Map<
    string,
    {
      action: ReactNavigationActionFactV1;
      target: ReactNavigationScreenFactV1;
      uses: ReactNavigationActionFactV1[];
    }
  >();
  for (const action of facts
    .filter((fact): fact is ReactNavigationActionFactV1 => fact.kind === 'react-navigation-action')
    .sort(compareAction)) {
    const resolution = resolveActionPath(action, graph);
    if (resolution.status !== 'resolved') {
      diagnostics.push({
        code:
          resolution.status === 'ambiguous'
            ? 'REACT_NAVIGATION_AMBIGUOUS_ACTION'
            : 'REACT_NAVIGATION_UNRESOLVED_ACTION',
        message: `Cannot resolve ${action.method}(${action.routePath.join(' > ')}): ${resolution.detail}.`,
        location: action.location,
      });
      continue;
    }
    const targetId = screenId(resolution.target, navigatorByKey);
    const sourceId = reactComponentId(action.owner.filePath, action.owner.exportName);
    const key = `${sourceId}\0${targetId}`;
    const existing = grouped.get(key);
    if (existing) existing.uses.push(action);
    else grouped.set(key, { action, target: resolution.target, uses: [action] });
  }

  return {
    edges: [...grouped.values()]
      .map(({ action, target, uses }) =>
        frameworkEdge({
          resolver: 'react-navigation-action',
          edgeType: 'navigates_to',
          sourceNodeId: reactComponentId(action.owner.filePath, action.owner.exportName),
          targetNodeId: screenId(target, navigatorByKey),
          sourceLanguage: languageFor(action.owner.filePath),
          targetLanguage: languageFor(target.filePath),
          confidence: 0.95,
          confidenceClass: 'framework-inferred',
          evidenceKind: 'react-navigation-static-action',
          locations: [
            action.owner.declaration,
            target.location,
            ...uses.map((item) => item.location),
          ],
        })
      )
      .sort((left, right) => left.id.localeCompare(right.id)),
    diagnostics,
  };
}

type ActionResolution =
  | { status: 'resolved'; target: ReactNavigationScreenFactV1 }
  | { status: 'ambiguous' | 'unresolved'; detail: string };

function resolveActionPath(
  action: ReactNavigationActionFactV1,
  graph: ReactNavigationGraphV1
): ActionResolution {
  let candidates = firstScreenCandidates(action.owner, action.routePath[0], graph);
  if (candidates.length !== 1)
    return failure(
      candidates.length,
      `route ${action.routePath[0]} has ${candidates.length} exact scoped matches`
    );
  let target = candidates[0];
  for (const segment of action.routePath.slice(1)) {
    if (!target.component)
      return {
        status: 'unresolved',
        detail: `route ${target.name} has no exact nested navigator component`,
      };
    const childNavigators = navigatorsOwnedBy(target.component, graph.navigators);
    candidates = graph.screens.filter(
      (screen) =>
        screen.name === segment &&
        childNavigators.some(
          (navigator) =>
            navigator.filePath === screen.filePath &&
            navigator.localName === screen.navigatorLocalName
        )
    );
    if (candidates.length !== 1)
      return failure(
        candidates.length,
        `nested route ${segment} has ${candidates.length} exact scoped matches`
      );
    target = candidates[0];
  }
  return { status: 'resolved', target };
}

function firstScreenCandidates(
  owner: NavigationComponentV1,
  name: string,
  graph: ReactNavigationGraphV1
): ReactNavigationScreenFactV1[] {
  const ownerScreens = graph.screens.filter((screen) => sameComponent(screen.component, owner));
  if (ownerScreens.length) {
    const parentKeys = new Set(
      ownerScreens.map((screen) => `${screen.filePath}\0${screen.navigatorLocalName}`)
    );
    return graph.screens.filter(
      (screen) =>
        name === screen.name && parentKeys.has(`${screen.filePath}\0${screen.navigatorLocalName}`)
    );
  }

  const ownedNavigators = navigatorsOwnedBy(owner, graph.navigators);
  if (ownedNavigators.length) {
    return graph.screens.filter(
      (screen) =>
        screen.name === name &&
        ownedNavigators.some(
          (navigator) =>
            navigator.filePath === screen.filePath &&
            navigator.localName === screen.navigatorLocalName
        )
    );
  }
  // A component outside navigator declarations can only navigate when the route name is globally
  // unique. This is intentionally conservative rather than guessing a root container.
  return graph.screens.filter((screen) => screen.name === name);
}

function navigatorsOwnedBy(
  component: NavigationComponentV1,
  navigators: readonly ReactNavigationNavigatorFactV1[]
): ReactNavigationNavigatorFactV1[] {
  return navigators.filter((navigator) => sameComponent(navigator.owner, component));
}

function sameComponent(
  left: NavigationComponentV1 | undefined,
  right: NavigationComponentV1 | undefined
): boolean {
  return Boolean(
    left &&
    right &&
    left.filePath === right.filePath &&
    left.exportName === right.exportName &&
    left.localName === right.localName
  );
}

function failure(count: number, detail: string): ActionResolution {
  return { status: count > 1 ? 'ambiguous' : 'unresolved', detail };
}

function compareAction(
  left: ReactNavigationActionFactV1,
  right: ReactNavigationActionFactV1
): number {
  return [left.filePath, left.location.line, left.location.column, left.method]
    .join('\0')
    .localeCompare(
      [right.filePath, right.location.line, right.location.column, right.method].join('\0')
    );
}

function languageFor(filePath: string): 'typescript' | 'javascript' {
  return /\.[cm]?tsx?$/u.test(filePath) && !/\.[cm]?jsx?$/u.test(filePath)
    ? 'typescript'
    : 'javascript';
}
