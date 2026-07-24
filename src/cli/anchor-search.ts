// src/cli/anchor-search.ts
//
// The shared hybrid anchor engine (Decision 2/3). Called by both cli/anchors.ts and mcp/server.ts so
// the ranking/refusal/fusion logic exists once. On the embeddings fence allowlist (03 §Layer & fence)
// — Phase 3 (spec 17) wires the semantic half in HERE, so this is where the scanner/embeddings/ read
// surface (the barrel + the semantic floor + the cached-weights probe) is imported. The read path is
// CACHED-ONLY: it never fetches model weights (it degrades to lexical-only instead), mirroring the
// index tail's stance (cli/index.ts runNodeEmbedTail).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LuxDatabase } from '../db/index.js';
import { rankAnchorsLexical, type LexicalAnchorHit } from '../scanner/anchors/lexical-ranker.js';
import {
  fuseRrf,
  ANCHOR_MIN_FUSED_SCORE,
  ANCHOR_MIN_LEXICAL_BM25,
  type SemanticRef,
} from '../scanner/anchors/fusion.js';
import { AnchorRefusalError } from '../scanner/anchors/anchor-refusal.js';
import type { AnchorResultV1, AnchorCoverageV1 } from './anchors-envelope.js';
// Semantic half (Phase 3) — the embeddings read surface. The barrel is this file's designated import
// door (scanner/embeddings/index.ts doc-comment); the semantic floor + the cached-weights probe bits
// are not on the barrel, so they come from their own fenced modules.
import {
  createEmbedder,
  topCosine,
  ANCHOR_EMBED_MODEL,
  type Embedder,
} from '../scanner/embeddings/index.js';
import {
  ANCHOR_MIN_COSINE,
  ANCHOR_EMBED_MODEL_ARTIFACTS,
} from '../scanner/embeddings/model-pin.js';
import { resolveModelCacheDir } from '../scanner/embeddings/model-cache.js';

export interface AnchorSearchOptions {
  limit: number;
  /** Phase 3: when false, skip the semantic half even if vectors exist. NOTE (reconciled to reality):
   *  no caller currently passes `false` — both the CLI (`lux anchors`) and the MCP mirror attempt the
   *  semantic half identically whenever the plane is populated AND the weights are cached. The
   *  cold-CLI lexical-first short-circuit that would set this false (answer lexically first, skip the
   *  model load) is a deferred follow-up, not wired yet. Default true (undefined ⇒ semantic attempted);
   *  the `semantic:false` branch exists and is exercised by tests but has no production caller. */
  semantic?: boolean;
}

export interface AnchorSearchResult {
  results: AnchorResultV1[];
  lowConfidence: boolean;
  coverage: AnchorCoverageV1;
}

/** Semantic candidate pool depth for RRF. topCosine fetches at least this many neighbours (or
 *  `opts.limit` if larger) so the semantic list carries depth to fuse below the lexical top hit — a
 *  bare `limit`-sized pool would starve RRF of cross-corroboration candidates. Internal default (03
 *  treats the pool as an internal knob), not a frozen contract name. */
const ANCHOR_SEMANTIC_POOL = 50;

/** Upper bound on the raw query length, applied ONCE at the top of runAnchorSearch before any
 *  tokenization. A real concept→anchor query is a short phrase; an unbounded multi-MB `lux_anchors`
 *  query would otherwise force O(n) tokenizer/FTS-builder work on the warm MCP server (a cheap DoS on a
 *  resident process). Truncation is gentler than refusal (the leading 8192 chars carry any genuine
 *  query intact) and is applied to the SHARED query so both the lexical and semantic halves — and any
 *  refusal message — see the bounded text. Internal knob, not a frozen contract name. */
const ANCHOR_MAX_QUERY_CHARS = 8192;

