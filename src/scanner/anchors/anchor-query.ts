// src/scanner/anchors/anchor-query.ts
//
// The anchor-specific FTS5 MATCH-expression builder (Decision 3/4 — the lexical half's query side).
// NON-fenced: imports nothing from scanner/embeddings/.
//
// Why NOT reuse the L0 `buildFtsMatchExpression` (which `lux search` uses): L0 passes the query to
// FTS5 verbatim, so bare space-separated terms are ANDed (FTS5's default). That is right for `lux
// search`, whose input is a KEYWORD query. But `lux anchors` takes a NATURAL-LANGUAGE query — a
// phrase or sentence describing a concept ("combine keyword matches and vector similarity into a
// ranking"). ANDing every term requires them ALL to co-occur in one node's prepared text, which a
// midpoint/NL query almost never satisfies, so the ranker returns nothing — the "search falls apart
// from a midpoint" failure. Anchors therefore OR-expands the query: any term may match, and the
// weighted bm25 (name/identifier hits ≫ context hits) ranks the multi-term / rare-term matches to the
// top. OR-expansion does NOT change a matched node's bm25 (FTS5 bm25 sums only the terms a node
// actually matches), so the confidence floor (fusion.ts ANCHOR_MIN_LEXICAL_BM25) separates confident
// from thin identically; it merely lets more candidates in for bm25 to rank — a strict recall gain
// measured on the concept→node battery (LIFT-PROBE-RESULTS.md: mismatch hit@10 0.00 → 0.25, easy
// 0.67 → 1.00, no regression).
//
// Refusal boundary vs L0 (deliberately NOT identical — anchors takes NL, not FTS grammar): the empty
// query still refuses as invalid-query (same error class, re-keyed by classifyAnchorFtsError). But
// because every term is tokenized to a quoted string literal, an input carrying FTS operator/grammar
// characters ("unterminated phrase, a:b, foo NEAR bar) is treated as its literal words rather than
// refused — the operators can't be interpreted, which is the point (Non-Goals: no query DSL). So
// invalid-query narrows to empty/tokenless input only; malformed-FTS-grammar input answers instead of
// refusing.
//
// Tokenizer mirrors the index's FTS5 unicode61 tokenizer (migration 014, default options), verified
// against node-sqlite3-wasm: it folds diacritics (remove_diacritics 1 — indexed `café` matches
// `cafe`) and indexes Unicode letters/numbers. So the query tokenizer decomposes + strips combining
// marks (fold), Unicode-lowercases, and splits on non-letter/number — a Cyrillic or accented query
// tokenizes and matches the index, and a non-Latin-script query is no longer mis-refused as
// "empty" (it answers, like L0). Injection stays structurally closed: a \p{L}\p{N} token cannot
// contain a quote or an FTS operator, and each is quoted + bound as a MATCH ? parameter downstream.

import { SearchRefusalError } from '../../db/search-query.js';

/** Cap on distinct OR terms fed to FTS5 (availability): a natural-language anchor query is a short
 *  phrase, so this is far above any real query; it bounds the FTS scan cost of a pathological/hostile
 *  mega-query (e.g. a ~1MB MCP request) to a fixed, linear size. Applied after dedupe. */
const MAX_ANCHOR_TERMS = 64;

// Conservative English function-word stoplist. Deliberately small: it drops only true stopwords
// (articles, prepositions, conjunctions, auxiliaries, pronouns) so a common word cannot become the
// sole matched term of an otherwise-specific query. It does NOT drop domain words that are meaningful
// in a code overlay ("node", "file", "index", "path", "type", "class") — those carry signal.
const ANCHOR_STOPWORDS = new Set<string>([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'but',
  'by',
  'can',
  'cannot',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'how',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'over',
  'per',
  'so',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'these',
  'this',
  'those',
  'to',
  'up',
  'was',
  'were',
  'what',
  'when',
  'which',
  'while',
  'who',
  'whose',
  'why',
  'will',
  'with',
  'would',
]);

/** Split a query into tokens mirroring the index's FTS5 unicode61 tokenizer (fold diacritics,
 *  Unicode-lowercase, split on non-letter/number). A \p{L}\p{N} token can never contain a quote or an
 *  FTS operator char, so quoting it downstream is injection-safe. */
function tokenize(query: string): string[] {
  return query
    .normalize('NFKD') // decompose accented letters so the combining marks can be stripped
    .replace(/\p{M}+/gu, '') // strip combining marks → fold diacritics (index uses remove_diacritics 1)
    .toLowerCase() // Unicode-aware lowercase (matches the index's case-folding)
    .split(/[^\p{L}\p{N}]+/u) // split on non-letter/number (Unicode), not just ASCII
    .filter((t) => t.length > 0);
}

/**
 * Build the anchor FTS5 MATCH expression from a natural-language query: OR-expanded, quoted terms.
 *
 *  - Tokenizes to alphanumeric terms, drops stopwords, dedupes (order-preserving).
 *  - If every term was a stopword, falls back to the un-stopworded terms (a query like "how to" still
 *    tries rather than refusing) — bm25 IDF down-weights the common terms anyway.
 *  - If there is no alphanumeric token at all (empty/punctuation-only query), throws
 *    SearchRefusalError('invalid-query'), echoing the query — the caller (lexical-ranker) re-keys it
 *    to AnchorRefusalError via classifyAnchorFtsError, matching L0's empty-query behavior.
 *  - Each term is double-quoted (an FTS5 string literal) so no token is interpreted as an operator;
 *    the whole expression is still bound as a `MATCH ?` parameter downstream (no injection surface).
 */
export function buildAnchorMatchExpression(query: string): string {
  const all = tokenize(query);
  if (all.length === 0) {
    throw new SearchRefusalError(
      'invalid-query',
      query,
      'Empty anchor query. Provide at least one term.'
    );
  }
  const kept = all.filter((t) => !ANCHOR_STOPWORDS.has(t));
  const terms = [...new Set(kept.length > 0 ? kept : all)].slice(0, MAX_ANCHOR_TERMS);
  return terms.map((t) => `"${t}"`).join(' OR ');
}
