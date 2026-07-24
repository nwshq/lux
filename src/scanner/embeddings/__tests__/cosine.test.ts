import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../../db/index.js';
import { cosineSimilarity, topCosine } from '../cosine.js';
import { encodeVector } from '../codec.js';
import { ANCHOR_EMBED_DIMS, ANCHOR_EMBED_MODEL } from '../model-pin.js';

const OTHER_MODEL =
  'other-model@sha256:0000000000000000000000000000000000000000000000000000000000000000';

/** A full-length unit vector living in the first two dims (rest zero) — so cosine == the 2-D dot
 *  product and every score is hand-computable. Callers pass unit inputs; these are already unit. */
function vec(x: number, y: number): Float32Array {
  const v = new Float32Array(ANCHOR_EMBED_DIMS);
  v[0] = x;
  v[1] = y;
  return v;
}

function seed(db: LuxDatabase, nodeId: string, model: string, v: Float32Array): void {
  db.upsertNodeEmbedding({
    node_id: nodeId,
    model,
    dims: ANCHOR_EMBED_DIMS,
    vector: encodeVector(v),
    content_hash: `hash-${nodeId}`,
  });
}

describe('cosineSimilarity (dot product of unit vectors)', () => {
  it('a unit vector against itself is 1.0 (within float rounding)', () => {
    const a = vec(1, 0);
    expect(cosineSimilarity(a, a)).toBeCloseTo(1.0, 6);
  });

  it('returns the arithmetic dot product for a known angle', () => {
    // 60° apart: dot = cos(60°) = 0.5.
    expect(cosineSimilarity(vec(1, 0), vec(0.5, Math.sqrt(3) / 2))).toBeCloseTo(0.5, 6);
    // Orthogonal → 0.
    expect(cosineSimilarity(vec(1, 0), vec(0, 1))).toBe(0);
  });

  it('throws on mismatched-length inputs', () => {
    expect(() => cosineSimilarity(new Float32Array(3), new Float32Array(4))).toThrow(
      /dimension mismatch/
    );
  });
});

describe('topCosine (model-filtered full-scan kernel — D11)', () => {
  let dir: string;
  let db: LuxDatabase;
  const query = vec(1, 0);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lux-cosine-'));
    db = new LuxDatabase(join(dir, 'test.db'));
    // Active-model rows: A cos=1.0, B cos=0.5, C cos=0.0.
    seed(db, 'nodeA', ANCHOR_EMBED_MODEL, vec(1, 0));
    seed(db, 'nodeB', ANCHOR_EMBED_MODEL, vec(0.5, Math.sqrt(3) / 2));
    seed(db, 'nodeC', ANCHOR_EMBED_MODEL, vec(0, 1));
    // Other-model rows (must be invisible under the active-model scan): X cos=1.0, Y cos=~0.707.
    seed(db, 'nodeX', OTHER_MODEL, vec(1, 0));
    seed(db, 'nodeY', OTHER_MODEL, vec(Math.SQRT1_2, Math.SQRT1_2));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns only active-model rows, correctly ordered, when k exceeds the row count', () => {
    const hits = topCosine(query, db, 5, ANCHOR_EMBED_MODEL);
    // At most the 3 active-model rows — never the 2 other-model rows.
    expect(hits.map((h) => h.nodeId)).toEqual(['nodeA', 'nodeB', 'nodeC']);
    expect(hits[0].score).toBeCloseTo(1.0, 6);
    expect(hits[1].score).toBeCloseTo(0.5, 6);
    expect(hits[2].score).toBeCloseTo(0.0, 6);
    expect(hits.some((h) => h.nodeId === 'nodeX' || h.nodeId === 'nodeY')).toBe(false);
  });

  it('respects a k smaller than the active-model row count, still ordered + scoped', () => {
    const hits = topCosine(query, db, 2, ANCHOR_EMBED_MODEL);
    expect(hits.map((h) => h.nodeId)).toEqual(['nodeA', 'nodeB']);
  });

  it('scans the OTHER model space when asked — the scope follows the model param', () => {
    const hits = topCosine(query, db, 5, OTHER_MODEL);
    expect(hits.map((h) => h.nodeId)).toEqual(['nodeX', 'nodeY']);
    expect(hits[0].score).toBeCloseTo(1.0, 6);
    expect(hits[1].score).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it('returns [] for a model with no rows', () => {
    expect(topCosine(query, db, 5, 'no-such-model@sha256:deadbeef')).toEqual([]);
  });

  it('throws when the query dims != ANCHOR_EMBED_DIMS', () => {
    expect(() => topCosine(new Float32Array(3), db, 5, ANCHOR_EMBED_MODEL)).toThrow(
      /ANCHOR_EMBED_DIMS/
    );
  });
});
