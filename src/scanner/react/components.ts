import type { ProjectResolutionContextV1, SourceDiagnosticV1 } from '../contracts/program.js';
import { reactComponentId } from '../identity/program-identity.js';
import { resolveProjectBinding } from '../project-resolution/resolver.js';
import { frameworkEdge } from './edge-factory.js';
import type {
  FrameworkNodeV1,
  ReactComponentFactV1,
  ReactFactV1,
  ReactLazyFactV1,
  ReactRenderFactV1,
  ResolvedBindingV1,
} from './types.js';

const RESOLVER = 'react-component';

type Resolution<T> =
  { status: 'resolved'; value: T } | { status: 'unresolved' | 'ambiguous'; detail: string };

export interface ReactComponentResolutionV1 {
  nodes: FrameworkNodeV1[];
  edges: ReturnType<typeof frameworkEdge>[];
  diagnostics: SourceDiagnosticV1[];
}

export function resolveReactComponents(
  facts: readonly ReactFactV1[],
  project: ProjectResolutionContextV1
): ReactComponentResolutionV1 {
  const declarations = componentDeclarations(facts);
  const diagnostics: SourceDiagnosticV1[] = [...declarations.diagnostics];
  const groupedEdges = new Map<
    string,
    { source: ReactComponentFactV1; target: ReactComponentFactV1; uses: ReactRenderFactV1[] }
  >();
  const lazyFacts = facts.filter((fact): fact is ReactLazyFactV1 => fact.kind === 'react-lazy');

  for (const render of facts
    .filter((fact): fact is ReactRenderFactV1 => fact.kind === 'react-render')
    .sort(compareUseFacts)) {
    const owner = resolveOwner(render, declarations.byExport);
    if (owner.status !== 'resolved') {
      diagnostics.push(bindingDiagnostic(owner.status, owner.detail, render));
      continue;
    }

    const target = resolveRenderTarget(
      render,
      lazyFacts,
      declarations.byLocal,
      declarations.all,
      project
    );
    if (target.status !== 'resolved') {
      diagnostics.push(bindingDiagnostic(target.status, target.detail, render));
      continue;
    }

    const sourceId = componentId(owner.value);
    const targetId = componentId(target.value);
    const key = `${sourceId}\0${targetId}`;
    const existing = groupedEdges.get(key);
    if (existing) existing.uses.push(render);
    else groupedEdges.set(key, { source: owner.value, target: target.value, uses: [render] });
  }

  const edges = [...groupedEdges.values()]
    .map(({ source, target, uses }) =>
      frameworkEdge({
        resolver: RESOLVER,
        edgeType: 'renders_component',
        sourceNodeId: componentId(source),
        targetNodeId: componentId(target),
        sourceLanguage: languageFor(source.filePath),
        targetLanguage: languageFor(target.filePath),
        confidence: 0.95,
        confidenceClass: 'framework-inferred',
        evidenceKind: 'react-static-component-render',
        locations: [source.declaration, target.declaration, ...uses.map((use) => use.location)],
      })
    )
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    nodes: declarations.all
      .map(componentNode)
      .sort((left, right) => left.id.localeCompare(right.id)),
    edges,
    diagnostics: sortDiagnostics(diagnostics),
  };
}

function resolveOwner(
  render: ReactRenderFactV1,
  byExport: ReadonlyMap<string, ReactComponentFactV1[]>
): Resolution<ReactComponentFactV1> {
  const candidates = byExport.get(`${render.filePath}\0${render.ownerExport}`) ?? [];
  if (candidates.length === 1) return { status: 'resolved', value: candidates[0] };
  if (candidates.length > 1) {
    return { status: 'ambiguous', detail: `owner ${render.ownerExport} has multiple declarations` };
  }
  return {
    status: 'unresolved',
    detail: `owner ${render.ownerExport} is not an exact component declaration`,
  };
}

function resolveRenderTarget(
  render: ReactRenderFactV1,
  lazyFacts: readonly ReactLazyFactV1[],
  byLocal: ReadonlyMap<string, ReactComponentFactV1[]>,
  components: readonly ReactComponentFactV1[],
  project: ProjectResolutionContextV1
): Resolution<ReactComponentFactV1> {
  if (render.binding)
    return resolveImportedComponent(render, render.binding, components, project, 'import');

  const local = byLocal.get(`${render.filePath}\0${render.jsxName}`) ?? [];
  const lazy = lazyFacts.filter(
    (fact) =>
      fact.filePath === render.filePath &&
      fact.ownerExport === render.ownerExport &&
      fact.localName === render.jsxName
  );
  if (local.length + lazy.length > 1) {
    return { status: 'ambiguous', detail: `render target ${render.jsxName} has multiple bindings` };
  }
  if (local.length === 1) return { status: 'resolved', value: local[0] };
  if (lazy.length === 1) {
    if (!lazy[0].specifier) {
      return {
        status: 'unresolved',
        detail: `lazy target ${render.jsxName} has no static specifier`,
      };
    }
    const binding: ResolvedBindingV1 = {
      localName: lazy[0].localName,
      importedName: lazy[0].targetExport ?? 'default',
      sourceSpecifier: lazy[0].specifier,
      targetFile: '',
      targetExport: lazy[0].targetExport ?? 'default',
    };
    return resolveImportedComponent(render, binding, components, project, 'dynamic-import');
  }
  return {
    status: 'unresolved',
    detail: `render target ${render.jsxName} has no exact local binding`,
  };
}

