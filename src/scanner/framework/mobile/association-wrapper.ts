import type {
  AssociationContext,
  AssociationResolver,
  StructuralRelationEdge,
} from '../../associations/types.js';
import { MobileFactExtractor } from './facts.js';
import { MobileRelationshipResolver } from './resolver.js';
export async function analyzeMobileContext(c: AssociationContext) {
  if (!c.programAnalysis?.project || !c.sharedExtractions) return undefined;
  const entries = c.entries.filter((e) => /\.[cm]?[jt]sx?$/iu.test(e.filePath)),
    sources = new Map(
      entries.flatMap((e) =>
        typeof e.metadata?.content === 'string' ? [[e.filePath, e.metadata.content] as const] : []
      )
    ),
    input = {
      rootPath: c.rootPath,
      files: entries.map((e) => e.filePath),
      sources,
      extractions: c.sharedExtractions,
      project: c.programAnalysis.project,
    },
    facts = await new MobileFactExtractor().extract(input),
    resolved = await new MobileRelationshipResolver().resolve(facts.facts, input.project);
  return { ...facts, ...resolved };
}
export class MobileArchitectureAssociationResolver implements AssociationResolver {
  readonly name = 'mobile-architecture';
  supports(c: AssociationContext) {
    return Boolean(c.programAnalysis?.project && c.sharedExtractions);
  }
  async resolve(c: AssociationContext): Promise<StructuralRelationEdge[]> {
    const o = await analyzeMobileContext(c);
    if (!o) return [];
    const ids = new Set(c.nodes.map((n) => n.id));
    return o.edges.filter((e) => ids.has(e.sourceNodeId) && ids.has(e.targetNodeId));
  }
}
