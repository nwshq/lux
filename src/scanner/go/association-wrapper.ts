import type {
  AssociationContext,
  AssociationResolver,
  StructuralRelationEdge,
} from '../associations/types.js';
import type { StructuralNode } from '../../db/types.js';
import { GoDeterministicAdapter } from './adapter.js';
export async function analyzeGoContext(c: AssociationContext) {
  const a = new GoDeterministicAdapter(),
    project = await a.discover(c.rootPath, [c.rootPath]);
  if (!project) return undefined;
  const facts = await a.extract(project),
    resolved = await a.resolve(project, facts);
  return {
    ...resolved,
    nodes: resolved.nodes.map((n): StructuralNode => ({
      id: n.id,
      node_type: n.nodeType,
      file_path: n.filePath,
      language_id: n.languageId,
      symbol_name: n.symbolName,
      symbol_kind: n.symbolKind,
      qualified_name: n.qualifiedName,
      metadata: JSON.stringify(n.metadata),
      origin: 'local',
      updated_at: 0,
    })),
  };
}
export class GoAssociationResolver implements AssociationResolver {
  readonly name = 'go-deterministic';
  supports(c: AssociationContext) {
    return c.entries.some((e) => e.filePath.endsWith('.go'));
  }
  async resolve(c: AssociationContext): Promise<StructuralRelationEdge[]> {
    const o = await analyzeGoContext(c);
    if (!o) return [];
    const ids = new Set(c.nodes.map((n) => n.id));
    return o.edges.filter((e) => ids.has(e.sourceNodeId) && ids.has(e.targetNodeId));
  }
}
