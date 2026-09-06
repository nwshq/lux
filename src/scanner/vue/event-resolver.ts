import type { StructuralRelationEdge } from '../associations/types.js';
import type { SourceLocationV1 } from '../contracts/program.js';
import {
  programEdgeId,
  vueComponentEventId,
  vueComponentId,
} from '../identity/program-identity.js';
import type { VueEventFactV1, VueSfcFactsV1 } from './types.js';

const CONFIDENCE = 0.9;

/** A child use already resolved by the Phase 9 component resolver. */
export interface VueResolvedChildV1 {
  parentComponentId: string;
  childComponentId: string;
  childTag: string;
  location: SourceLocationV1;
}

/** Pure event-artifact input for the later persistence/materialization step. */
export interface VueComponentEventArtifactV1 {
  id: string;
  childComponentId: string;
  eventName: string;
  declarations: VueEventFactV1[];
}

export interface VueEventResolutionV1 {
  artifacts: VueComponentEventArtifactV1[];
  edges: StructuralRelationEdge[];
}

export interface VueEventResolverOptionsV1 {
  now?: () => number;
}

function normalizeName(name: string): string {
  return name.replaceAll('-', '').toLocaleLowerCase('en-US');
}

function canonicalFacts(facts: readonly VueSfcFactsV1[]): Map<string, VueSfcFactsV1> {
  const byId = new Map<string, VueSfcFactsV1>();
  const duplicateIds = new Set<string>();
  for (const fact of facts) {
    if (fact.componentId !== vueComponentId(fact.filePath)) continue;
    if (byId.has(fact.componentId)) duplicateIds.add(fact.componentId);
    else byId.set(fact.componentId, fact);
  }
  for (const id of duplicateIds) byId.delete(id);
  return byId;
}

function locationKey(location: SourceLocationV1): string {
  return `${location.filePath}\0${location.line}\0${location.column}`;
}

function sortedDeclarations(events: readonly VueEventFactV1[]): VueEventFactV1[] {
  const unique = new Map<string, VueEventFactV1>();
  for (const event of events) {
    unique.set(`${event.source}\0${event.eventName}\0${locationKey(event.location)}`, event);
  }
  return [...unique.values()].sort((left, right) =>
    `${locationKey(left.location)}\0${left.source}`.localeCompare(
      `${locationKey(right.location)}\0${right.source}`
    )
  );
}

function evidence(
  locations: readonly SourceLocationV1[],
  note: string
): StructuralRelationEdge['provenance']['evidenceLocations'] {
  const unique = new Map<
    string,
    StructuralRelationEdge['provenance']['evidenceLocations'][number]
  >();
  for (const location of locations) {
    const item = { filePath: location.filePath, line: location.line, note };
    unique.set(`${item.filePath}\0${item.line}\0${item.note}`, item);
  }
  return [...unique.values()].sort((left, right) =>
    `${left.filePath}\0${left.line ?? ''}\0${left.note ?? ''}`.localeCompare(
      `${right.filePath}\0${right.line ?? ''}\0${right.note ?? ''}`
    )
  );
}

function mergeEvidence(
  left: StructuralRelationEdge['provenance']['evidenceLocations'],
  right: StructuralRelationEdge['provenance']['evidenceLocations']
): StructuralRelationEdge['provenance']['evidenceLocations'] {
  const merged = new Map<
    string,
    StructuralRelationEdge['provenance']['evidenceLocations'][number]
  >();
  for (const item of [...left, ...right]) {
    merged.set(`${item.filePath}\0${item.line ?? ''}\0${item.note ?? ''}`, item);
  }
  return [...merged.values()].sort((a, b) =>
    `${a.filePath}\0${a.line ?? ''}\0${a.note ?? ''}`.localeCompare(
      `${b.filePath}\0${b.line ?? ''}\0${b.note ?? ''}`
    )
  );
}

/** Resolve static child events and parent listeners without persisting graph rows. */
export class VueEventResolver {
  readonly id = 'vue-component-event';

  constructor(private readonly options: VueEventResolverOptionsV1 = {}) {}

