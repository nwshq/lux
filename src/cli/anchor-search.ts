// src/cli/anchor-search.ts
//
// The shared hybrid anchor engine (Decision 2/3). Called by both cli/anchors.ts and mcp/server.ts so
// the ranking/refusal/fusion logic exists once. On the embeddings fence allowlist (03 §Layer & fence)
// — Phase 3 (spec 17) adds the scanner/embeddings/ import here for the semantic half; Phase 1 imports
// none of it.

import type { LuxDatabase } from '../db/index.js';
import { rankAnchorsLexical, type LexicalAnchorHit } from '../scanner/anchors/lexical-ranker.js';
import {
  fuseRrf,
  ANCHOR_MIN_FUSED_SCORE,
  ANCHOR_MIN_LEXICAL_BM25,
  type SemanticRef,
} from '../scanner/anchors/fusion.js';
import { AnchorRefusalError } from '../scanner/anchors/anchor-refusal.js';
import type { AnchorResultV1, AnchorCoverageV1 } from './anchors-envelope.js';

export interface AnchorSearchOptions {
  limit: number;
  /** Phase 3: when false, skip the semantic half even if vectors exist (the CLI lexical-first path
   *  uses this on the fast lexical answer; MCP/warm always attempts semantic). Default true. */
  semantic?: boolean;
}

export interface AnchorSearchResult {
  results: AnchorResultV1[];
  lowConfidence: boolean;
  coverage: AnchorCoverageV1;
}

/**
 * Run the hybrid anchor search. Throws AnchorRefusalError for overlay-missing / anchor-texts-absent /
 * invalid-query / fts-unavailable (the caller renders the refusal envelope + nonzero exit). A healthy
 * populated-index zero result returns an empty `results` (exit 0, unresolved).
 */
export async function runAnchorSearch(
  db: LuxDatabase,
  query: string,
  opts: AnchorSearchOptions
): Promise<AnchorSearchResult> {
  // Extended refusals (03 §The surface): probe the overlay/texts BEFORE any FTS MATCH, so the honest
  // "I cannot look here yet" is distinct from a genuine zero-result.
  if (!db.hasStructuralOverlay()) {
    throw new AnchorRefusalError(
      'overlay-missing',
      query,
      // A corpus with code mints anchor nodes on rebuild; a documents-only corpus has none — the
      // remediation must also point that operator at the prose surface (this message is all a --json
      // / MCP consumer sees; the text renderer adds the same hand-off line).
      'The structural overlay has not been built. Run `lux index rebuild` (a corpus with code mints ' +
        'anchor nodes); a documents-only corpus has none — search its prose with `lux search`.'
    );
  }
  const anchorViableNodes = db.getAnchorViableNodeCount();
  if (anchorViableNodes === 0) {
    throw new AnchorRefusalError(
      'anchor-texts-absent',
      query,
      'The overlay is present but carries no anchor texts (is `ast.enabled` false?). ' +
        'Enable AST materialization, or run `lux index rebuild`.'
    );
  }

  // Lexical half — always runs (throws its own invalid-query/fts-unavailable refusals).
  const lexical: LexicalAnchorHit[] = rankAnchorsLexical(db, query, opts.limit);

  // Semantic half — PHASE 1 STUB: no vectors, no model. Phase 3 (spec 17) replaces the awaited call
  // with `await runSemanticHalf(db, query, opts)`, returning topCosine hits (cosine >=
  // ANCHOR_MIN_COSINE) as SemanticRef[] plus the active model + coverage. The `await` is the
  // Phase-3 seam (an async model load + query-embed lands here); in Phase 1 the surface degrades to
  // lexical-only and says so in coverage.model:null.
  const semantic: SemanticRef[] = await Promise.resolve([]);
  const semanticModel: string | null = null;
  const embeddedNodes = 0;

  const fused = fuseRrf(
    lexical.map((h) => ({ nodeId: h.nodeId, lexicalRank: h.lexicalRank })),
    semantic
  ).slice(0, opts.limit);

  // Attach node metadata: from the lexical hit map, else (semantic-only, Phase 3) a node lookup.
  const lexByNode = new Map(lexical.map((h) => [h.nodeId, h]));
  const results: AnchorResultV1[] = fused.map((f) => {
    const meta = lexByNode.get(f.nodeId);
    if (meta) {
      return {
        nodeId: f.nodeId,
        symbolKind: meta.symbolKind,
        symbolName: meta.symbolName,
        qualifiedName: meta.qualifiedName,
        filePath: meta.filePath,
        matchedVia: f.matchedVia,
        lexicalRank: f.lexicalRank,
        cosine: f.cosine,
        fusedScore: f.fusedScore,
      };
    }
    // Semantic-only (Phase 3): resolve metadata from structural_nodes by id.
    const node = db.getStructuralNode(f.nodeId);
    return {
      nodeId: f.nodeId,
      symbolKind: node?.symbol_kind ?? 'Unknown',
      symbolName: node?.symbol_name ?? f.nodeId,
      qualifiedName: node?.qualified_name ?? null,
      filePath: node?.file_path ?? '',
      matchedVia: f.matchedVia,
      lexicalRank: f.lexicalRank,
      cosine: f.cosine,
      fusedScore: f.fusedScore,
    };
  });

  // Confidence floor (Decision-Fusion) — two modes (T1.8):
  //  · Lexical-only (semanticModel === null, always in Phase 1): the fused score of a single-list RRF
  //    top hit is always ~1/(RRF_K+1) regardless of match quality, so it cannot separate a confident
  //    anchor from a thin token collision. Derive confidence from the top hit's raw weighted-bm25
  //    signal instead — a top bm25 weaker (greater) than ANCHOR_MIN_LEXICAL_BM25 is a thin match.
  //  · Hybrid (semanticModel !== null, Phase 3): the fused score IS meaningful across two rank lists,
  //    so the whole-surface ANCHOR_MIN_FUSED_SCORE gates.
  let lowConfidence = false;
  const top = results[0];
  if (top) {
    if (semanticModel === null) {
      const topBm25 = lexByNode.get(top.nodeId)?.bm25Rank ?? 0;
      lowConfidence = topBm25 > ANCHOR_MIN_LEXICAL_BM25;
    } else {
      lowConfidence = top.fusedScore < ANCHOR_MIN_FUSED_SCORE;
    }
  }

  return {
    results,
    lowConfidence,
    coverage: { embeddedNodes, anchorViableNodes, model: semanticModel },
  };
}

/**
 * Coverage for a REFUSAL envelope (CLI --json / MCP). A refusal carries no ranked hits, but the
 * anchor-viable count is still real and must be reported accurately: a non-overlay refusal
 * (invalid-query / fts-unavailable) over a POPULATED index has embedded texts, so a hardcoded zero
 * would be a false statement in the frozen schemaVersion:1 `coverage` field. For overlay-missing /
 * anchor-texts-absent the count is a genuine 0 (autoMigrate keeps the table present, so the probe is
 * always safe). Embeddings are absent in Phase 1, so embeddedNodes:0 / model:null stay hardcoded.
 */
export function anchorRefusalCoverage(db: LuxDatabase): AnchorCoverageV1 {
  return { embeddedNodes: 0, anchorViableNodes: db.getAnchorViableNodeCount(), model: null };
}
