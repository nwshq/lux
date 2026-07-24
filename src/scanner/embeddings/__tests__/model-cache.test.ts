// src/scanner/embeddings/__tests__/model-cache.test.ts
//
// Unit tests for ensureModelWeights's cache/fetch/verify contract, fully offline: every test injects
// `fetchImpl` + `artifacts` (the EnsureModelWeightsOptions test seams) so nothing here touches the
// real pinned digests, the real origin, or ~/.lux/embeddings. Real-weight integration coverage lives
// in wasm-local-embedder.determinism.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ensureModelWeights, resolveModelCacheDir } from '../model-cache.js';

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

const GOOD = {
  model: Buffer.from('fake onnx bytes'),
  tokJson: Buffer.from('{"fake":"tokenizer.json"}'),
  tokCfg: Buffer.from('{"fake":"tokenizer_config.json"}'),
};

/** Same shape as ANCHOR_EMBED_MODEL_ARTIFACTS — fake bytes/digests/source, never the real pin, and
 *  the real bge filenames (model_quantized.onnx per the shipped q8 export). */
function fakeArtifacts() {
  return {
    cacheKey: 'fake-model-v1',
    files: {
      'model_quantized.onnx': { sha256: sha256Hex(GOOD.model), bytes: GOOD.model.length },
      'tokenizer.json': { sha256: sha256Hex(GOOD.tokJson), bytes: GOOD.tokJson.length },
      'tokenizer_config.json': { sha256: sha256Hex(GOOD.tokCfg), bytes: GOOD.tokCfg.length },
    },
    source: 'https://fake.example.invalid/models/fake-model-v1/',
  } as const;
}

function goodFetchImpl() {
  return vi.fn(async (url: string | URL) => {
    const name = url.toString().split('/').pop() as string;
    const body =
      name === 'model_quantized.onnx'
        ? GOOD.model
        : name === 'tokenizer.json'
          ? GOOD.tokJson
          : GOOD.tokCfg;
    return new Response(body, { status: 200 });
  });
}

let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'lux-model-cache-'));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('ensureModelWeights', () => {
  it('fetches, verifies, and writes all three files on a clean cache dir', async () => {
    const artifacts = fakeArtifacts();
    const fetchImpl = goodFetchImpl();

    const paths = await ensureModelWeights({
      cacheDir,
      artifacts,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(readFileSync(paths.modelPath).equals(GOOD.model)).toBe(true);
    expect(readFileSync(paths.tokenizerJsonPath).equals(GOOD.tokJson)).toBe(true);
    expect(readFileSync(paths.tokenizerConfigPath).equals(GOOD.tokCfg)).toBe(true);
  });

  it('is a no-network cache hit on the second call (fetch is never invoked)', async () => {
    const artifacts = fakeArtifacts();
    const fetchImpl = goodFetchImpl();

    await ensureModelWeights({
      cacheDir,
      artifacts,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    fetchImpl.mockClear();
    await ensureModelWeights({
      cacheDir,
      artifacts,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws and never writes a file whose fetched bytes fail the pinned sha256 — never embeds', async () => {
    const artifacts = fakeArtifacts(); // pin matches GOOD bytes
    const wrongBytes = Buffer.from('these are NOT the pinned bytes');
    const fetchImpl = vi.fn(async () => new Response(wrongBytes, { status: 200 }));

    await expect(
      ensureModelWeights({ cacheDir, artifacts, fetchImpl: fetchImpl as unknown as typeof fetch })
    ).rejects.toThrow(/sha256 mismatch/);

    expect(existsSync(join(cacheDir, 'model_quantized.onnx'))).toBe(false);
  });

  it('detects a corrupted on-disk cache file and repairs it by re-fetching the pinned bytes', async () => {
    const artifacts = fakeArtifacts();
    writeFileSync(
      join(cacheDir, 'model_quantized.onnx'),
      Buffer.from('corrupted, truncated, or bit-flipped')
    );
    const fetchImpl = goodFetchImpl();

    const paths = await ensureModelWeights({
      cacheDir,
      artifacts,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(readFileSync(paths.modelPath).equals(GOOD.model)).toBe(true); // corrupted bytes overwritten
  });

  it('propagates a non-ok HTTP response as a thrown error, never writing a partial file', async () => {
    const artifacts = fakeArtifacts();
    const fetchImpl = vi.fn(
      async () => new Response('not found', { status: 404, statusText: 'Not Found' })
    );

    await expect(
      ensureModelWeights({ cacheDir, artifacts, fetchImpl: fetchImpl as unknown as typeof fetch })
    ).rejects.toThrow(/HTTP 404/);
    expect(existsSync(join(cacheDir, 'model_quantized.onnx'))).toBe(false);
  });

  // noFetch (verify-only) — the read/routine-index path (WasmLocalEmbedder.create passes noFetch:true).
  // The invariant: a cache miss (missing OR corrupt) THROWS and NEVER fetches, so the read path cannot
  // trigger a 34 MB refetch on a present-but-corrupt cache.
  it('noFetch: a present-but-corrupt cached file THROWS and never fetches (no refetch on corruption)', async () => {
    const artifacts = fakeArtifacts();
    // A present-but-corrupt model file (wrong bytes → sha mismatch). In fetch mode this would self-heal
    // by refetching; under noFetch it must throw WITHOUT any network call.
    writeFileSync(
      join(cacheDir, 'model_quantized.onnx'),
      Buffer.from('corrupt — not the pinned bytes')
    );
    const fetchImpl = goodFetchImpl();

    await expect(
      ensureModelWeights({
        cacheDir,
        artifacts,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        noFetch: true,
      })
    ).rejects.toThrow(/noFetch/);
    expect(fetchImpl).not.toHaveBeenCalled(); // the point: a corrupt cache does NOT trigger a refetch
  });

  it('noFetch: a MISSING cached file THROWS and never fetches', async () => {
    const artifacts = fakeArtifacts(); // empty cacheDir — nothing present
    const fetchImpl = goodFetchImpl();

    await expect(
      ensureModelWeights({
        cacheDir,
        artifacts,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        noFetch: true,
      })
    ).rejects.toThrow(/noFetch/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('noFetch: a fully valid cache verifies and returns paths WITHOUT fetching', async () => {
    const artifacts = fakeArtifacts();
    // Populate a valid cache first (fetch mode), then re-run verify-only with a fresh spy.
    const seedFetch = goodFetchImpl();
    await ensureModelWeights({
      cacheDir,
      artifacts,
      fetchImpl: seedFetch as unknown as typeof fetch,
    });
    const verifyFetch = goodFetchImpl();
    const paths = await ensureModelWeights({
      cacheDir,
      artifacts,
      fetchImpl: verifyFetch as unknown as typeof fetch,
      noFetch: true,
    });
    expect(verifyFetch).not.toHaveBeenCalled();
    expect(readFileSync(paths.modelPath).equals(GOOD.model)).toBe(true);
  });
});

describe('resolveModelCacheDir', () => {
  it('honors an explicit cacheDir override ahead of ANCHOR_EMBED_MODEL_ARTIFACTS.cacheKey', () => {
    expect(resolveModelCacheDir({ cacheDir: '/explicit/path' })).toBe(resolve('/explicit/path'));
  });
});
