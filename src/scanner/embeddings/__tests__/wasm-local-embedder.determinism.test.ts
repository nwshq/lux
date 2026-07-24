// src/scanner/embeddings/__tests__/wasm-local-embedder.determinism.test.ts
//
// Real-model smoke + same-machine determinism for WasmLocalEmbedder, via the production entry point
// createEmbedder(undefined). SKIPPED by default so `npm test` stays network-free and weights-free —
// it runs ONLY when LUX_EMBED_SMOKE=1.
//
// Network-free run: point LUX_EMBED_SMOKE_MODEL_DIR at a local bge-small-en-v1.5 dir laid out like the
// HF export (onnx/model_quantized.onnx + tokenizer.json + tokenizer_config.json). The beforeAll seeds
// the real per-machine cache (~/.lux/embeddings/<cacheKey>/) from it, so createEmbedder()'s
// ensureModelWeights() is a verified cache HIT with no fetch. If LUX_EMBED_SMOKE_MODEL_DIR is unset,
// the test falls back to createEmbedder's normal download-on-first-index (a one-time ~34 MB fetch) —
// the opt-in flag is still required, so default `npm test` never reaches either path.
//
// The CROSS-MACHINE half of SC-DETERM (comparability within epsilon across architectures) is NOT
// asserted here — it is a design invariant spot-checked manually across >=2 architectures at ship.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ANCHOR_EMBED_DIMS, ANCHOR_EMBED_MODEL } from '../model-pin.js';
import { createEmbedder } from '../embedder.js';
import { ensureModelWeights, resolveModelCacheDir } from '../model-cache.js';

const SMOKE = process.env.LUX_EMBED_SMOKE === '1';
const MODEL_SRC_DIR = process.env.LUX_EMBED_SMOKE_MODEL_DIR;

const cosine = (a: Float32Array, b: Float32Array): number => {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // vectors are L2-normalized
};

const l2 = (v: Float32Array): number => {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
};

const bytesEqual = (a: Float32Array, b: Float32Array): boolean =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(
    Buffer.from(b.buffer, b.byteOffset, b.byteLength)
  );

let savedToken: string | undefined;

describe.skipIf(!SMOKE)(
  'WasmLocalEmbedder (real bge weights, LUX_EMBED_SMOKE-gated, network-free)',
  () => {
    beforeAll(async () => {
      // createEmbedder() throws when LUX_EMBEDDING_TOKEN is set (Phase-4 API path is unbuilt); the smoke
      // exercises the LOCAL path, so temporarily clear the token for this file.
      savedToken = process.env.LUX_EMBEDDING_TOKEN;
      delete process.env.LUX_EMBEDDING_TOKEN;

      // Seed the real per-machine cache from a local model dir (network-free) when one is provided.
      if (MODEL_SRC_DIR) {
        const cacheDir = resolveModelCacheDir();
        mkdirSync(cacheDir, { recursive: true });
        const copies: Array<[string, string]> = [
          [
            join(MODEL_SRC_DIR, 'onnx', 'model_quantized.onnx'),
            join(cacheDir, 'model_quantized.onnx'),
          ],
          [join(MODEL_SRC_DIR, 'tokenizer.json'), join(cacheDir, 'tokenizer.json')],
          [join(MODEL_SRC_DIR, 'tokenizer_config.json'), join(cacheDir, 'tokenizer_config.json')],
        ];
        for (const [src, dst] of copies) if (!existsSync(dst)) cpSync(src, dst);
      }
      // Verify the (seeded or previously-fetched) files against the pinned sha256s; fetches only if
      // still missing/invalid and no MODEL_SRC_DIR was given.
      await ensureModelWeights();
    }, 180_000);

    afterAll(() => {
      if (savedToken !== undefined) process.env.LUX_EMBEDDING_TOKEN = savedToken;
    });

    it('createEmbedder(undefined) is the real WasmLocalEmbedder and embeds one 384-dim L2-normalized passage vector', async () => {
      const embedder = await createEmbedder(undefined);
      expect(embedder.model).toBe(ANCHOR_EMBED_MODEL); // token-absent -> real local identity
      expect(embedder.dims).toBe(ANCHOR_EMBED_DIMS);
      const [v] = await embedder.embed(['stripe service']);
      expect(v.length).toBe(ANCHOR_EMBED_DIMS);
      expect(l2(v)).toBeCloseTo(1, 2);
    }, 180_000);

    it('is deterministic on one machine: identical text -> byte-identical vector', async () => {
      const embedder = await createEmbedder(undefined);
      const [a] = await embedder.embed(['payment gateway charge']);
      const [b] = await embedder.embed(['payment gateway charge']);
      expect(bytesEqual(a, b)).toBe(true);
    }, 180_000);

    it('CLS-pooled query cosine: a near-duplicate passage outranks an unrelated one; embedQuery is well-formed', async () => {
      const embedder = await createEmbedder(undefined);
      const q = await embedder.embedQuery('stripe payment service');
      const [near] = await embedder.embed([
        'StripeService charges payments through the Stripe API',
      ]);
      const [far] = await embedder.embed(['the weather is sunny today']);
      expect(q.length).toBe(ANCHOR_EMBED_DIMS);
      expect(l2(q)).toBeCloseTo(1, 2);
      expect(cosine(q, near)).toBeGreaterThan(cosine(q, far));
    }, 180_000);
  }
);
