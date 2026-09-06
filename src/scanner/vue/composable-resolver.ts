import type { StructuralRelationEdge } from '../associations/types.js';
import { tsSymbolNodeId } from '../associations/types.js';
import type { RelationshipResolverV1 } from '../adapters/types.js';
import type {
  ProjectResolutionContextV1,
  SourceFactsV1,
  SourceLocationV1,
} from '../contracts/program.js';
import { programEdgeId, vueComponentId } from '../identity/program-identity.js';
import { resolveProjectBinding } from '../project-resolution/resolver.js';
import { isVueSfcFacts, type VueImportBindingV1, type VueSfcFactsV1 } from './types.js';

const EDGE_TYPE = 'uses_composable' as const;
const CONFIDENCE = 0.9;
const COMPOSABLE_NAME = /^use[A-Z0-9]/u;

export interface VueComposableResolverOptions {
  now?: () => number;
}

interface ResolvedComposable {
  targetId: string;
  targetLanguage: string;
  declaration: SourceLocationV1;
  evidenceFile?: string;
}

/** Resolve calls of imported Vue composables to their existing exported symbol nodes. */
export class VueComposableResolver implements RelationshipResolverV1 {
  readonly id = 'vue-composable';

  constructor(private readonly options: VueComposableResolverOptions = {}) {}

  resolve(
    facts: readonly SourceFactsV1[],
    project: ProjectResolutionContextV1
  ): Promise<StructuralRelationEdge[]> {
    const factsByPath = uniqueFactsByPath(facts);
    const edges = new Map<string, StructuralRelationEdge>();
    const extractedAt = this.options.now?.() ?? Math.floor(Date.now() / 1000);

    for (const component of facts.filter(isVueSfcFacts).sort(compareFacts)) {
      if (component.componentId !== vueComponentId(component.filePath)) continue;

      for (const binding of [...component.imports].sort(compareImports)) {
        if (binding.importedName === '*') continue;
        if (hasLocalShadow(component, binding.localName)) continue;

        const calls = component.calls.filter(
          (call) => call.callee === binding.localName && call.localBinding === binding.localName
        );
        if (calls.length === 0) continue;

        const resolved = resolveComposable(binding, component.filePath, factsByPath, project);
        if (!resolved) continue;

        const edgeId = programEdgeId(EDGE_TYPE, component.componentId, resolved.targetId, this.id);
        const locations = composableEvidence(
          binding,
          resolved,
          calls.map((call) => call.location)
        );
        const existing = edges.get(edgeId);
        if (existing) {
          existing.provenance.evidenceLocations = mergeEvidence(
            existing.provenance.evidenceLocations,
            locations
          );
          continue;
        }

        edges.set(edgeId, {
          id: edgeId,
          edgeType: EDGE_TYPE,
          sourceNodeId: component.componentId,
          targetNodeId: resolved.targetId,
          sourceLanguage: 'vue',
          targetLanguage: resolved.targetLanguage,
          confidence: CONFIDENCE,
          confidenceClass: 'framework-inferred',
          provenance: {
            resolver: this.id,
            evidenceKind: 'vue-resolved-composable-call',
            evidenceLocations: locations,
            extractedAt,
          },
        });
      }
    }

    return Promise.resolve(
      [...edges.values()].sort((left, right) => left.id.localeCompare(right.id))
    );
  }
}

function resolveComposable(
  binding: VueImportBindingV1,
  importerFile: string,
  factsByPath: ReadonlyMap<string, SourceFactsV1>,
  project: ProjectResolutionContextV1
): ResolvedComposable | undefined {
  const resolution = resolveProjectBinding(
    {
      importerFile,
      specifier: binding.specifier,
      importedName: binding.importedName,
      mode: 'import',
    },
    project
  );
  if (resolution.module.status !== 'resolved' || resolution.exported?.status !== 'resolved') {
    return undefined;
  }

  const target = resolution.exported.target;
  const sourceFacts = factsByPath.get(target.filePath);
  if (
    !sourceFacts ||
    (sourceFacts.languageId !== 'javascript' && sourceFacts.languageId !== 'typescript')
  ) {
    return undefined;
  }

  const symbolName = target.declarationId ?? target.localName;
  const declarations = sourceFacts.declarations.filter(
    (declaration) =>
      declaration.kind === 'function' &&
      (declaration.localId === symbolName || declaration.name === symbolName)
  );
  if (declarations.length !== 1 || !COMPOSABLE_NAME.test(declarations[0].name)) return undefined;

  return {
    targetId: tsSymbolNodeId(target.filePath, symbolName),
    targetLanguage: sourceFacts.languageId,
    declaration: declarations[0].location,
    ...(resolution.module.evidenceFile ? { evidenceFile: resolution.module.evidenceFile } : {}),
  };
}

function uniqueFactsByPath(facts: readonly SourceFactsV1[]): ReadonlyMap<string, SourceFactsV1> {
  const result = new Map<string, SourceFactsV1>();
  const ambiguous = new Set<string>();
  for (const fact of facts) {
    if (result.has(fact.filePath)) {
      result.delete(fact.filePath);
      ambiguous.add(fact.filePath);
    } else if (!ambiguous.has(fact.filePath)) {
      result.set(fact.filePath, fact);
    }
  }
  return result;
}

function hasLocalShadow(component: VueSfcFactsV1, localName: string): boolean {
  return component.declarations.some(
    (declaration) => declaration.name === localName || declaration.localId === localName
  );
}

function composableEvidence(
  binding: VueImportBindingV1,
  resolved: ResolvedComposable,
  calls: readonly SourceLocationV1[]
): StructuralRelationEdge['provenance']['evidenceLocations'] {
  return mergeEvidence(
    [
      {
        filePath: binding.location.filePath,
        line: binding.location.line,
        note: `resolved import ${binding.localName} from ${binding.specifier}`,
      },
      {
        filePath: resolved.declaration.filePath,
        line: resolved.declaration.line,
        note: 'exported composable declaration',
      },
      ...calls.map((call) => ({
        filePath: call.filePath,
        line: call.line,
        note: `call of imported binding ${binding.localName}`,
      })),
    ],
    resolved.evidenceFile
      ? [
          {
            filePath: resolved.evidenceFile,
            note: `project resolution evidence for ${binding.specifier}`,
          },
        ]
      : []
  );
}

function mergeEvidence(
  left: StructuralRelationEdge['provenance']['evidenceLocations'],
  right: StructuralRelationEdge['provenance']['evidenceLocations']
): StructuralRelationEdge['provenance']['evidenceLocations'] {
  const result = new Map<string, (typeof left)[number]>();
  for (const location of [...left, ...right]) {
    const key = `${location.filePath}\0${location.line ?? ''}\0${location.note ?? ''}`;
    result.set(key, location);
  }
  return [...result.values()].sort((a, b) =>
    `${a.filePath}\0${a.line ?? ''}\0${a.note ?? ''}`.localeCompare(
      `${b.filePath}\0${b.line ?? ''}\0${b.note ?? ''}`
    )
  );
}

function compareFacts(left: SourceFactsV1, right: SourceFactsV1): number {
  return left.filePath.localeCompare(right.filePath);
}

function compareImports(left: VueImportBindingV1, right: VueImportBindingV1): number {
  return [left.specifier, left.importedName, left.localName]
    .join('\0')
    .localeCompare([right.specifier, right.importedName, right.localName].join('\0'));
}