/**
 * Read-path process-shared embedder (03 §Warm vs cold). The warm MCP server reuses ONE embedder across
 * queries (the model + WASM session stay resident → the warm-p50 latency target); the cold CLI process
 * constructs it once per invocation. Mirrors the write-path memo in cli/index.ts. A REJECTED promise is
 * NOT cached — a transient weight-load failure on one query must not poison later queries in the same
 * process. PHASE 3: local-only via `createEmbedder(undefined)` (the tokenless WasmLocalEmbedder); Phase
 * 4 (spec 19 §Part D) threads `loadLspConfig(corpusPath).embedding` through this SAME memo, touching
 * only the `createEmbedder(...)` argument, not the caching contract.
 */
let sharedEmbedderPromise: Promise<Embedder> | null = null;

/**
 * Test seam (clearly test-only — never an operator surface). Production embeds through
 * `createEmbedder(undefined)`, gated cached-only by `semanticReadAvailable`. A test injects a
 * deterministic StubEmbedder factory here to exercise the semantic half network-free; setting a factory
 * ALSO makes `semanticReadAvailable` true (a stub needs no on-disk weights) and resets the memo. `null`
 * restores the production factory + the cached-only gate.
 */
let readPathEmbedderFactoryForTests: (() => Promise<Embedder>) | null = null;

export function __setReadPathEmbedderFactoryForTests(
  factory: (() => Promise<Embedder>) | null
): void {
  readPathEmbedderFactoryForTests = factory;
  sharedEmbedderPromise = null;
}

function getSharedEmbedder(): Promise<Embedder> {
  if (!sharedEmbedderPromise) {
    const construct = readPathEmbedderFactoryForTests ?? (() => createEmbedder(undefined));
    sharedEmbedderPromise = construct().catch((error: unknown) => {
      sharedEmbedderPromise = null; // never cache a failure — allow a retry on the next query
      throw error;
    });
  }
  return sharedEmbedderPromise;
}

/**
 * Is a semantic read available WITHOUT a network fetch? A test factory (a stub — no weights) is always
 * available. In production the pinned weights must already be present in the per-machine cache: a pure
 * presence check on `resolveModelCacheDir()` (no sha re-hash — that is the embedder-create /
 * `--embeddings` job). This is what keeps the READ path cached-only, exactly like the index tail
 * (cli/index.ts `anchorModelWeightsCached`): a `lux anchors` query NEVER triggers a weight fetch — a
 * weights-absent machine degrades to lexical-only. `lux index rebuild --embeddings` is the one fetch
 * path. Gated behind the cheap coverage>0 check in the caller, so this disk probe runs only when there
 * is actually a populated embedding plane to read.
 */
function semanticReadAvailable(): boolean {
  if (readPathEmbedderFactoryForTests !== null) return true;
  const dir = resolveModelCacheDir();
  return Object.keys(ANCHOR_EMBED_MODEL_ARTIFACTS.files).every((file) =>
    existsSync(join(dir, file))
  );
}

/**
 * Run the hybrid anchor search. Throws AnchorRefusalError for overlay-missing / anchor-texts-absent /
 * invalid-query / fts-unavailable (the caller renders the refusal envelope + nonzero exit). A healthy
 * populated-index zero result returns an empty `results` (exit 0, unresolved).
 */
