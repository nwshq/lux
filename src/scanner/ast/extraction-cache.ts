// Shared per-rebuild AST extraction cache (Lever D).
//
// Historically each source file was tree-sitter parsed THREE times per rebuild:
// once in materializeAstSymbols, once in AstStructuralResolver.resolve, and once
// in resolveTypedReceiverEdges. This cache parses every AST-eligible file exactly
// once; all three consumers read the returned map instead of re-parsing. Keyed by
// path relative to the scanned root, matching every consumer's `toRelative`.

import type { ScanResult } from '../types.js';
import { extractSource, getGrammars, langForFile, type Extraction } from './extract.js';

/** Extraction results for a rebuild, keyed by path relative to the scanned root. */
export type SharedExtractions = Map<string, Extraction>;

/**
 * Parse every AST-eligible source file exactly once for this rebuild. A parse
 * failure on one file is isolated (reported via `onWarn`, omitted from the cache)
 * so a single pathological source cannot abort the rest — each consumer then
 * skips the missing entry, matching its own parse-failure isolation.
 */
export async function buildSharedExtractions(
  scan: ScanResult,
  rootPath: string,
  onWarn?: (message: string) => void
): Promise<SharedExtractions> {
  const grammars = await getGrammars();
  const cache: SharedExtractions = new Map();

  for (const entry of scan.knowledge) {
    if (entry.type !== 'source-code' || !entry.content) continue;
    const lang = langForFile(entry.filePath);
    if (!lang) continue;

    const relPath = entry.filePath.startsWith(rootPath + '/')
      ? entry.filePath.slice(rootPath.length + 1)
      : entry.filePath;
    try {
      cache.set(relPath, extractSource(grammars, entry.content, relPath, lang).extraction);
    } catch (error) {
      onWarn?.(
        `AST extraction failed for ${relPath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return cache;
}
