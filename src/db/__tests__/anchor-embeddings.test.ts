import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../index.js';
import { encodeVector, decodeVector } from '../../scanner/embeddings/codec.js';
import { ANCHOR_EMBED_DIMS, ANCHOR_EMBED_MODEL } from '../../scanner/embeddings/model-pin.js';

const MODEL = ANCHOR_EMBED_MODEL;
const OTHER = 'other-model@sha256:1111111111111111111111111111111111111111111111111111111111111111';

/** Seed a structural_node_texts (+ FTS) row directly — the anchor-viable driving table for the queue
 *  and coverage reads. FTS fields are filler; these tests exercise the texts/embeddings join only. */
function seedText(db: LuxDatabase, nodeId: string, contentHash: string): void {
  db.upsertNodeAnchorText({
    node_id: nodeId,
    prepared: `prepared text for ${nodeId}`,
    content_hash: contentHash,
    name: nodeId,
    identifiers: nodeId,
    qualified: nodeId,
    path_segments: 'src services',
    context: 'signature',
  });
}

function anyVector(seed = 0.25): Float32Array {
  const v = new Float32Array(ANCHOR_EMBED_DIMS);
  for (let i = 0; i < v.length; i++) v[i] = Math.sin(i + seed) * 0.5;
  return v;
}

function seedEmbedding(db: LuxDatabase, nodeId: string, model: string, contentHash: string): void {
  db.upsertNodeEmbedding({
    node_id: nodeId,
    model,
    dims: ANCHOR_EMBED_DIMS,
    vector: encodeVector(anyVector()),
    content_hash: contentHash,
  });
}

