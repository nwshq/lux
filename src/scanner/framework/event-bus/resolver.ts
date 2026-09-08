import { busEventId, reactComponentId, reactHookId } from '../../identity/program-identity.js';
import { tsSymbolNodeId } from '../../associations/types.js';
import { frameworkEdge } from '../../react/edge-factory.js';
import type { FrameworkNodeV1 } from '../../react/types.js';
import type { StructuralRelationEdge } from '../../associations/types.js';
import type { EventBusCallFactV1, EventBusCatalogEntryV1, EventBusResultV1 } from './types.js';
export function resolveEventBus(
  calls: readonly EventBusCallFactV1[],
  catalog: readonly EventBusCatalogEntryV1[]
): Pick<EventBusResultV1, 'nodes' | 'edges' | 'diagnostics'> {
  const by = new Map(catalog.map((x) => [x.busId, x])),
    nodes = new Map<string, FrameworkNodeV1>(),
    edges: StructuralRelationEdge[] = [];
  for (const c of calls) {
    if (!c.busId || !c.eventKey || !by.has(c.busId)) continue;
    const bus = by.get(c.busId)!,
      id = busEventId(c.busId, c.eventKey);
    nodes.set(id, {
      id,
      type: 'event',
      name: c.eventKey,
      filePath: bus.declarationFile,
      languageId: lang(bus.declarationFile),
      metadata: { busId: c.busId, eventKey: c.eventKey, declarationFile: bus.declarationFile },
    });
    const source = /^use[A-Z0-9]/u.test(c.ownerExport)
      ? reactHookId(c.filePath, c.ownerExport)
      : /\.[jt]sx$/u.test(c.filePath)
        ? reactComponentId(c.filePath, c.ownerExport)
        : tsSymbolNodeId(c.filePath, c.ownerExport);
    edges.push(
      frameworkEdge({
        resolver: 'event-bus',
        edgeType: c.operation === 'publish' ? 'publishes_bus_event' : 'subscribes_bus_event',
        sourceNodeId: source,
        targetNodeId: id,
        sourceLanguage: lang(c.filePath),
        targetLanguage: lang(bus.declarationFile),
        confidence: 0.95,
        confidenceClass: 'framework-inferred',
        evidenceKind: `event-bus-${c.operation}`,
        locations: [...bus.evidence, c.location],
      })
    );
  }
  return {
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: edges.sort((a, b) => a.id.localeCompare(b.id)),
    diagnostics: [],
  };
}
function lang(p: string): 'typescript' | 'javascript' {
  return /\.[cm]?tsx?$/u.test(p) && !/\.[cm]?jsx?$/u.test(p) ? 'typescript' : 'javascript';
}
