import type { RankedSearchResult } from '../db/types.js';
import type { SearchRefusalReason } from '../db/index.js';

/** One result in the machine envelope. Mirrors RankedSearchResult; `rank` is raw bm25 (D1). */
export interface SearchResultV1 {
  entryId: number;
  entryType: string;
  title: string;
  filePath: string;
  rank: number;
  snippet?: string;
}

/** A structured refusal (D3). Present iff the search could not run; `results` is then empty. */
export interface SearchRefusalV1 {
  reason: SearchRefusalReason; // 'invalid-query' | 'fts-unavailable'
  /** the FTS5 MATCH expression that failed (echoed for invalid-query) */
  expression: string;
  /** human-facing remediation */
  message: string;
}

/** The frozen machine envelope for a single-repo `lux search`. schemaVersion is 1 and stable. */
export interface SearchReportV1 {
  schemaVersion: 1;
  surface: 'search';
  query: string;
  /**
   * NOTE: post-migration-005 this is a NO-OP filter — `knowledge_entries` is the only searchable
   * table, so `all` ≡ `knowledge` and `searchDocumentsRanked` applies no type predicate. It is echoed
   * for envelope stability (schemaVersion:1 is frozen), NOT to signal that results were filtered — a
   * consumer must not over-trust it as a scope guarantee. Retained rather than dropped precisely
   * because the frozen envelope contract forbids removing a field (n11).
   */
  type: 'all' | 'knowledge';
  contentOnly: boolean;
  limit: number;
  /** bm25-ordered, best-first; empty on a genuine zero-result answer OR on a refusal. */
  results: SearchResultV1[];
  /** present only on a refusal (D3); absent on answered/zero-result. */
  refusal?: SearchRefusalV1;
}

/** Build an answered/zero-result envelope from ranked rows. */
export function buildSearchReport(input: {
  query: string;
  type: 'all' | 'knowledge';
  contentOnly: boolean;
  limit: number;
  results: RankedSearchResult[];
}): SearchReportV1 {
  return {
    schemaVersion: 1,
    surface: 'search',
    query: input.query,
    type: input.type,
    contentOnly: input.contentOnly,
    limit: input.limit,
    results: input.results.map((r) => ({
      entryId: r.entryId,
      entryType: r.entryType,
      title: r.title,
      filePath: r.filePath,
      rank: r.rank,
      ...(r.snippet !== undefined ? { snippet: r.snippet } : {}),
    })),
  };
}

/** Build a refusal envelope (empty results + a refusal block). */
export function buildSearchRefusalReport(input: {
  query: string;
  type: 'all' | 'knowledge';
  contentOnly: boolean;
  limit: number;
  refusal: SearchRefusalV1;
}): SearchReportV1 {
  return {
    schemaVersion: 1,
    surface: 'search',
    query: input.query,
    type: input.type,
    contentOnly: input.contentOnly,
    limit: input.limit,
    results: [],
    refusal: input.refusal,
  };
}
