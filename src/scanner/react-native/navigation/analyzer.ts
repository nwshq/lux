import type {
  ReactNavigationAnalysisInputV1,
  ReactNavigationAnalysisResultV1,
  ReactNavigationFactExtractorV1,
  ReactNavigationRelationshipResolverV1,
} from './types.js';

/** Verbatim extraction-to-resolution composition for the React Navigation overlay. */
export class ReactNavigationAnalyzer {
  constructor(
    private readonly extractor: ReactNavigationFactExtractorV1,
    private readonly resolver: ReactNavigationRelationshipResolverV1
  ) {}

  async analyze(input: ReactNavigationAnalysisInputV1): Promise<ReactNavigationAnalysisResultV1> {
    const extracted = await this.extractor.extract(input);
    const resolved = await this.resolver.resolve(extracted.facts, input.project);
    return {
      facts: [...extracted.facts],
      nodes: [...resolved.nodes].sort((left, right) => left.id.localeCompare(right.id)),
      edges: [...resolved.edges].sort((left, right) => left.id.localeCompare(right.id)),
      dependencies: [
        ...new Set([...extracted.dependencies, ...input.project.fingerprintInputs]),
      ].sort(),
      diagnostics: [...extracted.diagnostics, ...resolved.diagnostics],
    };
  }
}
