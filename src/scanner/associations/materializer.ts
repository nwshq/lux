// Structural node materializer.
//
// Converts scan results and LSP enrichment data into StructuralNode records
// and persists them to the DB. This is the step that populates the node table
// before the association engine can produce edges.
//
// Two node categories are materialized here:
//   - file   : one per indexed source code file
//   - symbol : top-level symbols from LSP enrichment results

import type { LuxDatabase } from '../../db/index.js';
import type { StructuralNode } from '../../db/types.js';
import type { ScanResult, ScannedKnowledge } from '../types.js';
import type { EnrichmentMap, EnrichmentResult } from '../lsp/index.js';
import { fileNodeId, phpSymbolNodeId, tsSymbolNodeId } from './types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface MaterializeResult {
  fileNodes: number;
  symbolNodes: number;
}

/**
 * Materialize and persist all structural nodes from a completed scan.
 *
 * Call this before running AssociationEngine so resolvers can reference
 * real node IDs that exist in the DB.
 *
 * @param db - Database to write nodes into.
 * @param scan - Completed scan result from GeneralScanner.
 * @param enrichments - LSP enrichment results keyed by absolute file path.
 * @param rootPath - Absolute repository root (used to compute relative paths).
 */
export function materializeNodes(
  db: LuxDatabase,
  scan: ScanResult,
  enrichments: EnrichmentMap,
  rootPath: string
): MaterializeResult {
  let fileNodes = 0;
  let symbolNodes = 0;

  for (const entry of scan.knowledge) {
    if (entry.type !== 'source-code') continue;

    // File node — one per source file
    const fileNode = buildFileNode(entry, rootPath);
    db.upsertStructuralNode(fileNode);
    fileNodes++;

    // Symbol nodes — from LSP enrichment (may be absent for unenriched files)
    const enrichment = enrichments.get(entry.filePath);
    if (enrichment && enrichment.symbols.length > 0) {
      const symNodes = buildSymbolNodes(entry.filePath, enrichment, rootPath);
      for (const node of symNodes) {
        db.upsertStructuralNode(node);
        symbolNodes++;
      }
    }
  }

  return { fileNodes, symbolNodes };
}

// ---------------------------------------------------------------------------
// Node builders (exported for testing and CLI use)
// ---------------------------------------------------------------------------

/**
 * Build a file StructuralNode from a scanned knowledge entry.
 */
export function buildFileNode(entry: ScannedKnowledge, rootPath: string): StructuralNode {
  const relPath = toRelative(entry.filePath, rootPath);
  const fm = entry.frontmatter as Record<string, unknown> | undefined;
  const languageId = (fm?.language as string | undefined) ?? undefined;

  return {
    id: fileNodeId(relPath),
    node_type: 'file',
    file_path: relPath,
    language_id: languageId,
    updated_at: nowEpoch(),
  };
}

/**
 * Build symbol StructuralNodes from an enrichment result.
 * Only top-level symbols are materialized (no nested children).
 */
export function buildSymbolNodes(
  absoluteFilePath: string,
  enrichment: EnrichmentResult,
  rootPath: string
): StructuralNode[] {
  const relPath = toRelative(absoluteFilePath, rootPath);
  const lang = enrichment.languageId;
  const nodes: StructuralNode[] = [];
  const ts = nowEpoch();

  // Use the PHP-enrichment-specific qualified name when available
  const ext = enrichment as unknown as Record<string, unknown>;
  const phpReferences = ext['references'] as Array<{ symbolName: string; symbolKind: number }> | undefined;
  const phpQualifiedNames = buildPhpQualifiedNameMap(phpReferences);

  for (const symbol of enrichment.symbols) {
    const id =
      lang === 'php'
        ? phpSymbolNodeId(phpQualifiedNames.get(symbol.name) ?? symbol.name)
        : tsSymbolNodeId(relPath, symbol.name);

    nodes.push({
      id,
      node_type: 'symbol',
      file_path: relPath,
      language_id: lang,
      symbol_name: symbol.name,
      symbol_kind: symbol.kindLabel,
      qualified_name: phpQualifiedNames.get(symbol.name),
      updated_at: ts,
    });
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function toRelative(absolutePath: string, rootPath: string): string {
  if (absolutePath.startsWith(rootPath + '/')) {
    return absolutePath.slice(rootPath.length + 1);
  }
  return absolutePath;
}

function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Build a name→qualified_name map from PHP reference data.
 * PHP enrichment includes the symbol name but not the FQN from enrichment.symbols;
 * the references field carries the same names, so we use it to detect what's present.
 * In practice, the FQN would come from type hierarchy data.
 */
function buildPhpQualifiedNameMap(
  references?: Array<{ symbolName: string; symbolKind: number }>
): Map<string, string> {
  const map = new Map<string, string>();
  if (!references) return map;
  for (const ref of references) {
    // Placeholder: in a full implementation, extract the FQN from the file's
    // namespace declaration combined with the symbol name. For now pass through.
    map.set(ref.symbolName, ref.symbolName);
  }
  return map;
}
