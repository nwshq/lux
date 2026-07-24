// src/cli/anchors-envelope.ts
import type { AnchorRefusalReason } from '../scanner/anchors/anchor-refusal.js';

/** One anchor in the machine envelope (03 §The surface). */
export interface AnchorResultV1 {
  nodeId: string;
  symbolKind: string;
  symbolName: string;
  qualifiedName: string | null;
  filePath: string;
  matchedVia: 'lexical' | 'semantic' | 'both';
  lexicalRank?: number;
  cosine?: number;
  fusedScore: number;
  /** file granularity ONLY (issue #77 item #3): how many ranked candidate nodes this file contributed
   *  to the fused pool (post test-exclusion, pre-dedupe). Absent in node granularity — additive, so a
   *  node-mode result stays byte-identical to v2.11.0. The result itself is still a REAL node id (the
   *  best-ranked node for the file), so it round-trips through `lux trace` verbatim. */
  fileNodeCount?: number;
}

export interface AnchorRefusalV1 {
  reason: AnchorRefusalReason;
  expression: string;
  message: string;
}

/** Why the semantic half was / was not used on THIS query — grounded in the actual branch structure of
 *  runAnchorSearch (issue #77 item #4). One value per real branch:
 *   · `used`                      — the semantic half ran AND contributed ≥1 above-floor candidate.
 *   · `exact-match-short-circuit` — the query IS the top lexical hit's symbol name (A2), so the model
 *                                   load is skipped and lexical is definitive.
 *   · `no-embedded-nodes`         — the corpus has no vectors under the active model (never embedded).
 *   · `weights-not-cached`        — vectors exist, but the model weights are not cached locally and no
 *                                   API token is set; the cached-only read path degrades (never fetches).
 *   · `below-cosine-floor`        — the semantic half ran but every candidate fell below the cosine floor.
 *   · `load-failed`               — the semantic half was attempted but the embedder/embed threw at read
 *                                   time (degraded to lexical rather than failing the query).
 *   · `disabled`                  — `semantic: false` was passed (no production caller; programmatic). */
export type AnchorSemanticReason =
  | 'used'
  | 'exact-match-short-circuit'
  | 'no-embedded-nodes'
  | 'weights-not-cached'
  | 'below-cosine-floor'
  | 'load-failed'
  | 'disabled';

/** The STABLE corpus embedding fact (issue #77 item #4): populated on EVERY answered query — including
 *  the A2 exact-match short-circuit — from a cheap DB count, so a consumer can read "is the corpus
 *  embedded?" without conflating it with the per-query "did THIS query use the semantic half?" signal.
 *  `model` is the active model when ≥1 fresh vector exists under it, else null. */
export interface AnchorIndexCoverageV1 {
  embeddedNodes: number;
  totalNodes: number;
  model: string | null;
}

/** The PER-QUERY semantic-usage fact (issue #77 item #4): whether the semantic half contributed to this
 *  query's ranking, and why. Distinct from the stable index fact above. */
export interface AnchorQueryCoverageV1 {
  semanticUsed: boolean;
  reason: AnchorSemanticReason;
}

/** Coverage of the semantic plane at query time (03 §The surface).
 *
 *  BACK-COMPAT: `embeddedNodes` / `anchorViableNodes` / `model` are the FROZEN v2.11.0 fields and are
 *  kept EXACTLY as-is — `embeddedNodes`/`model` are PER-QUERY (0/null when the semantic half did not
 *  contribute, e.g. the A2 short-circuit), `anchorViableNodes` is the stable total. The additive
 *  `index` (stable corpus fact) + `query` (per-query semantic usage) sub-objects (issue #77 item #4)
 *  disambiguate the two facts the flat fields conflated. Both are present on an ANSWERED/empty query
 *  and absent on a REFUSAL (which carries no query semantics). */
export interface AnchorCoverageV1 {
  embeddedNodes: number;
  anchorViableNodes: number;
  model: string | null;
  index?: AnchorIndexCoverageV1;
  query?: AnchorQueryCoverageV1;
}

/** Which test files the default filter dropped (issue #77 item #3), so a consumer can SEE what the
 *  default did. `tests` reflects the requested mode; `excludedTestFiles` counts the distinct test file
 *  paths removed from the ranked candidate pool before the limit was applied. */
export interface AnchorFiltersV1 {
  tests: 'excluded' | 'included';
  excludedTestFiles: number;
}

/** The frozen machine envelope for `lux anchors`. schemaVersion is 1 and additive-only.
 *  `granularity` + `filters` (issue #77 item #3) and `coverage.index`/`coverage.query` (item #4) are
 *  additive. NOTE (byte-identity): the ranked `results` array and the frozen coverage fields are
 *  unchanged in the legacy `--include-tests --granularity node` mode; the new top-level keys are
 *  additions a v2.11.0 consumer ignores (the schema is documented additive-only). */
export interface AnchorReportV1 {
  schemaVersion: 1;
  surface: 'anchors';
  query: string;
  limit: number;
  /** result granularity: `node` (default, one anchor per ranked node) or `file` (one representative
   *  anchor per file). */
  granularity: 'node' | 'file';
  results: AnchorResultV1[];
  /** true when the top hit clears no confidence floor (a thin, uncorroborated match). */
  lowConfidence: boolean;
  /** what the test-file filter did on this query (default excludes tests). */
  filters: AnchorFiltersV1;
  coverage: AnchorCoverageV1;
  /** present only on a refusal; results is then empty. */
  refusal?: AnchorRefusalV1;
}

export function buildAnchorReport(input: {
  query: string;
  limit: number;
  granularity: 'node' | 'file';
  results: AnchorResultV1[];
  lowConfidence: boolean;
  filters: AnchorFiltersV1;
  coverage: AnchorCoverageV1;
}): AnchorReportV1 {
  return {
    schemaVersion: 1,
    surface: 'anchors',
    query: input.query,
    limit: input.limit,
    granularity: input.granularity,
    results: input.results,
    lowConfidence: input.lowConfidence,
    filters: input.filters,
    coverage: input.coverage,
  };
}

export function buildAnchorRefusalReport(input: {
  query: string;
  limit: number;
  granularity: 'node' | 'file';
  filters: AnchorFiltersV1;
  coverage: AnchorCoverageV1;
  refusal: AnchorRefusalV1;
}): AnchorReportV1 {
  return {
    schemaVersion: 1,
    surface: 'anchors',
    query: input.query,
    limit: input.limit,
    granularity: input.granularity,
    results: [],
    lowConfidence: false,
    filters: input.filters,
    coverage: input.coverage,
    refusal: input.refusal,
  };
}
