// src/scanner/anchors/lexical-ranker.ts
//
// The lexical half of the anchor ranker (Decision 3/4). Builds the FTS5 match expression with the
// anchor-specific OR-expanding builder (anchor-query.ts) — `lux anchors` takes a natural-language
// query, so bare terms are OR-expanded (not L0's keyword-AND) and the weighted bm25 ranks the
// multi-term/rare-term hits to the top. Invalid-query classification stays identical to L0 (same
// error class, re-keyed by classifyAnchorFtsError) — refusal classification, not a new query DSL
// (Non-Goals). NON-fenced: imports nothing from scanner/embeddings/.

import type { LuxDatabase, LexicalAnchorRow } from '../../db/index.js';
import { buildAnchorMatchExpression } from './anchor-query.js';
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
 * Rank anchors lexically. Throws AnchorRefusalError('invalid-query') for an empty/tokenless query
 * (via buildAnchorMatchExpression) and AnchorRefusalError('fts-unavailable'|'invalid-query') for a
 * MATCH-time failure (via classifyAnchorFtsError) — never a silent empty. `limit` is validated by
 * the caller.
 */
export function rankAnchorsLexical(
  db: LuxDatabase,
  query: string,
  limit: number
): LexicalAnchorHit[] {
  // buildAnchorMatchExpression throws SearchRefusalError('invalid-query') on an empty/tokenless query;
  // re-key it to AnchorRefusalError (identical L0 behavior).
  let expression: string;
  try {
    expression = buildAnchorMatchExpression(query);
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
