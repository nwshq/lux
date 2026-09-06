import type { RelationshipResolverV1 } from '../adapters/types.js';
import type {
  AssociationContext,
  AssociationResolver,
  StructuralRelationEdge,
} from '../associations/types.js';
import { VueComponentResolver } from './component-resolver.js';
import { VueComposableResolver } from './composable-resolver.js';
import { VueStoreResolver } from './store-resolver.js';

const VUE_SFC_PRODUCER = 'vue-compiler-sfc';

abstract class VueAnalysisAssociationResolver implements AssociationResolver {
  abstract readonly name: string;

  constructor(protected readonly resolver: RelationshipResolverV1) {}

  supports(context: AssociationContext): boolean {
    return Boolean(
      context.programAnalysis?.producersRun.has(VUE_SFC_PRODUCER) &&
      context.programAnalysis.vueFacts.length > 0
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

export class VueComponentAssociationResolver extends VueAnalysisAssociationResolver {
  readonly name = 'vue-component';
  constructor(resolver: RelationshipResolverV1 = new VueComponentResolver()) {
    super(resolver);
  }

  override supports(context: AssociationContext): boolean {
    return Boolean(
      super.supports(context) &&
      context.programAnalysis?.vueFacts.some((fact) => fact.templateElements.length > 0)
    );
  }
}

export class VueComposableAssociationResolver extends VueAnalysisAssociationResolver {
  readonly name = 'vue-composable';
  constructor(resolver: RelationshipResolverV1 = new VueComposableResolver()) {
    super(resolver);
  }
}

export class VueStoreAssociationResolver extends VueAnalysisAssociationResolver {
  readonly name = 'vue-store';
  constructor(resolver: RelationshipResolverV1 = new VueStoreResolver()) {
    super(resolver);
  }
}
