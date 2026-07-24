// src/scanner/embeddings/codec.ts  (FENCED — scanner/embeddings/*)
//
// Float32Array <-> BLOB byte codec for structural_node_embeddings.vector (migration 015). Little-
// endian, dims * 4 bytes, no header/length prefix — dims lives in the sibling `dims` column, not in
// the blob. This is the ONLY place vectors cross the byte boundary; both db/index.ts (bytes in/out)
// and cosine.ts (Float32Array math) go through it.

import { ANCHOR_EMBED_DIMS, ANCHOR_EMBED_MODEL } from './model-pin.js';

/**
 * Encode a Float32Array as little-endian bytes for the `vector` BLOB column.
 *
 * `ArrayBuffer.prototype.slice` (not a raw `Uint8Array` view over `vector.buffer`) copies the
 * vector's own byte range into a fresh, exactly-sized buffer. Two reasons this matters even though
 * `arrayToHeap`'s `HEAPU8.set(array, ptr)` (sqlite-adapter) would read a shared/offset view correctly
 * on its own: (1) it decouples the returned BLOB bytes from the caller's `Float32Array` — mutating
 * `vector` after this call can never corrupt bytes already handed to `bind_blob`; (2) it keeps the
 * encode/decode pair symmetric with `decodeVector`'s defensive copy below, so neither direction of
 * this codec depends on an adapter-internal buffer-sharing detail holding across an engine bump.
 *
 * `Float32Array`'s element byte order is the platform's native endianness. Every target Lux runs on
 * (darwin/linux/win32 x64/arm64, under Node >= 22.12) is little-endian, so the raw bytes ARE
 * little-endian without a per-element `DataView.setFloat32(offset, value, true)` loop.
 */
export function encodeVector(vector: Float32Array): Uint8Array {
  if (vector.length !== ANCHOR_EMBED_DIMS) {
    throw new Error(
      `encodeVector: expected ${ANCHOR_EMBED_DIMS} dims for model ${ANCHOR_EMBED_MODEL}, got ${vector.length}`
    );
  }
  return new Uint8Array(
    vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength)
  );
}

/**
 * Decode a `vector` BLOB column back to a Float32Array.
 *
 * The WASM adapter's BLOB read always hands back a `Uint8Array` at `byteOffset 0` over its own
 * exactly-sized buffer today, so `new Float32Array(bytes.buffer, 0, dims)` would be safe as written.
 * This codec does not lean on that: constructing a `Float32Array` view requires the source
 * `byteOffset` to be a multiple of 4, and a future adapter/engine change handing back a subarray or a
 * `Buffer` with a non-aligned `byteOffset` would make that construction throw a `RangeError` — or,
 * worse, silently misalign every subsequent float if the check were removed. Copying into a fresh,
 * guaranteed-4-byte-aligned buffer unconditionally makes this codec correct independent of that
 * internal, at the cost of one small copy per row (384 floats = 1536 bytes).
 */
export function decodeVector(bytes: Uint8Array): Float32Array {
  const expectedBytes = ANCHOR_EMBED_DIMS * 4;
  if (bytes.byteLength !== expectedBytes) {
    throw new Error(
      `decodeVector: expected ${expectedBytes} bytes (${ANCHOR_EMBED_DIMS} dims) for model ${ANCHOR_EMBED_MODEL}, ` +
        `got ${bytes.byteLength} bytes`
    );
  }
  const aligned = new Uint8Array(bytes.byteLength);
  aligned.set(bytes);
  return new Float32Array(aligned.buffer);
}
