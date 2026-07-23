// src/scanner/anchors/fusion.ts
//
// Reciprocal-rank fusion of the lexical + semantic anchor rank lists (Decision 3/Decision-Fusion).
// Rank-based because bm25 (negative, unbounded) and cosine ([-1,1]) are incomparable scales. Pure —
// takes two rank lists as data, returns fused entries keyed by nodeId. The semantic list is EMPTY in
// Phase 1 (lexical-only); Phase 3 (spec 17) populates it and nothing here changes.

/** RRF constant (Decision-Fusion): score = Σ 1/(RRF_K + rank_i). k=60 is the standard robust default. */
export const RRF_K = 60 as const;

/**
 * Hybrid-mode confidence floor (Decision-Fusion). Gates `lowConfidence` when the semantic half has
 * run (Phase 3): a top FUSED score below this — a top hit only one modality found, with no strong
 * cross-corroboration — sets lowConfidence:true. NOT configurable.
 *
 * Derivation (RRF math, re-confirmed against the Phase-2/3 hybrid battery when the semantic half
 * ships): a top hit ranked #1 by BOTH lexical and semantic scores 2/(60+1) ≈ 0.0328; a top hit found
 * by only ONE modality at rank #1 scores 1/61 ≈ 0.0164. The floor sits between them, so a single-
 * modality top hit with no corroboration reads as low-confidence while a both-modalities top hit does
 * not. In LEXICAL-ONLY mode (Phase 1, and any index without vectors) this floor is NOT used — every
 * single-list RRF top hit is rank-1 ≈ 0.0164 regardless of match quality, so it cannot separate a
 * confident anchor from a thin token collision. The lexical path uses ANCHOR_MIN_LEXICAL_BM25 below.
 */
export const ANCHOR_MIN_FUSED_SCORE = 0.025 as const;

/**
 * Lexical-only confidence floor (Decision-Fusion, the T1.8 pin). In lexical-only mode the fused score
 * is meaningless for confidence (always ~1/61), so `lowConfidence` derives from the top hit's raw
 * WEIGHTED bm25 signal instead. bm25 is negative and lower = stronger; a top bm25 GREATER than (weaker
 * than) this floor is a thin match — a common word that matched only the low-weighted `context` column
 * with no name/identifier/qualified hit. Below (more negative than) the floor is a confident anchor:
 * a real name/identifier/path hit, which the (5,4,2,2,1) column weights drive strongly negative.
 *
 * Calibrated on the T1.8 battery (method + evidence recorded in benchmarks/anchors/BATTERY-OWNER.md):
 * the value separates the seeded thin-collision case (lowConfidence:true) from every confident/
 * exact-identifier case (lowConfidence:false). Measured top weighted-bm25 on the calibration corpus —
 * confident name/identifier hits land at ≤ -3.4 ("user" -3.47, "stripe service" -4.59, "payment
 * gateway" -7.58, "EmailEventRegistrants" -4.15); thin context-only collisions land at ≥ -1.3
 * ("handles" -1.29, "class" 0). -2.0 sits in the gap between them. The (5,4,2,2,1) column weights
 * dominate the separation (a name hit is ≥5× a context hit). bm25 is IDF-driven, so the separation is
 * NOT uniform across corpus sizes: on an overlay LARGER than this calibration set a rare identifier's
 * higher IDF pushes confident hits further negative (the gap widens, -2.0 stays conservative); on an
 * overlay SMALLER than it the IDF shrinks and a strong hit's top bm25 can rise above -2.0, so a tiny
 * overlay may OVER-FLAG a confident anchor as low-confidence. That is benign — lowConfidence is a soft
 * warning and results are still returned. Net: conservative for overlays ≥ the calibration size,
 * merely over-cautious below it. The value's live-index validation is deferred to the owner-run T1.8
 * battery (Phase 2). NOT configurable.
 *
 * Holds under OR-expansion (anchor-query.ts). FTS5 bm25 sums only the terms a node actually matches,
 * so OR-expanding the query does not change a matched node's score — it only lets more candidates in
 * for bm25 to rank. Re-measured on the live concept→node battery (LIFT-PROBE-RESULTS.md): every
 * gold-is-top case lands at bm25 ≤ -18 (all correctly lowConfidence:false, zero confident anchors
 * wrongly flagged); only the weakest single-common-word tops rise above -2.0. On a large overlay the
 * OR-expanded multi-term match drives confident hits strongly negative, so -2.0 stays conservative.
 */
export const ANCHOR_MIN_LEXICAL_BM25 = -2.0 as const;

/** A lexical rank-list entry (1-based position). */
export interface LexicalRef {
  nodeId: string;
  lexicalRank: number;
}
/** A semantic rank-list entry (1-based position + its cosine, for the envelope). */
export interface SemanticRef {
  nodeId: string;
  semanticRank: number;
  cosine: number;
}

export interface FusedEntry {
  nodeId: string;
  matchedVia: 'lexical' | 'semantic' | 'both';
  lexicalRank?: number;
  cosine?: number;
  fusedScore: number;
}

/**
 * Fuse two rank lists by RRF. A node in both lists sums both reciprocal ranks and is `matchedVia:
 * 'both'`. Output is sorted by descending fused score; ties broken by lexicalRank then nodeId for
 * determinism.
 */
export function fuseRrf(
  lexical: LexicalRef[],
  semantic: SemanticRef[],
  opts: { k?: number } = {}
): FusedEntry[] {
  const k = opts.k ?? RRF_K;
  const byNode = new Map<string, FusedEntry>();

  for (const l of lexical) {
    byNode.set(l.nodeId, {
      nodeId: l.nodeId,
      matchedVia: 'lexical',
      lexicalRank: l.lexicalRank,
      fusedScore: 1 / (k + l.lexicalRank),
    });
  }
  for (const s of semantic) {
    const existing = byNode.get(s.nodeId);
    if (existing) {
      existing.matchedVia = 'both';
      existing.cosine = s.cosine;
      existing.fusedScore += 1 / (k + s.semanticRank);
    } else {
      byNode.set(s.nodeId, {
        nodeId: s.nodeId,
        matchedVia: 'semantic',
        cosine: s.cosine,
        fusedScore: 1 / (k + s.semanticRank),
      });
    }
  }

  return [...byNode.values()].sort(
    (a, b) =>
      b.fusedScore - a.fusedScore ||
      (a.lexicalRank ?? Infinity) - (b.lexicalRank ?? Infinity) ||
      (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0)
  );
}
