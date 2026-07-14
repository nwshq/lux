// AST symbol materializer (Phase 2 of the arm-D structural tier).
//
// Produces `symbol` StructuralNodes from a tree-sitter Extraction WITHOUT LSP,
// filling the gap where the LSP-based materializer (associations/materializer.ts)
// yields nothing when no language server is configured. Top-level symbols reuse
// the exact node-id builders the LSP path uses (tsSymbolNodeId / phpSymbolNodeId)
// so AST- and LSP-sourced nodes coincide by identity; methods add a container
// segment so nested symbols get unambiguous ids (per the approved exploration's
// node-identity scheme).

import type { StructuralNode } from '../../db/types.js';
import { phpSymbolNodeId, tsSymbolNodeId } from '../associations/types.js';
import type { AstLang, AstNode, Extraction } from './extract.js';

const SYMBOL_KIND_LABEL: Record<'function' | 'method' | 'class', string> = {
  function: 'Function',
  method: 'Method',
  class: 'Class',
};

/**
 * Compute the node id (and PHP qualified name) for a single AST definition.
 *
 * This is the single source of truth for AST symbol identity — shared by the
 * materializer (which creates the nodes) and the association resolver (which
 * references them as edge endpoints), so the two never drift apart.
 *
 * - TS/TSX: `symbol:ts:<relPath>#<name>` (methods: `#<Container>.<name>`).
 * - PHP: `symbol:php:<Ns\\name>` (methods: `<Ns\\Class::name>`); un-namespaced
 *   top-level symbols fall back to the short name, matching the LSP path.
 */
export function astSymbolIdentity(
  relPath: string,
  def: AstNode,
  lang: AstLang,
  namespace?: string
): { id: string; qualifiedName?: string } {
  if (lang === 'php') {
    let qualifiedName: string | undefined;
    if (def.type === 'method' && def.container) {
      const classFqn = namespace ? `${namespace}\\${def.container}` : def.container;
      qualifiedName = `${classFqn}::${def.name}`;
    } else if (namespace) {
      qualifiedName = `${namespace}\\${def.name}`;
    }
    return { id: phpSymbolNodeId(qualifiedName ?? def.name), qualifiedName };
  }

  const localName =
    def.type === 'method' && def.container ? `${def.container}.${def.name}` : def.name;
  return { id: tsSymbolNodeId(relPath, localName) };
}

/**
 * Build `symbol` StructuralNodes from an AST extraction.
 *
 * @param updatedAt - Unix epoch seconds to stamp on each node (caller-supplied
 *   for determinism).
 */
export function buildAstSymbolNodes(
  relPath: string,
  extraction: Extraction,
  lang: AstLang,
  updatedAt: number
): StructuralNode[] {
  const isPhp = lang === 'php';
  const nodes: StructuralNode[] = [];
  const seen = new Set<string>();

  for (const def of extraction.nodes) {
    const { id, qualifiedName } = astSymbolIdentity(relPath, def, lang, extraction.namespace);
    if (seen.has(id)) continue;
    seen.add(id);

    nodes.push({
      id,
      node_type: 'symbol',
      file_path: relPath,
      language_id: isPhp ? 'php' : 'typescript',
      symbol_name: def.name,
      symbol_kind: SYMBOL_KIND_LABEL[def.type],
      ...(qualifiedName ? { qualified_name: qualifiedName } : {}),
      updated_at: updatedAt,
    });
  }

  return nodes;
}
