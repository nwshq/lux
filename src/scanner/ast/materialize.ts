// AST symbol materialization into the structural overlay (Phase 4).
//
// Persists `symbol` StructuralNodes derived from tree-sitter for every source
// file, so the overlay has symbol nodes even when LSP enrichment is absent.
// Gated by lux.yaml `ast.enabled`; invoked from rebuildStructuralOverlay before
// the association engine runs, so the AST resolver's edges reference real nodes.

import type { LuxDatabase } from '../../db/index.js';
import type { ScanResult } from '../types.js';
import { extractSource, getGrammars, langForFile } from './extract.js';
import { buildAstSymbolNodes } from './symbols.js';

/**
 * Extract and persist AST symbol nodes for all source-code files in a scan.
 *
 * A parse failure on one file is isolated (logged, skipped) so a single
 * pathological source cannot abort materialization of the rest.
 *
 * @returns The number of distinct symbol nodes materialized.
 */
export async function materializeAstSymbols(
  db: LuxDatabase,
  scan: ScanResult,
  rootPath: string,
  now: number,
  onWarn?: (message: string) => void
): Promise<number> {
  const grammars = await getGrammars();
  const seen = new Set<string>();
  let count = 0;

  for (const entry of scan.knowledge) {
    if (entry.type !== 'source-code' || !entry.content) continue;
    const lang = langForFile(entry.filePath);
    if (!lang) continue;

    const relPath = toRelative(entry.filePath, rootPath);
    let nodes;
    try {
      const { extraction } = extractSource(grammars, entry.content, relPath, lang);
      nodes = buildAstSymbolNodes(relPath, extraction, lang, now);
    } catch (error) {
      onWarn?.(
        `AST symbol extraction failed for ${relPath}: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
    for (const node of nodes) {
      db.upsertStructuralNode(node);
      if (!seen.has(node.id)) {
        seen.add(node.id);
        count++;
      }
    }
  }

  return count;
}

function toRelative(absolutePath: string, rootPath: string): string {
  if (absolutePath.startsWith(rootPath + '/')) {
    return absolutePath.slice(rootPath.length + 1);
  }
  return absolutePath;
}
