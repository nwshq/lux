import { describe, it, expect } from 'vitest';
import {
  buildAnchorReport,
  buildAnchorRefusalReport,
  type AnchorResultV1,
  type AnchorCoverageV1,
  type AnchorFiltersV1,
} from '../anchors-envelope.js';

// The CLI `--json` path (cli/anchors.ts) and the `lux_anchors` MCP tool (mcp/server.ts) BOTH build
// their machine envelope through these two functions — so one shape guard here covers both surfaces
// and they cannot drift. These assertions pin the frozen schemaVersion:1 contract.
describe('anchors envelope (AnchorReportV1)', () => {
  const coverage: AnchorCoverageV1 = {
    embeddedNodes: 0,
    anchorViableNodes: 12,
    model: null,
    index: { embeddedNodes: 0, totalNodes: 12, model: null },
    query: { semanticUsed: false, reason: 'no-embedded-nodes' },
  };
  const filters: AnchorFiltersV1 = { tests: 'excluded', excludedTestFiles: 0 };
  const result: AnchorResultV1 = {
    nodeId: 'symbol:php:App\\Services\\Payments\\StripeService',
    symbolKind: 'Class',
    symbolName: 'StripeService',
    qualifiedName: 'App\\Services\\Payments\\StripeService',
    filePath: 'app/Services/Payments/StripeService.php',
    matchedVia: 'lexical',
    lexicalRank: 1,
    fusedScore: 0.0164,
  };

  it('buildAnchorReport carries schemaVersion:1, surface:anchors, granularity, filters, and passes the result set through intact', () => {
    const report = buildAnchorReport({
      query: 'stripe service',
      limit: 10,
      granularity: 'node',
      results: [result],
      lowConfidence: false,
      filters,
      coverage,
    });
    expect(report.schemaVersion).toBe(1);
    expect(report.surface).toBe('anchors');
    expect(report.query).toBe('stripe service');
    expect(report.limit).toBe(10);
    expect(report.granularity).toBe('node');
    expect(report.lowConfidence).toBe(false);
    expect(report.filters).toEqual(filters);
    expect(report.coverage).toEqual(coverage);
    expect(report.results).toHaveLength(1);
    // The frozen node-mode AnchorResultV1 field set (a semantic hit would additionally carry `cosine`;
    // a file-mode result additionally carries `fileNodeCount` — asserted below).
    expect(Object.keys(report.results[0]).sort()).toEqual(
      [
        'filePath',
        'fusedScore',
        'lexicalRank',
        'matchedVia',
        'nodeId',
        'qualifiedName',
        'symbolKind',
        'symbolName',
      ].sort()
    );
    expect(report.refusal).toBeUndefined();
  });

  it('file-granularity result carries the additive fileNodeCount field', () => {
    const fileResult: AnchorResultV1 = { ...result, fileNodeCount: 3 };
    const report = buildAnchorReport({
      query: 'payments',
      limit: 10,
      granularity: 'file',
      results: [fileResult],
      lowConfidence: false,
      filters,
      coverage,
    });
    expect(report.granularity).toBe('file');
    expect(report.results[0].fileNodeCount).toBe(3);
    expect(Object.keys(report.results[0])).toContain('fileNodeCount');
  });

  it('buildAnchorRefusalReport carries the refusal shape: empty results, lowConfidence:false, refusal present', () => {
    const refusalCoverage: AnchorCoverageV1 = {
      embeddedNodes: 0,
      anchorViableNodes: 12,
      model: null,
    };
    const report = buildAnchorRefusalReport({
      query: '   ',
      limit: 10,
      granularity: 'node',
      filters,
      coverage: refusalCoverage,
      refusal: { reason: 'invalid-query', expression: '   ', message: 'Empty search query.' },
    });
    expect(report.schemaVersion).toBe(1);
    expect(report.surface).toBe('anchors');
    expect(report.granularity).toBe('node');
    expect(report.results).toEqual([]);
    expect(report.lowConfidence).toBe(false);
    expect(report.filters).toEqual(filters);
    expect(report.coverage).toEqual(refusalCoverage);
    // A refusal carries the flat coverage fields only — no per-query index/query sub-objects.
    expect(report.coverage.index).toBeUndefined();
    expect(report.coverage.query).toBeUndefined();
    expect(report.refusal).toBeDefined();
    expect(report.refusal?.reason).toBe('invalid-query');
    expect(report.refusal?.expression).toBe('   ');
    expect(report.refusal?.message).toBe('Empty search query.');
  });
});