  resolve(
    facts: readonly VueSfcFactsV1[],
    resolvedChildren: readonly VueResolvedChildV1[]
  ): VueEventResolutionV1 {
    const byId = canonicalFacts(facts);
    const artifacts = new Map<string, VueComponentEventArtifactV1>();

    for (const child of [...byId.values()].sort((left, right) =>
      left.componentId.localeCompare(right.componentId)
    )) {
      const byName = new Map<string, VueEventFactV1[]>();
      for (const event of child.events) {
        if (!event.eventName) continue;
        const declarations = byName.get(event.eventName) ?? [];
        declarations.push(event);
        byName.set(event.eventName, declarations);
      }
      for (const [eventName, declarations] of byName) {
        const id = vueComponentEventId(child.componentId, eventName);
        artifacts.set(id, {
          id,
          childComponentId: child.componentId,
          eventName,
          declarations: sortedDeclarations(declarations),
        });
      }
    }

    const now = this.options.now?.() ?? Math.floor(Date.now() / 1000);
    const edges = new Map<string, StructuralRelationEdge>();
    for (const artifact of artifacts.values()) {
      const edge: StructuralRelationEdge = {
        id: programEdgeId('emits_component_event', artifact.childComponentId, artifact.id, this.id),
        edgeType: 'emits_component_event',
        sourceNodeId: artifact.childComponentId,
        targetNodeId: artifact.id,
        sourceLanguage: 'vue',
        targetLanguage: 'vue',
        confidence: CONFIDENCE,
        confidenceClass: 'framework-inferred',
        provenance: {
          resolver: this.id,
          evidenceKind: 'vue-static-component-event',
          evidenceLocations: evidence(
            artifact.declarations.map((item) => item.location),
            `static child event ${artifact.eventName}`
          ),
          extractedAt: now,
        },
      };
      edges.set(edge.id, edge);
    }

    const uniqueChildren = new Map<string, VueResolvedChildV1>();
    const ambiguousChildren = new Set<string>();
    for (const child of resolvedChildren) {
      if (!byId.has(child.parentComponentId) || !byId.has(child.childComponentId)) continue;
      const key = `${child.parentComponentId}\0${normalizeName(child.childTag)}\0${locationKey(child.location)}`;
      const prior = uniqueChildren.get(key);
      if (prior && prior.childComponentId !== child.childComponentId) ambiguousChildren.add(key);
      else uniqueChildren.set(key, child);
    }
    for (const key of ambiguousChildren) uniqueChildren.delete(key);

    for (const child of uniqueChildren.values()) {
      const parent = byId.get(child.parentComponentId);
      if (!parent) continue;
      for (const listener of parent.templateListeners) {
        if (normalizeName(listener.childTag) !== normalizeName(child.childTag)) continue;
        const matchingElement = parent.templateElements.some(
          (element) =>
            normalizeName(element.staticIs ?? element.tag) === normalizeName(child.childTag) &&
            locationKey(element.location) === locationKey(child.location)
        );
        if (!matchingElement) continue;
        const artifactId = vueComponentEventId(child.childComponentId, listener.eventName);
        if (!artifacts.has(artifactId)) continue;
        const edgeId = programEdgeId(
          'handles_component_event',
          child.parentComponentId,
          artifactId,
          this.id
        );
        const listenerEvidence = evidence(
          [child.location, listener.location],
          `resolved child ${child.childTag} handles ${listener.eventName}`
        );
        const existing = edges.get(edgeId);
        if (existing) {
          existing.provenance.evidenceLocations = mergeEvidence(
            existing.provenance.evidenceLocations,
            listenerEvidence
          );
          continue;
        }
        edges.set(edgeId, {
          id: edgeId,
          edgeType: 'handles_component_event',
          sourceNodeId: child.parentComponentId,
          targetNodeId: artifactId,
          sourceLanguage: 'vue',
          targetLanguage: 'vue',
          confidence: CONFIDENCE,
          confidenceClass: 'framework-inferred',
          provenance: {
            resolver: this.id,
            evidenceKind: 'vue-resolved-child-static-listener',
            evidenceLocations: listenerEvidence,
            extractedAt: now,
          },
        });
      }
    }

    return {
      artifacts: [...artifacts.values()].sort((left, right) => left.id.localeCompare(right.id)),
      edges: [...edges.values()].sort((left, right) => left.id.localeCompare(right.id)),
    };
  }
}
