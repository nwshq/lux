import type {
  AssociationContext,
  AssociationResolver,
  StructuralRelationEdge,
} from '../../associations/types.js';
import { EventBusAnalyzer } from './index.js';
export async function analyzeEventBusContext(c: AssociationContext) {
  if (!c.programAnalysis?.project) return undefined;
  const entries = c.entries.filter((e) => /\.[cm]?[jt]sx?$/iu.test(e.filePath));
  return new EventBusAnalyzer().analyze({
    rootPath: c.rootPath,
    files: entries.map((e) => e.filePath),
    sources: new Map(
      entries.flatMap((e) =>
        typeof e.metadata?.content === 'string' ? [[e.filePath, e.metadata.content] as const] : []
      )
    ),
    extractions: c.sharedExtractions,
    project: c.programAnalysis.project,
    catalog: [],
  });
}
export class EventBusAssociationResolver implements AssociationResolver {
  readonly name = 'event-bus';
  supports(c: AssociationContext) {
    return Boolean(c.programAnalysis?.project);
  }
  async resolve(c: AssociationContext): Promise<StructuralRelationEdge[]> {
    const o = await analyzeEventBusContext(c);
    if (!o) return [];
    const ids = new Set(c.nodes.map((n) => n.id));
    return o.edges.filter((e) => ids.has(e.sourceNodeId) && ids.has(e.targetNodeId));
  }
}
