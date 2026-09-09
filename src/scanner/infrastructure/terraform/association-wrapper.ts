import type {
  AssociationContext,
  AssociationResolver,
  StructuralRelationEdge,
} from '../../associations/types.js';
import { HclArtifactAdapter } from '../../adapters/hcl/adapter.js';
import { DEFAULT_PARSER_LIMITS } from '../../adapters/types.js';
import { resolveTerraformGraph } from './resolver.js';
export async function analyzeTerraformContext(c: AssociationContext) {
  const entries = c.entries.filter(
      (e) => e.languageId === 'hcl' || /\.(?:tf|tfvars|hcl)$/u.test(e.filePath)
    ),
    facts = [];
  for (const e of entries) {
    const o = await new HclArtifactAdapter().extract({
      corpusRoot: c.rootPath,
      allowedRoots: [c.rootPath],
      filePath: e.filePath,
      limits: DEFAULT_PARSER_LIMITS,
    });
    facts.push(...o.artifactFacts);
  }
  return resolveTerraformGraph(facts);
}
export class TerraformAssociationResolver implements AssociationResolver {
  readonly name = 'terraform-static';
  supports(c: AssociationContext) {
    return c.entries.some(
      (e) => e.languageId === 'hcl' || /\.(?:tf|tfvars|hcl)$/u.test(e.filePath)
    );
  }
  async resolve(c: AssociationContext): Promise<StructuralRelationEdge[]> {
    const o = await analyzeTerraformContext(c),
      ids = new Set(c.nodes.map((n) => n.id));
    return o.edges.filter((e) => ids.has(e.sourceNodeId) && ids.has(e.targetNodeId));
  }
}
