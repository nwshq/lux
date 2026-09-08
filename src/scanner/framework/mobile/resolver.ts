import type { StructuralNode } from '../../../db/types.js';
import type { StructuralRelationEdge } from '../../associations/types.js';
import { tsSymbolNodeId } from '../../associations/types.js';
import type {
  ExportTargetV1,
  ProjectResolutionContextV1,
  SourceDiagnosticV1,
  SourceLocationV1,
} from '../../contracts/program.js';
import { resolveProjectBinding } from '../../project-resolution/resolver.js';
import { frameworkEdge } from '../../react/edge-factory.js';
import { sortDiagnostics } from './shared.js';
import type {
  MobileBindingV1,
  MobileDeclarationV1,
  MobileFactV1,
  MobileRepositoryImplementationFactV1,
  MobileRepositoryInterfaceFactV1,
  MobileResolutionResultV1,
  MobileViewModelFactV1,
  MobileViewModelUseFactV1,
} from './types.js';

type Resolution<T> =
  { status: 'resolved'; value: T } | { status: 'unresolved' | 'ambiguous'; detail: string };

interface CanonicalDeclaration extends MobileDeclarationV1 {
  classification: 'interface' | 'implementation' | 'view-model' | 'owner' | 'hook';
}

/** Resolve explicit mobile repository and ViewModel facts through canonical project bindings. */
export class MobileRelationshipResolver {
  resolve(
    facts: readonly MobileFactV1[],
    project: ProjectResolutionContextV1
  ): Promise<MobileResolutionResultV1> {
    const interfaces = uniqueDeclarations(
      facts.filter(
        (fact): fact is MobileRepositoryInterfaceFactV1 =>
          fact.kind === 'mobile-repository-interface'
      )
    );
    const implementations = uniqueDeclarations(
      facts.filter(
        (fact): fact is MobileRepositoryImplementationFactV1 =>
          fact.kind === 'mobile-repository-implementation'
      )
    );
    const viewModels = uniqueDeclarations(
      facts.filter((fact): fact is MobileViewModelFactV1 => fact.kind === 'mobile-view-model')
    );
    const uses = facts.filter(
      (fact): fact is MobileViewModelUseFactV1 => fact.kind === 'mobile-view-model-use'
    );
    const nodes = new Map<string, StructuralNode>();
    const edges = new Map<string, StructuralRelationEdge>();
    const diagnostics: SourceDiagnosticV1[] = [];

    for (const declaration of interfaces)
      addNode(nodes, { ...declaration, classification: 'interface' });
    for (const declaration of implementations)
      addNode(nodes, { ...declaration, classification: 'implementation' });
    for (const declaration of viewModels)
      addNode(nodes, { ...declaration, classification: 'view-model' });

    for (const implementation of implementations) {
      const target = resolveDeclaration(
        implementation.filePath,
        implementation.interfaceName,
        implementation.interfaceBinding,
        interfaces,
        project
      );
      if (target.status !== 'resolved') {
        diagnostics.push(
          resolutionDiagnostic(
            target.status,
            `repository interface ${implementation.interfaceName}: ${target.detail}`,
            implementation.interfaceLocation
          )
        );
        continue;
      }
      addEdge(
        edges,
        frameworkEdge({
          resolver: 'mobile-repository',
          edgeType: 'declares_resource',
          sourceNodeId: declarationId(implementation),
          targetNodeId: declarationId(target.value),
          sourceLanguage: languageFor(implementation.filePath),
          targetLanguage: languageFor(target.value.filePath),
          confidence: 0.98,
          confidenceClass: 'framework-inferred',
          evidenceKind: 'mobile-explicit-interface-implementation',
          locations: [
            implementation.location,
            implementation.interfaceLocation,
            target.value.location,
          ],
        })
      );
    }

    for (const use of [...uses].sort(compareUses)) {
      const source = resolveUseSource(use, project);
      if (source.status !== 'resolved') {
        diagnostics.push(
          resolutionDiagnostic(
            source.status,
            `${use.mode === 'hook-return' ? 'hook' : 'owner'} for ${use.viewModelName}: ${source.detail}`,
            use.location
          )
        );
        continue;
      }
      const target = resolveDeclaration(
        source.value.bindingImporter,
        use.viewModelName,
        use.viewModelBinding,
        viewModels,
        project
      );
      if (target.status !== 'resolved') {
        diagnostics.push(
          resolutionDiagnostic(
            target.status,
            `ViewModel ${use.viewModelName}: ${target.detail}`,
            use.location
          )
        );
        continue;
      }
      addNode(nodes, source.value.declaration);
      addEdge(
        edges,
        frameworkEdge({
          resolver: 'mobile-view-model',
          edgeType: 'uses_view_model',
          sourceNodeId: declarationId(source.value.declaration),
          targetNodeId: declarationId(target.value),
          sourceLanguage: languageFor(source.value.declaration.filePath),
          targetLanguage: languageFor(target.value.filePath),
          confidence: 0.95,
          confidenceClass: 'framework-inferred',
          evidenceKind:
            use.mode === 'hook-return'
              ? 'mobile-resolved-hook-view-model'
              : 'mobile-direct-view-model-construction',
          locations: [source.value.declaration.location, use.location, target.value.location],
        })
      );
    }

    return Promise.resolve({
      nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
      edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
      diagnostics: sortDiagnostics(diagnostics),
    });
  }
}

