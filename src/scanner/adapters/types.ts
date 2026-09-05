import type {
  ProjectResolutionContextV1,
  SourceDiagnosticV1,
  SourceFactsV1,
} from '../contracts/program.js';
import type { StructuralRelationEdge } from '../associations/types.js';

export interface ParserLimitsV1 {
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
  maxReferences: number;
  timeoutMs: number;
  maxResultBytes: number;
}

export const DEFAULT_PARSER_LIMITS: ParserLimitsV1 = {
  maxBytes: 2 * 1024 * 1024,
  maxDepth: 128,
  maxNodes: 100_000,
  maxReferences: 10_000,
  timeoutMs: 5_000,
  maxResultBytes: 8 * 1024 * 1024,
};

export interface AdapterInputV1 {
  corpusRoot: string;
  allowedRoots: readonly string[];
  filePath: string;
  limits: ParserLimitsV1;
}

export interface AdapterOutputV1 {
  facts: SourceFactsV1;
  dependencies: string[];
  diagnostics: SourceDiagnosticV1[];
}

export interface SourceAdapterV1 {
  readonly id: string;
  readonly languages: readonly string[];
  extract(input: AdapterInputV1): Promise<AdapterOutputV1>;
}

export interface RelationshipResolverV1 {
  readonly id: string;
  resolve(
    facts: readonly SourceFactsV1[],
    project: ProjectResolutionContextV1
  ): Promise<StructuralRelationEdge[]>;
}
