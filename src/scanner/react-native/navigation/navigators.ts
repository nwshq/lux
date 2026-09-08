import { reactNavigationScreenId, reactNavigatorId } from '../../identity/program-identity.js';
import type { SourceDiagnosticV1 } from '../../contracts/program.js';
import type { FrameworkNodeV1 } from '../../react/types.js';
import type {
  ReactNavigationFactV1,
  ReactNavigationNavigatorFactV1,
  ReactNavigationScreenFactV1,
} from './types.js';

export interface ReactNavigationGraphV1 {
  navigators: ReactNavigationNavigatorFactV1[];
  screens: ReactNavigationScreenFactV1[];
  nodes: FrameworkNodeV1[];
  diagnostics: SourceDiagnosticV1[];
}

/** Build navigator and navigator-scoped screen declarations, refusing duplicate scoped names. */
export function resolveReactNavigationNavigators(
  facts: readonly ReactNavigationFactV1[]
): ReactNavigationGraphV1 {
  const diagnostics: SourceDiagnosticV1[] = [];
  const navigatorGroups = group(
    facts.filter(
      (fact): fact is ReactNavigationNavigatorFactV1 => fact.kind === 'react-navigation-navigator'
    ),
    (fact) => reactNavigatorId(fact.filePath, fact.localName)
  );
  const navigators: ReactNavigationNavigatorFactV1[] = [];
  for (const [id, candidates] of navigatorGroups) {
    const unique = uniqueBy(candidates, (item) => JSON.stringify(item));
    if (unique.length === 1) navigators.push(unique[0]);
    else
      diagnostics.push({
        code: 'REACT_NAVIGATION_AMBIGUOUS_NAVIGATOR',
        message: `Multiple navigator declarations claim ${id}.`,
        location: candidates[0].location,
      });
  }

  const navigatorByKey = new Map(
    navigators.map((item) => [`${item.filePath}\0${item.localName}`, item])
  );
  const screenGroups = group(
    facts.filter(
      (fact): fact is ReactNavigationScreenFactV1 => fact.kind === 'react-navigation-screen'
    ),
    (fact) => {
      const navigator = navigatorByKey.get(`${fact.filePath}\0${fact.navigatorLocalName}`);
      return navigator ? reactNavigationScreenId(navigatorId(navigator), fact.name) : '';
    }
  );
  const screens: ReactNavigationScreenFactV1[] = [];
  for (const [id, candidates] of screenGroups) {
    if (!id) {
      for (const candidate of candidates)
        diagnostics.push({
          code: 'REACT_NAVIGATION_UNRESOLVED_NAVIGATOR',
          message: `Screen ${candidate.name} has no exact navigator declaration.`,
          location: candidate.location,
        });
      continue;
    }
    const unique = uniqueBy(candidates, (item) => JSON.stringify(item));
    if (unique.length === 1) screens.push(unique[0]);
    else
      diagnostics.push({
        code: 'REACT_NAVIGATION_AMBIGUOUS_SCREEN',
        message: `Multiple screen declarations claim ${id}.`,
        location: candidates[0].location,
      });
  }

  return {
    navigators: navigators.sort(compareLocation),
    screens: screens.sort(compareLocation),
    nodes: [
      ...navigators.map(navigatorNode),
      ...screens.map((screen) => screenNode(screen, navigatorByKey)),
    ].sort((left, right) => left.id.localeCompare(right.id)),
    diagnostics,
  };
}

function navigatorId(fact: ReactNavigationNavigatorFactV1): string {
  return reactNavigatorId(fact.filePath, fact.localName);
}

export function screenId(
  fact: ReactNavigationScreenFactV1,
  navigatorByKey: ReadonlyMap<string, ReactNavigationNavigatorFactV1>
): string {
  const navigator = navigatorByKey.get(`${fact.filePath}\0${fact.navigatorLocalName}`);
  if (!navigator) return '';
  return reactNavigationScreenId(navigatorId(navigator), fact.name);
}

function navigatorNode(fact: ReactNavigationNavigatorFactV1): FrameworkNodeV1 {
  return {
    id: navigatorId(fact),
    type: 'symbol',
    name: fact.localName,
    filePath: fact.filePath,
    languageId: languageFor(fact.filePath),
    metadata: {
      framework: 'react-navigation',
      kind: 'navigator',
      factory: fact.factory,
      packageName: fact.packageName,
    },
  };
}

function screenNode(
  fact: ReactNavigationScreenFactV1,
  navigatorByKey: ReadonlyMap<string, ReactNavigationNavigatorFactV1>
): FrameworkNodeV1 {
  const navigator = navigatorByKey.get(`${fact.filePath}\0${fact.navigatorLocalName}`)!;
  return {
    id: screenId(fact, navigatorByKey),
    type: 'route',
    name: fact.name,
    filePath: fact.filePath,
    languageId: languageFor(fact.filePath),
    metadata: {
      framework: 'react-navigation',
      kind: 'screen',
      navigatorId: navigatorId(navigator),
      ...(fact.component
        ? {
            componentFile: fact.component.filePath,
            componentExport: fact.component.exportName,
          }
        : {}),
    },
  };
}

function group<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) {
    const groupValues = result.get(key(value));
    if (groupValues) groupValues.push(value);
    else result.set(key(value), [value]);
  }
  return result;
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}

function languageFor(filePath: string): 'typescript' | 'javascript' {
  return /\.[cm]?tsx?$/u.test(filePath) && !/\.[cm]?jsx?$/u.test(filePath)
    ? 'typescript'
    : 'javascript';
}

function compareLocation<
  T extends { location: { filePath: string; line: number; column: number } },
>(left: T, right: T): number {
  return [left.location.filePath, left.location.line, left.location.column]
    .join('\0')
    .localeCompare(
      [right.location.filePath, right.location.line, right.location.column].join('\0')
    );
}
