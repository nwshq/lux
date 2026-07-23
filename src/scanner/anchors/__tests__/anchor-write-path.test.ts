import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../../db/index.js';
import type { ScanResult } from '../../types.js';
import { materializeAstSymbols } from '../../ast/materialize.js';
import { buildFtsMatchExpression } from '../../../db/search-query.js';

function scanOf(
  content: string,
  file = 'app/Services/StripeService.php',
  lang = 'php'
): ScanResult {
  return {
    knowledge: [
      {
        type: 'source-code',
        title: file,
        filePath: `/repo/${file}`,
        frontmatter: { language: lang },
        content,
      },
    ],
  };
}

/** Node ids whose FTS row matches a query — the behavioural freshness/scope probe. */
function ranked(db: LuxDatabase, query: string): string[] {
  return db.rankAnchorsLexical(buildFtsMatchExpression(query, {}), 20).map((r) => r.node_id);
}

describe('anchor write path (materialize → texts/FTS → freshness → clear)', () => {
  let dir: string;
  let db: LuxDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lux-anchor-wp-'));
    db = new LuxDatabase(join(dir, 'test.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes one anchor text per anchor-viable node (Class/Function/Method) and no more (SC-Scope)', async () => {
    const content = [
      '<?php',
      'namespace App\\Services;',
      'class StripeService {',
      '  public function charge() {}',
      '  public function refund() {}',
      '}',
    ].join('\n');
    const count = await materializeAstSymbols(db, scanOf(content), '/repo', 1000);
    // 1 class + 2 methods = 3 anchor-viable nodes.
    expect(count).toBe(3);
    expect(db.getAnchorViableNodeCount()).toBe(3);
    expect(db.hasStructuralOverlay()).toBe(true);
    // The class resolves by name.
    expect(ranked(db, 'StripeService')).toContain('symbol:php:App\\Services\\StripeService');
  });

  it('writes zero anchor texts for non-source (markdown) content (SC-Scope)', async () => {
    await materializeAstSymbols(db, scanOf('# just docs', 'README.md', 'markdown'), '/repo', 1000);
    expect(db.getAnchorViableNodeCount()).toBe(0);
  });

  it('rewrites a stable-id node’s FTS row when its body/doc changes (SC-Freshness, text side)', async () => {
    const v1 = [
      '<?php',
      'namespace App\\Services;',
      'class StripeService {',
      '  /** alphaunique settlement path. */',
      '  public function charge() {}',
      '}',
    ].join('\n');
    await materializeAstSymbols(db, scanOf(v1), '/repo', 1000);
    const chargeId = 'symbol:php:App\\Services\\StripeService::charge';
    expect(ranked(db, 'alphaunique')).toContain(chargeId);

    // Same file, same symbol id, changed doc-comment vocabulary.
    const v2 = v1.replace('alphaunique', 'omegaunique');
    await materializeAstSymbols(db, scanOf(v2), '/repo', 2000);
    expect(ranked(db, 'omegaunique')).toContain(chargeId);
    expect(ranked(db, 'alphaunique')).not.toContain(chargeId); // the stale FTS row did not survive
  });

  it('deleteNodeAnchorRowsForNodeIds removes a victim node’s sibling rows (scoped-refresh delete)', async () => {
    const content = [
      '<?php',
      'namespace App\\Services;',
      'class StripeService {',
      '  public function charge() {}',
      '}',
    ].join('\n');
    await materializeAstSymbols(db, scanOf(content), '/repo', 1000);
    const chargeId = 'symbol:php:App\\Services\\StripeService::charge';
    expect(db.getAnchorViableNodeCount()).toBe(2); // StripeService class + charge method
    expect(ranked(db, 'charge')).toContain(chargeId);

    db.deleteNodeAnchorRowsForNodeIds([chargeId]);
    expect(ranked(db, 'charge')).not.toContain(chargeId);
    expect(db.getAnchorViableNodeCount()).toBe(1); // only the class remains
  });

  it('clearOverlay empties the anchor texts + FTS beside the structural nodes (full-rebuild clear)', async () => {
    const content = [
      '<?php',
      'namespace App\\Services;',
      'class StripeService { public function charge() {} }',
    ].join('\n');
    await materializeAstSymbols(db, scanOf(content), '/repo', 1000);
    expect(db.getAnchorViableNodeCount()).toBeGreaterThan(0);

    db.clearOverlay();
    expect(db.getAnchorViableNodeCount()).toBe(0);
    expect(db.hasStructuralOverlay()).toBe(false);
    expect(ranked(db, 'StripeService')).toHaveLength(0); // FTS emptied too
  });
});
