import { TREE_SITTER_PRODUCERS } from '../adapters/registry.js';
import type {
  AssociationContext,
  AssociationResolver,
  StructuralRelationEdge,
} from '../associations/types.js';
import { ReactFrameworkAnalyzer } from './analyzer.js';
import { ReactFactExtractor } from './facts.js';
import { ReactRelationshipResolver } from './resolver.js';
import type { ReactAnalysisResultV1 } from './types.js';

const PRODUCERS = new Set<string>([
  TREE_SITTER_PRODUCERS.typescript,
  TREE_SITTER_PRODUCERS.javascript,
]);

export function isReactSourcePath(filePath: string): boolean {
  return /\.(?:[cm]?[jt]sx?)$/iu.test(filePath);
}

function reactAnalysisInput(context: AssociationContext) {
  const entries = context.entries.filter((entry) => isReactSourcePath(entry.filePath));
  return {
    rootPath: context.rootPath,
    files: entries.map((entry) => entry.filePath).sort(),
    project: context.programAnalysis!.project,
    extractions: context.sharedExtractions,
    sources: new Map(
      entries.flatMap((entry) => {
        const content = entry.metadata?.content;
        return typeof content === 'string' ? [[entry.filePath, content] as const] : [];
      })
    ),
  };
}

export async function analyzeReactContext(
  context: AssociationContext
): Promise<ReactAnalysisResultV1 | undefined> {
  const analysis = context.programAnalysis;
  if (
    !analysis?.project ||
    !context.sharedExtractions ||
    ![...analysis.producersRun].some((producer) => PRODUCERS.has(producer))
  )
    return undefined;
  const input = reactAnalysisInput(context);
  if (input.files.length === 0) return undefined;
  return new ReactFrameworkAnalyzer(
    new ReactFactExtractor(),
    new ReactRelationshipResolver()
  ).analyze(input);
}

/** Association-engine wrapper. Integration materializes analysis nodes before this resolver runs. */
export class ReactAssociationResolver implements AssociationResolver {
  readonly name = 'react-framework';

  supports(context: AssociationContext): boolean {
    const analysis = context.programAnalysis;
    return Boolean(
      analysis?.project &&
      context.sharedExtractions &&
      [...analysis.producersRun].some((producer) => PRODUCERS.has(producer)) &&
      context.entries.some((entry) => isReactSourcePath(entry.filePath))
    );
  }

  async resolve(context: AssociationContext): Promise<StructuralRelationEdge[]> {
    const result = await analyzeReactContext(context);
    if (!result) return [];
    const materialized = new Set(context.nodes.map((node) => node.id));
    return result.edges.filter(
      (edge) => materialized.has(edge.sourceNodeId) && materialized.has(edge.targetNodeId)
    );
  }
}
