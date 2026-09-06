import type { StructuralNode } from '../../../../db/types.js';
import { TREE_SITTER_PRODUCERS } from '../../../adapters/registry.js';
import type { SourceDiagnosticV1, SourceLocationV1 } from '../../../contracts/program.js';
import { bladeTemplateId, programEdgeId } from '../../../identity/program-identity.js';
import type {
  AssociationContext,
  AssociationResolver,
  StructuralRelationEdge,
} from '../../types.js';
import { phpSymbolNodeId } from '../../types.js';
import { extractBladeLivewireFacts, isBladePath } from './blade-livewire.js';
import {
  DEFAULT_LIVEWIRE_FRAMEWORK_CONFIG,
  extractLivewireFacts,
  isSafeRepositoryPath,
  isVendorPath,
  normalizeLivewireConfig,
  type LivewireClassFactV1,
  type LivewireFrameworkConfigV1,
  type LivewireRegistrationFactV1,
  type LivewireViewNamespaceFactV1,
} from './livewire-facts.js';

const CONFIDENCE = 0.9;

export interface LivewireResolutionV1 {
  nodes: StructuralNode[];
  edges: StructuralRelationEdge[];
  diagnostics: SourceDiagnosticV1[];
}

export interface LivewireResolverOptions {
  config?: Partial<LivewireFrameworkConfigV1>;
  now?: () => number;
  onDiagnostic?: (diagnostic: SourceDiagnosticV1) => void;
}

/** Pure leaf resolver. Integration owns persistence/materialization and registry wiring. */
export function resolveLivewire(
  context: AssociationContext,
  options: LivewireResolverOptions = {}
): LivewireResolutionV1 {
  const config = normalizeLivewireConfig(options.config ?? DEFAULT_LIVEWIRE_FRAMEWORK_CONFIG);
  const classFacts = extractLivewireFacts(context, config);
  const bladeFacts = extractBladeLivewireFacts(context);
  const diagnostics = [...classFacts.diagnostics, ...bladeFacts.diagnostics];
  const scannedBlade = new Set(
    context.entries.filter((entry) => isBladePath(entry.filePath)).map((entry) => entry.filePath)
  );
  const now = options.now?.() ?? Math.floor(Date.now() / 1000);
  const nodesById = new Map<string, StructuralNode>();
  const edgesById = new Map<string, StructuralRelationEdge>();
  const namespaces = groupNamespaces(classFacts.viewNamespaces);

  for (const component of classFacts.classes) {
    const sourceId = phpSymbolNodeId(component.qualifiedName);
    for (const view of component.views) {
      const candidates = resolveViewName(view.name, config.viewRoots, namespaces, scannedBlade);
      if (candidates.length !== 1) {
        diagnostics.push(
          resolutionDiagnostic(
            candidates.length === 0 ? 'livewire-view-missing' : 'livewire-view-ambiguous',
            `Livewire ${view.kind} view ${view.name} resolved to ${candidates.length} scanned templates.`,
            view.location
          )
        );
        continue;
      }
      addTemplate(nodesById, candidates[0], now);
      addEdge(edgesById, {
        edgeType: 'renders_template',
        sourceId,
        targetId: bladeTemplateId(candidates[0]),
        sourceLanguage: 'php',
        targetLanguage: 'blade',
        kind: view.kind === 'layout' ? 'livewire-literal-layout' : 'livewire-literal-render',
        locations: [component.location, view.location, ...namespaceEvidence(view.name, namespaces)],
        now,
      });
    }

    if (!component.views.some((view) => view.kind === 'render') && component.conventionalName) {
      const candidates = resolveConventionView(
        component.conventionalName,
        config.viewRoots,
        scannedBlade
      );
      if (candidates.length === 1) {
        addTemplate(nodesById, candidates[0], now);
        addEdge(edgesById, {
          edgeType: 'renders_template',
          sourceId,
          targetId: bladeTemplateId(candidates[0]),
          sourceLanguage: 'php',
          targetLanguage: 'blade',
          kind: 'livewire-conventional-view',
          locations: [component.location, { filePath: candidates[0], line: 1, column: 0 }],
          now,
        });
      } else if (candidates.length > 1) {
        diagnostics.push(
          resolutionDiagnostic(
            'livewire-view-ambiguous',
            `Conventional Livewire view ${component.conventionalName} is ambiguous.`,
            component.location
          )
        );
      }
    }
  }

  const mountedComponents = buildMountIndex(classFacts.classes, classFacts.registrations);
  for (const mount of bladeFacts.mounts) {
    const explicit = mountedComponents.registrations.get(mount.name) ?? [];
    const candidates =
      explicit.length > 0 ? explicit : (mountedComponents.conventions.get(mount.name) ?? []);
    if (candidates.length !== 1) {
      diagnostics.push(
        resolutionDiagnostic(
          candidates.length === 0 ? 'livewire-component-missing' : 'livewire-component-ambiguous',
          `Livewire mount ${mount.name} resolved to ${candidates.length} scanned classes.`,
          mount.location
        )
      );
      continue;
    }
    addTemplate(nodesById, mount.filePath, now);
    addEdge(edgesById, {
      edgeType: 'hydrates_component',
      sourceId: bladeTemplateId(mount.filePath),
      targetId: phpSymbolNodeId(candidates[0].qualifiedName),
      sourceLanguage: 'blade',
      targetLanguage: 'php',
      kind: `livewire-${mount.form}-mount`,
      locations: [
        mount.location,
        registrationLocation(mount.name, candidates[0], classFacts.registrations),
      ],
      now,
    });
  }

  for (const diagnostic of diagnostics) options.onDiagnostic?.(diagnostic);
  return {
    nodes: [...nodesById.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...edgesById.values()].sort((left, right) => left.id.localeCompare(right.id)),
    diagnostics,
  };
}

