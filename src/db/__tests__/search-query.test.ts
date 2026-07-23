// Pure unit tests for the FTS5 match-expression builder + refusal classifier (spec 10 Part B).
// No DB handle — these are the deterministic building blocks of the ranked search contract (D3, D4).

import { describe, expect, it } from 'vitest';
import {
  buildFtsMatchExpression,
  classifySearchError,
  coerceSearchLimit,
  DEFAULT_SEARCH_LIMIT,
  SearchRefusalError,
} from '../search-query.js';

describe('buildFtsMatchExpression', () => {
  it('passes a plain query through verbatim (operator syntax preserved), trimmed', () => {
    expect(buildFtsMatchExpression('settlement')).toBe('settlement');
    expect(buildFtsMatchExpression('  a OR b  ')).toBe('a OR b');
    expect(buildFtsMatchExpression('refund*')).toBe('refund*');
  });

  it('scopes the WHOLE expression to content under contentOnly (D4 — closes the first-term leak)', () => {
    expect(buildFtsMatchExpression('a b', { contentOnly: true })).toBe('content: (a b)');
    expect(buildFtsMatchExpression('(a OR b)', { contentOnly: true })).toBe('content: ((a OR b))');
  });

  it('throws invalid-query for an empty or whitespace-only query', () => {
    expect(() => buildFtsMatchExpression('')).toThrow(SearchRefusalError);
    expect(() => buildFtsMatchExpression('   ')).toThrow(SearchRefusalError);
    try {
      buildFtsMatchExpression('');
    } catch (e) {
      expect(e).toBeInstanceOf(SearchRefusalError);
      expect((e as SearchRefusalError).reason).toBe('invalid-query');
    }
  });

  it('throws invalid-query for unbalanced parens under contentOnly (the wrap cannot manufacture a syntax error)', () => {
    expect(() => buildFtsMatchExpression('a (b', { contentOnly: true })).toThrow(
      SearchRefusalError
    );
    expect(() => buildFtsMatchExpression('a )b', { contentOnly: true })).toThrow(
      SearchRefusalError
    );
    try {
      buildFtsMatchExpression('a (b', { contentOnly: true });
    } catch (e) {
      expect((e as SearchRefusalError).reason).toBe('invalid-query');
    }
  });

  it('ignores parens inside a double-quoted phrase when balancing', () => {
    // The `)(` live inside a quoted phrase, so paren-balance is not disturbed → wraps cleanly.
    expect(buildFtsMatchExpression('")("', { contentOnly: true })).toBe('content: (")(")');
  });
});

describe('classifySearchError', () => {
  it('maps a missing FTS table to fts-unavailable with the migrate remediation', () => {
    const refusal = classifySearchError(new Error('no such table: knowledge_entries_fts'), 'foo');
    expect(refusal).toBeInstanceOf(SearchRefusalError);
    expect(refusal.reason).toBe('fts-unavailable');
    expect(refusal.message).toMatch(/lux migrate up/);
  });

  it('maps the REAL corruption string "database disk image is malformed" to fts-unavailable (m4)', () => {
    // The bare `malformed database` never appears in the driver; the real string is
    // "database disk image is malformed". A subtly-corrupt index must refuse honestly, not crash or
    // be misclassified as an invalid query.
    const refusal = classifySearchError(
      new Error('database disk image is malformed'),
      'settlement'
    );
    expect(refusal.reason).toBe('fts-unavailable');
  });

  it('maps an FTS5 parse failure to invalid-query and echoes the expression', () => {
    const refusal = classifySearchError(new Error('fts5: syntax error near "("'), 'content: ((');
    expect(refusal.reason).toBe('invalid-query');
    expect(refusal.expression).toBe('content: ((');
  });

  it('maps `no such column` (a user col:term filter on a bad column) to invalid-query, NOT fts-unavailable', () => {
    // FTS5 raises `no such column: <col>` for a `col:term` filter naming a nonexistent column (and
    // for a hyphenated bareword like `double-charging`) — a QUERY error, not a broken index.
    const refusal = classifySearchError(new Error('no such column: charging'), 'double-charging');
    expect(refusal.reason).toBe('invalid-query');
  });

  it('returns a SearchRefusalError unchanged (no double-wrap)', () => {
    const original = new SearchRefusalError('invalid-query', 'x', 'msg');
    expect(classifySearchError(original, 'x')).toBe(original);
  });

  it('treats an unrecognized error as fts-unavailable (conservative, non-fabricating)', () => {
    const refusal = classifySearchError(new Error('disk I/O error'), 'foo');
    expect(refusal.reason).toBe('fts-unavailable');
  });
});

describe('coerceSearchLimit (the one shared rule for coercing paths — M2)', () => {
  it('passes a positive integer through untouched', () => {
    expect(coerceSearchLimit(1)).toBe(1);
    expect(coerceSearchLimit(20)).toBe(20);
    expect(coerceSearchLimit(500)).toBe(500);
  });

  it('coerces every unsafe input to the default (no raw limit reaches `LIMIT ?`)', () => {
    expect(coerceSearchLimit(0)).toBe(DEFAULT_SEARCH_LIMIT); // `LIMIT 0` fabricates empty
    expect(coerceSearchLimit(-1)).toBe(DEFAULT_SEARCH_LIMIT); // `LIMIT -1` is unbounded
    expect(coerceSearchLimit(-500)).toBe(DEFAULT_SEARCH_LIMIT);
    expect(coerceSearchLimit(2.5)).toBe(DEFAULT_SEARCH_LIMIT); // non-integer hard-aborts WASM
    expect(coerceSearchLimit(Number.NaN)).toBe(DEFAULT_SEARCH_LIMIT);
    expect(coerceSearchLimit(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SEARCH_LIMIT);
    expect(coerceSearchLimit(undefined)).toBe(DEFAULT_SEARCH_LIMIT);
    expect(coerceSearchLimit('20')).toBe(DEFAULT_SEARCH_LIMIT); // a string is not a number
    expect(coerceSearchLimit(null)).toBe(DEFAULT_SEARCH_LIMIT);
  });
});
