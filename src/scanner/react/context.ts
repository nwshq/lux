import type {
  ModuleExportIndexV1,
  ProjectResolutionContextV1,
  SourceDiagnosticV1,
  SourceLocationV1,
} from '../contracts/program.js';
import { reactComponentId, reactContextId, reactHookId } from '../identity/program-identity.js';
import { resolveProjectBinding } from '../project-resolution/resolver.js';
import { frameworkEdge } from './edge-factory.js';
import type {
  FrameworkNodeV1,
  ReactComponentFactV1,
  ReactContextFactV1,
  ReactContextUseFactV1,
  ReactFactV1,
  ResolvedBindingV1,
} from './types.js';

const RESOLVER = 'react-context';
const HOOK_NAME = /^use[A-Z0-9]/u;

type Resolution<T> =
  { status: 'resolved'; value: T } | { status: 'unresolved' | 'ambiguous'; detail: string };

export interface ReactContextResolutionV1 {
  nodes: FrameworkNodeV1[];
  edges: ReturnType<typeof frameworkEdge>[];
  diagnostics: SourceDiagnosticV1[];
}

export function resolveReactContexts(
  facts: readonly ReactFactV1[],
  project: ProjectResolutionContextV1
): ReactContextResolutionV1 {
  const components = facts.filter(
    (fact): fact is ReactComponentFactV1 => fact.kind === 'react-component'
  );
  const declarations = contextDeclarations(facts);
  const diagnostics: SourceDiagnosticV1[] = [...declarations.diagnostics];
  const groups = new Map<
    string,
    {
      edgeType: 'provides_context' | 'consumes_context';
      sourceId: string;
      sourceLanguage: string;
      target: ReactContextFactV1;
      uses: SourceLocationV1[];
    }
  >();

  for (const use of facts
    .filter((fact): fact is ReactContextUseFactV1 => fact.kind === 'react-context-use')
    .sort(compareUses)) {
    const owner = resolveOwner(use, components, project);
    if (owner.status !== 'resolved') {
      diagnostics.push(diagnostic(owner.status, `owner ${use.ownerExport}: ${owner.detail}`, use));
      continue;
    }
    const context = resolveContext(use, declarations, project);
    if (context.status !== 'resolved') {
      diagnostics.push(diagnostic(context.status, context.detail, use));
      continue;
    }

    const edgeType = use.mode === 'provider' ? 'provides_context' : 'consumes_context';
    const targetId = contextId(context.value);
    const key = `${edgeType}\0${owner.value.id}\0${targetId}`;
    const existing = groups.get(key);
    if (existing) existing.uses.push(use.location);
    else {
      groups.set(key, {
        edgeType,
        sourceId: owner.value.id,
        sourceLanguage: owner.value.language,
        target: context.value,
        uses: [use.location],
      });
    }
  }

  return {
    nodes: declarations.all.map(contextNode).sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...groups.values()]
      .map((group) =>
        frameworkEdge({
          resolver: RESOLVER,
          edgeType: group.edgeType,
          sourceNodeId: group.sourceId,
          targetNodeId: contextId(group.target),
          sourceLanguage: group.sourceLanguage,
          targetLanguage: languageFor(group.target.filePath),
          confidence: 0.95,
          confidenceClass: 'framework-inferred',
          evidenceKind:
            group.edgeType === 'provides_context'
              ? 'react-static-context-provider'
              : 'react-static-context-consumer',
          locations: [group.target.declaration, ...group.uses],
        })
      )
      .sort((left, right) => left.id.localeCompare(right.id)),
    diagnostics: sortDiagnostics(diagnostics),
  };
}

function resolveOwner(
  use: ReactContextUseFactV1,
  components: readonly ReactComponentFactV1[],
  project: ProjectResolutionContextV1
): Resolution<{ id: string; language: string }> {
  const componentOwners = components.filter(
    (component) => component.filePath === use.filePath && component.exportName === use.ownerExport
  );
  if (componentOwners.length === 1) {
    return {
      status: 'resolved',
      value: {
        id: reactComponentId(use.filePath, use.ownerExport),
        language: languageFor(use.filePath),
      },
    };
  }
  if (componentOwners.length > 1) {
    return { status: 'ambiguous', detail: 'multiple component declarations' };
  }

  const hooks = directHooks(use.filePath, project.exportsByFile).filter(
    (hook) => hook === use.ownerExport
  );
  if (hooks.length === 1) {
    return {
      status: 'resolved',
      value: { id: reactHookId(use.filePath, hooks[0]), language: languageFor(use.filePath) },
    };
  }
  return hooks.length > 1
    ? { status: 'ambiguous', detail: 'multiple hook declarations' }
    : { status: 'unresolved', detail: 'not an exact component or hook declaration' };
}

function resolveContext(
  use: ReactContextUseFactV1,
  declarations: ReturnType<typeof contextDeclarations>,
  project: ProjectResolutionContextV1
): Resolution<ReactContextFactV1> {
  if (!use.contextBinding) {
    return oneContext(
      declarations.byLocal.get(`${use.filePath}\0${use.contextLocalName}`) ?? [],
      use.contextLocalName
    );
  }
  return resolveImportedContext(use, use.contextBinding, declarations.all, project);
}

