import type {
  AssociationContext,
  AssociationResolver,
  StructuralRelationEdge,
} from '../../associations/types.js';
import { ExpoRouterAnalyzer } from './resolver.js';
import type { ExpoRouterResultV1 } from './types.js';

function expoInput(context: AssociationContext) {
  const entries = context.entries.filter((entry) => /\.(?:[cm]?[jt]sx?)$/iu.test(entry.filePath));
  return {
    rootPath: context.rootPath,
    appRoots: ['app'],
    files: entries.map((e) => e.filePath).sort(),
    sources: new Map(
      entries.flatMap((e) =>
        typeof e.metadata?.content === 'string' ? [[e.filePath, e.metadata.content] as const] : []
      )
    ),
    project: context.programAnalysis!.project,
  };
}
export async function analyzeExpoContext(
  context: AssociationContext
): Promise<ExpoRouterResultV1 | undefined> {
  if (!context.programAnalysis?.project) return undefined;
  const input = expoInput(context);
  if (!input.files.some((file) => file.startsWith('app/'))) return undefined;
  return new ExpoRouterAnalyzer().analyze(input);
}
export class ExpoRouterAssociationResolver implements AssociationResolver {
  readonly name = 'expo-router';
  supports(context: AssociationContext) {
    return Boolean(
      context.programAnalysis?.project &&
      context.entries.some(
        (e) => e.filePath.startsWith('app/') && /\.[cm]?[jt]sx?$/iu.test(e.filePath)
      )
    );
  }
  async resolve(context: AssociationContext): Promise<StructuralRelationEdge[]> {
    const out = await analyzeExpoContext(context);
    if (!out) return [];
    const ids = new Set(context.nodes.map((n) => n.id));
    return out.edges.filter((e) => ids.has(e.sourceNodeId) && ids.has(e.targetNodeId));
  }
}
