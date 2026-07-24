import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../../db/index.js';
import { runAnchorSearch } from '../../../cli/anchor-search.js';
import { rankAnchorsLexical } from '../lexical-ranker.js';
import { fuseRrf } from '../fusion.js';
import { resolveStartNode } from '../../associations/trace.js';
import { isTestPath } from '../test-path.js';

// Consumer-polish behaviors (issue #77 items #3/#4): file granularity, test-exclusion-by-default, and
// the byte-identical legacy escape hatch. Lexical-only fixture (no embeddings), so fusion is pure
// lexical and the byte-identity comparison is exact.

const split = (raw: string): string[] =>
  raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
const toks = (s: string): string => split(s).join(' ').toLowerCase();

interface SeedNode {
  id: string;
  name: string;
  qualified: string;
  path: string;
  kind: string;
  context: string;
}

// A crowder FILE (app/Services/Settlement/SettlementService.php) with 4 nodes that all match
// 'settlement' on their NAME/identifiers (column weight 5/4 → strong bm25) so they outrank the weak
// single-node file below; one single-node product file (AuditLog) that matches 'settlement' only in
// its low-weighted CONTEXT column (weight 1) so it is crowded out of a small node-mode limit; and a
// test file that matches 'settlement' strongly but is excluded by default.
const CROWDER = 'app/Services/Settlement/SettlementService.php';
const AUDIT = 'app/Logging/AuditLog.php';
const TEST_FILE = 'tests/Unit/SettlementServiceTest.php';

const NODES: SeedNode[] = [
  {
    id: 'symbol:php:App\\Services\\Settlement\\SettlementService',
    name: 'SettlementService',
    qualified: 'App\\Services\\Settlement\\SettlementService',
    path: CROWDER,
    kind: 'Class',
    context: 'class SettlementService orchestrates settlement of seller proceeds',
  },
  {
    id: 'symbol:php:App\\Services\\Settlement\\SettlementService::computeSettlement',
    name: 'computeSettlement',
    qualified: 'App\\Services\\Settlement\\SettlementService::computeSettlement',
    path: CROWDER,
    kind: 'Method',
    context: 'public function computeSettlement totals a settlement',
  },
  {
    id: 'symbol:php:App\\Services\\Settlement\\SettlementService::settlementBatch',
    name: 'settlementBatch',
    qualified: 'App\\Services\\Settlement\\SettlementService::settlementBatch',
    path: CROWDER,
    kind: 'Method',
    context: 'public function settlementBatch runs a settlement batch',
  },
  {
    id: 'symbol:php:App\\Services\\Settlement\\SettlementService::reconcileSettlement',
    name: 'reconcileSettlement',
    qualified: 'App\\Services\\Settlement\\SettlementService::reconcileSettlement',
    path: CROWDER,
    kind: 'Method',
    context: 'public function reconcileSettlement reconciles a settlement',
  },
  {
    // Weak match: 'settlement' appears ONLY in the context column (weight 1), never the name/path.
    id: 'symbol:php:App\\Logging\\AuditLog',
    name: 'AuditLog',
    qualified: 'App\\Logging\\AuditLog',
    path: AUDIT,
    kind: 'Class',
    context: 'class AuditLog records a settlement event to the audit trail',
  },
  {
    // Strong match but a TEST file → excluded by default, restored by include-tests.
    id: 'symbol:php:Tests\\Unit\\SettlementServiceTest',
    name: 'SettlementServiceTest',
    qualified: 'Tests\\Unit\\SettlementServiceTest',
    path: TEST_FILE,
    kind: 'Class',
    context: 'class SettlementServiceTest asserts settlement behavior',
  },
];

function seed(db: LuxDatabase): void {
  const now = Math.floor(Date.now() / 1000);
  db.transaction(() => {
    for (const n of NODES) {
      db.upsertStructuralNode({
        id: n.id,
        node_type: 'symbol',
        file_path: n.path,
        language_id: 'php',
        symbol_name: n.name,
        symbol_kind: n.kind,
        qualified_name: n.qualified,
        updated_at: now,
      });
      db.upsertNodeAnchorText({
        node_id: n.id,
        prepared: `${n.kind} ${n.name} — ${n.qualified} (${n.path})\n${n.context}`,
        content_hash: 'x'.repeat(64),
        name: n.name,
        identifiers: split(n.name)
          .map((s) => s.toLowerCase())
          .join(' '),
        qualified: toks(n.qualified),
        path_segments: toks(n.path.replace(/\.[a-z]+$/i, '')),
        context: n.context.toLowerCase(),
      });
    }
  });
}

