// src/scanner/embeddings/__tests__/api-embedder.test.ts
//
// ApiEmbedder (Phase 4, spec 19 Part B) — fully network-free: globalThis.fetch is stubbed, so no test
// ever reaches the real OpenAI endpoint. Pins the contract: 384-dim L2-normalized vectors returned in
// INPUT order (data sorted by index), a non-384 provider response throws the dims-contract error,
// embedQuery is embed([text])[0], and fromConfig throws when the env token is absent.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiEmbedder, OPENAI_DEFAULT_MODEL, OPENAI_FETCH_TIMEOUT_MS } from '../api-embedder.js';
import { ANCHOR_EMBED_DIMS } from '../model-pin.js';

const savedToken = process.env.LUX_EMBEDDING_TOKEN;
const realFetch = globalThis.fetch;

function makeVec(fill: number, len: number = ANCHOR_EMBED_DIMS): number[] {
  return Array.from({ length: len }, () => fill);
}

/** Stub globalThis.fetch to return an OpenAI-shaped embeddings response. `data` is passed through
 *  verbatim so a test can send it out of index order and assert the embedder re-sorts. */
function stubFetch(data: Array<{ index: number; embedding: number[] }>, ok = true): void {
  globalThis.fetch = vi.fn(async () => ({
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? 'OK' : 'Internal Server Error',
    json: async () => ({ data }),
  })) as unknown as typeof fetch;
}

function l2(v: Float32Array): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s);
}

beforeEach(() => {
  process.env.LUX_EMBEDDING_TOKEN = 'sk-test-fake';
});
afterEach(() => {
  if (savedToken === undefined) delete process.env.LUX_EMBEDDING_TOKEN;
  else process.env.LUX_EMBEDDING_TOKEN = savedToken;
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ApiEmbedder.fromConfig', () => {
  it('throws when LUX_EMBEDDING_TOKEN is absent (honest guard)', () => {
    delete process.env.LUX_EMBEDDING_TOKEN;
    expect(() => ApiEmbedder.fromConfig(undefined)).toThrow(/LUX_EMBEDDING_TOKEN is not set/);
  });

  it('identity is openai:<model>, defaulting to text-embedding-3-small', () => {
    expect(ApiEmbedder.fromConfig(undefined).model).toBe(`openai:${OPENAI_DEFAULT_MODEL}`);
    expect(
      ApiEmbedder.fromConfig({ provider: 'openai', model: 'text-embedding-3-large' }).model
    ).toBe('openai:text-embedding-3-large');
    expect(ApiEmbedder.fromConfig(undefined).dims).toBe(ANCHOR_EMBED_DIMS);
  });
});