/** AssociationEngine-compatible leaf wrapper; central integration decides when to register it. */
export class LivewireAssociationResolver implements AssociationResolver {
  readonly name = 'livewire';

  constructor(private readonly options: LivewireResolverOptions = {}) {}

  supports(context: AssociationContext): boolean {
    if (!context.programAnalysis?.producersRun.has(TREE_SITTER_PRODUCERS.php)) return false;
    const facts = extractLivewireFacts(context, this.options.config);
    return facts.classes.length > 0 || extractBladeLivewireFacts(context).mounts.length > 0;
  }

  resolve(context: AssociationContext): Promise<StructuralRelationEdge[]> {
    if (!context.programAnalysis?.producersRun.has(TREE_SITTER_PRODUCERS.php)) {
      return Promise.resolve([]);
    }
    const result = resolveLivewire(context, this.options);
    const materialized = new Set(context.nodes.map((node) => node.id));
    return Promise.resolve(
      result.edges.filter(
        (edge) => materialized.has(edge.sourceNodeId) && materialized.has(edge.targetNodeId)
      )
    );
  }
}

function resolveViewName(
  name: string,
  viewRoots: readonly string[],
  namespaces: ReadonlyMap<string, LivewireViewNamespaceFactV1[]>,
  scannedBlade: ReadonlySet<string>
): string[] {
  const separator = name.indexOf('::');
  const roots =
    separator >= 0
      ? (namespaces.get(name.slice(0, separator))?.flatMap((item) => item.roots) ?? [])
      : viewRoots;
  const localName = separator >= 0 ? name.slice(separator + 2) : name;
  return resolveConventionView(localName, roots, scannedBlade);
}

