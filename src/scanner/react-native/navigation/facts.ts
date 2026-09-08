import type { SourceDiagnosticV1 } from '../../contracts/program.js';
import type { ImportBinding } from '../../ast/extract.js';
import {
  callArguments,
  componentAt,
  firstArgument,
  literal,
  location,
  sortDiagnostics,
  SOURCE_EXTENSION,
} from './shared.js';
import type {
  NavigationComponentV1,
  ReactNavigationActionFactV1,
  ReactNavigationActionMethodV1,
  ReactNavigationAnalysisInputV1,
  ReactNavigationExtractionResultV1,
  ReactNavigationFactExtractorV1,
  ReactNavigationFactV1,
  ReactNavigationFactoryV1,
  ReactNavigationNavigatorFactV1,
} from './types.js';

const FACTORY_PACKAGES: Readonly<Record<ReactNavigationFactoryV1, readonly string[]>> = {
  createStackNavigator: ['@react-navigation/stack'],
  createNativeStackNavigator: ['@react-navigation/native-stack'],
  createBottomTabNavigator: ['@react-navigation/bottom-tabs'],
  createDrawerNavigator: ['@react-navigation/drawer'],
  createMaterialBottomTabNavigator: ['@react-navigation/material-bottom-tabs'],
  createMaterialTopTabNavigator: ['@react-navigation/material-top-tabs'],
};
const ACTIONS = new Set<ReactNavigationActionMethodV1>(['navigate', 'push', 'replace', 'jumpTo']);

interface FileState {
  filePath: string;
  source: string;
  imports: ReadonlyMap<string, ImportBinding>;
  components: NavigationComponentV1[];
  input: ReactNavigationAnalysisInputV1;
}

/** Deterministic React Navigation extraction over the shared source and AST caches. */
export class ReactNavigationFactExtractor implements ReactNavigationFactExtractorV1 {
  extract(input: ReactNavigationAnalysisInputV1): Promise<ReactNavigationExtractionResultV1> {
    const facts: ReactNavigationFactV1[] = [];
    const diagnostics: SourceDiagnosticV1[] = [];
    const dependencies = new Set(input.project.fingerprintInputs);
    if (!input.extractions || !input.sources) {
      return Promise.resolve({
        facts,
        dependencies: [...dependencies].sort(),
        diagnostics: [
          {
            code: 'REACT_NAVIGATION_CACHE_REQUIRED',
            message: 'React Navigation analysis requires the shared extraction and source caches.',
          },
        ],
      });
    }

    for (const filePath of [...new Set(input.files)]
      .filter((file) => SOURCE_EXTENSION.test(file))
      .sort()) {
      const source = input.sources.get(filePath);
      const extraction = input.extractions.get(filePath);
      if (source === undefined || !extraction) continue;
      dependencies.add(filePath);
      const state: FileState = {
        filePath,
        source,
        input,
        imports: new Map((extraction.imports ?? []).map((item) => [item.local, item])),
        components: componentsFor(filePath, source, extraction),
      };
      const navigators = extractNavigators(state, diagnostics);
      facts.push(...navigators);
      facts.push(...extractScreens(state, navigators, diagnostics));
      facts.push(...extractActions(state, diagnostics));
    }

    return Promise.resolve({
      facts: deduplicate(facts),
      dependencies: [...dependencies].sort(),
      diagnostics: sortDiagnostics(diagnostics),
    });
  }
}

function componentsFor(
  filePath: string,
  source: string,
  extraction: NonNullable<ReactNavigationAnalysisInputV1['extractions']> extends ReadonlyMap<
    string,
    infer T
  >
    ? T
    : never
): NavigationComponentV1[] {
  const exports = new Map<string, string>();
  for (const fact of extraction.moduleFacts ?? []) {
    if (fact.kind === 'esm-export-default' && fact.localName)
      exports.set(fact.localName, 'default');
    if (fact.kind === 'esm-export-named' && fact.localName && fact.exportedName)
      exports.set(fact.localName, fact.exportedName);
    if (
      (fact.kind === 'commonjs-module-exports' || fact.kind === 'commonjs-exports-member') &&
      fact.localName
    )
      exports.set(fact.localName, fact.exportedName ?? 'default');
  }
  return extraction.nodes
    .filter((node) => node.type === 'function' || node.type === 'class')
    .map((node) => ({
      filePath,
      exportName: exports.get(node.name) ?? node.name,
      localName: node.name,
      declaration: {
        filePath,
        line: node.range.startLine,
        column: node.range.startColumn,
      },
    }))
    .filter((component, index, values) => {
      const start = source.indexOf(component.localName);
      return (
        start >= 0 &&
        values.findIndex(
          (item) =>
            item.localName === component.localName && item.exportName === component.exportName
        ) === index
      );
    });
}

