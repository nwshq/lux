// src/scanner/anchors/lexical-ranker.ts
//
// The lexical half of the anchor ranker (Decision 3/4). Reuses the L0 FTS5 match-expression builder
// (search-query.ts) so `lux anchors` speaks the same FTS5 grammar and classifies the same invalid
// queries the same way `lux search` does — refusal classification, not a new query DSL (Non-Goals).
// NON-fenced: imports nothing from scanner/embeddings/.

import type { LuxDatabase, LexicalAnchorRow } from '../../db/index.js';
import { buildFtsMatchExpression } from '../../db/search-query.js';
import { classifyAnchorFtsError } from './anchor-refusal.js';

export interface LexicalAnchorHit {
  nodeId: string;
  symbolKind: string;
  symbolName: string;
  qualifiedName: string | null;
  filePath: string;
  bm25Rank: number; // raw weighted bm25 (negative, lower = better)
  lexicalRank: number; // 1-based position in the bm25 order (RRF input)
}

/**
 * Rank anchors lexically. Throws AnchorRefusalError('invalid-query') for an empty/malformed query
 * (via buildFtsMatchExpression) and AnchorRefusalError('fts-unavailable'|'invalid-query') for a
 * MATCH-time failure (via classifyAnchorFtsError) — never a silent empty. `limit` is validated by
 * the caller.
 */
export function rankAnchorsLexical(
  db: LuxDatabase,
  query: string,
  limit: number
): LexicalAnchorHit[] {
  // buildFtsMatchExpression throws SearchRefusalError('invalid-query') on an empty query; re-key it.
  let expression: string;
  try {
    expression = buildFtsMatchExpression(query, {});
  } catch (error) {
    throw classifyAnchorFtsError(error, query);
  }

  let rows: LexicalAnchorRow[];
  try {
    rows = db.rankAnchorsLexical(expression, limit);
  } catch (error) {
    throw classifyAnchorFtsError(error, expression);
  }

  return rows.map((row, i) => ({
    nodeId: row.node_id,
    symbolKind: row.symbol_kind,
    symbolName: row.symbol_name,
    qualifiedName: row.qualified_name,
    filePath: row.file_path,
    bm25Rank: row.rank,
    lexicalRank: i + 1,
  }));
}
