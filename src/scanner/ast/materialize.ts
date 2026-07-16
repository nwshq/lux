// AST symbol materialization into the structural overlay (Phase 4).
//
// Persists `symbol` StructuralNodes derived from tree-sitter for every source
// file, so the overlay has symbol nodes even when LSP enrichment is absent.
// Gated by lux.yaml `ast.enabled`; invoked from rebuildStructuralOverlay before
// the association engine runs, so the AST resolver's edges reference real nodes.

import type { LuxDatabase } from '../../db/index.js';
import type { ScanResult } from '../types.js';
import type { StructuralNode } from '../../db/types.js';
import { extractSource, getGrammars, langForFile, type Extraction } from './extract.js';
import type { SharedExtractions } from './extraction-cache.js';
import { buildAstSymbolNodes } from './symbols.js';

/**
 * Extract and persist AST symbol nodes for all source-code files in a scan.
 *
 * A parse failure on one file is isolated (logged, skipped) so a single
 * pathological source cannot abort materialization of the rest.
 *
 * @param extractions - Shared per-rebuild extraction cache (Lever D). When
 *   provided, files are read from it instead of re-parsed; a file absent from
 *   the cache (parse failure upstream) is skipped, matching the isolation the
 *   standalone parse path applies.
 * @returns The number of distinct symbol nodes materialized.
 */
export async function materializeAstSymbols(
  db: LuxDatabase,
  scan: ScanResult,
  rootPath: string,
  now: number,
  extractions?: SharedExtractions,
  onWarn?: (message: string) => void
): Promise<number> {
  // Only parse on demand when no shared cache was supplied.
  const grammars = extractions ? null : await getGrammars();
  const seen = new Set<string>();
  const nodes: StructuralNode[] = [];

  for (const entry of scan.knowledge) {
    if (entry.type !== 'source-code' || !entry.content) continue;
    const lang = langForFile(entry.filePath);
    if (!lang) continue;

    const relPath = toRelative(entry.filePath, rootPath);
    let extraction: Extraction;
    if (extractions) {
      const cached = extractions.get(relPath);
      if (!cached) continue; // absent from the shared cache — isolated upstream
      extraction = cached;
    } else {
      try {
        extraction = extractSource(grammars!, entry.content, relPath, lang).extraction;
      } catch (error) {
        onWarn?.(
          `AST symbol extraction failed for ${relPath}: ${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }
    }
    nodes.push(...buildAstSymbolNodes(relPath, extraction, lang, now));
  }

  // Batch all upserts into one transaction (Lever E) — WAL + synchronous=NORMAL
  // turns the many small commits into a single fsync.
  let count = 0;
  db.transaction(() => {
    for (const node of nodes) {
      db.upsertStructuralNode(node);
      if (!seen.has(node.id)) {
        seen.add(node.id);
        count++;
      }
    }
  });

  return count;
}

function toRelative(absolutePath: string, rootPath: string): string {
  if (absolutePath.startsWith(rootPath + '/')) {
    return absolutePath.slice(rootPath.length + 1);
  }
  return absolutePath;
}
