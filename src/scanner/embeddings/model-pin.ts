// src/scanner/embeddings/model-pin.ts  (FENCED — scanner/embeddings/*)
//
// The pinned local default identity (Decision 7/9) + the frozen semantic-tier constants. Architecture
// + quantization + weights digest, fixed in code like a dependency version, and recorded in every
// structural_node_embeddings.model cell so a vector's provenance is self-describing. A model bump is a
// code release that edits ANCHOR_EMBED_MODEL; mismatched rows then re-embed via the widened queue's
// (node_id, model) LEFT JOIN. Digests measured/verified against the live q8 model (Phase-3 pins).

export const ANCHOR_EMBED_MODEL =
  'bge-small-en-v1.5-q8@sha256:6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4' as const;
export const ANCHOR_EMBED_DIMS = 384 as const;
/** Internal committed budget (Decision 5 degrade semantics), NOT operator config. Test-injectable. */
export const ANCHOR_EMBED_BUDGET_MS = 30_000 as const;
// Semantic-half floor (Decision-Fusion). Calibrated on the live concept→node battery: every gold hit
// (q8, query-prefix) sits at cosine ≥ 0.588 (min; median 0.736), so 0.4 sits below every real hit with
// margin and cuts the sub-0.4 noise tail. Recall-conservative; owner-battery may tighten. NOT configurable.
export const ANCHOR_MIN_COSINE = 0.4 as const;
// NOTE (reconciliation, MANIFEST §Reconciliation notes #1): the whole-surface confidence floor
// ANCHOR_MIN_FUSED_SCORE and RRF_K are NOT here — they live in the NON-fenced src/scanner/anchors/
// fusion.ts (Phase 1), because they ship with the lexical tier before this fenced model-pin.ts exists.
// This file owns only ANCHOR_MIN_COSINE (the semantic-half floor).
/** bge-family asymmetric query instruction (OQ2). Applied by embedQuery iff the probe selects it. */
export const BGE_QUERY_PREFIX =
  'Represent this sentence for searching relevant passages: ' as const;
export const ANCHOR_EMBED_MODEL_ARTIFACTS = {
  cacheKey: 'bge-small-en-v1.5-q8',
  // Immutable HF revision (Xenova ONNX export). LFS sha256 of model_quantized.onnx verified == local.
  source:
    'https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/ea104dacec62c0de699686887e3f920caeb4f3e3',
  files: {
    'model_quantized.onnx': {
      sha256: '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4',
      bytes: 34014426,
    },
    'tokenizer.json': {
      sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66',
      bytes: 711396,
    },
    'tokenizer_config.json': {
      sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
      bytes: 366,
    },
  },
} as const;
