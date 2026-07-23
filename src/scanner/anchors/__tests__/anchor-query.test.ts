import { describe, it, expect } from 'vitest';
import { buildAnchorMatchExpression } from '../anchor-query.js';
import { SearchRefusalError } from '../../../db/search-query.js';

describe('buildAnchorMatchExpression', () => {
  it('OR-expands a multi-word natural-language query (not L0 keyword-AND)', () => {
    // The core fix: bare terms are ORed, so a midpoint/NL query does not require every term to
    // co-occur in one node's text (the "search falls apart from a midpoint" failure).
    expect(buildAnchorMatchExpression('combine keyword matches and vector similarity')).toBe(
      '"combine" OR "keyword" OR "matches" OR "vector" OR "similarity"'
    );
  });

  it('quotes every term (an FTS5 string literal — no operator interpretation, no injection)', () => {
    // A term that would be an FTS5 operator or contain punctuation is defanged by tokenization +
    // quoting: 'read-only' → two quoted string literals, never a `-only` NOT operator.
    expect(buildAnchorMatchExpression('read-only handle')).toBe('"read" OR "only" OR "handle"');
    expect(buildAnchorMatchExpression('a OR b')).toBe('"b"'); // 'a'/'or' are stopwords → only 'b'
  });

  it('drops stopwords but keeps code-meaningful words', () => {
    // "the"/"of"/"to" dropped; "node"/"index"/"path" kept (they carry signal in a code overlay).
    expect(buildAnchorMatchExpression('prepare the text of a node for the index')).toBe(
      '"prepare" OR "text" OR "node" OR "index"'
    );
  });

  it('dedupes repeated terms, order-preserving', () => {
    expect(buildAnchorMatchExpression('rank the rank list')).toBe('"rank" OR "list"');
  });

  it('falls back to the un-stopworded terms when the query is all stopwords', () => {
    // "how to" would otherwise empty out; keep the tokens so the query still tries (bm25 IDF
    // down-weights the common terms) rather than refusing a non-empty query.
    expect(buildAnchorMatchExpression('how to')).toBe('"how" OR "to"');
  });

  it('throws invalid-query on an empty / punctuation-only query (identical to L0)', () => {
    for (const q of ['', '   ', '   \t\n ', '!!! ??? ...']) {
      expect(() => buildAnchorMatchExpression(q)).toThrow(SearchRefusalError);
      try {
        buildAnchorMatchExpression(q);
      } catch (e) {
        expect((e as SearchRefusalError).reason).toBe('invalid-query');
      }
    }
  });

  it('lowercases (FTS5 unicode61 token shape) and splits camel/punct boundaries into tokens', () => {
    expect(buildAnchorMatchExpression('StripeService')).toBe('"stripeservice"'); // no camel split on query side — the INDEX identifiers column is pre-split
    expect(buildAnchorMatchExpression('Fuse RRF')).toBe('"fuse" OR "rrf"');
  });

  it('folds diacritics to mirror the index (unicode61 remove_diacritics 1)', () => {
    // The index folds `café`→`cafe`; the query tokenizer must too, or it would never match. Also
    // fixes the ASCII-split mangling (`café`→`caf`, `naïve`→`na`+`ve`).
    expect(buildAnchorMatchExpression('café')).toBe('"cafe"');
    expect(buildAnchorMatchExpression('naïve résumé')).toBe('"naive" OR "resume"');
  });

  it('tokenizes non-Latin scripts (Unicode split) instead of refusing them as empty', () => {
    // ASCII-only split produced zero tokens → a misleading invalid-query refusal. Unicode split
    // yields real terms, so the query answers (like L0) rather than refusing.
    expect(buildAnchorMatchExpression('Москва город')).toBe('"москва" OR "город"');
    expect(() => buildAnchorMatchExpression('日本語のクエリ')).not.toThrow();
  });

  it('caps the distinct OR terms (availability — a hostile mega-query stays bounded)', () => {
    const q = Array.from({ length: 500 }, (_, i) => `term${i}`).join(' ');
    const expr = buildAnchorMatchExpression(q);
    expect(expr.split(' OR ')).toHaveLength(64); // MAX_ANCHOR_TERMS
  });
});