describe('runAnchorSearch — consumer polish (granularity + test exclusion)', () => {
  let dir: string;
  let db: LuxDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lux-anchors-polish-'));
    db = new LuxDatabase(join(dir, 'test.db'));
    seed(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('excludes test files by DEFAULT and reports the count in filters', async () => {
    const { results, filters, granularity } = await runAnchorSearch(db, 'settlement', {
      limit: 10,
    });
    expect(granularity).toBe('node');
    expect(filters.tests).toBe('excluded');
    expect(filters.excludedTestFiles).toBe(1);
    // No test-path node survives the default filter.
    expect(results.some((r) => isTestPath(r.filePath))).toBe(false);
    expect(results.map((r) => r.filePath)).not.toContain(TEST_FILE);
  });

  it('restores test files with includeTests and reports tests:included', async () => {
    const { results, filters } = await runAnchorSearch(db, 'settlement', {
      limit: 10,
      includeTests: true,
    });
    expect(filters.tests).toBe('included');
    expect(filters.excludedTestFiles).toBe(0);
    expect(results.map((r) => r.filePath)).toContain(TEST_FILE);
  });

  it('all matches are test files: default mode returns empty (not a refusal), lowConfidence:false, and counts the exclusion', async () => {
    // 'asserts' appears ONLY in the test node's context column, so it is the sole lexical match — and
    // the default filter removes it. The result is a clean empty answer (exit 0, not a refusal), the
    // confidence floor sees no top hit (lowConfidence stays false), and the drop is counted so a consumer
    // can tell "everything I matched was a test" from "nothing matched".
    const { results, lowConfidence, filters } = await runAnchorSearch(db, 'asserts', { limit: 10 });
    expect(results).toHaveLength(0);
    expect(lowConfidence).toBe(false);
    expect(filters.tests).toBe('excluded');
    expect(filters.excludedTestFiles).toBe(1);
  });

  it('node granularity: a multi-node file crowds a weaker single-node file out of a small limit', async () => {
    // limit 4 = the crowder file's 4 strong (name-match) nodes; AuditLog (context-only, weight 1) is
    // rank 5 and falls outside the cap — the exact flooding the consumer reported.
    const { results } = await runAnchorSearch(db, 'settlement', { limit: 4 });
    expect(results).toHaveLength(4);
    expect(new Set(results.map((r) => r.filePath))).toEqual(new Set([CROWDER]));
    expect(results.map((r) => r.filePath)).not.toContain(AUDIT);
    // Node mode adds no fileNodeCount.
    expect(results.every((r) => r.fileNodeCount === undefined)).toBe(true);
  });

  it('file granularity: the crowder collapses to one representative and the weaker file now surfaces', async () => {
    const { results, granularity } = await runAnchorSearch(db, 'settlement', {
      limit: 4,
      granularity: 'file',
    });
    expect(granularity).toBe('file');
    // Each file appears at most once.
    const paths = results.map((r) => r.filePath);
    expect(new Set(paths).size).toBe(paths.length);
    // Both product files surface now (the crowder no longer floods the cap); the test file stays excluded.
    expect(paths).toContain(CROWDER);
    expect(paths).toContain(AUDIT);
    expect(paths).not.toContain(TEST_FILE);
    // The crowder's representative is its best-ranked REAL node and reports its ranked-node count (4,
    // all non-test). The representative round-trips through the resolver `lux trace` uses.
    const rep = results.find((r) => r.filePath === CROWDER)!;
    expect(rep.fileNodeCount).toBe(4);
    expect(resolveStartNode(db, rep.nodeId)).toEqual({ nodeId: rep.nodeId });
    // The single-node file reports fileNodeCount 1.
    expect(results.find((r) => r.filePath === AUDIT)!.fileNodeCount).toBe(1);
  });

  it('legacy mode (includeTests + node) yields a results array BYTE-IDENTICAL to the raw v2.11.0 fusion pipeline', async () => {
    // v2.11.0 computed results = fuseRrf(rankAnchorsLexical(db,q,limit), []).slice(0,limit).map(meta).
    // The legacy escape hatch must reproduce that EXACTLY — no widened pool, no filtering, no dedupe,
    // no added per-result field — for every query.
    for (const q of ['settlement', 'settlement batch', 'audit', 'reconcile']) {
      for (const limit of [2, 4, 10]) {
        const lex = rankAnchorsLexical(db, q, limit);
        const lexByNode = new Map(lex.map((h) => [h.nodeId, h]));
        const expected = fuseRrf(
          lex.map((h) => ({ nodeId: h.nodeId, lexicalRank: h.lexicalRank })),
          []
        )
          .slice(0, limit)
          .map((f) => {
            const m = lexByNode.get(f.nodeId)!;
            return {
              nodeId: f.nodeId,
              symbolKind: m.symbolKind,
              symbolName: m.symbolName,
              qualifiedName: m.qualifiedName,
              filePath: m.filePath,
              matchedVia: f.matchedVia,
              lexicalRank: f.lexicalRank,
              cosine: f.cosine,
              fusedScore: f.fusedScore,
            };
          });
        const legacy = await runAnchorSearch(db, q, {
          limit,
          includeTests: true,
          granularity: 'node',
        });
        expect(legacy.results, `query=${q} limit=${limit}`).toEqual(expected);
        // No fileNodeCount key leaks into node mode.
        expect(legacy.results.every((r) => !('fileNodeCount' in r))).toBe(true);
      }
    }
  });
});
