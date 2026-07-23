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
}

export interface AnchorRefusalV1 {
  reason: AnchorRefusalReason;
  expression: string;
  message: string;
}

/** Coverage of the semantic plane at query time (03 §The surface). `model` is null in Phase 1 and
 *  whenever no vectors exist. `embeddedNodes`/`anchorViableNodes` report the semantic coverage gap. */
export interface AnchorCoverageV1 {
  embeddedNodes: number;
  anchorViableNodes: number;
  model: string | null;
}

/** The frozen machine envelope for `lux anchors`. schemaVersion is 1 and additive-only. */
export interface AnchorReportV1 {
  schemaVersion: 1;
  surface: 'anchors';
  query: string;
  limit: number;
  results: AnchorResultV1[];
  /** true when the top hit clears no confidence floor (a thin, uncorroborated match). */
  lowConfidence: boolean;
  coverage: AnchorCoverageV1;
  /** present only on a refusal; results is then empty. */
  refusal?: AnchorRefusalV1;
}

export function buildAnchorReport(input: {
  query: string;
  limit: number;
  results: AnchorResultV1[];
  lowConfidence: boolean;
  coverage: AnchorCoverageV1;
}): AnchorReportV1 {
  return {
    schemaVersion: 1,
    surface: 'anchors',
    query: input.query,
    limit: input.limit,
    results: input.results,
    lowConfidence: input.lowConfidence,
    coverage: input.coverage,
  };
}

export function buildAnchorRefusalReport(input: {
  query: string;
  limit: number;
  coverage: AnchorCoverageV1;
  refusal: AnchorRefusalV1;
}): AnchorReportV1 {
  return {
    schemaVersion: 1,
    surface: 'anchors',
    query: input.query,
    limit: input.limit,
    results: [],
    lowConfidence: false,
    coverage: input.coverage,
    refusal: input.refusal,
  };
}