function extractNavigators(
  state: FileState,
  diagnostics: SourceDiagnosticV1[]
): ReactNavigationNavigatorFactV1[] {
  const result: ReactNavigationNavigatorFactV1[] = [];
  const pattern =
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\s*(?:<[^;=()]*>)?\s*\(\s*\)/gu;
  for (const match of state.source.matchAll(pattern)) {
    const binding = state.imports.get(match[2]);
    const factory = binding?.imported as ReactNavigationFactoryV1 | undefined;
    if (!factory || !(factory in FACTORY_PACKAGES)) continue;
    const allowed = FACTORY_PACKAGES[factory];
    if (!binding?.module || !allowed.includes(binding.module)) {
      diagnostics.push({
        code: 'REACT_NAVIGATION_UNSUPPORTED_FACTORY',
        message: `${match[2]} is not imported from an exact React Navigation navigator package.`,
        location: location(state.filePath, state.source, match.index),
      });
      continue;
    }
    result.push({
      kind: 'react-navigation-navigator',
      filePath: state.filePath,
      localName: match[1],
      factory,
      packageName: binding.module,
      owner: componentAt(
        state.source,
        state.input.extractions!.get(state.filePath)!,
        state.components,
        match.index
      ),
      location: location(state.filePath, state.source, match.index),
    });
  }
  return result;
}

