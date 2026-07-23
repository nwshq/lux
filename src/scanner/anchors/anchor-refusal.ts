// src/scanner/anchors/anchor-refusal.ts
//
// The anchors surface's refusal classes. EXTENDS the shipped L0 union (search-query.ts:7:
// 'invalid-query' | 'fts-unavailable') with two node-plane members, and reuses classifySearchError
// for the FTS classes so the two surfaces classify identical SQLite errors identically.

import { classifySearchError, SearchRefusalError } from '../../db/search-query.js';
import type { SearchRefusalReason } from '../../db/index.js';

/** The L0 reasons PLUS the two the anchor plane adds (03 §The surface). */
export type AnchorRefusalReason =
  | SearchRefusalReason // 'invalid-query' | 'fts-unavailable'
  | 'overlay-missing' // the structural overlay has never been built (remediation: lux index rebuild)
  | 'anchor-texts-absent'; // overlay present, but no anchor texts (e.g. ast.enabled=false)

export class AnchorRefusalError extends Error {
  constructor(
    public readonly reason: AnchorRefusalReason,
    /** the FTS5 MATCH expression that failed (echoed on invalid-query); the query text otherwise */
    public readonly expression: string,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'AnchorRefusalError';
  }
}

/** Map an FTS5 MATCH failure raised by rankAnchorsLexical to an AnchorRefusalError, reusing the L0
 *  classifier (invalid-query with the expression echoed / fts-unavailable with the migrate
 *  remediation). overlay-missing / anchor-texts-absent are NOT FTS errors — runAnchorSearch
 *  constructs those directly from the overlay/texts probes before it ever runs the MATCH. */
export function classifyAnchorFtsError(error: unknown, expression: string): AnchorRefusalError {
  if (error instanceof AnchorRefusalError) return error;
  const l0: SearchRefusalError = classifySearchError(error, expression);
  return new AnchorRefusalError(l0.reason, l0.expression, l0.message, l0.cause);
}
