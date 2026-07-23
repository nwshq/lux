import { describe, it, expect } from 'vitest';
import {
  fuseRrf,
  RRF_K,
  ANCHOR_MIN_FUSED_SCORE,
  ANCHOR_MIN_LEXICAL_BM25,
  type LexicalRef,
  type SemanticRef,
  type FusedEntry,
} from '../fusion.js';

describe('fuseRrf', () => {
  it('pins the RRF constant at 60 (the standard robust default)', () => {
    expect(RRF_K).toBe(60);
  });

  it('marks a node in both lists matchedVia:both and sums both reciprocal ranks', () => {
    const lexical: LexicalRef[] = [{ nodeId: 'n1', lexicalRank: 1 }];
    const semantic: SemanticRef[] = [{ nodeId: 'n1', semanticRank: 1, cosine: 0.9 }];
    const fused: FusedEntry[] = fuseRrf(lexical, semantic);
    expect(fused).toHaveLength(1);
    expect(fused[0].matchedVia).toBe('both');
    expect(fused[0].cosine).toBe(0.9);
    expect(fused[0].fusedScore).toBeCloseTo(1 / 61 + 1 / 61, 10);
  });

  it('keeps provenance for lexical-only and semantic-only nodes', () => {
    const fused = fuseRrf(
      [{ nodeId: 'lex', lexicalRank: 1 }],
      [{ nodeId: 'sem', semanticRank: 1, cosine: 0.5 }]
    );
    const byId = new Map(fused.map((f) => [f.nodeId, f]));
    expect(byId.get('lex')?.matchedVia).toBe('lexical');
    expect(byId.get('sem')?.matchedVia).toBe('semantic');
  });

  it('orders by descending fused score, ties broken deterministically', () => {
    // n2 is in both lists (higher fused), n1 lexical-only rank 1, n3 semantic-only rank 2.
    const fused = fuseRrf(
      [
        { nodeId: 'n1', lexicalRank: 1 },
        { nodeId: 'n2', lexicalRank: 2 },
      ],
      [
        { nodeId: 'n2', semanticRank: 1, cosine: 0.8 },
        { nodeId: 'n3', semanticRank: 2, cosine: 0.7 },
      ]
    );
    expect(fused[0].nodeId).toBe('n2'); // in both → highest
    expect(fused.map((f) => f.nodeId)).toEqual(['n2', 'n1', 'n3']);
  });

  it('is empty-safe (Phase-1 lexical-only degenerates to single-list RRF)', () => {
    const fused = fuseRrf([{ nodeId: 'a', lexicalRank: 1 }], []);
    expect(fused).toHaveLength(1);
    expect(fused[0].matchedVia).toBe('lexical');
    expect(fused[0].fusedScore).toBeCloseTo(1 / 61, 10);
  });

  it('confidence floors are the pinned battery-derived values (T1.8)', () => {
    expect(ANCHOR_MIN_FUSED_SCORE).toBeGreaterThan(0); // reachable in hybrid mode (Phase 3)
    expect(ANCHOR_MIN_LEXICAL_BM25).toBe(-2.0); // lexical-mode floor, calibrated (BATTERY-OWNER.md)
  });
});
