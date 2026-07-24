// src/scanner/embeddings/api-embedder.ts  (FENCED — scanner/embeddings/*)
//
// External embedder over fetch (Decision 7 — the measured quality lever). Selected ONLY when
// process.env.LUX_EMBEDDING_TOKEN is set (Decision 11 — env-only). model comes from lux.yaml
// (EmbeddingConfig); the provider is OpenAI (NOT Anthropic — no first-party embeddings API; NOT
// Voyage — see the §why-not-Voyage note below). Requests 384 dims so stored vectors stay codec/kernel-
// compatible (ANCHOR_EMBED_DIMS). No SDK — plain fetch, so the default install pulls no API dependency
// and the zero-.node CI assertion is unaffected.

import { ANCHOR_EMBED_DIMS } from './model-pin.js';
import type { Embedder, EmbeddingConfig } from './embedder.js';
// The OpenAI default model lives in ONE import-light const module (openai-defaults.ts) so this file and
// active-model.ts share a single literal — the "no two-space split" guarantee is structural, not merely
// locked by active-model.test.ts. Re-exported here so the model-identity default keeps its historical
// import door (active-model.test.ts / api-embedder.test.ts import it from this module).
import { OPENAI_DEFAULT_MODEL } from './openai-defaults.js';
export { OPENAI_DEFAULT_MODEL };

/** Wall-clock ceiling on a single embeddings request (Fix 4 — no unbounded fetch). A hung provider
 *  endpoint must not stall the index embed pass; on timeout the request aborts and throws, degrading
 *  exactly like any other embed failure (runNodeEmbedPass never persists a partial batch). */
const OPENAI_FETCH_TIMEOUT_MS = 30_000;
export { OPENAI_FETCH_TIMEOUT_MS };

export class ApiEmbedder implements Embedder {
  readonly model: string;
  readonly dims = ANCHOR_EMBED_DIMS; // 384 — requested from OpenAI via the `dimensions` param (embed())
  private readonly providerModel: string;
  private readonly token: string;

  private constructor(providerModel: string, token: string) {
    this.providerModel = providerModel;
    this.token = token;
    this.model = `openai:${providerModel}`; // the per-row identity + read filter (D11)
  }

  /** Construct from config + the env token. Throws if the token is absent (createEmbedder only calls
   *  this when the token IS present, but the guard keeps the failure honest if that changes). */
  static fromConfig(config: EmbeddingConfig | undefined): ApiEmbedder {
    const token = process.env.LUX_EMBEDDING_TOKEN;
    if (!token) {
      throw new Error('ApiEmbedder: LUX_EMBEDDING_TOKEN is not set.');
    }
    // provider is validated to 'openai' (the sole shipped provider); model defaults to OpenAI's
    // 384-capable small model. A future provider slots in here (behind a dims-aware codec — §note).
    const providerModel = config?.model ?? OPENAI_DEFAULT_MODEL;
    return new ApiEmbedder(providerModel, token);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    return this.embedOpenai(texts);
  }

  /** Query side — symmetric for the API providers (no asymmetric instruction prefix). */
  async embedQuery(text: string): Promise<Float32Array> {
    const [v] = await this.embed([text]);
    return v;
  }

  private async embedOpenai(texts: string[]): Promise<Float32Array[]> {
    // Fix 4: bound the request with an AbortController so a hung endpoint can't stall the embed pass.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OPENAI_FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.providerModel,
          input: texts,
          dimensions: ANCHOR_EMBED_DIMS,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      // A timeout (our abort) or any network-layer failure lands here. Fail loud with a clear message
      // so the pass degrades like any other embed failure — never persisting a partial/misassigned row.
      if (controller.signal.aborted) {
        throw new Error(
          `ApiEmbedder(openai): request timed out after ${OPENAI_FETCH_TIMEOUT_MS} ms ` +
            `(the provider endpoint did not respond).`,
          { cause: error }
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new Error(`ApiEmbedder(openai): HTTP ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as { data: Array<{ index: number; embedding: number[] }> };
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    // Fix 1 — count + contiguity assertion (the Embedder contract: "exactly texts.length vectors, in
    // order"). node-embed-pass.ts consumes these POSITIONALLY (`vectors[i]` ↔ `rows[i]`), so a short,
    // gapped, or duplicated provider response would silently persist a WRONG vector against a matching
    // content_hash — one that never self-heals. Assert BEFORE mapping to vectors: exactly one row per
    // input, and (post-sort) the indices are exactly 0,1,…,n-1 (no gaps, no dupes). The length check
    // also closes the empty-response case (`embedQuery` on empty `data`). Fail loud in the same style as
    // the non-384 dims throw, so the pass degrades without ever writing a misassigned row.
    if (sorted.length !== texts.length) {
      throw new Error(
        `ApiEmbedder(openai): provider returned ${sorted.length} embeddings, expected ${texts.length} ` +
          `(the Embedder contract requires exactly one vector per input, in order).`
      );
    }
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].index !== i) {
        throw new Error(
          `ApiEmbedder(openai): provider returned non-contiguous embedding indices — expected ` +
            `0..${texts.length - 1}, got a gap/duplicate at position ${i} (index ${sorted[i].index}). ` +
            `The Embedder contract requires exactly one vector per input, in order.`
        );
      }
    }
    return this.toVectors(sorted.map((d) => d.embedding));
  }

  /** Validate + L2-normalize each returned embedding into a 384-length Float32Array. The kernel's
   *  cosine assumes unit vectors; normalize here so an API model that returns un-normalized vectors is
   *  still comparable byte-for-byte with the local path. */
  private toVectors(raw: number[][]): Float32Array[] {
    return raw.map((arr) => {
      if (arr.length !== ANCHOR_EMBED_DIMS) {
        throw new Error(
          `ApiEmbedder: provider returned ${arr.length} dims, expected ${ANCHOR_EMBED_DIMS} ` +
            `(request a 384-dim model, or the codec/kernel dims contract is violated).`
        );
      }
      const v = Float32Array.from(arr);
      let norm = 0;
      for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < v.length; i++) v[i] /= norm;
      return v;
    });
  }
}
