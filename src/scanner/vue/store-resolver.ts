import type { StructuralRelationEdge } from '../associations/types.js';
import { tsSymbolNodeId } from '../associations/types.js';
import type { RelationshipResolverV1 } from '../adapters/types.js';
import type {
  ExportTargetV1,
  ProjectResolutionContextV1,
  SourceFactsV1,
  SourceLocationV1,
} from '../contracts/program.js';
import { programEdgeId, vueComponentId } from '../identity/program-identity.js';
import { resolveProjectBinding } from '../project-resolution/resolver.js';
import {
  isVueSfcFacts,
  type VueCallFactV1,
  type VueImportBindingV1,
  type VueSfcFactsV1,
  type VueStoreDeclarationV1,
} from './types.js';

const EDGE_TYPE = 'uses_store' as const;
const CONFIDENCE = 0.9;

/** Optional exact identifier arguments produced by a syntax enricher. String literals are excluded. */
export interface VueStoreCallFactV1 extends VueCallFactV1 {
  argumentBindings?: readonly string[];
}

export interface VueStoreResolverOptions {
  now?: () => number;
}

interface StoreFactsV1 extends SourceFactsV1 {
  stores: VueStoreDeclarationV1[];
}

interface ResolvedStore {
  targetId: string;
  targetLanguage: string;
  declaration: VueStoreDeclarationV1;
  evidenceFile?: string;
}

interface StoreUse {
  importLocations: VueImportBindingV1[];
  callLocation: SourceLocationV1;
  resolved: ResolvedStore;
  kind: 'pinia-call' | 'vuex-direct-reference' | 'vuex-keyed-use-store';
}

/** Resolve exact Pinia and Vuex use sites to their existing exported symbol nodes. */
export class VueStoreResolver implements RelationshipResolverV1 {
  readonly id = 'vue-store';

  constructor(private readonly options: VueStoreResolverOptions = {}) {}

