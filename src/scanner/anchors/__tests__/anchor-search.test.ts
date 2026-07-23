import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LuxDatabase } from '../../../db/index.js';
import { runAnchorSearch, anchorRefusalCoverage } from '../../../cli/anchor-search.js';
import { resolveStartNode } from '../../associations/trace.js';
import { AnchorRefusalError } from '../anchor-refusal.js';

// A realistic payment-domain anchor corpus (mirrors the calibration fixture, BATTERY-OWNER.md). The
// `context` field carries a signature line + doc comment — the low-weighted column where common words
// collide (the thin-match source the confidence floor must catch).
const SEED: Array<[string, string, string, string, string]> = [
  [
    'symbol:php:App\\Contracts\\PaymentGateway',
    'PaymentGateway',
    'App\\Contracts\\PaymentGateway',
    'app/Contracts/PaymentGateway.php',
    'interface PaymentGateway defines the payment contract for charge and refund',
  ],
  [
    'symbol:php:App\\Services\\Payments\\StripeService',
    'StripeService',
    'App\\Services\\Payments\\StripeService',
    'app/Services/Payments/StripeService.php',
    'class StripeService implements PaymentGateway handles stripe charge and settlement',
  ],
  [
    'symbol:php:App\\Services\\Payments\\BraintreeService',
    'BraintreeService',
    'App\\Services\\Payments\\BraintreeService',
    'app/Services/Payments/BraintreeService.php',
    'class BraintreeService implements PaymentGateway handles braintree charge',
  ],
  [
    'symbol:php:App\\Services\\Payments\\AnetService',
    'AnetService',
    'App\\Services\\Payments\\AnetService',
    'app/Services/Payments/AnetService.php',
    'class AnetService implements PaymentGateway authorize net gateway',
  ],
  [
    'symbol:php:App\\Services\\Settlement\\splitByPlatform',
    'splitByPlatform',
    'App\\Services\\Settlement\\SettlementService::splitByPlatform',
    'app/Services/Settlement/SettlementService.php',
    'public function splitByPlatform divides proceeds among sellers',
  ],
  [
    'symbol:php:App\\Mail\\EmailEventRegistrants',
    'EmailEventRegistrants',
    'App\\Mail\\EmailEventRegistrants',
    'app/Mail/EmailEventRegistrants.php',
    'class EmailEventRegistrants mailable notifies event registrants',
  ],
  [
    'symbol:php:App\\Models\\User',
    'User',
    'App\\Models\\User',
    'app/Models/User.php',
    'class User eloquent model for an application user',
  ],
  [
    'symbol:php:App\\Models\\Order',
    'Order',
    'App\\Models\\Order',
    'app/Models/Order.php',
    'class Order represents a customer order with line items',
  ],
  [
    'symbol:php:App\\Http\\Controllers\\OrderController',
    'OrderController',
    'App\\Http\\Controllers\\OrderController',
    'app/Http/Controllers/OrderController.php',
    'class OrderController handles order http requests',
  ],
  [
    'symbol:php:App\\Jobs\\SendInvoice',
    'SendInvoice',
    'App\\Jobs\\SendInvoice',
    'app/Jobs/SendInvoice.php',
    'class SendInvoice queued job emails an invoice to the customer',
  ],
  [
    'symbol:php:App\\Support\\Money',
    'Money',
    'App\\Support\\Money',
    'app/Support/Money.php',
    'class Money value object wraps an amount and currency',
  ],
  [
    'symbol:php:App\\Services\\Catalog\\ProductService',
    'ProductService',
    'App\\Services\\Catalog\\ProductService',
    'app/Services/Catalog/ProductService.php',
    'class ProductService manages the product catalog',
  ],
];

const split = (raw: string): string[] =>
  raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
const toks = (s: string): string => split(s).join(' ').toLowerCase();

function seed(db: LuxDatabase): void {
  const now = Math.floor(Date.now() / 1000);
  db.transaction(() => {
    for (const [id, name, qualified, path, context] of SEED) {
      db.upsertStructuralNode({
        id,
        node_type: 'symbol',
        file_path: path,
        language_id: 'php',
        symbol_name: name,
        symbol_kind: 'Class',
        qualified_name: qualified,
        updated_at: now,
      });
      db.upsertNodeAnchorText({
        node_id: id,
        prepared: `Class ${name} — ${qualified} (${path})\n${context}`,
        content_hash: 'x'.repeat(64),
        name,
        identifiers: split(name)
          .map((s) => s.toLowerCase())
          .join(' '),
        qualified: toks(qualified),
        path_segments: toks(path.replace(/\.[a-z]+$/i, '')),
        context: context.toLowerCase(),
      });
    }
  });
}

