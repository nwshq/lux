import type { StructuralNode } from '../../../../db/types.js';
import { TREE_SITTER_PRODUCERS } from '../../../adapters/registry.js';
import type { SourceDiagnosticV1, SourceLocationV1 } from '../../../contracts/program.js';
import {
  novaArtifactId,
  programEdgeId,
  vueComponentId,
} from '../../../identity/program-identity.js';
import type {
  AssociationContext,
  AssociationResolver,
  StructuralRelationEdge,
} from '../../types.js';
import { fileNodeId, phpSymbolNodeId } from '../../types.js';
import {
  extractNovaFacts,
  type NovaAssetFactV1,
  type NovaClassFactV1,
  type NovaFactOptionsV1,
  type NovaFrontendComponentFactV1,
} from './nova-facts.js';

const PRODUCER = 'laravel-nova';
const CONFIDENCE = 1;

export interface NovaResolutionV1 {
  /** Artifact/file nodes the central integration owner materializes before edges. */
  nodes: StructuralNode[];
  edges: StructuralRelationEdge[];
  diagnostics: SourceDiagnosticV1[];
}

export interface NovaResolverOptionsV1 extends NovaFactOptionsV1 {
  now?: () => number;
  onDiagnostic?: (diagnostic: SourceDiagnosticV1) => void;
}

/**
 * Build the static Nova graph. This leaf returns nodes and edges but performs no
 * persistence; central materialization owns database writes and resolver wiring.
 */
