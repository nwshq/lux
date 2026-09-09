import type {
  AssociationContext,
  AssociationResolver,
  StructuralRelationEdge,
} from '../../associations/types.js';
import { DEFAULT_PARSER_LIMITS } from '../../adapters/types.js';
import { extractDockerFacts } from '../../adapters/docker/adapter.js';
import { extractComposeFacts } from '../../adapters/compose/adapter.js';
import { resolveContainerGraph } from './resolver.js';
export function analyzeContainerContext(c: AssociationContext) {
  const docker = [],
    compose = [];
  for (const e of c.entries) {
    const input = {
      corpusRoot: c.rootPath,
      allowedRoots: [c.rootPath],
      filePath: e.filePath,
      limits: DEFAULT_PARSER_LIMITS,
    };
    if (e.languageId === 'dockerfile') docker.push(...extractDockerFacts(input).facts);
    if (e.languageId === 'compose') compose.push(...extractComposeFacts(input).facts);
  }
  return resolveContainerGraph(docker, compose);
}
export class ContainerAssociationResolver implements AssociationResolver {
  readonly name = 'containers';
  supports(c: AssociationContext) {
    return c.entries.some((e) => e.languageId === 'dockerfile' || e.languageId === 'compose');
  }
  resolve(c: AssociationContext): Promise<StructuralRelationEdge[]> {
    const o = analyzeContainerContext(c),
      ids = new Set(c.nodes.map((n) => n.id));
    return Promise.resolve(
      o.edges.filter((e) => ids.has(e.sourceNodeId) && ids.has(e.targetNodeId))
    );
  }
}
