import type { AssociationContext } from '../../types.js';
import {
  emptyOperationalBatch,
  operationalBoundaryId,
  operationalEdgeId,
  operationalHandlerId,
  type OperationalExtractor,
  type OperationalExtractionBatch,
} from '../../operational/types.js';
import {
  inferStructuralContextId,
  getLaravelPhpEntries,
  resolvePhpClassReference,
  shortName,
} from './shared.js';
import { phpSymbolNodeId } from '../../types.js';

const STATIC_JOB_DISPATCH_RE = /\b([A-Za-z_\\][A-Za-z0-9_\\]*)::(dispatch|dispatchSync)\s*\(/g;
const FUNCTION_JOB_DISPATCH_RE =
  /(?<!::)\b(dispatch|dispatchSync)\s*\(\s*new\s+([A-Za-z_\\][A-Za-z0-9_\\]*)/g;
const BUS_JOB_DISPATCH_RE =
  /\bBus::(dispatch|dispatchSync)\s*\(\s*new\s+([A-Za-z_\\][A-Za-z0-9_\\]*)/g;

export class LaravelJobDispatchExtractor implements OperationalExtractor {
  readonly name = 'laravel-job-dispatch';

  supports(context: AssociationContext): boolean {
    return context.entries.some((entry) => entry.languageId === 'php');
  }

  extract(context: AssociationContext): Promise<OperationalExtractionBatch> {
    const batch = emptyOperationalBatch();

    for (const entry of getLaravelPhpEntries(context)) {
      const sourceId = inferStructuralContextId(entry);

      STATIC_JOB_DISPATCH_RE.lastIndex = 0;
      let staticMatch: RegExpExecArray | null;
      while ((staticMatch = STATIC_JOB_DISPATCH_RE.exec(entry.content)) !== null) {
        const resolvedClass = resolvePhpClassReference(staticMatch[1], entry);
        if (
          shortName(resolvedClass) === 'Bus' ||
          resolvedClass === 'Illuminate\\Support\\Facades\\Bus'
        ) {
          continue;
        }

        addDispatch(batch, context.rootPath, sourceId, resolvedClass, staticMatch[2]);
      }

      FUNCTION_JOB_DISPATCH_RE.lastIndex = 0;
      let dispatchMatch: RegExpExecArray | null;
      while ((dispatchMatch = FUNCTION_JOB_DISPATCH_RE.exec(entry.content)) !== null) {
        addDispatch(
          batch,
          context.rootPath,
          sourceId,
          resolvePhpClassReference(dispatchMatch[2], entry),
          dispatchMatch[1]
        );
      }

      BUS_JOB_DISPATCH_RE.lastIndex = 0;
      let busMatch: RegExpExecArray | null;
      while ((busMatch = BUS_JOB_DISPATCH_RE.exec(entry.content)) !== null) {
        addDispatch(
          batch,
          context.rootPath,
          sourceId,
          resolvePhpClassReference(busMatch[2], entry),
          busMatch[1]
        );
      }
    }

    return Promise.resolve(batch);
  }
}

function addDispatch(
  batch: OperationalExtractionBatch,
  repoRoot: string,
  sourceId: string,
  jobClass: string,
  dispatchMethod: string
): void {
  if (!jobClass) return;

  const jobBoundaryId = operationalBoundaryId('job', jobClass);
  const jobSymbolId = phpSymbolNodeId(jobClass);
  const transport = dispatchMethod === 'dispatchSync' ? 'sync' : 'async';

  batch.boundaries.push({
    id: jobBoundaryId,
    repo_root: repoRoot,
    kind: 'job',
    name: jobClass,
    trust_tier: 4,
  });
  batch.handlers.push({
    id: operationalHandlerId(jobBoundaryId, jobSymbolId),
    boundary_id: jobBoundaryId,
    symbol_id: jobSymbolId,
    trust_tier: 4,
  });
  batch.edges.push({
    id: operationalEdgeId(sourceId, jobBoundaryId, 'DISPATCHES', transport),
    source_id: sourceId,
    target_id: jobBoundaryId,
    edge_type: 'DISPATCHES',
    transport,
    trust_tier: 4,
  });
  batch.edges.push({
    id: operationalEdgeId(jobBoundaryId, jobSymbolId, 'HANDLED_BY'),
    source_id: jobBoundaryId,
    target_id: jobSymbolId,
    edge_type: 'HANDLED_BY',
    transport,
    trust_tier: 4,
  });
}
