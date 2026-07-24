// src/scanner/embeddings/index.ts  (FENCED — scanner/embeddings/*)
//
// Public read surface of the anchor-embeddings tier. Decision-Boundary's fence
// (scripts/lint-architecture.ts's PATH_FORBIDDEN_RULES, spec 18) gates who may import from
// scanner/embeddings/ — only scanner/embeddings/ (internal), cli/index.ts (the embed-pass tail),
// cli/anchor-search.ts (the hybrid orchestration), cli/anchors.ts (the CLI), and mcp/server.ts (the
// lux_anchors mirror). Re-exports only what a fenced consumer imports THROUGH this door: topCosine
// (the semantic candidate fetch), the coverage type, and the embedder seam (createEmbedder + the
// Embedder/EmbeddingConfig types). createEmbedder dynamic-imports the heavy WasmLocalEmbedder, so
// re-exporting it here keeps this barrel import-light (no eager onnxruntime-web load). The active-model
// identity is now resolved via active-model.ts's activeEmbeddingModel (Phase 4) — ANCHOR_EMBED_MODEL is
// imported from model-pin directly where still needed, no longer re-exported here. The codec
// (encode/decode), cosineSimilarity, ANCHOR_EMBED_DIMS, the embed pass, the model-cache, active-model,
// and the api-embedder are consumed directly from their own fenced modules, never through this barrel —
// so they are not re-exported here (dead-code hygiene).

export { topCosine } from './cosine.js';
export { createEmbedder } from './embedder.js';
export type { Embedder, EmbeddingConfig } from './embedder.js';
export type { AnchorEmbeddingCoverage } from '../../db/index.js';