function resolveImportedComponent(
  render: ReactRenderFactV1,
  binding: ResolvedBindingV1,
  components: readonly ReactComponentFactV1[],
  project: ProjectResolutionContextV1,
  mode: 'import' | 'dynamic-import'
): Resolution<ReactComponentFactV1> {
  const resolution = resolveProjectBinding(
    {
      importerFile: render.filePath,
      specifier: binding.sourceSpecifier,
      importedName: binding.importedName,
      mode,
    },
    project
  );
  if (resolution.module.status === 'ambiguous' || resolution.exported?.status === 'ambiguous') {
    return { status: 'ambiguous', detail: `binding ${binding.localName} is ambiguous` };
  }
  if (resolution.module.status !== 'resolved' || resolution.exported?.status !== 'resolved') {
    return {
      status: 'unresolved',
      detail: `binding ${binding.localName} resolves as ${resolution.module.status}`,
    };
  }

  const target = resolution.exported.target;
  const declarationName = target.declarationId ?? target.localName;
  const candidates = components.filter(
    (component) =>
      component.filePath === target.filePath &&
      (component.localName === declarationName || component.exportName === declarationName)
  );
  if (candidates.length === 1) return { status: 'resolved', value: candidates[0] };
  if (candidates.length > 1) {
    return {
      status: 'ambiguous',
      detail: `binding ${binding.localName} matches multiple components`,
    };
  }
  return {
    status: 'unresolved',
    detail: `binding ${binding.localName} does not resolve to a component declaration`,
  };
}

function componentDeclarations(facts: readonly ReactFactV1[]): {
  all: ReactComponentFactV1[];
  byExport: ReadonlyMap<string, ReactComponentFactV1[]>;
  byLocal: ReadonlyMap<string, ReactComponentFactV1[]>;
  diagnostics: SourceDiagnosticV1[];
} {
  const groups = new Map<string, ReactComponentFactV1[]>();
  for (const fact of facts) {
    if (fact.kind !== 'react-component') continue;
    const key = componentId(fact);
    const group = groups.get(key);
    if (group) group.push(fact);
    else groups.set(key, [fact]);
  }

  const all: ReactComponentFactV1[] = [];
  const diagnostics: SourceDiagnosticV1[] = [];
  for (const [id, group] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    const unique = uniqueComponents(group);
    if (unique.length === 1) all.push(unique[0]);
    else {
      diagnostics.push({
        code: 'REACT_AMBIGUOUS_BINDING',
        message: `Multiple React component declarations claim ${id}.`,
        location: group[0].declaration,
      });
    }
  }
  return {
    all,
    byExport: groupComponents(all, (fact) => `${fact.filePath}\0${fact.exportName}`),
    byLocal: groupComponents(all, (fact) => `${fact.filePath}\0${fact.localName}`),
    diagnostics,
  };
}

function uniqueComponents(facts: readonly ReactComponentFactV1[]): ReactComponentFactV1[] {
  const unique = new Map<string, ReactComponentFactV1>();
  for (const fact of facts) {
    const key = [
      fact.localName,
      fact.form,
      fact.declaration.filePath,
      fact.declaration.line,
      fact.declaration.column,
    ].join('\0');
    unique.set(key, fact);
  }
  return [...unique.values()];
}

function groupComponents(
  facts: readonly ReactComponentFactV1[],
  key: (fact: ReactComponentFactV1) => string
): ReadonlyMap<string, ReactComponentFactV1[]> {
  const result = new Map<string, ReactComponentFactV1[]>();
  for (const fact of facts) {
    const values = result.get(key(fact));
    if (values) values.push(fact);
    else result.set(key(fact), [fact]);
  }
  return result;
}

function componentNode(fact: ReactComponentFactV1): FrameworkNodeV1 {
  return {
    id: componentId(fact),
    type: 'symbol',
    name: fact.exportName,
    filePath: fact.filePath,
    languageId: languageFor(fact.filePath),
    metadata: {
      framework: 'react',
      kind: 'component',
      exportName: fact.exportName,
      form: fact.form,
    },
  };
}

function componentId(fact: ReactComponentFactV1): string {
  return reactComponentId(fact.filePath, fact.exportName);
}

function bindingDiagnostic(
  status: 'unresolved' | 'ambiguous',
  detail: string,
  fact: ReactRenderFactV1
): SourceDiagnosticV1 {
  return {
    code: status === 'ambiguous' ? 'REACT_AMBIGUOUS_BINDING' : 'REACT_UNRESOLVED_BINDING',
    message: `Cannot resolve React render ${fact.jsxName}: ${detail}.`,
    location: fact.location,
  };
}

function languageFor(filePath: string): 'typescript' | 'javascript' {
  return /\.[cm]?tsx?$/u.test(filePath) && !/\.[cm]?jsx?$/u.test(filePath)
    ? 'typescript'
    : 'javascript';
}

function compareUseFacts(left: ReactRenderFactV1, right: ReactRenderFactV1): number {
  return [left.filePath, left.ownerExport, left.location.line, left.location.column, left.jsxName]
    .join('\0')
    .localeCompare(
      [
        right.filePath,
        right.ownerExport,
        right.location.line,
        right.location.column,
        right.jsxName,
      ].join('\0')
    );
}

function sortDiagnostics(diagnostics: SourceDiagnosticV1[]): SourceDiagnosticV1[] {
  return diagnostics.sort((left, right) =>
    [left.location?.filePath ?? '', left.location?.line ?? 0, left.code, left.message]
      .join('\0')
      .localeCompare(
        [right.location?.filePath ?? '', right.location?.line ?? 0, right.code, right.message].join(
          '\0'
        )
      )
  );
}