  resolve(
    facts: readonly SourceFactsV1[],
    project: ProjectResolutionContextV1
  ): Promise<StructuralRelationEdge[]> {
    const factsByPath = uniqueStoreFactsByPath(facts);
    const edges = new Map<string, StructuralRelationEdge>();
    const extractedAt = this.options.now?.() ?? Math.floor(Date.now() / 1000);

    for (const component of facts.filter(isVueSfcFacts).sort(compareFacts)) {
      if (component.componentId !== vueComponentId(component.filePath)) continue;
      const uses = [
        ...directStoreUses(component, factsByPath, project),
        ...keyedVuexUses(component, factsByPath, project),
      ];

      for (const use of uses) {
        const edgeId = programEdgeId(
          EDGE_TYPE,
          component.componentId,
          use.resolved.targetId,
          this.id
        );
        const locations = storeEvidence(use);
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
          targetNodeId: use.resolved.targetId,
          sourceLanguage: 'vue',
          targetLanguage: use.resolved.targetLanguage,
          confidence: CONFIDENCE,
          confidenceClass: 'framework-inferred',
          provenance: {
            resolver: this.id,
            evidenceKind: `vue-resolved-${use.kind}`,
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

function directStoreUses(
  component: VueSfcFactsV1,
  factsByPath: ReadonlyMap<string, StoreFactsV1>,
  project: ProjectResolutionContextV1
): StoreUse[] {
  const uses: StoreUse[] = [];
  for (const binding of component.imports) {
    if (binding.importedName === '*' || hasLocalShadow(component, binding.localName)) continue;
    const resolved = resolveImportedStore(binding, component.filePath, factsByPath, project);
    if (!resolved) continue;

    const calls = component.calls.filter((call) => {
      if (resolved.declaration.kind === 'pinia') {
        return call.callee === binding.localName && call.localBinding === binding.localName;
      }
      return (
        (call.callee === binding.localName && call.localBinding === binding.localName) ||
        call.callee.startsWith(`${binding.localName}.`)
      );
    });
    for (const call of calls) {
      uses.push({
        importLocations: [binding],
        callLocation: call.location,
        resolved,
        kind: resolved.declaration.kind === 'pinia' ? 'pinia-call' : 'vuex-direct-reference',
      });
    }
  }
  return uses;
}

function keyedVuexUses(
  component: VueSfcFactsV1,
  factsByPath: ReadonlyMap<string, StoreFactsV1>,
  project: ProjectResolutionContextV1
): StoreUse[] {
  const uses: StoreUse[] = [];
  const useStoreImports = component.imports.filter(
    (binding) =>
      binding.specifier === 'vuex' &&
      binding.importedName === 'useStore' &&
      !hasLocalShadow(component, binding.localName)
  );

  for (const frameworkImport of useStoreImports) {
    for (const call of component.calls) {
      if (
        call.callee !== frameworkImport.localName ||
        call.localBinding !== frameworkImport.localName
      ) {
        continue;
      }
      const argumentBindings = identifierArguments(call);
      if (argumentBindings.length !== 1) continue;
      const keyImport = component.imports.find(
        (binding) => binding.localName === argumentBindings[0] && binding.specifier !== 'vuex'
      );
      if (!keyImport || hasLocalShadow(component, keyImport.localName)) continue;

      const resolution = resolveProjectBinding(
        {
          importerFile: component.filePath,
          specifier: keyImport.specifier,
          importedName: keyImport.importedName,
          mode: 'import',
        },
        project
      );
      if (resolution.module.status !== 'resolved' || resolution.exported?.status !== 'resolved') {
        continue;
      }
      const targetFile = resolution.exported.target.filePath;
      const sourceFacts = factsByPath.get(targetFile);
      const declarations = sourceFacts?.stores.filter((store) => store.kind === 'vuex') ?? [];
      if (!sourceFacts || declarations.length !== 1) continue;
      const declaration = declarations[0];
      const symbolName = storeSymbolName(resolution.exported.target, declaration);
      uses.push({
        importLocations: [frameworkImport, keyImport],
        callLocation: call.location,
        resolved: {
          targetId: tsSymbolNodeId(targetFile, symbolName),
          targetLanguage: sourceFacts.languageId,
          declaration,
          ...(resolution.module.evidenceFile
            ? { evidenceFile: resolution.module.evidenceFile }
            : {}),
        },
        kind: 'vuex-keyed-use-store',
      });
    }
  }
  return uses;
}

function resolveImportedStore(
  binding: VueImportBindingV1,
  importerFile: string,
  factsByPath: ReadonlyMap<string, StoreFactsV1>,
  project: ProjectResolutionContextV1
): ResolvedStore | undefined {
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
  if (!sourceFacts) return undefined;
  const declarations = matchingStores(sourceFacts.stores, target, binding.importedName);
  if (declarations.length !== 1) return undefined;
  const declaration = declarations[0];
  return {
    targetId: tsSymbolNodeId(target.filePath, storeSymbolName(target, declaration)),
    targetLanguage: sourceFacts.languageId,
    declaration,
    ...(resolution.module.evidenceFile ? { evidenceFile: resolution.module.evidenceFile } : {}),
  };
}

function matchingStores(
  stores: readonly VueStoreDeclarationV1[],
  target: ExportTargetV1,
  importedName: string
): VueStoreDeclarationV1[] {
  const symbolName = target.declarationId ?? target.localName;
  return stores.filter(
    (store) =>
      store.localName === symbolName ||
      store.exportName === symbolName ||
      (importedName === 'default' && store.exportName === 'default')
  );
}

function storeSymbolName(target: ExportTargetV1, declaration: VueStoreDeclarationV1): string {
  return (
    target.declarationId ??
    (target.localName === 'default' || declaration.localName === 'default'
      ? 'default'
      : target.localName)
  );
}

function identifierArguments(call: VueCallFactV1): readonly string[] {
  const values: readonly string[] | undefined = (call as VueStoreCallFactV1).argumentBindings;
  if (!values) return [];
  return values.every((value) => /^[A-Za-z_$][\w$]*$/u.test(value)) ? values : [];
}

function uniqueStoreFactsByPath(
  facts: readonly SourceFactsV1[]
): ReadonlyMap<string, StoreFactsV1> {
  const result = new Map<string, StoreFactsV1>();
  const ambiguous = new Set<string>();
  for (const fact of facts) {
    if (!hasStores(fact)) continue;
    if (result.has(fact.filePath)) {
      result.delete(fact.filePath);
      ambiguous.add(fact.filePath);
    } else if (!ambiguous.has(fact.filePath)) {
      result.set(fact.filePath, fact);
    }
  }
  return result;
}

function hasStores(facts: SourceFactsV1): facts is StoreFactsV1 {
  return 'stores' in facts && Array.isArray((facts as Partial<StoreFactsV1>).stores);
}

function hasLocalShadow(component: VueSfcFactsV1, localName: string): boolean {
  return component.declarations.some(
    (declaration) => declaration.name === localName || declaration.localId === localName
  );
}

function storeEvidence(use: StoreUse): StructuralRelationEdge['provenance']['evidenceLocations'] {
  const locations: StructuralRelationEdge['provenance']['evidenceLocations'] = [
    ...use.importLocations.map((binding) => ({
      filePath: binding.location.filePath,
      line: binding.location.line,
      note: `resolved import ${binding.localName} from ${binding.specifier}`,
    })),
    {
      filePath: use.resolved.declaration.location.filePath,
      line: use.resolved.declaration.location.line,
      note: `exported ${use.resolved.declaration.kind} store declaration`,
    },
    {
      filePath: use.callLocation.filePath,
      line: use.callLocation.line,
      note: use.kind,
    },
  ];
  if (use.resolved.evidenceFile) {
    locations.push({
      filePath: use.resolved.evidenceFile,
      note: 'project resolution evidence for store import',
    });
  }
  return mergeEvidence([], locations);
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