function extractScreens(
  state: FileState,
  navigators: readonly ReactNavigationNavigatorFactV1[],
  diagnostics: SourceDiagnosticV1[]
): ReactNavigationFactV1[] {
  const result: ReactNavigationFactV1[] = [];
  const navigatorNames = new Set(navigators.map((item) => item.localName));
  const pattern = /<([A-Za-z_$][\w$]*)\.Screen\b([^>]*?)(?:\/>|>)/gsu;
  for (const match of state.source.matchAll(pattern)) {
    if (!navigatorNames.has(match[1])) continue;
    const nameAttribute = /\bname\s*=\s*(?:(['"])([^'"]+)\1|\{([^}]*)\})/u.exec(match[2]);
    const name = nameAttribute?.[2] ?? (nameAttribute?.[3] ? literal(nameAttribute[3]) : undefined);
    if (!name) {
      diagnostics.push({
        code: 'REACT_NAVIGATION_DYNAMIC_SCREEN_NAME',
        message: `Screen on ${match[1]} has no static literal name.`,
        location: location(state.filePath, state.source, match.index),
      });
      continue;
    }
    const componentAttribute = /\bcomponent\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/u.exec(match[2]);
    let component: NavigationComponentV1 | undefined;
    if (componentAttribute) {
      component = resolveComponentBinding(state, componentAttribute[1], diagnostics, match.index);
    } else if (/\bcomponent\s*=/u.test(match[2])) {
      diagnostics.push({
        code: 'REACT_NAVIGATION_DYNAMIC_COMPONENT',
        message: `Screen ${name} does not have an exact component identifier.`,
        location: location(state.filePath, state.source, match.index),
      });
    }
    result.push({
      kind: 'react-navigation-screen',
      filePath: state.filePath,
      navigatorLocalName: match[1],
      name,
      ...(component ? { component } : {}),
      location: location(state.filePath, state.source, match.index),
    });
  }
  return result;
}

function resolveComponentBinding(
  state: FileState,
  localName: string,
  diagnostics: SourceDiagnosticV1[],
  offset: number
): NavigationComponentV1 | undefined {
  const local = state.components.filter((component) => component.localName === localName);
  const imported = state.imports.get(localName);
  if (local.length === 1 && !imported) return local[0];
  if (local.length > 1 || (local.length === 1 && imported)) {
    componentDiagnostic('AMBIGUOUS', localName, state, diagnostics, offset);
    return undefined;
  }
  if (!imported?.module) {
    componentDiagnostic('UNRESOLVED', localName, state, diagnostics, offset);
    return undefined;
  }
  const resolution = resolveBinding(state, imported);
  if (resolution.status !== 'resolved') {
    componentDiagnostic(
      resolution.status === 'ambiguous' ? 'AMBIGUOUS' : 'UNRESOLVED',
      localName,
      state,
      diagnostics,
      offset
    );
    return undefined;
  }
  return resolution.component;
}

function resolveBinding(
  state: FileState,
  binding: ImportBinding
):
  | { status: 'resolved'; component: NavigationComponentV1 }
  | { status: 'ambiguous' | 'unresolved' } {
  // Keep resolution local to the frozen project substrate and never trust a pre-filled target.
  const { resolveProjectBinding } = projectResolver();
  const resolution = resolveProjectBinding(
    {
      importerFile: state.filePath,
      specifier: binding.module!,
      importedName: binding.imported,
      mode: 'import',
    },
    state.input.project
  );
  if (resolution.module.status === 'ambiguous' || resolution.exported?.status === 'ambiguous')
    return { status: 'ambiguous' };
  if (resolution.module.status !== 'resolved' || resolution.exported?.status !== 'resolved')
    return { status: 'unresolved' };
  const target = resolution.exported.target;
  return {
    status: 'resolved',
    component: {
      filePath: target.filePath,
      exportName: binding.imported,
      localName: target.declarationId ?? target.localName,
      declaration: { filePath: target.filePath, line: 1, column: 0 },
    },
  };
}

// This indirection is replaced below by a normal import after keeping the resolver call visually isolated.
import { resolveProjectBinding } from '../../project-resolution/resolver.js';
function projectResolver(): { resolveProjectBinding: typeof resolveProjectBinding } {
  return { resolveProjectBinding };
}

function componentDiagnostic(
  status: 'AMBIGUOUS' | 'UNRESOLVED',
  localName: string,
  state: FileState,
  diagnostics: SourceDiagnosticV1[],
  offset: number
): void {
  diagnostics.push({
    code: `REACT_NAVIGATION_${status}_COMPONENT`,
    message: `Screen component ${localName} is ${status.toLowerCase()}.`,
    location: location(state.filePath, state.source, offset),
  });
}

function extractActions(
  state: FileState,
  diagnostics: SourceDiagnosticV1[]
): ReactNavigationActionFactV1[] {
  const result: ReactNavigationActionFactV1[] = [];
  const pattern =
    /\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.(navigate|push|replace|jumpTo)\s*\(/gu;
  for (const match of state.source.matchAll(pattern)) {
    const method = match[2] as ReactNavigationActionMethodV1;
    if (!ACTIONS.has(method)) continue;
    const form = actionForm(state, match[1], method);
    if (!form) continue;
    const call = callArguments(state.source, match.index + match[0].length - 1);
    if (!call) continue;
    const routeName = literal(firstArgument(call.text));
    const owner = componentAt(
      state.source,
      state.input.extractions!.get(state.filePath)!,
      state.components,
      match.index
    );
    if (!owner) {
      diagnostics.push({
        code: 'REACT_NAVIGATION_UNRESOLVED_ACTION_OWNER',
        message: `${method} call is not owned by an exact component declaration.`,
        location: location(state.filePath, state.source, match.index),
      });
      continue;
    }
    if (!routeName) {
      diagnostics.push({
        code: 'REACT_NAVIGATION_DYNAMIC_ACTION',
        message: `${method} target is not a static literal route name.`,
        location: location(state.filePath, state.source, match.index),
      });
      continue;
    }
    result.push({
      kind: 'react-navigation-action',
      filePath: state.filePath,
      owner,
      method,
      routePath: [routeName, ...nestedScreenPath(call.text)],
      location: location(state.filePath, state.source, match.index),
      form,
    });
  }
  return result;
}

function actionForm(
  state: FileState,
  receiver: string,
  method: ReactNavigationActionMethodV1
): ReactNavigationActionFactV1['form'] | undefined {
  const root = receiver.split('.')[0];
  const binding = state.imports.get(root);
  if (binding?.module === '@react-navigation/native' && binding.imported === 'CommonActions')
    return method === 'navigate' ? 'action-creator' : undefined;
  if (binding?.module === '@react-navigation/native' && binding.imported === 'StackActions')
    return method === 'push' || method === 'replace' ? 'action-creator' : undefined;
  if (binding?.module === '@react-navigation/native' && binding.imported === 'TabActions')
    return method === 'jumpTo' ? 'action-creator' : undefined;
  if (receiver === 'navigation' || receiver.endsWith('.navigation')) return 'navigation-object';
  return undefined;
}

function nestedScreenPath(argumentsText: string): string[] {
  const result: string[] = [];
  const rest = argumentsText.slice(firstArgument(argumentsText).length + 1);
  const pattern = /\bscreen\s*:\s*(['"])([^'"]+)\1/gu;
  for (const match of rest.matchAll(pattern)) result.push(match[2]);
  return result;
}

function deduplicate(facts: ReactNavigationFactV1[]): ReactNavigationFactV1[] {
  const unique = new Map<string, ReactNavigationFactV1>();
  for (const fact of facts) unique.set(JSON.stringify(fact), fact);
  return [...unique.values()].sort((left, right) =>
    [left.filePath, left.location.line, left.location.column, left.kind]
      .join('\0')
      .localeCompare(
        [right.filePath, right.location.line, right.location.column, right.kind].join('\0')
      )
  );
}
