// src/scanner/anchors/embedding-config.ts  (NON-FENCED — scanner/anchors/*)
//
// The `embedding:` config type, deliberately relocated OUT of the fenced scanner/embeddings/ subtree
// (spec 19 §Note, resolution 2). scanner/config.ts needs THIS type to type `LuxLspConfig.embedding`,
// but config.ts is association/overlay-adjacent machinery that the path-fence (scripts/lint-
// architecture.ts) forbids from importing scanner/embeddings/ at all — and `import type` still resolves
// to a path under the fenced prefix, so a bare type import from the seam would trip the fence. Defining
// the two-field, runtime-free interface here (non-fenced) lets config.ts import it legally, while the
// seam (scanner/embeddings/embedder.ts) re-exports it so every embeddings consumer still reads it from
// the one door it already imports.

/**
 * The embedding configuration surface, from `lux.yaml`'s `embedding:` section (Phase 4; Decision 7/11).
 * Deliberately carries NO token field:
 *   - The API key is read from `process.env.LUX_EMBEDDING_TOKEN` ONLY.
 *   - An inline `embedding.token` in lux.yaml is REJECTED at config load (fail-closed) — Decision 11.
 * Setting/clearing the token, or editing provider/model, changes the ACTIVE model (embedder.model),
 * which stales every stored vector under the active-model read filter; the widened freshness queue
 * re-embeds on the next sync and reads never mix embedding spaces.
 */
export interface EmbeddingConfig {
  provider?: 'openai'; // yaml, optional — the sole shipped API provider (OpenAI; NOT Anthropic). No
  // Voyage: no Voyage model emits 384 dims (voyage-3-lite is fixed-512; Matryoshka only
  // {256,512,1024,2048}), so it cannot satisfy the codec's 384 contract. A future dynamic-dims codec
  // could re-admit a 384-incompatible provider — a measured follow-on, not v1 (spec 19 §Part B note).
  model?: string; // yaml, optional (provider default applies)
  // NO token field — see the interface doc-comment above (env-only LUX_EMBEDDING_TOKEN; Decision 11).
}
