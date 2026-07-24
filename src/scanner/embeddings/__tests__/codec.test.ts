import { describe, it, expect } from 'vitest';
import { encodeVector, decodeVector } from '../codec.js';
import { ANCHOR_EMBED_DIMS } from '../model-pin.js';

/** A full-length fixture with the non-trivial values SC-CONSUME requires: a negative, an exact 0,
 *  a near-±1, plus a deterministic spread across the rest. Every value round-trips exactly because
 *  the codec is a pure byte copy of an already-f32 array. */
function fixtureVector(): Float32Array {
  const v = new Float32Array(ANCHOR_EMBED_DIMS);
  for (let i = 0; i < v.length; i++) v[i] = Math.sin(i) * 0.5;
  v[0] = -0.983423; // negative
  v[1] = 0; // exact zero
  v[2] = 0.99999994; // near +1 (a representable f32)
  v[3] = -1; // exact -1
  return v;
}

describe('embedding codec (Float32 <-> little-endian BLOB)', () => {
  it('round-trips byte-identically — exact float equality, no epsilon (SC-CONSUME)', () => {
    const v = fixtureVector();
    const round = decodeVector(encodeVector(v));
    expect(round.length).toBe(ANCHOR_EMBED_DIMS);
    for (let i = 0; i < v.length; i++) {
      expect(Object.is(round[i], v[i])).toBe(true);
    }
  });

  it('encodeVector produces exactly dims*4 little-endian bytes', () => {
    const bytes = encodeVector(fixtureVector());
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBe(ANCHOR_EMBED_DIMS * 4);
    // Element 3 == -1.0 → IEEE-754 f32 bits 0xBF800000 → little-endian bytes 00 00 80 BF at offset 12.
    expect([bytes[12], bytes[13], bytes[14], bytes[15]]).toEqual([0x00, 0x00, 0x80, 0xbf]);
  });

  it('decode is independent of the source Uint8Array byteOffset (the defensive copy)', () => {
    const v = fixtureVector();
    const encoded = encodeVector(v);
    // Place the encoded bytes at a non-zero, non-4-aligned offset inside a larger buffer, then decode
    // a subarray VIEW (byteOffset === 3). A `new Float32Array(view.buffer, 3, dims)` would throw; the
    // codec's copy-into-aligned-buffer path must decode it correctly regardless.
    const backing = new Uint8Array(encoded.byteLength + 3);
    backing.set(encoded, 3);
    const offsetView = backing.subarray(3);
    expect(offsetView.byteOffset).toBe(3);
    const round = decodeVector(offsetView);
    for (let i = 0; i < v.length; i++) expect(Object.is(round[i], v[i])).toBe(true);
  });

  it('encodeVector throws when length !== ANCHOR_EMBED_DIMS', () => {
    expect(() => encodeVector(new Float32Array(ANCHOR_EMBED_DIMS - 1))).toThrow(
      /expected 384 dims/
    );
    expect(() => encodeVector(new Float32Array(ANCHOR_EMBED_DIMS + 1))).toThrow(
      /expected 384 dims/
    );
    expect(() => encodeVector(new Float32Array(0))).toThrow();
  });

  it('decodeVector throws when byteLength !== ANCHOR_EMBED_DIMS * 4', () => {
    expect(() => decodeVector(new Uint8Array(ANCHOR_EMBED_DIMS * 4 - 4))).toThrow(
      /expected 1536 bytes/
    );
    expect(() => decodeVector(new Uint8Array(ANCHOR_EMBED_DIMS * 4 + 4))).toThrow(
      /expected 1536 bytes/
    );
    expect(() => decodeVector(new Uint8Array(0))).toThrow();
  });
});