describe('ApiEmbedder.embed', () => {
  it('returns 384-dim L2-normalized vectors, one per input, in INPUT order (sorted by index)', async () => {
    // Respond OUT of index order to prove the embedder re-sorts by `index`.
    stubFetch([
      { index: 1, embedding: makeVec(3) },
      { index: 0, embedding: makeVec(2) },
    ]);
    const embedder = ApiEmbedder.fromConfig(undefined);
    const vecs = await embedder.embed(['first', 'second']);
    expect(vecs).toHaveLength(2);
    for (const v of vecs) {
      expect(v).toBeInstanceOf(Float32Array);
      expect(v.length).toBe(ANCHOR_EMBED_DIMS);
      expect(l2(v)).toBeCloseTo(1, 5); // unit vectors (kernel cosine assumes normalized)
    }
    // index 0 (fill 2) is the FIRST output; index 1 (fill 3) the second — proving the re-sort.
    // A constant-fill vector normalizes to 1/sqrt(dims) per component regardless of the fill value.
    const expectedComponent = 1 / Math.sqrt(ANCHOR_EMBED_DIMS);
    expect(vecs[0][0]).toBeCloseTo(expectedComponent, 5);
    expect(vecs[1][0]).toBeCloseTo(expectedComponent, 5);
  });

  it('empty input returns [] without hitting fetch', async () => {
    const spy = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ data: [] }),
    }));
    globalThis.fetch = spy as unknown as typeof fetch;
    const embedder = ApiEmbedder.fromConfig(undefined);
    expect(await embedder.embed([])).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('throws the dims-contract error when the provider returns a non-384 vector', async () => {
    stubFetch([{ index: 0, embedding: makeVec(1, 383) }]);
    const embedder = ApiEmbedder.fromConfig(undefined);
    await expect(embedder.embed(['x'])).rejects.toThrow(/returned 383 dims, expected 384/);
  });

  it('throws the count-contract error on a SHORT response (fewer vectors than inputs)', async () => {
    // Two inputs, one embedding back — vectors[1] would be undefined (or worse, misassigned). The
    // count assertion must fail loud BEFORE any vector is mapped, so no misassigned row is persisted.
    stubFetch([{ index: 0, embedding: makeVec(1) }]);
    const embedder = ApiEmbedder.fromConfig(undefined);
    await expect(embedder.embed(['first', 'second'])).rejects.toThrow(
      /returned 1 embeddings, expected 2/
    );
  });

  it('throws the contiguity-contract error on a GAPPED response (indices [0,1,3] for 4 inputs)', async () => {
    // A same-length-but-gapped batch is the dangerous case: after sort the 4 embeddings compact to
    // positions 0..3 while their `index` values are [0,1,3,4], so a positional consumer would bind the
    // wrong vector to node #2. The contiguity assertion (sorted[i].index === i) must reject it.
    stubFetch([
      { index: 0, embedding: makeVec(1) },
      { index: 1, embedding: makeVec(2) },
      { index: 3, embedding: makeVec(3) },
      { index: 4, embedding: makeVec(4) },
    ]);
    const embedder = ApiEmbedder.fromConfig(undefined);
    await expect(embedder.embed(['a', 'b', 'c', 'd'])).rejects.toThrow(
      /non-contiguous embedding indices/
    );
  });

  it('throws on an EMPTY response for a non-empty input (closes the embedQuery empty-data case)', async () => {
    // embedQuery('x') → embed(['x']); a provider that returns `data: []` must not yield `undefined`.
    stubFetch([]);
    const embedder = ApiEmbedder.fromConfig(undefined);
    await expect(embedder.embedQuery('x')).rejects.toThrow(/returned 0 embeddings, expected 1/);
  });

  it('aborts + throws a clear timeout error when the endpoint never responds (Fix 4)', async () => {
    vi.useFakeTimers();
    // A fetch that never resolves on its own but rejects (AbortError) the instant our controller aborts.
    globalThis.fetch = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        })
    ) as unknown as typeof fetch;
    const embedder = ApiEmbedder.fromConfig(undefined);
    const pending = embedder.embed(['x']);
    const assertion = expect(pending).rejects.toThrow(/timed out after \d+ ms/);
    // Advance past the injected timeout → the setTimeout fires → controller.abort() → fetch rejects.
    await vi.advanceTimersByTimeAsync(OPENAI_FETCH_TIMEOUT_MS + 1);
    await assertion;
  });

  it('throws on a non-ok HTTP response', async () => {
    stubFetch([], false);
    const embedder = ApiEmbedder.fromConfig(undefined);
    await expect(embedder.embed(['x'])).rejects.toThrow(/HTTP 500/);
  });

  it('embedQuery is symmetric — equals embed([text])[0] (no asymmetric prefix)', async () => {
    stubFetch([{ index: 0, embedding: makeVec(5) }]);
    const embedder = ApiEmbedder.fromConfig(undefined);
    const q = await embedder.embedQuery('a concept');
    expect(q.length).toBe(ANCHOR_EMBED_DIMS);
    expect(l2(q)).toBeCloseTo(1, 5);
  });

  it('sends dimensions:384 + the configured model + Bearer token in the request body/headers', async () => {
    const spy = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ data: [{ index: 0, embedding: makeVec(1) }] }),
    }));
    globalThis.fetch = spy as unknown as typeof fetch;
    await ApiEmbedder.fromConfig({ provider: 'openai', model: 'text-embedding-3-small' }).embed([
      'x',
    ]);
    const [url, init] = spy.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('https://api.openai.com/v1/embeddings');
    expect(init.headers.Authorization).toBe('Bearer sk-test-fake');
    const body = JSON.parse(init.body) as { model: string; input: string[]; dimensions: number };
    expect(body).toEqual({ model: 'text-embedding-3-small', input: ['x'], dimensions: 384 });
  });
});