function resolveDeclaration<T extends MobileDeclarationV1>(
  importerFile: string,
  localName: string,
  binding: MobileBindingV1 | undefined,
  declarations: readonly T[],
  project: ProjectResolutionContextV1
): Resolution<T> {
  if (!binding) {
    return exactlyOne(
      declarations.filter(
        (declaration) =>
          declaration.filePath === importerFile && declaration.localName === localName
      ),
      `${localName} has no exact local declaration`
    );
  }

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
    return { status: 'ambiguous', detail: `${binding.localName} has an ambiguous project binding` };
  }
  if (resolution.module.status !== 'resolved' || resolution.exported?.status !== 'resolved') {
    return {
      status: 'unresolved',
      detail: `${binding.localName} resolves as ${resolution.module.status}`,
    };
  }
  const target = resolution.exported.target;
  return exactlyOne(
    declarations.filter((declaration) => matchesExportTarget(declaration, target)),
    `${binding.localName} does not resolve to an exact declaration`
  );
}

function resolveUseSource(
  use: MobileViewModelUseFactV1,
  project: ProjectResolutionContextV1
): Resolution<{ declaration: CanonicalDeclaration; bindingImporter: string }> {
  if (use.mode === 'direct') {
    return {
      status: 'resolved',
      value: {
        declaration: { ...use.owner, classification: 'owner' },
        bindingImporter: use.filePath,
      },
    };
  }
  if (!use.hookName) return { status: 'unresolved', detail: 'hook-return fact has no hook name' };
  if (!use.hookBinding) {
    return {
      status: 'resolved',
      value: {
        declaration: {
          filePath: use.filePath,
          localName: use.hookName,
          exportName: use.hookName,
          location: use.location,
          classification: 'hook',
        },
        bindingImporter: use.filePath,
      },
    };
  }

  const resolution = resolveProjectBinding(
    {
      importerFile: use.filePath,
      specifier: use.hookBinding.sourceSpecifier,
      importedName: use.hookBinding.importedName,
      mode: 'import',
    },
    project
  );
  if (resolution.module.status === 'ambiguous' || resolution.exported?.status === 'ambiguous') {
    return { status: 'ambiguous', detail: `${use.hookName} has an ambiguous project binding` };
  }
  if (resolution.module.status !== 'resolved' || resolution.exported?.status !== 'resolved') {
    return { status: 'unresolved', detail: `${use.hookName} has no exact project binding` };
  }
  const target = resolution.exported.target;
  const localName = target.declarationId ?? target.localName;
  return {
    status: 'resolved',
    value: {
      declaration: {
        filePath: target.filePath,
        localName,
        exportName: use.hookBinding.importedName,
        location: use.location,
        classification: 'hook',
      },
      bindingImporter: target.filePath,
    },
  };
}

function matchesExportTarget(declaration: MobileDeclarationV1, target: ExportTargetV1): boolean {
  const targetName = target.declarationId ?? target.localName;
  return declaration.filePath === target.filePath && declaration.localName === targetName;
}

function exactlyOne<T>(values: readonly T[], missingDetail: string): Resolution<T> {
  if (values.length === 1) return { status: 'resolved', value: values[0] };
  if (values.length > 1)
    return { status: 'ambiguous', detail: 'multiple exact declarations match' };
  return { status: 'unresolved', detail: missingDetail };
}

function uniqueDeclarations<T extends MobileDeclarationV1>(values: readonly T[]): T[] {
  const result = new Map<string, T>();
  for (const value of values) {
    const key = [
      value.filePath,
      value.localName,
      value.exportName,
      value.location.line,
      value.location.column,
    ].join('\0');
    if (!result.has(key)) result.set(key, value);
  }
  return [...result.values()].sort((left, right) =>
    declarationId(left).localeCompare(declarationId(right))
  );
}

function addNode(nodes: Map<string, StructuralNode>, declaration: CanonicalDeclaration): void {
  const id = declarationId(declaration);
  if (nodes.has(id)) return;
  nodes.set(id, {
    id,
    node_type: 'symbol',
    file_path: declaration.filePath,
    language_id: languageFor(declaration.filePath),
    symbol_name: declaration.localName,
    symbol_kind: declaration.classification === 'interface' ? 'interface' : 'class/function',
    metadata: JSON.stringify({
      framework: 'mobile',
      kind: declaration.classification,
      exportName: declaration.exportName,
    }),
    updated_at: 0,
  });
}

function addEdge(edges: Map<string, StructuralRelationEdge>, edge: StructuralRelationEdge): void {
  if (!edges.has(edge.id)) edges.set(edge.id, edge);
}

function declarationId(declaration: MobileDeclarationV1): string {
  return tsSymbolNodeId(declaration.filePath, declaration.localName);
}

function resolutionDiagnostic(
  status: 'unresolved' | 'ambiguous',
  detail: string,
  location: SourceLocationV1
): SourceDiagnosticV1 {
  return {
    code: status === 'ambiguous' ? 'MOBILE_AMBIGUOUS_BINDING' : 'MOBILE_UNRESOLVED_BINDING',
    message: `Cannot resolve ${detail}.`,
    location,
  };
}

function languageFor(filePath: string): 'typescript' | 'javascript' {
  return /\.[cm]?tsx?$/u.test(filePath) && !/\.[cm]?jsx?$/u.test(filePath)
    ? 'typescript'
    : 'javascript';
}

function compareUses(left: MobileViewModelUseFactV1, right: MobileViewModelUseFactV1): number {
  return [left.filePath, left.location.line, left.location.column, left.viewModelName]
    .join('\0')
    .localeCompare(
      [right.filePath, right.location.line, right.location.column, right.viewModelName].join('\0')
    );
}