describe('runAnchorSearch', () => {
  let dir: string;
  let db: LuxDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lux-anchors-'));
    db = new LuxDatabase(join(dir, 'test.db'));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses overlay-missing on a never-built index', async () => {
    await expect(runAnchorSearch(db, 'stripe service', { limit: 10 })).rejects.toMatchObject({
      reason: 'overlay-missing',
    });
  });

  it('refuses anchor-texts-absent when the overlay exists but has no anchor texts', async () => {
    // A structural node with NO anchor text (the ast.enabled=false state).
    db.upsertStructuralNode({
      id: 'symbol:php:App\\Models\\Bare',
      node_type: 'symbol',
      file_path: 'app/Models/Bare.php',
      language_id: 'php',
      symbol_name: 'Bare',
      symbol_kind: 'Class',
      updated_at: 1,
    });
    expect(db.hasStructuralOverlay()).toBe(true);
    expect(db.getAnchorViableNodeCount()).toBe(0);
    await expect(runAnchorSearch(db, 'bare', { limit: 10 })).rejects.toMatchObject({
      reason: 'anchor-texts-absent',
    });
  });

  it('refuses invalid-query on an empty query and echoes it', async () => {
    seed(db);
    await expect(runAnchorSearch(db, '   ', { limit: 10 })).rejects.toBeInstanceOf(
      AnchorRefusalError
    );
    await expect(runAnchorSearch(db, '   ', { limit: 10 })).rejects.toMatchObject({
      reason: 'invalid-query',
    });
  });

  it('mints ranked node anchors best-first for a name/identifier query (SC-Spread)', async () => {
    seed(db);
    const { results } = await runAnchorSearch(db, 'stripe service', { limit: 10 });
    expect(results[0].nodeId).toBe('symbol:php:App\\Services\\Payments\\StripeService');
    expect(results[0].matchedVia).toBe('lexical');
    expect(results[0].symbolKind).toBe('Class');
  });

  it('surfaces the name-derivable contract for a concept-name query (SC-Spread, contract side)', async () => {
    seed(db);
    // "payment gateway" (implicit-AND) hits the contract whose split identifiers carry both tokens.
    const { results } = await runAnchorSearch(db, 'payment gateway', { limit: 10 });
    expect(results.map((r) => r.nodeId)).toContain('symbol:php:App\\Contracts\\PaymentGateway');
  });

  it('surfaces the path-derivable implementations for a path-concept query (SC-Spread, impl side)', async () => {
    seed(db);
    // "payments" matches the Services/Payments/* path segment — the concrete gateways. Lexical mints
    // the name/path-derivable seeds; structural expansion (trace/deps) reaches the rest (SC-Pipeline).
    const { results } = await runAnchorSearch(db, 'payments', { limit: 10 });
    const ids = results.map((r) => r.nodeId);
    expect(ids).toContain('symbol:php:App\\Services\\Payments\\StripeService');
    expect(ids).toContain('symbol:php:App\\Services\\Payments\\BraintreeService');
  });

  it('mints a nodeId that round-trips through getStructuralNode (SC-Roundtrip, trace.ts:299)', async () => {
    seed(db);
    const { results } = await runAnchorSearch(db, 'EmailEventRegistrants', { limit: 5 });
    const node = db.getStructuralNode(results[0].nodeId);
    expect(node).not.toBeNull();
    expect(node?.id).toBe(results[0].nodeId);
    // Drive the REAL resolver `lux trace` runs (trace.ts:295), not just getStructuralNode: a minted
    // anchor id must be accepted verbatim by resolveStartNode's symbol fast-path — resolving to
    // itself, no disambiguation. This is the "mint an id the structural ops accept verbatim" contract.
    expect(resolveStartNode(db, results[0].nodeId)).toEqual({ nodeId: results[0].nodeId });
  });

  it('returns an empty result (not a refusal) for a healthy populated-index zero match', async () => {
    seed(db);
    const { results, coverage } = await runAnchorSearch(db, 'zzzznonexistentquery', { limit: 10 });
    expect(results).toHaveLength(0);
    expect(coverage.model).toBeNull(); // lexical-only in Phase 1
    expect(coverage.anchorViableNodes).toBe(SEED.length);
  });

  it('confidence floor (SC-Confidence): a confident name hit is NOT lowConfidence', async () => {
    seed(db);
    const strong = await runAnchorSearch(db, 'stripe service', { limit: 10 });
    expect(strong.lowConfidence).toBe(false);
  });

  it('confidence floor (SC-Confidence): a thin context-only token collision IS lowConfidence', async () => {
    seed(db);
    // "handles" appears only in the low-weighted `context` column of a few nodes — a thin collision,
    // no name/identifier hit. The lexical bm25 floor (T1.8) must flag it.
    const thin = await runAnchorSearch(db, 'handles', { limit: 10 });
    expect(thin.results.length).toBeGreaterThan(0);
    expect(thin.lowConfidence).toBe(true);
  });

  it('reports accurate refusal coverage on a non-overlay refusal over a populated index', async () => {
    seed(db);
    // An invalid-query refusal fires even though the index is populated. The coverage the CLI/MCP
    // refusal envelope carries (anchorRefusalCoverage) must reflect the real anchor-viable count, not
    // a hardcoded 0 — the frozen schemaVersion:1 `coverage` field would otherwise state a falsehood.
    await expect(runAnchorSearch(db, '   ', { limit: 10 })).rejects.toMatchObject({
      reason: 'invalid-query',
    });
    expect(anchorRefusalCoverage(db)).toEqual({
      embeddedNodes: 0,
      anchorViableNodes: SEED.length,
      model: null,
    });
  });

  it('reports a genuine zero refusal coverage on a never-built index (overlay-missing)', async () => {
    // No seed: overlay-missing. The count probe is still safe (autoMigrate keeps the table present)
    // and correctly reports 0 anchor-viable nodes.
    await expect(runAnchorSearch(db, 'stripe service', { limit: 10 })).rejects.toMatchObject({
      reason: 'overlay-missing',
    });
    expect(anchorRefusalCoverage(db)).toEqual({
      embeddedNodes: 0,
      anchorViableNodes: 0,
      model: null,
    });
  });
});
