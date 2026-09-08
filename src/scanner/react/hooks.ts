import type {
  ExportTargetV1,
  ModuleExportIndexV1,
  ProjectResolutionContextV1,
  SourceDiagnosticV1,
  SourceLocationV1,
} from '../contracts/program.js';
import { reactComponentId, reactHookId } from '../identity/program-identity.js';
import { resolveProjectBinding } from '../project-resolution/resolver.js';
import { frameworkEdge } from './edge-factory.js';
import type {
  FrameworkNodeV1,
  ReactComponentFactV1,
  ReactFactV1,
  ReactHookCallFactV1,
  ResolvedBindingV1,
} from './types.js';

const RESOLVER = 'react-hook';
const HOOK_NAME = /^use[A-Z0-9]/u;

interface HookDeclaration {
  filePath: string;
  exportName: string;
  localName: string;
  declarationId: string;
}

type Resolution<T> =
  { status: 'resolved'; value: T } | { status: 'unresolved' | 'ambiguous'; detail: string };

export interface ReactHookResolutionV1 {
  nodes: FrameworkNodeV1[];
  edges: ReturnType<typeof frameworkEdge>[];
  diagnostics: SourceDiagnosticV1[];
}

export function resolveReactHooks(
  facts: readonly ReactFactV1[],
  project: ProjectResolutionContextV1
): ReactHookResolutionV1 {
  const components = facts.filter(
    (fact): fact is ReactComponentFactV1 => fact.kind === 'react-component'
  );
  const diagnostics: SourceDiagnosticV1[] = [];
  const nodes = new Map<string, FrameworkNodeV1>();
  const groups = new Map<
    string,
    { sourceId: string; sourceLanguage: string; target: HookDeclaration; calls: SourceLocationV1[] }
  >();

  for (const call of facts
    .filter((fact): fact is ReactHookCallFactV1 => fact.kind === 'react-hook-call')
    .sort(compareCalls)) {
    const owner = resolveOwner(call, components, project);
    if (owner.status !== 'resolved') {
      diagnostics.push(
        diagnostic(owner.status, `owner ${call.ownerExport}: ${owner.detail}`, call)
      );
      continue;
    }
    const hook = resolveHook(call, project);
    if (hook.status !== 'resolved') {
      diagnostics.push(diagnostic(hook.status, hook.detail, call));
      continue;
    }

    const targetId = reactHookId(hook.value.filePath, hook.value.exportName);
    nodes.set(targetId, hookNode(hook.value));
    const key = `${owner.value.id}\0${targetId}`;
    const existing = groups.get(key);
    if (existing) existing.calls.push(call.location);
    else {
      groups.set(key, {
        sourceId: owner.value.id,
        sourceLanguage: owner.value.language,
        target: hook.value,
        calls: [call.location],
      });
    }
  }

  return {
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...groups.values()]
      .map((group) =>
        frameworkEdge({
          resolver: RESOLVER,
          edgeType: 'uses_hook',
          sourceNodeId: group.sourceId,
          targetNodeId: reactHookId(group.target.filePath, group.target.exportName),
          sourceLanguage: group.sourceLanguage,
          targetLanguage: languageFor(group.target.filePath),
          confidence: 0.95,
          confidenceClass: 'framework-inferred',
          evidenceKind: 'react-resolved-custom-hook-call',
          locations: group.calls,
        })
      )
      .sort((left, right) => left.id.localeCompare(right.id)),
    diagnostics: sortDiagnostics(diagnostics),
  };
}

function resolveOwner(
  call: ReactHookCallFactV1,
  components: readonly ReactComponentFactV1[],
  project: ProjectResolutionContextV1
): Resolution<{ id: string; language: string }> {
  const componentOwners = components.filter(
    (component) => component.filePath === call.filePath && component.exportName === call.ownerExport
  );
  if (componentOwners.length === 1) {
    return {
      status: 'resolved',
      value: {
        id: reactComponentId(call.filePath, call.ownerExport),
        language: languageFor(call.filePath),
      },
    };
  }
  if (componentOwners.length > 1) {
    return { status: 'ambiguous', detail: 'multiple component declarations' };
  }

  const hooks = directHookDeclarations(call.filePath, project.exportsByFile).filter(
    (hook) => hook.exportName === call.ownerExport
  );
  if (hooks.length === 1) {
    return {
      status: 'resolved',
      value: {
        id: reactHookId(hooks[0].filePath, hooks[0].exportName),
        language: languageFor(hooks[0].filePath),
      },
    };
  }
  return hooks.length > 1
    ? { status: 'ambiguous', detail: 'multiple hook declarations' }
    : { status: 'unresolved', detail: 'not an exact component or hook declaration' };
}

