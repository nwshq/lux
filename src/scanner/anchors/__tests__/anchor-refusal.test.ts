import { describe, it, expect } from 'vitest';
import { classifyAnchorFtsError, AnchorRefusalError } from '../anchor-refusal.js';

// classifyAnchorFtsError maps an FTS5 MATCH failure to an AnchorRefusalError by reusing the shipped L0
// classifier (classifySearchError), so the anchors surface classifies identical SQLite errors
// identically to `lux search`. The overlay-missing / anchor-texts-absent classes are constructed
// directly by runAnchorSearch (they are not FTS errors) and must pass through this function untouched.
describe('classifyAnchorFtsError', () => {
  it('passes an existing AnchorRefusalError through unchanged (identity — no re-wrapping)', () => {
    const original = new AnchorRefusalError('overlay-missing', 'stripe service', 'no overlay yet');
    expect(classifyAnchorFtsError(original, 'stripe service')).toBe(original);
  });

  it('maps an fts-unavailable-class driver error to reason:fts-unavailable, echoing the expression + cause', () => {
    // A "no such table" SQLite driver error is an unavailable-index signal — the L0 classifier routes
    // it to fts-unavailable (the honest "I could not look"), not invalid-query.
    const driverError = new Error('SQLITE_ERROR: no such table: structural_node_texts_fts');
    const refusal = classifyAnchorFtsError(driverError, 'stripe service');
    expect(refusal).toBeInstanceOf(AnchorRefusalError);
    expect(refusal.reason).toBe('fts-unavailable');
    expect(refusal.expression).toBe('stripe service');
    expect(refusal.cause).toBe(driverError);
  });

  it('maps an FTS5 MATCH parse failure to reason:invalid-query, echoing the offending expression', () => {
    const parseError = new Error('fts5: syntax error near "AND"');
    const refusal = classifyAnchorFtsError(parseError, 'stripe AND');
    expect(refusal.reason).toBe('invalid-query');
    expect(refusal.expression).toBe('stripe AND');
  });
});
