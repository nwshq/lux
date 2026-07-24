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

// The `embedding:` config TYPE lives in the NON-fenced scanner/anchors/embedding-config.ts (spec 19
// §Note, resolution 2) so scanner/config.ts can import it without tripping the path-fence; the seam
// re-exports it here so every embeddings consumer still reads it through this one door.
export type { EmbeddingConfig } from '../anchors/embedding-config.js';
import type { EmbeddingConfig } from '../anchors/embedding-config.js';

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
 * The env token is the ONLY selector (Decision 7/11): `LUX_EMBEDDING_TOKEN` present ⇒ the API path
 * (`ApiEmbedder` over fetch, provider/model from lux.yaml `config`); absent ⇒ the native-free local
 * `WasmLocalEmbedder` (bge-small). The default install is tokenless ⇒ native-free, zero config; a
 * token-configured operator's `provider`/`model` in yaml select the API model, but the key itself is
 * env-only (an inline `embedding.token` fails config load — Decision 11).
 *
 * BOTH implementations are behind a dynamic `import()`. Keeping WasmLocalEmbedder AND ApiEmbedder out
 * of this file's static import graph means merely importing the `Embedder` type or the `createEmbedder`
 * symbol eager-loads NEITHER onnxruntime-web (~34 MB of WASM glue, the local path) nor the API-embedder
 * module (the tokenless hot path never touches it). Each loads only when createEmbedder is CALLED down
 * its branch — exactly the cold-CLI lazy-load posture `03 §Warm vs cold` asks the orchestration to
 * preserve, and it keeps the tokenless default install free of any API-path code on its hot path.
 */
export async function createEmbedder(config: EmbeddingConfig | undefined): Promise<Embedder> {
  if (process.env.LUX_EMBEDDING_TOKEN) {
    const { ApiEmbedder } = await import('./api-embedder.js');
    return ApiEmbedder.fromConfig(config);
  }
  void config; // provider/model are inert without a token — the local path is native-free by default.
  const { WasmLocalEmbedder } = await import('./wasm-local-embedder.js');
  return WasmLocalEmbedder.create();
}