function resolveHook(
  call: ReactHookCallFactV1,
  project: ProjectResolutionContextV1
): Resolution<HookDeclaration> {
  if (!HOOK_NAME.test(call.localName)) {
    return { status: 'unresolved', detail: `hook ${call.localName} is not a custom-hook binding` };
  }
  if (!call.binding) {
    const candidates = directHookDeclarations(call.filePath, project.exportsByFile).filter(
      (hook) => hook.localName === call.localName || hook.exportName === call.localName
    );
    if (candidates.length === 1) return { status: 'resolved', value: candidates[0] };
    return candidates.length > 1
      ? { status: 'ambiguous', detail: `hook ${call.localName} has multiple local declarations` }
      : { status: 'unresolved', detail: `hook ${call.localName} has no exact local declaration` };
  }
  return resolveImportedHook(call.filePath, call.binding, project);
}

function resolveImportedHook(
  importerFile: string,
  binding: ResolvedBindingV1,
  project: ProjectResolutionContextV1
): Resolution<HookDeclaration> {
  const resolution = resolveProjectBinding(
    {
      importerFile,
      specifier: binding.sourceSpecifier,
      importedName: binding.importedName,
      mode: 'import',
    },
    project
  );
  if (resolution.module.status === 'ambiguous' || resolution.exported?.status === 'ambiguous') {
    return { status: 'ambiguous', detail: `hook ${binding.localName} is ambiguous` };
  }
  if (resolution.module.status !== 'resolved' || resolution.exported?.status !== 'resolved') {
    return {
      status: 'unresolved',
      detail: `hook ${binding.localName} resolves as ${resolution.module.status}`,
    };
  }
  const declaration = hookDeclaration(resolution.exported.target, binding.importedName);
  return declaration
    ? { status: 'resolved', value: declaration }
    : {
        status: 'unresolved',
        detail: `hook ${binding.localName} does not resolve to an exact custom-hook declaration`,
      };
}

function directHookDeclarations(
  filePath: string,
  exportsByFile: ReadonlyMap<string, ModuleExportIndexV1>
): HookDeclaration[] {
  const index = exportsByFile.get(filePath);
  if (!index) return [];
  const declarations: HookDeclaration[] = [];
  if (index.default) {
    const declaration = hookDeclaration(index.default, 'default');
    if (declaration) declarations.push(declaration);
  }
  for (const [exportName, target] of Object.entries(index.named)) {
    const declaration = hookDeclaration(target, exportName);
    if (declaration) declarations.push(declaration);
  }
  return declarations;
}

function hookDeclaration(target: ExportTargetV1, exportName: string): HookDeclaration | undefined {
  if (!target.declarationId) return undefined;
  const declarationName = target.declarationId;
  if (!HOOK_NAME.test(declarationName)) return undefined;
  return {
    filePath: target.filePath,
    exportName,
    localName: target.localName,
    declarationId: declarationName,
  };
}

function hookNode(hook: HookDeclaration): FrameworkNodeV1 {
  return {
    id: reactHookId(hook.filePath, hook.exportName),
    type: 'symbol',
    name: hook.exportName,
    filePath: hook.filePath,
    languageId: languageFor(hook.filePath),
    metadata: {
      framework: 'react',
      kind: 'hook',
      exportName: hook.exportName,
      localName: hook.localName,
      declarationId: hook.declarationId,
    },
  };
}

function diagnostic(
  status: 'unresolved' | 'ambiguous',
  detail: string,
  call: ReactHookCallFactV1
): SourceDiagnosticV1 {
  return {
    code: status === 'ambiguous' ? 'REACT_AMBIGUOUS_BINDING' : 'REACT_UNRESOLVED_BINDING',
    message: `Cannot resolve React hook call ${call.localName}: ${detail}.`,
    location: call.location,
  };
}

function languageFor(filePath: string): 'typescript' | 'javascript' {
  return /\.[cm]?tsx?$/u.test(filePath) && !/\.[cm]?jsx?$/u.test(filePath)
    ? 'typescript'
    : 'javascript';
}

function compareCalls(left: ReactHookCallFactV1, right: ReactHookCallFactV1): number {
  return [left.filePath, left.ownerExport, left.location.line, left.location.column, left.localName]
    .join('\0')
    .localeCompare(
      [
        right.filePath,
        right.ownerExport,
        right.location.line,
        right.location.column,
        right.localName,
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
