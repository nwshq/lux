import { createHash } from 'node:crypto';
import type { ConfidenceClass, EdgeType } from '../../db/types.js';
import type { SourceLocationV1 } from '../contracts/program.js';
import type { StructuralRelationEdge } from '../associations/types.js';

export interface FrameworkEdgeInputV1 {
  resolver: string;
  edgeType: EdgeType;
  sourceNodeId: string;
  targetNodeId: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  confidence: number;
  confidenceClass: ConfidenceClass;
  evidenceKind: string;
  locations: readonly SourceLocationV1[];
}

export function frameworkEdge(input: FrameworkEdgeInputV1): StructuralRelationEdge {
  const evidenceLocations = [...input.locations]
    .map(({ filePath, line, column }) => ({ filePath, line, note: `column:${column}` }))
    .sort(
      (a, b) =>
        a.filePath.localeCompare(b.filePath) ||
        (a.line ?? 0) - (b.line ?? 0) ||
        (a.note ?? '').localeCompare(b.note ?? '')
    );
  const identity = [
    input.edgeType,
    input.sourceNodeId,
    input.targetNodeId,
    input.resolver,
    input.evidenceKind,
  ].join('\u0000');

  return {
    id: `edge:${createHash('sha256').update(identity).digest('hex')}`,
    edgeType: input.edgeType,
    sourceNodeId: input.sourceNodeId,
    targetNodeId: input.targetNodeId,
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    confidence: input.confidence,
    confidenceClass: input.confidenceClass,
    provenance: {
      resolver: input.resolver,
      evidenceKind: input.evidenceKind,
      evidenceLocations,
      extractedAt: 0,
    },
  };
}
