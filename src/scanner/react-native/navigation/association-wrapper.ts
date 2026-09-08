import type {
  AssociationContext,
  AssociationResolver,
  StructuralRelationEdge,
} from '../../associations/types.js';
import { ReactNavigationAnalyzer } from './analyzer.js';
import { ReactNavigationFactExtractor } from './facts.js';
import { ReactNavigationRelationshipResolver } from './resolver.js';
import type { ReactNavigationAnalysisResultV1 } from './types.js';
export async function analyzeNavigationContext(
  context: AssociationContext
): Promise<ReactNavigationAnalysisResultV1 | undefined> {
  if (!context.programAnalysis?.project || !context.sharedExtractions) return undefined;
  const entries = context.entries.filter((e) => /\.[cm]?[jt]sx?$/iu.test(e.filePath)),
    sources = new Map(
      entries.flatMap((e) =>
        typeof e.metadata?.content === 'string' ? [[e.filePath, e.metadata.content] as const] : []
      )
    );
  return new ReactNavigationAnalyzer(
    new ReactNavigationFactExtractor(),
    new ReactNavigationRelationshipResolver()
  ).analyze({
    rootPath: context.rootPath,
    files: entries.map((e) => e.filePath),
    sources,
    extractions: context.sharedExtractions,
    project: context.programAnalysis.project,
  });
}
export class ReactNavigationAssociationResolver implements AssociationResolver {
  readonly name = 'react-navigation';
  supports(c: AssociationContext) {
    return Boolean(
      c.programAnalysis?.project &&
      c.sharedExtractions &&
      c.entries.some((e) => /\.[cm]?[jt]sx?$/iu.test(e.filePath))
    );
  }
  async resolve(c: AssociationContext): Promise<StructuralRelationEdge[]> {
    const o = await analyzeNavigationContext(c);
    if (!o) return [];
    const ids = new Set(c.nodes.map((n) => n.id));
    return o.edges.filter((e) => ids.has(e.sourceNodeId) && ids.has(e.targetNodeId));
  }
}
