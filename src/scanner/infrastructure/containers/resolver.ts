import type { StructuralNode } from '../../../db/types.js';
import type { StructuralRelationEdge } from '../../associations/types.js';
import {
  composeServiceId,
  containerContextId,
  containerImageId,
  containerStageId,
  repositoryPathArtifactId,
} from '../../identity/program-identity.js';
import { frameworkEdge } from '../../react/edge-factory.js';
import type { DockerFact } from '../../adapters/docker/adapter.js';
import type { ComposeFact } from '../../adapters/compose/adapter.js';
export function resolveContainerGraph(
  docker: readonly DockerFact[],
  compose: readonly ComposeFact[],
  now = 0
) {
  const nodes = new Map<string, StructuralNode>(),
    edges: StructuralRelationEdge[] = [];
  for (const f of docker) {
    if (f.family === 'stage') {
      const id = containerStageId(f.filePath, f.stage);
      nodes.set(id, node(id, f.filePath, 'container-stage', now));
      if (f.static && f.base) {
        const image = containerImageId(f.base);
        nodes.set(image, node(image, f.filePath, 'container-image', now));
        edge(edges, 'uses_base_image', id, image, f.filePath, f.line);
      }
    } else if (f.family === 'copy' && f.static) {
      const stage = containerStageId(f.filePath, f.stage);
      for (const source of f.sources ?? []) {
        const target = f.from
          ? containerStageId(f.filePath, f.from)
          : repositoryPathArtifactId(source);
        nodes.set(
          target,
          node(target, f.filePath, f.from ? 'container-stage' : 'repository-path', now)
        );
        edge(edges, 'copies_artifact', stage, target, f.filePath, f.line);
      }
    }
  }
  for (const f of compose) {
    const service = composeServiceId(f.filePath, f.service);
    nodes.set(service, node(service, f.filePath, 'compose-service', now));
    if (f.family === 'image' && f.value) {
      const image = containerImageId(f.value);
      nodes.set(image, node(image, f.filePath, 'container-image', now));
      edge(edges, 'consumes_artifact', service, image, f.filePath, f.line);
    }
    if (f.family === 'build' && f.context) {
      const context = containerContextId(f.context);
      nodes.set(context, node(context, f.filePath, 'container-context', now));
      edge(edges, 'consumes_artifact', service, context, f.filePath, f.line);
    }
    if (f.family === 'dependency' && f.value) {
      const target = composeServiceId(f.filePath, f.value);
      nodes.set(target, node(target, f.filePath, 'compose-service', now));
      edge(edges, 'depends_on_service', service, target, f.filePath, f.line);
    }
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
    symbol_kind,
    language_id: 'docker',
    origin: 'local',
    updated_at,
  };
}
function edge(
  out: StructuralRelationEdge[],
  edgeType: 'uses_base_image' | 'copies_artifact' | 'consumes_artifact' | 'depends_on_service',
  sourceNodeId: string,
  targetNodeId: string,
  filePath: string,
  line: number
) {
  out.push(
    frameworkEdge({
      resolver: 'containers',
      edgeType,
      sourceNodeId,
      targetNodeId,
      sourceLanguage: 'docker',
      targetLanguage: 'docker',
      confidence: 1,
      confidenceClass: 'artifact-backed',
      evidenceKind: 'container-static-fact',
      locations: [{ filePath, line, column: 0 }],
    })
  );
}
