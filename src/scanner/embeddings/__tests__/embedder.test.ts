// src/scanner/embeddings/__tests__/embedder.test.ts
//
// The seam entry point createEmbedder's BRANCHING logic, fully network-free and weights-free: the
// heavy WasmLocalEmbedder module is mocked, so the token-absent local path is exercised without
// loading the ~34 MB ONNX weights or touching the network. The token-present branch constructs the real
// ApiEmbedder (Phase 4) — which is a pure constructor (no fetch until embed()), so it too is
// network-free here. Real WasmLocalEmbedder identity/dims are asserted against the actual model in
// wasm-local-embedder.determinism.test.ts (LUX_EMBED_SMOKE-gated).

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

  it('ignores config on the local path when tokenless — provider/model are inert (Decision 11)', async () => {
    delete process.env.LUX_EMBEDDING_TOKEN;
    const embedder = await createEmbedder({ provider: 'openai', model: 'text-embedding-3-large' });
    // Still the local embedder — config does not select a provider without the env token.
    expect(embedder.dims).toBe(384);
    expect(embedder.model).toContain('bge-small-en-v1.5-q8');
    expect(embedder.model).not.toContain('openai');
  });

  it('routes to the ApiEmbedder when LUX_EMBEDDING_TOKEN is present — model === openai:<model> (Phase 4)', async () => {
    process.env.LUX_EMBEDDING_TOKEN = 'sk-test-fake';
    const embedder = await createEmbedder({ provider: 'openai', model: 'text-embedding-3-small' });
    expect(embedder.model).toBe('openai:text-embedding-3-small');
    expect(embedder.dims).toBe(384);
  });

  it('defaults the API model to text-embedding-3-small when config omits it', async () => {
    process.env.LUX_EMBEDDING_TOKEN = 'sk-test-fake';
    const fromUndefined = await createEmbedder(undefined);
    expect(fromUndefined.model).toBe('openai:text-embedding-3-small');
    const fromProviderOnly = await createEmbedder({ provider: 'openai' });
    expect(fromProviderOnly.model).toBe('openai:text-embedding-3-small');
  });
});
