import type { StructuralNode } from '../../../db/types.js';
import type { StructuralRelationEdge } from '../../associations/types.js';
import {
  actionId,
  repositoryPathArtifactId,
  workflowArtifactId,
  workflowId,
  workflowJobId,
  workflowStepId,
} from '../../identity/program-identity.js';
import { frameworkEdge } from '../../react/edge-factory.js';
import type { ActionFact } from '../../adapters/actions/adapter.js';
export function resolveActionGraph(facts: readonly ActionFact[], now = 0) {
  const nodes = new Map<string, StructuralNode>(),
    edges: StructuralRelationEdge[] = [],
    ids = new Map<string, string>();
  for (const f of facts) {
    let id: string | undefined,
      kind = '';
    if (f.family === 'workflow') {
      id = workflowId(f.filePath);
      kind = 'workflow';
    } else if (f.family === 'job') {
      id = workflowJobId(f.filePath, f.value!);
      kind = 'workflow-job';
    } else if (f.family === 'step') {
      const owner = f.ownerLocalId!,
        job = owner.split(':job:')[1];
      id = workflowStepId(f.filePath, job, f.value!);
      kind = 'workflow-step';
    } else if (f.family === 'artifact') {
      id = workflowArtifactId(f.filePath, f.value!);
      kind = 'workflow-artifact';
    }
    if (id) {
      ids.set(f.localId, id);
      nodes.set(id, node(id, f.filePath, kind, now));
    }
  }
  for (const f of facts) {
    if (!f.ownerLocalId || !f.value) continue;
    const owner = ids.get(f.ownerLocalId);
    if (!owner) continue;
    let target: string | undefined,
      type: 'invokes_workflow' | 'produces_artifact' | 'consumes_artifact' = 'invokes_workflow';
    if (f.family === 'uses') {
      target = f.value.startsWith('./.github/workflows/')
        ? workflowId(f.value.slice(2))
        : f.value.startsWith('./')
          ? repositoryPathArtifactId(f.value.slice(2))
          : actionId(f.value);
      nodes.set(
        target,
        node(target, f.filePath, f.value.startsWith('./') ? 'repository-path' : 'action', now)
      );
    } else if (f.family === 'run' && f.value.startsWith('./')) {
      target = repositoryPathArtifactId(f.value.slice(2));
      nodes.set(target, node(target, f.filePath, 'repository-path', now));
    } else if (f.family === 'artifact') {
      target = workflowArtifactId(f.filePath, f.value);
      type = f.operation === 'upload' ? 'produces_artifact' : 'consumes_artifact';
    }
    if (target)
      edges.push(
        frameworkEdge({
          resolver: 'github-actions',
          edgeType: type,
          sourceNodeId: owner,
          targetNodeId: target,
          sourceLanguage: 'yaml',
          targetLanguage: 'yaml',
          confidence: 1,
          confidenceClass: 'artifact-backed',
          evidenceKind: `actions-${f.family}`,
          locations: [f.location],
        })
      );
  }
  return {
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: edges.sort((a, b) => a.id.localeCompare(b.id)),
    diagnostics: [],
  };
}
function node(
  id: string,
  file_path: string,
  symbol_kind: string,
  updated_at: number
): StructuralNode {
  return {
    id,
    node_type: 'artifact',
    file_path,
    language_id: 'yaml',
    symbol_kind,
    origin: 'local',
    updated_at,
  };
}