describe('anchor embeddings — migration 015 storage/queue/coverage (D5/D7/D11)', () => {
  let dir: string;
  let db: LuxDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lux-embed-'));
    db = new LuxDatabase(join(dir, 'test.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('migration 015 applies (schema reaches version 15)', () => {
    expect(db.getMigrationStatus().currentVersion).toBeGreaterThanOrEqual(15);
  });

  it('round-trips a vector through a real WASM upsert → get → decode cycle, byte-exact (SC-CONSUME)', () => {
    const v = anyVector(0.7);
    v[0] = -1;
    v[1] = 0;
    v[2] = 0.99999994;
    db.upsertNodeEmbedding({
      node_id: 'symbol:php:App\\Services\\StripeService',
      model: MODEL,
      dims: ANCHOR_EMBED_DIMS,
      vector: encodeVector(v),
      content_hash: 'ch-1',
    });
    const row = db.getNodeEmbeddingByNode('symbol:php:App\\Services\\StripeService', MODEL);
    expect(row).toBeDefined();
    expect(row!.model).toBe(MODEL);
    expect(row!.dims).toBe(ANCHOR_EMBED_DIMS);
    expect(row!.content_hash).toBe('ch-1');
    const decoded = decodeVector(row!.vector);
    for (let i = 0; i < v.length; i++) expect(Object.is(decoded[i], v[i])).toBe(true);
  });

  it('getNodeEmbeddingByNode is model-scoped (a row under a different model reads back undefined)', () => {
    seedText(db, 'n1', 'ch');
    seedEmbedding(db, 'n1', MODEL, 'ch');
    expect(db.getNodeEmbeddingByNode('n1', MODEL)).toBeDefined();
    expect(db.getNodeEmbeddingByNode('n1', OTHER)).toBeUndefined();
  });

  it('re-embedding a node REPLACEs its single active vector (node_id PK)', () => {
    seedText(db, 'n1', 'ch');
    seedEmbedding(db, 'n1', MODEL, 'ch');
    // Re-embed the same node under OTHER — the PK is node_id, so this replaces the row in place.
    seedEmbedding(db, 'n1', OTHER, 'ch');
    expect(db.getNodeEmbeddingByNode('n1', MODEL)).toBeUndefined(); // old-model row gone
    expect(db.getNodeEmbeddingByNode('n1', OTHER)).toBeDefined();
    expect(db.getNodeVectorsForModel(MODEL)).toHaveLength(0);
    expect(db.getNodeVectorsForModel(OTHER)).toHaveLength(1);
  });

  describe('the widened freshness queue (D5 — IS NULL + content_hash<> arms)', () => {
    it('returns exactly the never-embedded + stale-survivor nodes, excludes the fresh one', () => {
      seedText(db, 'a', 'ha'); // never embedded
      seedText(db, 'b', 'hb'); // fresh embedding (content_hash matches)
      seedText(db, 'c', 'hc'); // stale survivor (embedding content_hash differs from text)
      seedEmbedding(db, 'b', MODEL, 'hb');
      seedEmbedding(db, 'c', MODEL, 'hc-OLD');

      const queue = db.getUnembeddedAnchorNodes(MODEL, 10);
      const ids = queue.map((r) => r.node_id).sort();
      expect(ids).toEqual(['a', 'c']); // a via IS NULL, c via content_hash<>; never b
      // Each returned row carries the persisted prepared text + the CURRENT text content_hash (the
      // value to copy onto the new embedding), proving the pass never re-parses.
      const rowC = queue.find((r) => r.node_id === 'c')!;
      expect(rowC.prepared).toBe('prepared text for c');
      expect(rowC.content_hash).toBe('hc'); // the text's current hash, not the stale embedding's
    });

    it('a node fresh under one model appears in the queue under a DIFFERENT model (LEFT JOIN e.model=?)', () => {
      seedText(db, 'b', 'hb');
      seedEmbedding(db, 'b', MODEL, 'hb'); // fresh under MODEL
      expect(db.getUnembeddedAnchorNodes(MODEL, 10).map((r) => r.node_id)).not.toContain('b');
      // Under OTHER, b has no embedding row → the IS NULL arm surfaces it (proves e.model = ? drives it).
      expect(db.getUnembeddedAnchorNodes(OTHER, 10).map((r) => r.node_id)).toContain('b');
    });

    it('honours the LIMIT', () => {
      for (let i = 0; i < 5; i++) seedText(db, `n${i}`, `h${i}`);
      expect(db.getUnembeddedAnchorNodes(MODEL, 2)).toHaveLength(2);
      expect(db.getUnembeddedAnchorNodes(MODEL, 10)).toHaveLength(5);
    });
  });

  describe('getAnchorEmbeddingCoverage (denominator = anchor-viable, numerator = fresh-under-model — D11)', () => {
    it('counts 5 anchor-viable, 3 embedded fresh under the bound model', () => {
      for (let i = 0; i < 5; i++) seedText(db, `n${i}`, `h${i}`);
      seedEmbedding(db, 'n0', MODEL, 'h0');
      seedEmbedding(db, 'n1', MODEL, 'h1');
      seedEmbedding(db, 'n2', MODEL, 'h2');
      expect(db.getAnchorEmbeddingCoverage(MODEL)).toEqual({
        anchorViableNodes: 5,
        embeddedNodes: 3,
        model: MODEL,
      });
    });

    it('a model change drops the numerator, not the denominator', () => {
      for (let i = 0; i < 5; i++) seedText(db, `n${i}`, `h${i}`);
      seedEmbedding(db, 'n0', MODEL, 'h0');
      seedEmbedding(db, 'n1', MODEL, 'h1');
      seedEmbedding(db, 'n2', MODEL, 'h2');
      // Re-embed one of the three under a different model, then read under the ORIGINAL model.
      seedEmbedding(db, 'n2', OTHER, 'h2');
      const cov = db.getAnchorEmbeddingCoverage(MODEL);
      expect(cov.embeddedNodes).toBe(2);
      expect(cov.anchorViableNodes).toBe(5);
    });

    it('a stale-content_hash row is counted un-embedded (coverage + queue agree on "fresh")', () => {
      for (let i = 0; i < 5; i++) seedText(db, `n${i}`, `h${i}`);
      seedEmbedding(db, 'n0', MODEL, 'h0');
      seedEmbedding(db, 'n1', MODEL, 'h1');
      seedEmbedding(db, 'n2', MODEL, 'h2');
      expect(db.getAnchorEmbeddingCoverage(MODEL).embeddedNodes).toBe(3);
      // Mutate n2's prepared text (a content_hash change under a stable id) WITHOUT re-embedding.
      seedText(db, 'n2', 'h2-CHANGED');
      expect(db.getAnchorEmbeddingCoverage(MODEL).embeddedNodes).toBe(2);
      expect(db.getAnchorEmbeddingCoverage(MODEL).anchorViableNodes).toBe(5);
      // The same node the queue's content_hash<> arm now surfaces.
      expect(db.getUnembeddedAnchorNodes(MODEL, 10).map((r) => r.node_id)).toContain('n2');
    });
  });

  describe('victim delete + full clear now cover the embeddings sibling table', () => {
    it('deleteNodeAnchorRowsForNodeIds sweeps the victim node’s embedding row', () => {
      seedText(db, 'keep', 'hk');
      seedText(db, 'victim', 'hv');
      seedEmbedding(db, 'keep', MODEL, 'hk');
      seedEmbedding(db, 'victim', MODEL, 'hv');
      expect(db.getNodeVectorsForModel(MODEL)).toHaveLength(2);

      db.deleteNodeAnchorRowsForNodeIds(['victim']);
      expect(db.getNodeEmbeddingByNode('victim', MODEL)).toBeUndefined();
      expect(db.getNodeEmbeddingByNode('keep', MODEL)).toBeDefined();
      const rows = db.getNodeVectorsForModel(MODEL);
      expect(rows.map((r) => r.node_id)).toEqual(['keep']);
    });

    it('clearOverlay empties the embeddings plane beside texts/FTS/nodes', () => {
      seedText(db, 'n1', 'h1');
      seedEmbedding(db, 'n1', MODEL, 'h1');
      expect(db.getNodeVectorsForModel(MODEL)).toHaveLength(1);

      db.clearOverlay();
      expect(db.getNodeVectorsForModel(MODEL)).toHaveLength(0);
      expect(db.getAnchorEmbeddingCoverage(MODEL)).toEqual({
        anchorViableNodes: 0,
        embeddedNodes: 0,
        model: MODEL,
      });
    });
  });
});
