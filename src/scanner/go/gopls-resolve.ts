import { relative, isAbsolute, resolve, sep } from 'node:path';
import type {
  DefinitionAnswerV1,
  DefinitionQueryV1,
  GoImplementationEvidenceV1,
  GoProjectV1,
} from '../languages/contracts.js';
export interface GoDefinitionProvider {
  resolveDefinition(
    filePath: string,
    line: number,
    character: number
  ): Promise<{ filePath: string; line: number } | null>;
}
export async function resolveGoSemanticQueries(
  project: GoProjectV1,
  queries: readonly DefinitionQueryV1[],
  provider: GoDefinitionProvider
) {
  const definitions: DefinitionAnswerV1[] = [],
    diagnostics: Array<{ code: string; message: string; filePath?: string }> = [];
  for (const q of queries) {
    try {
      const a = await provider.resolveDefinition(q.filePath, q.line, q.character);
      if (!a) continue;
      if (!inside(project.corpusRoot, a.filePath)) {
        diagnostics.push({
          code: 'target-outside-root',
          message: 'gopls target escaped corpus',
          filePath: q.filePath,
        });
        continue;
      }
      definitions.push({
        query: q,
        targetFile: relative(project.corpusRoot, a.filePath).split(sep).join('/'),
        targetLine: a.line,
        targetCharacter: 0,
        producer: 'gopls',
      });
    } catch (error) {
      diagnostics.push({
        code: 'request-timeout',
        message: error instanceof Error ? error.message : 'gopls failure',
        filePath: q.filePath,
      });
    }
  }
  return { definitions, implementations: [] as GoImplementationEvidenceV1[], diagnostics };
}
function inside(root: string, path: string) {
  const r = relative(resolve(root), resolve(path));
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r));
}