function resolveImportedContext(
  use: ReactContextUseFactV1,
  binding: ResolvedBindingV1,
  contexts: readonly ReactContextFactV1[],
  project: ProjectResolutionContextV1
): Resolution<ReactContextFactV1> {
  const resolution = resolveProjectBinding(
    {
      importerFile: use.filePath,
      specifier: binding.sourceSpecifier,
      importedName: binding.importedName,
      mode: 'import',
    },
    project
  );
  if (resolution.module.status === 'ambiguous' || resolution.exported?.status === 'ambiguous') {
    return { status: 'ambiguous', detail: `context ${binding.localName} is ambiguous` };
  }
  if (resolution.module.status !== 'resolved' || resolution.exported?.status !== 'resolved') {
    return {
      status: 'unresolved',
      detail: `context ${binding.localName} resolves as ${resolution.module.status}`,
    };
  }

  const target = resolution.exported.target;
  const declarationName = target.declarationId ?? target.localName;
  return oneContext(
    contexts.filter(
      (context) =>
        context.filePath === target.filePath &&
        (context.localName === declarationName || context.exportName === declarationName)
    ),
    binding.localName
  );
}

function oneContext(
  candidates: readonly ReactContextFactV1[],
  name: string
): Resolution<ReactContextFactV1> {
  if (candidates.length === 1) return { status: 'resolved', value: candidates[0] };
  return candidates.length > 1
    ? { status: 'ambiguous', detail: `context ${name} has multiple declarations` }
    : { status: 'unresolved', detail: `context ${name} has no exact declaration` };
}

function contextDeclarations(facts: readonly ReactFactV1[]): {
  all: ReactContextFactV1[];
  byLocal: ReadonlyMap<string, ReactContextFactV1[]>;
  diagnostics: SourceDiagnosticV1[];
} {
  const groups = new Map<string, ReactContextFactV1[]>();
  for (const fact of facts) {
    if (fact.kind !== 'react-context') continue;
    const group = groups.get(contextId(fact));
    if (group) group.push(fact);
    else groups.set(contextId(fact), [fact]);
  }
  const all: ReactContextFactV1[] = [];
  const diagnostics: SourceDiagnosticV1[] = [];
  for (const [id, group] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    const unique = uniqueContexts(group);
    if (unique.length === 1) all.push(unique[0]);
    else {
      diagnostics.push({
        code: 'REACT_AMBIGUOUS_BINDING',
        message: `Multiple React context declarations claim ${id}.`,
        location: group[0].declaration,
      });
    }
  }

  const byLocal = new Map<string, ReactContextFactV1[]>();
  for (const context of all) {
    const key = `${context.filePath}\0${context.localName}`;
    const values = byLocal.get(key);
    if (values) values.push(context);
    else byLocal.set(key, [context]);
  }
  return { all, byLocal, diagnostics };
}

function uniqueContexts(facts: readonly ReactContextFactV1[]): ReactContextFactV1[] {
  const unique = new Map<string, ReactContextFactV1>();
  for (const fact of facts) {
    const key = [
      fact.localName,
      fact.declaration.filePath,
      fact.declaration.line,
      fact.declaration.column,
    ].join('\0');
    unique.set(key, fact);
  }
  return [...unique.values()];
}

function directHooks(
  filePath: string,
  exportsByFile: ReadonlyMap<string, ModuleExportIndexV1>
): string[] {
  const index = exportsByFile.get(filePath);
  if (!index) return [];
  return [
    ...(index.default?.declarationId && HOOK_NAME.test(index.default.declarationId)
      ? ['default']
      : []),
    ...Object.entries(index.named).flatMap(([exportName, target]) =>
      target.declarationId && HOOK_NAME.test(target.declarationId) ? [exportName] : []
    ),
  ];
}

function contextNode(fact: ReactContextFactV1): FrameworkNodeV1 {
  return {
    id: contextId(fact),
    type: 'symbol',
    name: fact.exportName,
    filePath: fact.filePath,
    languageId: languageFor(fact.filePath),
    metadata: { framework: 'react', kind: 'context', exportName: fact.exportName },
  };
}

function contextId(fact: ReactContextFactV1): string {
  return reactContextId(fact.filePath, fact.exportName);
}

function diagnostic(
  status: 'unresolved' | 'ambiguous',
  detail: string,
  use: ReactContextUseFactV1
): SourceDiagnosticV1 {
  return {
    code: status === 'ambiguous' ? 'REACT_AMBIGUOUS_BINDING' : 'REACT_UNRESOLVED_BINDING',
    message: `Cannot resolve React context use ${use.contextLocalName}: ${detail}.`,
    location: use.location,
  };
}

function languageFor(filePath: string): 'typescript' | 'javascript' {
  return /\.[cm]?tsx?$/u.test(filePath) && !/\.[cm]?jsx?$/u.test(filePath)
    ? 'typescript'
    : 'javascript';
}

function compareUses(left: ReactContextUseFactV1, right: ReactContextUseFactV1): number {
  return [left.filePath, left.ownerExport, left.location.line, left.location.column, left.mode]
    .join('\0')
    .localeCompare(
      [
        right.filePath,
        right.ownerExport,
        right.location.line,
        right.location.column,
        right.mode,
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