function resolveConventionView(
  name: string,
  roots: readonly string[],
  scannedBlade: ReadonlySet<string>
): string[] {
  const relative = `${name.replaceAll('.', '/')}.blade.php`;
  const candidates = new Set<string>();
  for (const root of roots) {
    const candidate = `${root.replace(/\/$/u, '')}/${relative}`;
    if (
      isSafeRepositoryPath(candidate) &&
      !isVendorPath(candidate) &&
      scannedBlade.has(candidate)
    ) {
      candidates.add(candidate);
    }
  }
  return [...candidates].sort();
}

function groupNamespaces(
  facts: readonly LivewireViewNamespaceFactV1[]
): ReadonlyMap<string, LivewireViewNamespaceFactV1[]> {
  const result = new Map<string, LivewireViewNamespaceFactV1[]>();
  for (const fact of facts)
    result.set(fact.namespace, [...(result.get(fact.namespace) ?? []), fact]);
  return result;
}

function namespaceEvidence(
  name: string,
  namespaces: ReadonlyMap<string, LivewireViewNamespaceFactV1[]>
): SourceLocationV1[] {
  const separator = name.indexOf('::');
  if (separator < 0) return [];
  return (namespaces.get(name.slice(0, separator)) ?? []).map((item) => item.location);
}

function buildMountIndex(
  classes: readonly LivewireClassFactV1[],
  registrations: readonly LivewireRegistrationFactV1[]
): {
  registrations: ReadonlyMap<string, LivewireClassFactV1[]>;
  conventions: ReadonlyMap<string, LivewireClassFactV1[]>;
} {
  const byClass = new Map(classes.map((item) => [item.qualifiedName, item]));
  const registrationIndex = new Map<string, LivewireClassFactV1[]>();
  for (const registration of registrations) {
    const item = byClass.get(registration.className);
    if (item)
      registrationIndex.set(registration.alias, [
        ...(registrationIndex.get(registration.alias) ?? []),
        item,
      ]);
  }
  const conventionIndex = new Map<string, LivewireClassFactV1[]>();
  for (const item of classes) {
    if (!item.conventionalName) continue;
    conventionIndex.set(item.conventionalName, [
      ...(conventionIndex.get(item.conventionalName) ?? []),
      item,
    ]);
  }
  return { registrations: registrationIndex, conventions: conventionIndex };
}

function registrationLocation(
  alias: string,
  component: LivewireClassFactV1,
  registrations: readonly LivewireRegistrationFactV1[]
): SourceLocationV1 {
  return (
    registrations.find((item) => item.alias === alias && item.className === component.qualifiedName)
      ?.location ?? component.location
  );
}

function addTemplate(
  nodes: Map<string, StructuralNode>,
  filePath: string,
  updatedAt: number
): void {
  const id = bladeTemplateId(filePath);
  nodes.set(id, {
    id,
    node_type: 'template',
    file_path: filePath,
    language_id: 'blade',
    symbol_name: filePath
      .replace(/\.blade\.php$/u, '')
      .split('/')
      .pop(),
    symbol_kind: 'BladeTemplate',
    origin: 'local',
    updated_at: updatedAt,
  });
}

function addEdge(
  edges: Map<string, StructuralRelationEdge>,
  input: {
    edgeType: 'renders_template' | 'hydrates_component';
    sourceId: string;
    targetId: string;
    sourceLanguage: string;
    targetLanguage: string;
    kind: string;
    locations: SourceLocationV1[];
    now: number;
  }
): void {
  const id = programEdgeId(input.edgeType, input.sourceId, input.targetId, 'livewire');
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
    confidenceClass: 'framework-inferred',
    provenance: {
      resolver: 'livewire',
      evidenceKind: input.kind,
      evidenceLocations: locations,
      extractedAt: input.now,
    },
  });
}

function uniqueLocations(locations: readonly SourceLocationV1[]): SourceLocationV1[] {
  const byKey = new Map<string, SourceLocationV1>();
  for (const location of locations) {
    byKey.set(`${location.filePath}\0${location.line}\0${location.column}`, location);
  }
  return [...byKey.values()].sort((left, right) =>
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
