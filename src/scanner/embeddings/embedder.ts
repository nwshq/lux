// src/scanner/embeddings/embedder.ts  (FENCED — scanner/embeddings/*)
//
// The one seam of the whole anchor-embedding substrate. Everything upstream (the embed pass,
// node-embed-pass.ts) and every consumer (the hybrid orchestration in cli/anchor-search.ts, the
// query-embed in the semantic half) programs against THIS interface — never against
// WasmLocalEmbedder or onnxruntime-web directly, and never against ApiEmbedder (Phase 4). In Phase 3
// there is exactly ONE production implementation (WasmLocalEmbedder) and exactly ONE other
// (a deterministic test stub, StubEmbedder, under __tests__/); Phase 4 adds a THIRD (ApiEmbedder,
// spec 19), selected inside createEmbedder below. The seam exists so:
//   (a) tests inject a fast, deterministic, network-free embedder instead of loading ~34 MB of ONNX
//       weights and running WASM inference in every unit test, and
//   (b) the native-free-vs-API choice (Decision 7) is one branch in createEmbedder — never a change
//       to any caller's code, because every caller holds an `Embedder`.

/**
 * The embedding configuration surface, from `lux.yaml`'s `embedding:` section (Phase 4 wires it;
 * Decision 7/11). Deliberately carries NO token field:
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

/**
 * The one seam. `model`/`dims` are read-only identity; `embed` is the passage (batched) side and
 * `embedQuery` the query (single-text) side. The two sides differ ONLY for asymmetric models:
 * WasmLocalEmbedder's embedQuery prepends BGE_QUERY_PREFIX, while an eventual symmetric provider's
 * embedQuery is a thin wrapper over embed(). Callers must not assume embed === embedQuery.
 */
export interface Embedder {
  /** Self-describing identity — ANCHOR_EMBED_MODEL for the local default, '<provider>:<model>' for
   *  the API path. Recorded verbatim into every structural_node_embeddings.model cell AND used as the
   *  read filter, so a stored vector's provenance is a checkable fact, never an assumption. */
  readonly model: string;
  /** ANCHOR_EMBED_DIMS (384) for the local default. Every returned Float32Array MUST have this length. */
  readonly dims: number;
  /** Batched — the PASSAGE side. Deterministic within a pinned runtime config (SC-DETERM). Returns
   *  exactly `texts.length` vectors, in order, each of length `dims`. NEVER prefixes: the node-embed
   *  pass stores passage vectors, and prefixing a passage would poison the corpus. */
  embed(texts: string[]): Promise<Float32Array[]>;
  /** The QUERY side. For the local bge default, prepends BGE_QUERY_PREFIX (the asymmetric retrieval
   *  instruction); passage-side embed() never prefixes. For a symmetric provider this is a no-op
   *  wrapper over embed([text]). Returns one vector of length `dims`. */
  embedQuery(text: string): Promise<Float32Array>;
}

/**
 * The substrate's only production entry point (`03 §Contract-name registry`).
 *
 * PHASE 3 (this spec): returns the native-free local WasmLocalEmbedder (Decision 3) whenever no API
 * token is configured. The `config` param is part of the frozen seam NOW so Phase 4 (spec 19) slots
 * the API branch in HERE, touching exactly this one function and not a single caller — every caller
 * holds an `Embedder`.
 *
 * The `LUX_EMBEDDING_TOKEN`-present case fails closed in Phase 3: `ApiEmbedder` (spec 19) does not
 * exist yet, so rather than silently downgrading a token-configured operator to the LOCAL model
 * (which would embed under a different `model` identity than they asked for and quietly poison the
 * active-model read filter), createEmbedder throws a clear "arrives in Phase 4" error. Phase 4
 * REPLACES the throw's body with the terminal edit:
 *
 *     const { ApiEmbedder } = await import('./api-embedder.js');
 *     return ApiEmbedder.create(config);
 *
 * The dynamic import of the local path below is deliberate: keeping WasmLocalEmbedder OUT of this
 * file's static import graph means merely importing the `Embedder` type or the `createEmbedder`
 * symbol does NOT eager-load onnxruntime-web (~34 MB of WASM glue). onnxruntime-web loads only when
 * createEmbedder is actually CALLED down the local path — exactly the cold-CLI lazy-load posture
 * `03 §Warm vs cold` asks the orchestration to preserve.
 */
export async function createEmbedder(config: EmbeddingConfig | undefined): Promise<Embedder> {
  if (process.env.LUX_EMBEDDING_TOKEN) {
    throw new Error(
      'LUX_EMBEDDING_TOKEN is set, but the API embedder (ApiEmbedder) is not available until Phase 4. ' +
        'Unset LUX_EMBEDDING_TOKEN to use the native-free local embedder (WasmLocalEmbedder).'
    );
  }
  void config; // threaded for the Phase-4 API seam; intentionally unread on the Phase-3 local path.
  const { WasmLocalEmbedder } = await import('./wasm-local-embedder.js');
  return WasmLocalEmbedder.create();
}
