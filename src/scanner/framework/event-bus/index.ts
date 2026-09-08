import { buildEventBusCatalog } from './catalog.js';
import { extractEventBusFacts } from './facts.js';
import { resolveEventBus } from './resolver.js';
import type { EventBusAnalyzerV1, EventBusInputV1, EventBusResultV1 } from './types.js';
export class EventBusAnalyzer implements EventBusAnalyzerV1 {
  async analyze(input: EventBusInputV1): Promise<EventBusResultV1> {
    const catalog = await buildEventBusCatalog(input),
      facts = await extractEventBusFacts({ ...input, catalog: catalog.catalog }),
      resolved = resolveEventBus(facts.calls, catalog.catalog);
    return {
      calls: facts.calls,
      nodes: resolved.nodes,
      edges: resolved.edges,
      dependencies: [...new Set([...catalog.dependencies, ...facts.dependencies])].sort(),
      diagnostics: [...catalog.diagnostics, ...facts.diagnostics, ...resolved.diagnostics],
    };
  }
}
export type { EventBusCatalogEntryV1, EventBusInputV1, EventBusResultV1 } from './types.js';
