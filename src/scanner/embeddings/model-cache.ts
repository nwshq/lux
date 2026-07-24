// src/scanner/embeddings/model-cache.ts  (FENCED — scanner/embeddings/*)
//
// Weight fetch/cache/hash-pin (the Decision-9 equivalent). download-on-first-index: a clean machine's
// first `lux index rebuild`/`lux index sync` that reaches WasmLocalEmbedder.create() fetches the
// three pinned bge files, verifies each against ANCHOR_EMBED_MODEL_ARTIFACTS' sha256 pin, and caches
// them — every subsequent embed on that machine is fully offline. Content NEVER leaves the machine at
// embed time; this module's only network traffic is fetching the (public) model weights, once.

import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ANCHOR_EMBED_MODEL_ARTIFACTS } from './model-pin.js';

/**
 * The three pinned artifact filenames. Reconciled to the CURRENT model-pin.ts (Exec A / Phase-3
 * pins): the shipped q8 export names its weight file `model_quantized.onnx` (NOT the spec-15
 * placeholder `model.onnx`) — see ANCHOR_EMBED_MODEL_ARTIFACTS.files.
 */
export type ModelArtifactFileName =
  'model_quantized.onnx' | 'tokenizer.json' | 'tokenizer_config.json';

/**
 * Structural shape of the artifact spec. Deliberately NOT `typeof ANCHOR_EMBED_MODEL_ARTIFACTS`: that
 * const is `as const`, so its type pins the real digests/source as string LITERALS, and the fetch/
 * verify unit tests (which inject a FAKE artifacts object with different digests/source but the same
 * three filenames — model-cache.test.ts) would then fail to type-check. This structural type keeps
 * the real const assignable AND admits the test fakes, exactly as those tests require.
 */
export interface ModelArtifacts {
  readonly cacheKey: string;
  readonly source: string;
  readonly files: Record<
    ModelArtifactFileName,
    { readonly sha256: string; readonly bytes: number }
  >;
}

export interface ModelPaths {
  modelPath: string;
  tokenizerJsonPath: string;
  tokenizerConfigPath: string;
}

export interface EnsureModelWeightsOptions {
  /** Test seam only (never an operator surface). Points the cache at a tmp directory instead of
   *  ~/.lux/embeddings so tests never touch the real machine-wide cache. */
  cacheDir?: string;
  /** Test seam only — inject a fetch stub so unit tests never hit the network. Defaults to the global
   *  fetch (Node >= 22.12; no new dependency). */
  fetchImpl?: typeof fetch;
  /** Test seam only — override the artifact spec (filenames/hashes/source) so unit tests exercise the
   *  fetch/verify/cache-hit/mismatch logic without the real pinned digests or a real network origin.
   *  The same three filenames are required (the type is ModelArtifacts) — only the digests/bytes/
   *  source vary. */
  artifacts?: ModelArtifacts;
  /** VERIFY-ONLY mode (read/routine-index paths). When true, ensureModelWeights hash-checks the
   *  present cached files and THROWS if any is missing OR corrupt — it NEVER fetches. This is what
   *  makes "the read path / index tail never fetches" literally true even against a present-but-corrupt
   *  cache: without it a stale-hash file would trip the cache-hit miss and trigger a 34 MB refetch.
   *  `WasmLocalEmbedder.create()` passes `noFetch: true` so NO embedder-create path ever fetches; the
   *  sole fetch path is the explicit `--embeddings` opt-in, which calls ensureModelWeights() WITHOUT
   *  this flag (default fetch) before the tail. Default false (fetch-if-missing). */
  noFetch?: boolean;
}

/** Resolve the per-machine weights cache directory: ~/.lux/embeddings/<cacheKey>/. No CLI flag, no
 *  env var — this deliberately does NOT mirror resolvePackCacheDir's --pack-cache/LUX_PACK_CACHE
 *  override (the anchor-embedding substrate is zero-config). Only an in-process `cacheDir` test seam. */
export function resolveModelCacheDir(options: EnsureModelWeightsOptions = {}): string {
  if (options.cacheDir) return resolve(options.cacheDir);
  const cacheKey = (options.artifacts ?? ANCHOR_EMBED_MODEL_ARTIFACTS).cacheKey;
  return resolve(homedir(), '.lux', 'embeddings', cacheKey);
}

