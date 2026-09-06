import type { RelationshipResolverV1 } from '../adapters/types.js';
import type {
  AssociationContext,
  AssociationResolver,
  StructuralRelationEdge,
} from '../associations/types.js';
import { VueComponentResolver } from './component-resolver.js';

/** Producer recorded by the compiler-SFC source adapter in ProgramAnalysisV1. */
const VUE_SFC_PRODUCER = 'vue-compiler-sfc';

/** Thin AssociationEngine adapter around the contract-shaped pure component resolver. */
export class VueComponentAssociationResolver implements AssociationResolver {
  readonly name = 'vue-component';

  constructor(private readonly resolver: RelationshipResolverV1 = new VueComponentResolver()) {}

  supports(context: AssociationContext): boolean {
    const analysis = context.programAnalysis;
    return Boolean(
      analysis?.producersRun.has(VUE_SFC_PRODUCER) &&
      analysis.vueFacts.some((fact) => fact.templateElements.length > 0)
    );
  }

  async resolve(context: AssociationContext): Promise<StructuralRelationEdge[]> {
    const analysis = context.programAnalysis;
    if (!analysis?.producersRun.has(VUE_SFC_PRODUCER)) return [];

    const materialized = new Set(context.nodes.map((node) => node.id));
    const edges = await this.resolver.resolve(analysis.facts, analysis.project);
    return edges.filter(
      (edge) => materialized.has(edge.sourceNodeId) && materialized.has(edge.targetNodeId)
    );
  }
}
