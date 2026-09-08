import type {
  ReactAnalysisInputV1,
  ReactAnalysisResultV1,
  ReactFactExtractorV1,
  ReactFrameworkAnalyzerV1,
  ReactRelationshipResolverV1,
} from './types.js';

/** Verbatim extraction-to-resolution composition; both stages retain their own semantics. */
export class ReactFrameworkAnalyzer implements ReactFrameworkAnalyzerV1 {
  constructor(
    private readonly extractor: ReactFactExtractorV1,
    private readonly resolver: ReactRelationshipResolverV1
  ) {}

  async analyze(input: ReactAnalysisInputV1): Promise<ReactAnalysisResultV1> {
    const extracted = await this.extractor.extract(input);
    const resolved = await this.resolver.resolve(extracted.facts, input.project);
    return {
      facts: [...extracted.facts],
      nodes: [...resolved.nodes].sort((a, b) => a.id.localeCompare(b.id)),
      edges: [...resolved.edges].sort(
        (a, b) =>
          a.sourceNodeId.localeCompare(b.sourceNodeId) ||
          a.edgeType.localeCompare(b.edgeType) ||
          a.targetNodeId.localeCompare(b.targetNodeId) ||
          a.id.localeCompare(b.id)
      ),
      dependencies: [
        ...new Set([...extracted.dependencies, ...input.project.fingerprintInputs]),
      ].sort(),
      diagnostics: [...extracted.diagnostics, ...resolved.diagnostics].sort(
        (a, b) =>
          (a.location?.filePath ?? '').localeCompare(b.location?.filePath ?? '') ||
          (a.location?.line ?? 0) - (b.location?.line ?? 0) ||
          a.code.localeCompare(b.code)
      ),
    };
  }
}
