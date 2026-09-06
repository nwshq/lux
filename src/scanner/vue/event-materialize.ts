import type { StructuralNode } from '../../db/types.js';
import type { VueComponentEventArtifactV1 } from './event-resolver.js';

export function buildVueEventNodes(
  artifacts: readonly VueComponentEventArtifactV1[],
  updatedAt: number
): StructuralNode[] {
  return artifacts.map((artifact) => ({
    id: artifact.id,
    node_type: 'artifact',
    language_id: 'vue',
    symbol_name: artifact.eventName,
    symbol_kind: 'VueComponentEvent',
    metadata: JSON.stringify({
      childComponentId: artifact.childComponentId,
      eventName: artifact.eventName,
    }),
    updated_at: updatedAt,
  }));
}
