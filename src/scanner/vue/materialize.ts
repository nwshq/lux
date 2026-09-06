import type { StructuralNode } from '../../db/types.js';
import type { VueSfcFactsV1 } from './types.js';

/** Build the canonical structural symbol that must exist before Vue graph edges are emitted. */
function buildVueComponentNode(facts: VueSfcFactsV1, updatedAt: number): StructuralNode {
  const name =
    facts.filePath
      .split('/')
      .pop()
      ?.replace(/\.vue$/u, '') ?? facts.filePath;
  return {
    id: facts.componentId,
    node_type: 'symbol',
    file_path: facts.filePath,
    language_id: 'vue',
    symbol_name: name,
    symbol_kind: 'VueComponent',
    updated_at: updatedAt,
  };
}

/** Build SFC component nodes in stable path order for pre-edge materialization. */
export function buildVueComponentNodes(
  facts: readonly VueSfcFactsV1[],
  updatedAt: number
): StructuralNode[] {
  return [...facts]
    .sort((left, right) => left.filePath.localeCompare(right.filePath))
    .map((item) => buildVueComponentNode(item, updatedAt));
}
