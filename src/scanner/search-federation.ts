// Federated search — a per-sibling FTS result union with repo attribution (Decision 5). No id joins
// (unlike trace): knowledge_entries.file_path is already absolute, so results are actionable without
// path translation. bm25 ranks are corpus-relative → grouped by repo, not interleaved (OQ5). Opt-in
// only (--with); the single-repo path is untouched (byte-identical).

import type { LuxDatabase } from '../db/index.js';
import type { FederationBlock } from './siblings.js';

export interface FederatedSearchResultItem {
  type: 'document';
  title: string;
  path: string;
  rank: number;
}

export interface FederatedSearchGroup {
  repo: string;
  results: FederatedSearchResultItem[];
}

export interface FederatedSearchResult {
  query: string;
  groups: FederatedSearchGroup[];
  federation: FederationBlock;
}

/** Per-repo FTS union (main first, then registry order). Each group is independently ranked. */
export function runFederatedSearch(
  primary: LuxDatabase,
  siblings: Array<{ name: string; db: LuxDatabase }>,
  query: string,
  federation: FederationBlock,
  limit: number
): FederatedSearchResult {
  const search = (db: LuxDatabase): FederatedSearchResultItem[] =>
    db
      .searchAllDocuments(query)
      .slice(0, limit)
      .map((d) => ({ type: 'document' as const, title: d.title, path: d.file_path, rank: d.rank }));

  const groups: FederatedSearchGroup[] = [{ repo: 'main', results: search(primary) }];
  for (const s of siblings) groups.push({ repo: s.name, results: search(s.db) });
  return { query, groups, federation };
}
