import type { SourceDiagnosticV1, SourceFactsV1, SourceLocationV1 } from '../contracts/program.js';
import type { AdapterInputV1, AdapterOutputV1, SourceAdapterV1 } from './types.js';
import type { AdapterWorkerRequestV1 } from './worker-protocol.js';
export interface SourceRangeV1 extends SourceLocationV1 {
  endLine: number;
  endColumn: number;
  startByte: number;
  endByte: number;
}
export interface InfrastructureFactBaseV1 {
  schemaVersion: 1;
  localId: string;
  filePath: string;
  range: SourceRangeV1;
}
export type InfrastructureFactV1 = InfrastructureFactBaseV1 & { family: string };
export interface ArtifactAdapterOutputV1<T extends InfrastructureFactV1> extends AdapterOutputV1 {
  facts: SourceFactsV1;
  artifactFacts: T[];
  dependencies: string[];
  diagnostics: SourceDiagnosticV1[];
}
export interface ArtifactAdapterV1<T extends InfrastructureFactV1> extends Omit<
  SourceAdapterV1,
  'extract'
> {
  extract(input: AdapterInputV1): Promise<ArtifactAdapterOutputV1<T>>;
}
export interface BoundedAdapterWorkerRequestV1 extends AdapterWorkerRequestV1 {
  canonicalFilePath: string;
  sourceBytes: Uint8Array;
}
export class ParseBudgetV1 {
  private nodes = 0;
  private references = 0;
  constructor(private readonly limits: AdapterInputV1['limits']) {}
  visit(depth: number) {
    if (depth > this.limits.maxDepth || ++this.nodes > this.limits.maxNodes)
      throw new Error('AST depth/node budget exceeded');
  }
  reference() {
    if (++this.references > this.limits.maxReferences) throw new Error('Reference budget exceeded');
  }
}
