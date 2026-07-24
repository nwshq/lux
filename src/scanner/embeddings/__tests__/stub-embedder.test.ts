// src/scanner/embeddings/__tests__/stub-embedder.test.ts
import { describe, expect, it } from 'vitest';
import { StubEmbedder } from './stub-embedder.js';

const bytesEqual = (a: Float32Array, b: Float32Array): boolean =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(
    Buffer.from(b.buffer, b.byteOffset, b.byteLength)
  );

describe('StubEmbedder (the seam’s only other implementation)', () => {
  it('is deterministic: the same text embeds to the byte-identical vector every call', async () => {
    const embedder = new StubEmbedder();
    const [a] = await embedder.embed(['hello world']);
    const [b] = await embedder.embed(['hello world']);
    expect(bytesEqual(a, b)).toBe(true);
  });

  it('produces different vectors for different text', async () => {
    const embedder = new StubEmbedder();
    const [a] = await embedder.embed(['hello world']);
    const [b] = await embedder.embed(['goodbye world']);
    expect(bytesEqual(a, b)).toBe(false);
  });

  it('returns unit-norm vectors of the configured dims (default 384, matching ANCHOR_EMBED_DIMS)', async () => {
    const embedder = new StubEmbedder();
    const [vector] = await embedder.embed(['any text']);
    expect(vector.length).toBe(384);
    let normSq = 0;
    for (const x of vector) normSq += x * x;
    expect(Math.sqrt(normSq)).toBeCloseTo(1, 5);
  });

  it('honors a custom dims/model for tests that need a different shape', async () => {
    const embedder = new StubEmbedder({ model: 'stub@custom', dims: 8 });
    expect(embedder.model).toBe('stub@custom');
    expect(embedder.dims).toBe(8);
    const [vector] = await embedder.embed(['x']);
    expect(vector.length).toBe(8);
  });

  it('batches: embed(texts) returns one vector per input, in order', async () => {
    const embedder = new StubEmbedder();
    const vectors = await embedder.embed(['a', 'b', 'c']);
    expect(vectors).toHaveLength(3);
    const [a1] = await embedder.embed(['a']);
    expect(bytesEqual(vectors[0], a1)).toBe(true);
  });

  it('embedQuery satisfies the extended interface: deterministic, unit-norm, matches embed([text])', async () => {
    const embedder = new StubEmbedder();
    const q1 = await embedder.embedQuery('find the payment gateway');
    const q2 = await embedder.embedQuery('find the payment gateway');
    expect(bytesEqual(q1, q2)).toBe(true); // deterministic
    const [viaEmbed] = await embedder.embed(['find the payment gateway']);
    expect(bytesEqual(q1, viaEmbed)).toBe(true); // stub is symmetric (no prefix)
    let normSq = 0;
    for (const x of q1) normSq += x * x;
    expect(Math.sqrt(normSq)).toBeCloseTo(1, 5);
  });
});
