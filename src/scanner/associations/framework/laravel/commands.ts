import { phpSymbolNodeId, type AssociationContext } from '../../types.js';
import {
  emptyOperationalBatch,
  operationalBoundaryId,
  operationalContractId,
  operationalEdgeId,
  operationalHandlerId,
  type OperationalExtractor,
  type OperationalExtractionBatch,
} from '../../operational/types.js';
import { getLaravelPhpEntries } from './shared.js';

const COMMAND_SIGNATURE_RE = /\$(?:signature|name)\s*=\s*['"]([^'"]+)['"]/;

export class LaravelCommandExtractor implements OperationalExtractor {
  readonly name = 'laravel-commands';

  supports(context: AssociationContext): boolean {
    return context.entries.some((entry) => entry.languageId === 'php');
  }

  extract(context: AssociationContext): Promise<OperationalExtractionBatch> {
    const batch = emptyOperationalBatch();

    for (const entry of getLaravelPhpEntries(context)) {
      for (const phpClass of entry.classes) {
        if (!isLaravelCommandClass(phpClass.extendsQualifiedName, phpClass.extendsName)) continue;

        const rawSignature = COMMAND_SIGNATURE_RE.exec(phpClass.body)?.[1]?.trim();
        if (!rawSignature) continue;

        const commandName = rawSignature.split(/\s+/)[0];
        const boundaryId = operationalBoundaryId('command', commandName);
        const symbolId = phpSymbolNodeId(phpClass.qualifiedName);

        batch.boundaries.push({
          id: boundaryId,
          repo_root: context.rootPath,
          kind: 'command',
          name: commandName,
          trust_tier: 5,
          file_path: entry.filePath,
        });
        batch.handlers.push({
          id: operationalHandlerId(boundaryId, symbolId),
          boundary_id: boundaryId,
          symbol_id: symbolId,
          trust_tier: 5,
        });
        batch.edges.push({
          id: operationalEdgeId(boundaryId, symbolId, 'HANDLED_BY'),
          source_id: boundaryId,
          target_id: symbolId,
          edge_type: 'HANDLED_BY',
          transport: 'sync',
          trust_tier: 5,
        });
        batch.contracts.push({
          id: operationalContractId(boundaryId, 'signature'),
          boundary_id: boundaryId,
          payload_schema: JSON.stringify({
            signature: rawSignature,
            source: rawSignature === commandName ? 'name' : 'signature',
          }),
          trust_tier: 5,
        });
      }
    }

    return Promise.resolve(batch);
  }
}

function isLaravelCommandClass(
  extendsQualifiedName: string | undefined,
  extendsName: string | undefined
): boolean {
  if (extendsQualifiedName === 'Illuminate\\Console\\Command') return true;
  return extendsName === 'Command';
}
