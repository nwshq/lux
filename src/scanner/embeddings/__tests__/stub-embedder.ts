// src/scanner/embeddings/__tests__/stub-embedder.ts
//
// The seam's only OTHER implementation in Phase 3 (embedder.ts: "exactly ONE other"). Deterministic
// and hash-seeded: the same input text always produces the same output vector, in any process, with
// no model weights, no network, and no WASM. Every embed-pass/storage/kernel test in this payload
// injects this instead of WasmLocalEmbedder so those suites run in milliseconds and never depend on
// the ~34 MB weights cache being present.
//
// This is NOT a relatedness-preserving embedder — it carries no semantic signal at all. Signal-
// quality assertions (cosine-of-related > cosine-of-unrelated) belong ONLY against the real
// WasmLocalEmbedder (the DIST/smoke test, and the lift probe) — never against this stub.

import { createHash } from 'node:crypto';
import type { Embedder } from '../embedder.js';

export class StubEmbedder implements Embedder {
  readonly model: string;
  readonly dims: number;

  constructor(options: { model?: string; dims?: number } = {}) {
    this.model = options.model ?? 'stub-embedder@test-fixture';
    this.dims = options.dims ?? 384; // matches ANCHOR_EMBED_DIMS by default
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.hashSeededVector(text));
  }

  /** Query side. The stub is symmetric — it applies no bge prefix (it carries no semantic signal, so
   *  an asymmetric instruction would be meaningless); it simply hash-seeds the raw query text, so
   *  embedQuery is as deterministic as embed and satisfies the extended interface. */
  async embedQuery(text: string): Promise<Float32Array> {
    const [vector] = await this.embed([text]);
    return vector;
  }

  /** Deterministic pseudo-embedding: stream sha256(text) (re-hashing to extend past 32 bytes) into a
   *  unit-length Float32Array. Same shape contract as a real embedder (fixed length, L2-normalized)
   *  so storage/codec/coverage tests exercise the real invariants — values carry no semantic meaning. */
  private hashSeededVector(text: string): Float32Array {
    const vector = new Float32Array(this.dims);
    let seed = createHash('sha256').update(text).digest();
    let offset = 0;
    for (let i = 0; i < this.dims; i++) {
      if (offset >= seed.length) {
        seed = createHash('sha256').update(seed).digest();
        offset = 0;
      }
      vector[i] = seed[offset] / 127.5 - 1; // map a byte (0-255) into [-1, 1)
      offset += 1;
    }
    let normSq = 0;
    for (let i = 0; i < this.dims; i++) normSq += vector[i] * vector[i];
    const norm = Math.sqrt(normSq) || 1;
    for (let i = 0; i < this.dims; i++) vector[i] /= norm;
    return vector;
  }
}