export async function runAnchorSearch(
  db: LuxDatabase,
  query: string,
  opts: AnchorSearchOptions
): Promise<AnchorSearchResult> {
  // Bound the raw query length BEFORE anything tokenizes it (both halves do). Applied once, at the very
  // top, so the lexical ranker, the semantic embedder, AND any refusal message all carry the bounded
  // text — a pathological multi-MB query can never reach the tokenizer/FTS-builder on the warm server.
  if (query.length > ANCHOR_MAX_QUERY_CHARS) {
    query = query.slice(0, ANCHOR_MAX_QUERY_CHARS);
  }

  // Extended refusals (03 §The surface): probe the overlay/texts BEFORE any FTS MATCH, so the honest
  // "I cannot look here yet" is distinct from a genuine zero-result.
  if (!db.hasStructuralOverlay()) {
    throw new AnchorRefusalError(
      'overlay-missing',
      query,
      // A corpus with code mints anchor nodes on rebuild; a documents-only corpus has none — the
      // remediation must also point that operator at the prose surface (this message is all a --json
      // / MCP consumer sees; the text renderer adds the same hand-off line).
      'The structural overlay has not been built. Run `lux index rebuild` (a corpus with code mints ' +
        'anchor nodes); a documents-only corpus has none — search its prose with `lux search`.'
    );
  }
  const anchorViableNodes = db.getAnchorViableNodeCount();
  if (anchorViableNodes === 0) {
    throw new AnchorRefusalError(
      'anchor-texts-absent',
      query,
      'The overlay is present but carries no anchor texts (is `ast.enabled` false?). ' +
        'Enable AST materialization, or run `lux index rebuild`.'
    );
  }

  // Lexical half — always runs (throws its own invalid-query/fts-unavailable refusals).
  const lexical: LexicalAnchorHit[] = rankAnchorsLexical(db, query, opts.limit);

  // Semantic half (Phase 3, spec 17 / 03 §Fusion). CACHED-ONLY read path: attempt the semantic half
  // ONLY when it is both wanted AND free of a network fetch — the embedding plane must already be
  // populated (coverage under the active model) AND the pinned weights already cached. This mirrors the
  // index tail's cached-only stance (cli/index.ts runNodeEmbedTail): a read NEVER fetches weights. When
  // vectors or weights are absent, the surface degrades to lexical-only and says so via coverage.model
  // = null — never an error, never silent (a user opts the tier in with `lux index rebuild
  // --embeddings`). The coverage read is scoped to the STATIC ANCHOR_EMBED_MODEL (Phase 3: identical to
  // the active embedder.model; Phase 4 re-reads under embedder.model alongside the config threading).
  const coverage = db.getAnchorEmbeddingCoverage(ANCHOR_EMBED_MODEL);
  let semantic: SemanticRef[] = [];
  let semanticModel: string | null = null;
  let embeddedNodes = 0;
  if (opts.semantic !== false && coverage.embeddedNodes > 0 && semanticReadAvailable()) {
    try {
      const embedder = await getSharedEmbedder();
      // embedQuery applies BGE_QUERY_PREFIX (the passage/query asymmetry, OQ2); the passage side never
      // prefixes. topCosine scans ONLY the active model's vectors (D11), cut at ANCHOR_MIN_COSINE to
      // drop the sub-floor nearest-anything noise. Survivors keep descending order, so the 1-based
      // semanticRank is intact after the filter.
      const qVec = await embedder.embedQuery(query);
      const hits = topCosine(qVec, db, Math.max(opts.limit, ANCHOR_SEMANTIC_POOL), embedder.model);
      semantic = hits
        .filter((h) => h.score >= ANCHOR_MIN_COSINE)
        .map((h, i) => ({ nodeId: h.nodeId, semanticRank: i + 1, cosine: h.score }));
      semanticModel = embedder.model;
      embeddedNodes = coverage.embeddedNodes;
    } catch {
      // A weights-unavailable / mid-load failure at read time degrades to lexical-only rather than
      // failing the whole query: the semantic half is a lift, not a prerequisite (03 §Fusion, floor,
      // honesty). The rejected memo already self-cleared so a later query can retry.
      semantic = [];
      semanticModel = null;
      embeddedNodes = 0;
    }
  }

  const fused = fuseRrf(
    lexical.map((h) => ({ nodeId: h.nodeId, lexicalRank: h.lexicalRank })),
    semantic
  ).slice(0, opts.limit);

  // Attach node metadata: from the lexical hit map, else (semantic-only, Phase 3) a node lookup.
  const lexByNode = new Map(lexical.map((h) => [h.nodeId, h]));
  const results: AnchorResultV1[] = fused.map((f) => {
    const meta = lexByNode.get(f.nodeId);
    if (meta) {
      return {
        nodeId: f.nodeId,
        symbolKind: meta.symbolKind,
        symbolName: meta.symbolName,
        qualifiedName: meta.qualifiedName,
        filePath: meta.filePath,
        matchedVia: f.matchedVia,
        lexicalRank: f.lexicalRank,
        cosine: f.cosine,
        fusedScore: f.fusedScore,
      };
    }
    // Semantic-only (Phase 3): resolve metadata from structural_nodes by id.
    const node = db.getStructuralNode(f.nodeId);
    return {
      nodeId: f.nodeId,
      symbolKind: node?.symbol_kind ?? 'Unknown',
      symbolName: node?.symbol_name ?? f.nodeId,
      qualifiedName: node?.qualified_name ?? null,
      filePath: node?.file_path ?? '',
      matchedVia: f.matchedVia,
      lexicalRank: f.lexicalRank,
      cosine: f.cosine,
      fusedScore: f.fusedScore,
    };
  });

  // Confidence floor (Decision-Fusion) — two modes (T1.8), keyed on whether the semantic half
  // CONTRIBUTED, not merely whether it RAN:
  //  · Hybrid (hybridActive): the semantic half ran AND landed at least one above-floor candidate, so
  //    the fused ranking spans two rank lists and the whole-surface ANCHOR_MIN_FUSED_SCORE gates.
  //  · Lexical-shaped (else): either the semantic half never ran (lexical-only, Phase 1 / no vectors /
  //    weights absent) OR it ran but every candidate fell below ANCHOR_MIN_COSINE, so `semantic` is []
  //    and the fused list is single-list. In BOTH cases a single-list RRF top hit scores ~1/(RRF_K+1)
  //    regardless of match quality, so the fused score cannot separate a confident anchor from a thin
  //    collision — confidence derives from the top hit's raw weighted-bm25 instead (a top bm25 weaker/
  //    greater than ANCHOR_MIN_LEXICAL_BM25 is a thin match). Keying this branch on `semanticModel !==
  //    null` alone would drag a populated-but-below-floor query into the hybrid branch, where a strong
  //    exact-identifier lexical top (fused ~1/61 < 0.025) would be wrongly flagged lowConfidence purely
  //    because the vector plane exists. coverage.model still reports semanticModel (the plane IS
  //    populated); only the confidence predicate keys on the actual contribution.
  const hybridActive = semanticModel !== null && semantic.length > 0;
  let lowConfidence = false;
  const top = results[0];
  if (top) {
    if (hybridActive) {
      lowConfidence = top.fusedScore < ANCHOR_MIN_FUSED_SCORE;
    } else {
      const topBm25 = lexByNode.get(top.nodeId)?.bm25Rank ?? 0;
      lowConfidence = topBm25 > ANCHOR_MIN_LEXICAL_BM25;
    }
  }

  return {
    results,
    lowConfidence,
    coverage: { embeddedNodes, anchorViableNodes, model: semanticModel },
  };
}

/**
 * Coverage for a REFUSAL envelope (CLI --json / MCP). A refusal carries no ranked hits, but the
 * anchor-viable count is still real and must be reported accurately: a non-overlay refusal
 * (invalid-query / fts-unavailable) over a POPULATED index has embedded texts, so a hardcoded zero
 * would be a false statement in the frozen schemaVersion:1 `coverage` field. For overlay-missing /
 * anchor-texts-absent the count is a genuine 0 (autoMigrate keeps the table present, so the probe is
 * always safe). Embeddings are absent in Phase 1, so embeddedNodes:0 / model:null stay hardcoded.
 */
export function anchorRefusalCoverage(db: LuxDatabase): AnchorCoverageV1 {
  return { embeddedNodes: 0, anchorViableNodes: db.getAnchorViableNodeCount(), model: null };
}
