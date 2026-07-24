// src/scanner/embeddings/active-model.ts  (FENCED — scanner/embeddings/*)
//
// The active-model reconciliation (spec 19 Part C intent, cross-cutting). The index tail's queue-gate
// + coverage and the read path's coverage + availability probe run BEFORE any embedder is constructed,
// so they cannot read `embedder.model` — yet they must key on the SAME model createEmbedder will build,
// or a token-configured operator's queue/coverage/reads would silently key on the local bge model
// while the embedder writes/reads under `openai:<model>` (two spaces, mixed, wrong).
//
// These two helpers mirror createEmbedder's env-token branch EXACTLY:
//   · activeEmbeddingModel(config)  — the model id every pre-embedder read filters on.
//   · embeddingReadAvailable(config) — whether a semantic read/embed can proceed without a fetch.
// With a token set the active model is `openai:<model>` and availability is "the token is set" (no
// local weight cache exists on the API path); tokenless it is ANCHOR_EMBED_MODEL, available iff the
// pinned bge weights are cached. Because createEmbedder → ApiEmbedder.fromConfig uses the SAME default
// (OPENAI_DEFAULT_MODEL), the resolved id here is always what the constructed embedder reports.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ANCHOR_EMBED_MODEL, ANCHOR_EMBED_MODEL_ARTIFACTS } from './model-pin.js';
import { resolveModelCacheDir } from './model-cache.js';
import type { EmbeddingConfig } from './embedder.js';
// The OpenAI default model id, shared with ApiEmbedder via the import-light openai-defaults.ts const
// module so activeEmbeddingModel resolves the IDENTICAL id createEmbedder → ApiEmbedder.fromConfig
// builds — one literal, not two. Importing this bare const does NOT pull api-embedder.ts (the runtime
// fetch-bearing class) onto the tokenless static graph, so this hot-path helper stays isolated; the
// equality remains locked by active-model.test.ts (activeEmbeddingModel === ApiEmbedder.fromConfig().model).
import { OPENAI_DEFAULT_MODEL } from './openai-defaults.js';

/**
 * The ACTIVE embedding-model identity for a given config — the value the pre-embedder queue-gate,
 * coverage read, and cosine read filter MUST all key on. Mirrors createEmbedder's branch: token set ⇒
 * `openai:<config.model ?? default>`; token unset ⇒ the pinned local ANCHOR_EMBED_MODEL (config inert).
 */
export function activeEmbeddingModel(config: EmbeddingConfig | undefined): string {
  return process.env.LUX_EMBEDDING_TOKEN
    ? `openai:${config?.model ?? OPENAI_DEFAULT_MODEL}`
    : ANCHOR_EMBED_MODEL;
}

/**
 * Can a semantic read/embed proceed WITHOUT a network weight fetch? Mirrors createEmbedder's branch:
 *   · token set  ⇒ true — the API path needs no local weight cache; availability IS "the token is set".
 *     (An actual API call may still fail at request time; that degrades exactly like a mid-load failure,
 *     it is not this pre-flight's concern.)
 *   · token unset ⇒ the pinned bge weights must already be present in the per-machine cache (a pure
 *     presence check on resolveModelCacheDir — no sha re-hash; that is ensureModelWeights' / the
 *     `--embeddings` opt-in's job). This is what keeps the index tail AND the read path cached-only.
 */
export function embeddingReadAvailable(config: EmbeddingConfig | undefined): boolean {
  if (process.env.LUX_EMBEDDING_TOKEN) return true;
  void config; // tokenless ⇒ provider/model are inert; availability is purely the local weight cache.
  const dir = resolveModelCacheDir();
  return Object.keys(ANCHOR_EMBED_MODEL_ARTIFACTS.files).every((file) =>
    existsSync(join(dir, file))
  );
}