function sha256OfFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Ensure ONE named file is present in `cacheDir` and verified against `expectedSha256`.
 *  - Cache hit (file exists AND its digest already matches the pin): return immediately, NO network
 *    call. This is what makes "no network if all files are present+verified" true.
 *  - Otherwise: fetch from `<source>/<fileName>`, hash the response body, and — ONLY if the digest
 *    matches the pin — write it to `cacheDir` and return. A digest mismatch throws and the file is
 *    NEVER written, so a partially/wrongly-fetched file can never be picked up as "cached" later.
 *    This also self-heals a corrupted on-disk cache file: a stale hash fails the cache-hit check
 *    above, so (in fetch mode) this re-fetches and (if the fresh bytes verify) overwrites the corrupted
 *    file.
 *  - noFetch: when set, the cache-miss branch NEVER fetches — it throws instead. A missing file and a
 *    present-but-corrupt file both throw here (the read/routine paths degrade to lexical-only), so the
 *    read path cannot trigger a 34 MB refetch on a corrupt cache.
 */
async function ensureFileVerified(
  fileName: string,
  expectedSha256: string,
  cacheDir: string,
  source: string,
  fetchImpl: typeof fetch,
  noFetch: boolean
): Promise<string> {
  const destPath = join(cacheDir, fileName);

  if (existsSync(destPath) && sha256OfFile(destPath) === expectedSha256) {
    return destPath; // cache hit, already verified — no network call
  }

  if (noFetch) {
    // Verify-only path: a cache miss (missing OR corrupt) must NOT fetch — throw so the caller degrades
    // to lexical-only. This keeps the read path / index tail's "never fetches" guarantee intact even
    // when a cached file is present-but-corrupt (which would otherwise self-heal via a refetch).
    const why = existsSync(destPath) ? 'is corrupt (sha256 mismatch)' : 'is missing';
    throw new Error(
      `ensureModelWeights(noFetch): cached weight ${fileName} ${why} and fetching is disabled on ` +
        `this path. Run \`lux index rebuild --embeddings\` to (re)fetch the pinned weights.`
    );
  }

  const base = source.endsWith('/') ? source : `${source}/`;
  const url = new URL(fileName, base).toString();

  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(
      `ensureModelWeights: HTTP ${res.status} ${res.statusText} fetching ${fileName} from ${url}`
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const actualSha256 = createHash('sha256').update(buf).digest('hex');

  if (actualSha256 !== expectedSha256) {
    // Never use an unverified weight: the file is not written, ensureModelWeights rejects, and
    // createEmbedder()/embed() are never reached with bad bytes.
    throw new Error(
      `ensureModelWeights: sha256 mismatch for ${fileName} downloaded from ${url}. ` +
        `expected ${expectedSha256}, got ${actualSha256}. The weight is NOT written to the cache ` +
        `and MUST NOT be used to embed.`
    );
  }

  // Atomic publish (only ever reached after the digest matches the pin): write to a temp file in the
  // SAME directory, then renameSync into place. rename is atomic on one filesystem, so a kill mid-write
  // leaves at most an orphan temp file — never a torn destPath that a later run would mistake for a
  // valid cache entry (the re-verify-on-load self-heal covers a pre-existing torn file; this prevents
  // minting one in the first place).
  const tmpPath = join(
    cacheDir,
    `.${fileName}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  );
  writeFileSync(tmpPath, buf);
  renameSync(tmpPath, destPath);
  return destPath;
}

/**
 * Ensure all three pinned bge artifacts are present and hash-verified in the resolved cache dir. In the
 * default (fetch) mode it fetches (once) whatever is missing or invalid; with `noFetch: true` it is
 * verify-only and throws on any missing/corrupt file instead of fetching. Either way it throws — never
 * returns a ModelPaths, never lets WasmLocalEmbedder construct a session — if any file cannot be
 * verified against its pin.
 */
export async function ensureModelWeights(
  options: EnsureModelWeightsOptions = {}
): Promise<ModelPaths> {
  const artifacts: ModelArtifacts = options.artifacts ?? ANCHOR_EMBED_MODEL_ARTIFACTS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const noFetch = options.noFetch ?? false;
  const cacheDir = resolveModelCacheDir(options);
  mkdirSync(cacheDir, { recursive: true });

  const modelPath = await ensureFileVerified(
    'model_quantized.onnx',
    artifacts.files['model_quantized.onnx'].sha256,
    cacheDir,
    artifacts.source,
    fetchImpl,
    noFetch
  );
  const tokenizerJsonPath = await ensureFileVerified(
    'tokenizer.json',
    artifacts.files['tokenizer.json'].sha256,
    cacheDir,
    artifacts.source,
    fetchImpl,
    noFetch
  );
  const tokenizerConfigPath = await ensureFileVerified(
    'tokenizer_config.json',
    artifacts.files['tokenizer_config.json'].sha256,
    cacheDir,
    artifacts.source,
    fetchImpl,
    noFetch
  );

  return { modelPath, tokenizerJsonPath, tokenizerConfigPath };
}
