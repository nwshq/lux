// src/scanner/embeddings/cosine.ts  (FENCED — scanner/embeddings/*)
//
// Plain-JS cosine kernel (D7 — no ANN, no sqlite-vec: node-sqlite3-wasm ships zero loadExtension and
// WASM cannot dlopen, so an in-process vector extension is not an option). The anchor-viable set on
// acme-core is ~40,915 nodes (03 §Population scope), and a full fp32 dot-product scan over that many
// 384-dim vectors is the warm-path latency target (03 §Warm vs cold: an FTS hit + a full-scan cosine
// in tens of ms, model + index resident). This is the exact read path the semantic half of the anchor
// ranker uses: the shared CLI/MCP orchestration (cli/anchor-search.ts) calls topCosine, then hands the
// ranked node ids to fuseRrf (fusion.ts) — the math lives here once, so lexical and semantic halves
// are fused over identically-scored bytes.

import type { LuxDatabase } from '../../db/index.js';
import { decodeVector } from './codec.js';
import { ANCHOR_EMBED_DIMS } from './model-pin.js';

/**
 * Cosine similarity as a plain dot product.
 *
 * Precondition (not re-checked per call, for the reason below): both vectors are already
 * L2-normalized. The committed local embedder CLS-pools (the [CLS] token's hidden state at position
 * 0 — NOT the primitive's mean-pool) then L2-normalizes every vector it produces (model-pin.ts;
 * WasmLocalEmbedder, spec 15/16), and every stored `vector` BLOB is that embedder's direct output; an
 * API embedder (Phase 4) returns provider-normalized unit vectors by the same caller contract. For two
 * unit vectors, cosine similarity IS the dot product; renormalizing here (an extra sqrt + two more
 * passes per vector) would be dead weight on the exact hot path D7's tens-of-ms full-scan rationale
 * depends on — `topCosine` calls this once per stored row. If a future caller ever hands this function
 * a non-unit vector, it silently returns a plain dot product, not a true cosine similarity; that
 * caller's obligation to normalize first is the contract, not a runtime-enforced invariant.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: dimension mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Top-k nearest node vectors to `query` under the ACTIVE model — the shared read path for the
 * semantic half of the anchor ranker (03 §The surface). Scans ONLY
 * `db.getNodeVectorsForModel(model)` (D11): a mid-model-change corpus transiently holds both
 * old- and new-model rows, and this function never sees the ones outside the requested space, so it
 * can never compute a cross-model cosine (two vectors from different embedding spaces are not
 * comparable at any normalization — D11's rejected alternative). The read is narrowed to the two
 * columns used here (node_id + vector) — the other row columns are pure over-fetch on this hot path.
 *
 * `model` is a REQUIRED parameter, not a baked constant — the deliberate re-key from the primitive's
 * constant-baked filter. The primitive had exactly one pinned model, so it filtered on the constant
 * `EMBED_MODEL`; this plane's active model is config-selectable (Decision 7/11 — the local default OR
 * an API model, and a bge re-pin changes it too), so the filter must be the active model. The D11
 * "no cross-model cosine" invariant is preserved because the caller ALWAYS passes `embedder.model`
 * (the active embedder's self-describing identity, 03 §The Embedder seam) and there is no code path
 * that widens the scan — the model scope is enforced HERE, once, in the single call from the shared
 * orchestration, so the fusion consumer cannot forget it.
 */
export function topCosine(
  query: Float32Array,
  db: LuxDatabase,
  k: number,
  model: string
): Array<{ nodeId: string; score: number }> {
  if (query.length !== ANCHOR_EMBED_DIMS) {
    throw new Error(
      `topCosine: query dims ${query.length} !== ANCHOR_EMBED_DIMS ${ANCHOR_EMBED_DIMS}`
    );
  }
  const limit = Math.max(0, Math.trunc(k));
  const rows = db.getNodeVectorsForModel(model);
  const scored: Array<{ nodeId: string; score: number }> = [];
  for (const row of rows) {
    const vector = decodeVector(row.vector);
    scored.push({ nodeId: row.node_id, score: cosineSimilarity(query, vector) });
  }
  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, limit);
}
