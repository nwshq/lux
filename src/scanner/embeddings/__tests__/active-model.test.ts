// src/scanner/embeddings/__tests__/active-model.test.ts
//
// The active-model reconciliation (Phase 4). Pins that activeEmbeddingModel / embeddingReadAvailable
// mirror createEmbedder's env-token branch EXACTLY (locked against ApiEmbedder.fromConfig(...).model),
// and that a real DB embedded under the local bge model counts every row as un-embedded once the ACTIVE
// model flips to `openai:<model>` — the automatic model-flip re-embed that keeps reads single-space
// (D11). Env token is guarded per-test and restored. Network-free (no embed() call is made).

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeEmbeddingModel, embeddingReadAvailable } from '../active-model.js';
import { ApiEmbedder, OPENAI_DEFAULT_MODEL } from '../api-embedder.js';
import { ANCHOR_EMBED_MODEL, ANCHOR_EMBED_DIMS } from '../model-pin.js';
import { encodeVector } from '../codec.js';
import { LuxDatabase } from '../../../db/index.js';

const savedToken = process.env.LUX_EMBEDDING_TOKEN;

afterEach(() => {
  if (savedToken === undefined) delete process.env.LUX_EMBEDDING_TOKEN;
  else process.env.LUX_EMBEDDING_TOKEN = savedToken;
});

describe('activeEmbeddingModel', () => {
  it('tokenless ⇒ the pinned local ANCHOR_EMBED_MODEL (config inert)', () => {
    delete process.env.LUX_EMBEDDING_TOKEN;
    expect(activeEmbeddingModel(undefined)).toBe(ANCHOR_EMBED_MODEL);
    // provider/model in config are inert without the env token.
    expect(activeEmbeddingModel({ provider: 'openai', model: 'text-embedding-3-large' })).toBe(
      ANCHOR_EMBED_MODEL
    );
  });

  it('token set ⇒ openai:<config.model ?? default>', () => {
    process.env.LUX_EMBEDDING_TOKEN = 'sk-test-fake';
    expect(activeEmbeddingModel(undefined)).toBe(`openai:${OPENAI_DEFAULT_MODEL}`);
    expect(activeEmbeddingModel({ provider: 'openai', model: 'text-embedding-3-large' })).toBe(
      'openai:text-embedding-3-large'
    );
  });

  it('LOCKED to createEmbedder: activeEmbeddingModel === ApiEmbedder.fromConfig(config).model', () => {
    process.env.LUX_EMBEDDING_TOKEN = 'sk-test-fake';
    for (const config of [
      undefined,
      { provider: 'openai' as const },
      { provider: 'openai' as const, model: 'text-embedding-3-large' },
    ]) {
      expect(activeEmbeddingModel(config)).toBe(ApiEmbedder.fromConfig(config).model);
    }
  });
});

describe('embeddingReadAvailable', () => {
  it('token set ⇒ true WITHOUT any local weights cached (availability IS "the token is set")', () => {
    process.env.LUX_EMBEDDING_TOKEN = 'sk-test-fake';
    // No cacheDir seam is touched: the API path needs no on-disk weights.
    expect(embeddingReadAvailable(undefined)).toBe(true);
    expect(embeddingReadAvailable({ provider: 'openai', model: 'text-embedding-3-large' })).toBe(
      true
    );
  });
});

describe('model-space integrity — a bge-embedded DB is fully un-embedded under the API active model', () => {
  let dir: string;
  let db: LuxDatabase;

  const seedText = (nodeId: string, hash: string): void =>
    db.upsertNodeAnchorText({
      node_id: nodeId,
      prepared: `prepared ${nodeId}`,
      content_hash: hash,
      name: nodeId,
      identifiers: nodeId,
      qualified: nodeId,
      path_segments: 'src services',
      context: 'signature',
    });

  const seedEmbedding = (nodeId: string, model: string, hash: string): void => {
    const v = new Float32Array(ANCHOR_EMBED_DIMS);
    for (let i = 0; i < v.length; i++) v[i] = Math.sin(i) * 0.5;
    db.upsertNodeEmbedding({
      node_id: nodeId,
      model,
      dims: ANCHOR_EMBED_DIMS,
      vector: encodeVector(v),
      content_hash: hash,
    });
  };

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('coverage under the openai active model reads 0 embedded; the queue re-includes every node', () => {
    dir = mkdtempSync(join(tmpdir(), 'lux-active-model-'));
    db = new LuxDatabase(join(dir, 'test.db'));

    // A corpus fully embedded under the LOCAL bge model.
    for (let i = 0; i < 4; i++) {
      seedText(`n${i}`, `h${i}`);
      seedEmbedding(`n${i}`, ANCHOR_EMBED_MODEL, `h${i}`);
    }
    expect(db.getAnchorEmbeddingCoverage(ANCHOR_EMBED_MODEL).embeddedNodes).toBe(4);

    // Flip the ACTIVE model to the API path (token set). The active model is now openai:<model>, under
    // which the bge rows are a DIFFERENT space — coverage reads 0 embedded, and the widened queue's
    // IS-NULL arm re-includes all four nodes (the automatic re-embed under the new space).
    process.env.LUX_EMBEDDING_TOKEN = 'sk-test-fake';
    const active = activeEmbeddingModel({ provider: 'openai', model: 'text-embedding-3-small' });
    expect(active).toBe('openai:text-embedding-3-small');

    const cov = db.getAnchorEmbeddingCoverage(active);
    expect(cov.embeddedNodes).toBe(0); // bge rows never counted under the openai model
    expect(cov.anchorViableNodes).toBe(4); // denominator unchanged (texts drive it)
    expect(
      db
        .getUnembeddedAnchorNodes(active, 10)
        .map((r) => r.node_id)
        .sort()
    ).toEqual(['n0', 'n1', 'n2', 'n3']);
    // And the local model is still fully covered — the two spaces never mix.
    expect(db.getAnchorEmbeddingCoverage(ANCHOR_EMBED_MODEL).embeddedNodes).toBe(4);
  });
});
