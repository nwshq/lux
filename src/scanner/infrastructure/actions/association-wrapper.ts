import type {
  AssociationContext,
  AssociationResolver,
  StructuralRelationEdge,
} from '../../associations/types.js';
import { DEFAULT_PARSER_LIMITS } from '../../adapters/types.js';
import { extractActionFacts } from '../../adapters/actions/adapter.js';
import { resolveActionGraph } from './resolver.js';
export function analyzeActionsContext(c: AssociationContext) {
  const facts = [];
  for (const e of c.entries.filter((x) => /\.github\/workflows\/[^/]+\.ya?ml$/u.test(x.filePath))) {
    const o = extractActionFacts({
      corpusRoot: c.rootPath,
      allowedRoots: [c.rootPath],
      filePath: e.filePath,
      limits: DEFAULT_PARSER_LIMITS,
    });
    facts.push(...o.facts);
  }
  return Promise.resolve(resolveActionGraph(facts));
}
export class ActionsAssociationResolver implements AssociationResolver {
  readonly name = 'github-actions';
  supports(c: AssociationContext) {
    return c.entries.some((e) => /\.github\/workflows\/[^/]+\.ya?ml$/u.test(e.filePath));
  }
  async resolve(c: AssociationContext): Promise<StructuralRelationEdge[]> {
    const o = await analyzeActionsContext(c),
      ids = new Set(c.nodes.map((n) => n.id));
    return o.edges.filter((e) => ids.has(e.sourceNodeId) && ids.has(e.targetNodeId));
  }
}
