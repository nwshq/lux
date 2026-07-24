// src/scanner/embeddings/__tests__/embedder.test.ts
//
// The seam entry point createEmbedder's BRANCHING logic, fully network-free and weights-free: the
// heavy WasmLocalEmbedder module is mocked, so the token-absent local path is exercised without
// loading the ~34 MB ONNX weights or touching the network. The token-present branch throws BEFORE the
// dynamic import, so it needs no mock at all. Real WasmLocalEmbedder identity/dims are asserted
// against the actual model in wasm-local-embedder.determinism.test.ts (LUX_EMBED_SMOKE-gated).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmbedder } from '../embedder.js';

// Intercept the module createEmbedder() dynamic-imports on the local path, so no weights load.
vi.mock('../wasm-local-embedder.js', () => ({
  WasmLocalEmbedder: {
    create: vi.fn(async () => ({
      model: 'bge-small-en-v1.5-q8@sha256:mocked',
      dims: 384,
      embed: async (texts: string[]) => texts.map(() => new Float32Array(384)),
      embedQuery: async () => new Float32Array(384),
    })),
  },
}));

const savedToken = process.env.LUX_EMBEDDING_TOKEN;

afterEach(() => {
  if (savedToken === undefined) delete process.env.LUX_EMBEDDING_TOKEN;
  else process.env.LUX_EMBEDDING_TOKEN = savedToken;
  vi.clearAllMocks();
});

describe('createEmbedder', () => {
  it('routes to the native-free local WasmLocalEmbedder when LUX_EMBEDDING_TOKEN is absent (Decision 3)', async () => {
    delete process.env.LUX_EMBEDDING_TOKEN;
    const embedder = await createEmbedder(undefined);
    expect(embedder.dims).toBe(384);
    expect(embedder.model).toContain('bge-small-en-v1.5-q8');
    const [v] = await embedder.embed(['x']);
    expect(v.length).toBe(384);
  });

  it('ignores config on the local path in Phase 3 (config is threaded for Phase 4, unread now)', async () => {
    delete process.env.LUX_EMBEDDING_TOKEN;
    const embedder = await createEmbedder({ provider: 'openai', model: 'text-embedding-3-small' });
    expect(embedder.dims).toBe(384); // still the local embedder — config does not select a provider yet
  });

  it('fails closed with a clear Phase-4 error when LUX_EMBEDDING_TOKEN is present (ApiEmbedder is spec 19)', async () => {
    process.env.LUX_EMBEDDING_TOKEN = 'sk-test-fake';
    await expect(createEmbedder(undefined)).rejects.toThrow(/Phase 4/);
    await expect(createEmbedder({ provider: 'openai' })).rejects.toThrow(/LUX_EMBEDDING_TOKEN/);
  });
});
