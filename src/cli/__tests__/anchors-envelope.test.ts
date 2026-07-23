import { describe, it, expect } from 'vitest';
import {
  buildAnchorReport,
  buildAnchorRefusalReport,
  type AnchorResultV1,
  type AnchorCoverageV1,
} from '../anchors-envelope.js';

// The CLI `--json` path (cli/anchors.ts) and the `lux_anchors` MCP tool (mcp/server.ts) BOTH build
// their machine envelope through these two functions — so one shape guard here covers both surfaces
// and they cannot drift. These assertions pin the frozen schemaVersion:1 contract.
describe('anchors envelope (AnchorReportV1)', () => {
  const coverage: AnchorCoverageV1 = { embeddedNodes: 0, anchorViableNodes: 12, model: null };
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

  it('buildAnchorReport carries schemaVersion:1, surface:anchors, and passes the result set through intact', () => {
    const report = buildAnchorReport({
      query: 'stripe service',
      limit: 10,
      results: [result],
      lowConfidence: false,
      coverage,
    });
    expect(report.schemaVersion).toBe(1);
    expect(report.surface).toBe('anchors');
    expect(report.query).toBe('stripe service');
    expect(report.limit).toBe(10);
    expect(report.lowConfidence).toBe(false);
    expect(report.coverage).toEqual(coverage);
    expect(report.results).toHaveLength(1);
    // The frozen AnchorResultV1 field set (a semantic hit would additionally carry `cosine`).
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

  it('buildAnchorRefusalReport carries the refusal shape: empty results, lowConfidence:false, refusal present', () => {
    const report = buildAnchorRefusalReport({
      query: '   ',
      limit: 10,
      coverage,
      refusal: { reason: 'invalid-query', expression: '   ', message: 'Empty search query.' },
    });
    expect(report.schemaVersion).toBe(1);
    expect(report.surface).toBe('anchors');
    expect(report.results).toEqual([]);
    expect(report.lowConfidence).toBe(false);
    expect(report.coverage).toEqual(coverage);
    expect(report.refusal).toBeDefined();
    expect(report.refusal?.reason).toBe('invalid-query');
    expect(report.refusal?.expression).toBe('   ');
    expect(report.refusal?.message).toBe('Empty search query.');
  });
});