export function resolveNova(
  context: AssociationContext,
  options: NovaResolverOptionsV1 = {}
): NovaResolutionV1 {
  const facts = extractNovaFacts(context, options);
  const diagnostics = [...facts.diagnostics];
  const existing = new Map(context.nodes.map((node) => [node.id, node]));
  const classFacts = new Map(facts.classes.map((item) => [item.qualifiedName, item]));
  const knownClasses = new Set(facts.classes.map((item) => item.qualifiedName));
  const now = options.now?.() ?? Math.floor(Date.now() / 1000);
  const nodes = new Map<string, StructuralNode>();
  const edges = new Map<string, StructuralRelationEdge>();

  for (const registration of facts.registrations) {
    const source = classEndpoint(registration.providerQualifiedName, classFacts, existing);
    const target = classEndpoint(registration.targetQualifiedName, classFacts, existing);
    if (!source || !target) {
      diagnostics.push(
        resolutionDiagnostic(
          'nova-registration-endpoint-missing',
          'Nova registration endpoints must resolve to exact scanned PHP symbols.',
          registration.location
        )
      );
      continue;
    }
    addEdge(edges, {
      edgeType: 'provides_capability',
      sourceId: source.id,
      targetId: target.id,
      sourceLanguage: 'php',
      targetLanguage: 'php',
      evidenceKind: `nova-${registration.form}-${registration.kind}`,
      locations: [
        registration.location,
        classFacts.get(registration.targetQualifiedName)!.location,
      ],
      now,
    });
  }

  for (const resource of facts.classes.filter((item) => item.kind === 'resource')) {
    if (!resource.modelQualifiedName || !resource.modelLocation) continue;
    const source = classEndpoint(resource.qualifiedName, classFacts, existing);
    const target = exactPhpEndpoint(resource.modelQualifiedName, knownClasses, existing);
    if (!source || !target) {
      diagnostics.push(
        resolutionDiagnostic(
          'nova-model-target-missing',
          'Nova model must resolve to an exact scanned PHP class; basename matching is forbidden.',
          resource.modelLocation
        )
      );
      continue;
    }
    addEdge(edges, {
      edgeType: 'transforms_model',
      sourceId: source.id,
      targetId: target.id,
      sourceLanguage: 'php',
      targetLanguage: 'php',
      evidenceKind: 'nova-static-resource-model',
      locations: [resource.location, resource.modelLocation],
      now,
    });
  }

  for (const asset of facts.assets) {
    addAssetNode(nodes, asset, now);
    if (asset.kind !== 'script') continue;
    const target = frontendEndpoint(asset.targetFile, existing);
    if (!target) {
      diagnostics.push(
        resolutionDiagnostic(
          'nova-script-target-missing',
          'Nova script target is not an exact scanned first-party frontend endpoint.',
          asset.location
        )
      );
      continue;
    }
    addEdge(edges, {
      edgeType: 'hydrates_component',
      sourceId: novaArtifactId(asset.registrationFile, asset.name),
      targetId: target.id,
      sourceLanguage: 'nova',
      targetLanguage: target.language,
      evidenceKind: 'nova-static-script',
      locations: [asset.location, { filePath: asset.targetFile, line: 1, column: 0 }],
      now,
    });
  }

  const componentsByName = groupComponents(facts.frontendComponents);
  for (const item of facts.classes.filter(
    (candidate) =>
      (candidate.kind === 'tool' || candidate.kind === 'card') && candidate.componentName
  )) {
    const matches = componentsByName.get(item.componentName!) ?? [];
    if (matches.length !== 1) {
      diagnostics.push(
        resolutionDiagnostic(
          matches.length === 0
            ? 'nova-component-target-missing'
            : 'nova-component-target-ambiguous',
          `Nova ${item.kind} component ${item.componentName} resolved to ${matches.length} exact entrypoints.`,
          item.componentLocation ?? item.location
        )
      );
      continue;
    }
    addComponentArtifact(nodes, item, matches[0], now);
    addEdge(edges, {
      edgeType: 'hydrates_component',
      sourceId: novaArtifactId(item.filePath, item.componentName!),
      targetId: vueComponentId(matches[0].targetFile),
      sourceLanguage: 'nova',
      targetLanguage: 'vue',
      evidenceKind: `nova-${item.kind}-component`,
      locations: [item.componentLocation ?? item.location, matches[0].location],
      now,
    });
  }

  for (const diagnostic of diagnostics) options.onDiagnostic?.(diagnostic);
  return {
    nodes: [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
    diagnostics,
  };
}

/** AssociationEngine-compatible edge seam; central integration materializes result.nodes first. */
export class NovaAssociationResolver implements AssociationResolver {
  readonly name = PRODUCER;

  constructor(private readonly options: NovaResolverOptionsV1 = {}) {}

  supports(context: AssociationContext): boolean {
    // Nova facts are PHP-parser dependent. A failed/disabled PHP producer must not be
    // misreported as an applicable framework pass, even when source text resembles Nova.
    if (!context.programAnalysis?.producersRun.has(TREE_SITTER_PRODUCERS.php)) return false;
    const facts = extractNovaFacts(context, this.options);
    return (
      facts.registrations.length > 0 ||
      facts.assets.length > 0 ||
      facts.frontendComponents.length > 0 ||
      facts.classes.some((item) => item.kind !== 'class')
    );
  }

  resolve(context: AssociationContext): Promise<StructuralRelationEdge[]> {
    const result = resolveNova(context, this.options);
    const materialized = new Set([
      ...context.nodes.map((node) => node.id),
      ...result.nodes.map((node) => node.id),
    ]);
    return Promise.resolve(
      result.edges.filter(
        (edge) => materialized.has(edge.sourceNodeId) && materialized.has(edge.targetNodeId)
      )
    );
  }
}

function classEndpoint(
  qualifiedName: string,
  classFacts: ReadonlyMap<string, NovaClassFactV1>,
  existing: ReadonlyMap<string, StructuralNode>
): StructuralNode | undefined {
  if (!classFacts.has(qualifiedName)) return undefined;
  return existing.get(phpSymbolNodeId(qualifiedName));
}

function exactPhpEndpoint(
  qualifiedName: string,
  knownClasses: ReadonlySet<string>,
  existing: ReadonlyMap<string, StructuralNode>
): StructuralNode | undefined {
  if (!knownClasses.has(qualifiedName)) return undefined;
  return existing.get(phpSymbolNodeId(qualifiedName));
}

function frontendEndpoint(
  targetFile: string,
  existing: ReadonlyMap<string, StructuralNode>
): { id: string; language: string } | undefined {
  if (targetFile.endsWith('.vue')) {
    const id = vueComponentId(targetFile);
    return existing.has(id) ? { id, language: 'vue' } : undefined;
  }
  if (!/\.(?:[cm]?[jt]sx?)$/u.test(targetFile)) return undefined;
  const id = fileNodeId(targetFile);
  if (!existing.has(id)) return undefined;
  return {
    id,
    language: /\.tsx?$/u.test(targetFile) ? 'typescript' : 'javascript',
  };
}

function addAssetNode(
  nodes: Map<string, StructuralNode>,
  asset: NovaAssetFactV1,
  now: number
): void {
  const id = novaArtifactId(asset.registrationFile, asset.name);
  nodes.set(id, {
    id,
    node_type: 'artifact',
    file_path: asset.registrationFile,
    language_id: 'nova',
    symbol_name: asset.name,
    symbol_kind: asset.kind === 'script' ? 'NovaScript' : 'NovaStyle',
    metadata: JSON.stringify({ kind: asset.kind, targetFile: asset.targetFile }),
    origin: 'local',
    updated_at: now,
  });
}

function addComponentArtifact(
  nodes: Map<string, StructuralNode>,
  owner: NovaClassFactV1,
  entrypoint: NovaFrontendComponentFactV1,
  now: number
): void {
  const id = novaArtifactId(owner.filePath, owner.componentName!);
  nodes.set(id, {
    id,
    node_type: 'artifact',
    file_path: owner.filePath,
    language_id: 'nova',
    symbol_name: owner.componentName,
    symbol_kind: owner.kind === 'tool' ? 'NovaToolComponent' : 'NovaCardComponent',
    metadata: JSON.stringify({
      owner: owner.qualifiedName,
      registrationFile: entrypoint.registrationFile,
      targetFile: entrypoint.targetFile,
    }),
    origin: 'local',
    updated_at: now,
  });
}

function groupComponents(
  facts: readonly NovaFrontendComponentFactV1[]
): ReadonlyMap<string, NovaFrontendComponentFactV1[]> {
  const result = new Map<string, NovaFrontendComponentFactV1[]>();
  for (const fact of facts) result.set(fact.name, [...(result.get(fact.name) ?? []), fact]);
  return result;
}

function addEdge(
  edges: Map<string, StructuralRelationEdge>,
  input: {
    edgeType: 'provides_capability' | 'transforms_model' | 'hydrates_component';
    sourceId: string;
    targetId: string;
    sourceLanguage: string;
    targetLanguage: string;
    evidenceKind: string;
    locations: readonly SourceLocationV1[];
    now: number;
  }
): void {
  const id = programEdgeId(input.edgeType, input.sourceId, input.targetId, PRODUCER);
  const locations = uniqueLocations(input.locations);
  const existing = edges.get(id);
  if (existing) {
    existing.provenance.evidenceLocations = uniqueLocations([
      ...existing.provenance.evidenceLocations.map((item) => ({
        filePath: item.filePath,
        line: item.line ?? 1,
        column: 0,
      })),
      ...locations,
    ]);
    return;
  }
  edges.set(id, {
    id,
    edgeType: input.edgeType,
    sourceNodeId: input.sourceId,
    targetNodeId: input.targetId,
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    confidence: CONFIDENCE,
    confidenceClass: 'artifact-backed',
    provenance: {
      resolver: PRODUCER,
      evidenceKind: input.evidenceKind,
      evidenceLocations: locations,
      extractedAt: input.now,
    },
  });
}

function uniqueLocations(locations: readonly SourceLocationV1[]): SourceLocationV1[] {
  const result = new Map<string, SourceLocationV1>();
  for (const item of locations) {
    result.set(`${item.filePath}\0${item.line}\0${item.column}`, item);
  }
  return [...result.values()].sort((left, right) =>
    `${left.filePath}\0${left.line}\0${left.column}`.localeCompare(
      `${right.filePath}\0${right.line}\0${right.column}`
    )
  );
}

function resolutionDiagnostic(
  code: string,
  message: string,
  location: SourceLocationV1
): SourceDiagnosticV1 {
  return { code, message, location };
}
