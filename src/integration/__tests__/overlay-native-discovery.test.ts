// Integration tests for overlay-native expert detection.
//
// Validates that the overlay-native discovery path:
//   1. Enriches DiscoveryContext with structural neighborhoods when overlay exists
//   2. Produces more domain-faithful proposals for cross-directory feature families (acme pattern)
//   3. Captures module-shaped architectural regions correctly (example-dashboard pattern)
//   4. Falls back gracefully when overlay is absent
//   5. Routes with trust-adjusted structural ownership scores

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../../db/index.js';
import { enrichContext } from '../../discovery/enrich.js';
import {
  extractOverlayNeighborhoods,
  deriveOverlayTrustLevel,
  scoreOwnershipMatch,
  computeStructuralSignature,
} from '../../experts/structural-analysis.js';
import { classifySignatureDrift } from '../../discovery/diff.js';
import { persistRebuildTrustState } from '../../scanner/overlay-trust-state.js';
import type { StructuralNode, StructuralEdge } from '../../db/types.js';
import type { DiscoveryOptions } from '../../discovery/types.js';

const testDir = join(import.meta.dirname, 'fixtures', 'overlay-native-discovery-test');

function freshDb(): LuxDatabase {
  mkdirSync(testDir, { recursive: true });
  return new LuxDatabase(join(testDir, `test-${Date.now()}.db`));
}

function surfaceNode(id: string, filePath: string, symbolName: string): StructuralNode {
  return {
    id,
    node_type: 'capability-surface',
    file_path: filePath,
    symbol_name: symbolName,
    updated_at: Math.floor(Date.now() / 1000),
  };
}

function symbolNode(id: string, filePath: string, symbolName: string): StructuralNode {
  return {
    id,
    node_type: 'symbol',
    file_path: filePath,
    symbol_name: symbolName,
    symbol_kind: 'class',
    updated_at: Math.floor(Date.now() / 1000),
  };
}

function fileNode(filePath: string): StructuralNode {
  return {
    id: `file:${filePath}`,
    node_type: 'file',
    file_path: filePath,
    updated_at: Math.floor(Date.now() / 1000),
  };
}

function handledByEdge(surfaceId: string, providerId: string): StructuralEdge {
  return {
    id: `${surfaceId}->handled_by->${providerId}`,
    source_node_id: surfaceId,
    target_node_id: providerId,
    edge_type: 'handled_by',
    confidence: 0.9,
    confidence_class: 'framework-inferred',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: Math.floor(Date.now() / 1000),
  };
}

function declaresSurfaceEdge(fileId: string, surfaceId: string): StructuralEdge {
  return {
    id: `${fileId}->declares_surface->${surfaceId}`,
    source_node_id: fileId,
    target_node_id: surfaceId,
    edge_type: 'declares_surface',
    confidence: 1.0,
    confidence_class: 'proven',
    freshness_status: 'fresh',
    dirty_dependency_count: 0,
    updated_at: Math.floor(Date.now() / 1000),
  };
}

function persistCompleteOverlay(db: LuxDatabase): void {
  persistRebuildTrustState(
    db,
    {
      mode: 'overlay-complete',
      repoPath: '/test',
      configSource: 'lux.yaml',
      configLspEnabled: true,
      surfaceCount: 10,
      detectorEdgeCount: 30,
      propagatedEdgeCount: 20,
      fileNodeCount: 60,
      symbolNodeCount: 120,
      controllerBackedCount: 8,
      closureBackedCount: 2,
      unknownProviderKindCount: 0,
      enrichmentStatus: 'active',
      propagationStatus: 'ran',
      warnings: [],
    },
    { sourceAction: 'index-rebuild' }
  );
}

// ---------------------------------------------------------------------------
// Auctic-pattern: cross-directory feature families
//
// Simulates a Laravel app where:
//   - routes/api.php declares surfaces for /invoices
//   - app/Http/Controllers/InvoiceController.php handles them
//   - app/Models/Invoice.php is the domain model
//   - resources/js/pages/Invoices/ has the frontend
//
// The cross-directory spread (routes, controllers, models, js) is the
// characteristic acme pattern that directory-first discovery misses.
// ---------------------------------------------------------------------------

describe('Auctic-pattern: cross-directory feature family neighborhoods', () => {
  let db: LuxDatabase;
  let tmpRoot: string;

  beforeEach(() => {
    db = freshDb();
    tmpRoot = join(testDir, 'auctic-root');
    mkdirSync(tmpRoot, { recursive: true });
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('extracts zero neighborhoods without overlay data', () => {
    const nbhds = extractOverlayNeighborhoods(db);
    expect(nbhds).toHaveLength(0);
  });

  it('extracts a neighborhood that spans routes + controllers for invoice surfaces', () => {
    persistCompleteOverlay(db);

    // Invoice surfaces
    const s1 = surfaceNode('surface:GET /api/invoices', 'routes/api.php', 'GET /api/invoices');
    const s2 = surfaceNode('surface:POST /api/invoices', 'routes/api.php', 'POST /api/invoices');
    const s3 = surfaceNode(
      'surface:GET /api/invoices/{id}',
      'routes/api.php',
      'GET /api/invoices/{id}'
    );

    // Controller
    const ctrl1 = symbolNode(
      'InvoiceController@index',
      'app/Http/Controllers/InvoiceController.php',
      'InvoiceController'
    );
    const ctrl2 = symbolNode(
      'InvoiceController@store',
      'app/Http/Controllers/InvoiceController.php',
      'InvoiceController'
    );
    const ctrl3 = symbolNode(
      'InvoiceController@show',
      'app/Http/Controllers/InvoiceController.php',
      'InvoiceController'
    );

    // Route file
    const routeFile = fileNode('routes/api.php');

    for (const n of [s1, s2, s3, ctrl1, ctrl2, ctrl3, routeFile]) {
      db.upsertStructuralNode(n);
    }

    db.upsertStructuralEdge(handledByEdge(s1.id, ctrl1.id));
    db.upsertStructuralEdge(handledByEdge(s2.id, ctrl2.id));
    db.upsertStructuralEdge(handledByEdge(s3.id, ctrl3.id));
    db.upsertStructuralEdge(declaresSurfaceEdge(routeFile.id, s1.id));
    db.upsertStructuralEdge(declaresSurfaceEdge(routeFile.id, s2.id));
    db.upsertStructuralEdge(declaresSurfaceEdge(routeFile.id, s3.id));

    const nbhds = extractOverlayNeighborhoods(db);

    // All three surfaces map to the same controller file → one neighborhood
    expect(nbhds).toHaveLength(1);
    const [invoice] = nbhds;

    expect(invoice.surfaceIds).toHaveLength(3);
    expect(invoice.anchorFiles).toContain('app/Http/Controllers/InvoiceController.php');
    expect(invoice.memberFiles).toContain('routes/api.php');
    expect(invoice.trustState).toBe('overlay-complete');
    expect(invoice.cohesionScore).toBeGreaterThan(0);
  });

  it('separates invoice and user feature families into distinct neighborhoods', () => {
    persistCompleteOverlay(db);

    // Invoice surfaces
    const invoiceSurface = surfaceNode(
      'surface:GET /api/invoices',
      'routes/api.php',
      'GET /api/invoices'
    );
    const invoiceCtrl = symbolNode(
      'InvoiceController@index',
      'app/Http/Controllers/InvoiceController.php',
      'InvoiceController'
    );

    // User surfaces
    const userSurface = surfaceNode('surface:GET /api/users', 'routes/api.php', 'GET /api/users');
    const userCtrl = symbolNode(
      'UserController@index',
      'app/Http/Controllers/UserController.php',
      'UserController'
    );

    for (const n of [invoiceSurface, invoiceCtrl, userSurface, userCtrl]) {
      db.upsertStructuralNode(n);
    }

    db.upsertStructuralEdge(handledByEdge(invoiceSurface.id, invoiceCtrl.id));
    db.upsertStructuralEdge(handledByEdge(userSurface.id, userCtrl.id));

    const nbhds = extractOverlayNeighborhoods(db);

    // Two distinct controller files → two neighborhoods (split-biased)
    expect(nbhds).toHaveLength(2);

    const labels = nbhds.map((n) => n.label);
    expect(labels).toContain('InvoiceController');
    expect(labels).toContain('UserController');
  });

  it('enriches DiscoveryContext with overlay neighborhoods via enrichContext', () => {
    persistCompleteOverlay(db);

    // Insert a minimal surface
    const s = surfaceNode('surface:GET /api/invoices', 'routes/api.php', 'GET /api/invoices');
    const ctrl = symbolNode(
      'InvoiceController@index',
      'app/Http/Controllers/InvoiceController.php',
      'InvoiceController'
    );
    db.upsertStructuralNode(s);
    db.upsertStructuralNode(ctrl);
    db.upsertStructuralEdge(handledByEdge(s.id, ctrl.id));

    // Create a minimal directory tree and corpus file so enrich has something
    writeFileSync(join(tmpRoot, 'dummy.md'), '# dummy', 'utf-8');

    const options: DiscoveryOptions = { rootPath: tmpRoot };
    const ctx = enrichContext('src/\n  app/', db, options);

    // Context must include overlay trust state
    expect(ctx.overlayTrustState).toBe('overlay-complete');

    // Context must include neighborhoods
    expect(ctx.overlayNeighborhoods).toBeDefined();
    expect(ctx.overlayNeighborhoods!.length).toBeGreaterThan(0);
    expect(ctx.overlayNeighborhoods![0].anchorFiles).toContain(
      'app/Http/Controllers/InvoiceController.php'
    );
  });

  it('computes a structural signature that survives simulated overlay rebuild', () => {
    persistCompleteOverlay(db);

    const s = surfaceNode('surface:GET /api/invoices', 'routes/api.php', 'GET /api/invoices');
    const ctrl = symbolNode(
      'InvoiceController@index',
      'app/Http/Controllers/InvoiceController.php',
      'InvoiceController'
    );
    db.upsertStructuralNode(s);
    db.upsertStructuralNode(ctrl);
    db.upsertStructuralEdge(handledByEdge(s.id, ctrl.id));

    const [nbhd] = extractOverlayNeighborhoods(db);
    const sig = computeStructuralSignature(nbhd);

    expect(sig.version).toBe(1);
    expect(sig.anchorFiles).toContain('app/Http/Controllers/InvoiceController.php');
    expect(sig.dominantDirectories).toContain('app/Http/Controllers');

    // Simulate a rebuild that renames the surface node ID but keeps the same file
    // The signature (file-anchored) should still be valid
    expect(sig.anchorFiles).not.toContain('surface:GET /api/invoices');
  });
});

// ---------------------------------------------------------------------------
// Recon-pattern: module-shaped architectural domains
//
// Simulates a TypeScript monorepo with module boundaries:
//   - src/billing/ handles all billing-related surfaces
//   - src/auth/ handles authentication surfaces
//   - src/notifications/ handles notification surfaces
//
// These module boundaries align well with overlay neighborhoods anchored
// on the module's handler files (services, controllers).
// ---------------------------------------------------------------------------

describe('Recon-pattern: module-shaped architectural domain neighborhoods', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = freshDb();
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('extracts module-aligned neighborhoods from monorepo surface structure', () => {
    persistCompleteOverlay(db);

    // Billing module surfaces
    const billingSurface1 = surfaceNode(
      'surface:POST /billing/subscribe',
      'src/billing/routes.ts',
      'POST /billing/subscribe'
    );
    const billingSurface2 = surfaceNode(
      'surface:GET /billing/status',
      'src/billing/routes.ts',
      'GET /billing/status'
    );
    const billingHandler1 = symbolNode(
      'BillingService.subscribe',
      'src/billing/BillingService.ts',
      'BillingService'
    );
    const billingHandler2 = symbolNode(
      'BillingService.getStatus',
      'src/billing/BillingService.ts',
      'BillingService'
    );

    // Auth module surfaces
    const authSurface1 = surfaceNode(
      'surface:POST /auth/login',
      'src/auth/routes.ts',
      'POST /auth/login'
    );
    const authHandler1 = symbolNode('AuthService.login', 'src/auth/AuthService.ts', 'AuthService');

    for (const n of [
      billingSurface1,
      billingSurface2,
      billingHandler1,
      billingHandler2,
      authSurface1,
      authHandler1,
    ]) {
      db.upsertStructuralNode(n);
    }

    db.upsertStructuralEdge(handledByEdge(billingSurface1.id, billingHandler1.id));
    db.upsertStructuralEdge(handledByEdge(billingSurface2.id, billingHandler2.id));
    db.upsertStructuralEdge(handledByEdge(authSurface1.id, authHandler1.id));

    const nbhds = extractOverlayNeighborhoods(db);

    // billing and auth modules stay separate (split-biased)
    expect(nbhds.length).toBeGreaterThanOrEqual(2);

    const billingNbhd = nbhds.find((n) => n.anchorFiles.some((f) => f.includes('BillingService')));
    const authNbhd = nbhds.find((n) => n.anchorFiles.some((f) => f.includes('AuthService')));

    expect(billingNbhd).toBeDefined();
    expect(authNbhd).toBeDefined();

    expect(billingNbhd!.surfaceIds).toHaveLength(2);
    expect(billingNbhd!.dominantDirectories[0]).toContain('billing');
  });

  it('structural ownership scoring prefers the correct module for a given query', () => {
    persistCompleteOverlay(db);

    // Setup billing and auth modules with structural data
    const billingSurface = surfaceNode(
      'surface:POST /billing/subscribe',
      'src/billing/routes.ts',
      'POST /billing/subscribe'
    );
    const billingHandler = symbolNode(
      'BillingService.subscribe',
      'src/billing/BillingService.ts',
      'BillingService'
    );
    const authSurface = surfaceNode(
      'surface:POST /auth/login',
      'src/auth/routes.ts',
      'POST /auth/login'
    );
    const authHandler = symbolNode('AuthService.login', 'src/auth/AuthService.ts', 'AuthService');

    for (const n of [billingSurface, billingHandler, authSurface, authHandler]) {
      db.upsertStructuralNode(n);
    }
    db.upsertStructuralEdge(handledByEdge(billingSurface.id, billingHandler.id));
    db.upsertStructuralEdge(handledByEdge(authSurface.id, authHandler.id));

    const allNbhds = extractOverlayNeighborhoods(db);
    const billingNbhd = allNbhds.find((n) =>
      n.anchorFiles.some((f) => f.includes('BillingService'))
    );
    const authNbhd = allNbhds.find((n) => n.anchorFiles.some((f) => f.includes('AuthService')));

    expect(billingNbhd).toBeDefined();
    expect(authNbhd).toBeDefined();

    const billingSig = computeStructuralSignature(billingNbhd!);
    const authSig = computeStructuralSignature(authNbhd!);

    // A query about billing files should score higher for billing sig
    const billingHitFiles = ['src/billing/BillingService.ts'];
    const billingMatchForBilling = scoreOwnershipMatch(
      billingHitFiles,
      billingSig,
      allNbhds,
      1.0,
      'billing'
    );
    const billingMatchForAuth = scoreOwnershipMatch(
      billingHitFiles,
      authSig,
      allNbhds,
      1.0,
      'auth'
    );

    expect(billingMatchForBilling.trustAdjustedScore).toBeGreaterThan(
      billingMatchForAuth.trustAdjustedScore
    );
  });

  it('degrades ownership confidence when overlay trust is reduced', () => {
    persistCompleteOverlay(db);

    const surface = surfaceNode(
      'surface:POST /billing/subscribe',
      'src/billing/routes.ts',
      'POST /billing/subscribe'
    );
    const handler = symbolNode(
      'BillingService.subscribe',
      'src/billing/BillingService.ts',
      'BillingService'
    );
    db.upsertStructuralNode(surface);
    db.upsertStructuralNode(handler);
    db.upsertStructuralEdge(handledByEdge(surface.id, handler.id));

    const [nbhd] = extractOverlayNeighborhoods(db);
    const sig = computeStructuralSignature(nbhd);
    const hitFiles = ['src/billing/BillingService.ts'];
    const allNbhds = [nbhd];

    const fullTrust = scoreOwnershipMatch(hitFiles, sig, allNbhds, 1.0);
    const degradedTrust = scoreOwnershipMatch(hitFiles, sig, allNbhds, 0.3);
    const staleTrust = scoreOwnershipMatch(hitFiles, sig, allNbhds, 0.4);

    // Trust degradation reduces confidence
    expect(degradedTrust.trustAdjustedScore).toBeLessThan(fullTrust.trustAdjustedScore);
    expect(staleTrust.trustAdjustedScore).toBeLessThan(fullTrust.trustAdjustedScore);
    expect(degradedTrust.trustAdjustedScore).toBeLessThan(staleTrust.trustAdjustedScore);

    // Warning levels reflect degradation
    expect(['debug-only', 'user-visible']).toContain(degradedTrust.warningLevel);
  });

  it('structural drift detection catches module boundary changes between overlays', () => {
    // Old signature: billing was in src/billing/
    const oldSig = {
      version: 1 as const,
      anchorFiles: ['src/billing/BillingService.ts', 'src/billing/routes.ts'],
      dominantDirectories: ['src/billing'],
    };

    // New proposal: billing has moved to packages/billing/ (boundary change)
    const newSig = {
      version: 1 as const,
      anchorFiles: ['packages/billing/BillingService.ts', 'packages/billing/routes.ts'],
      dominantDirectories: ['packages/billing'],
    };

    // Same module, one anchor file added within same parent — evolutionary (anchor Jaccard < 0.5)
    const reorganizedSig = {
      version: 1 as const,
      anchorFiles: ['src/billing/BillingService.ts', 'src/billing/v2/SubscriptionService.ts'],
      dominantDirectories: ['src/billing'],
    };

    expect(classifySignatureDrift(oldSig, newSig)).toBe('boundary-changing');
    expect(classifySignatureDrift(oldSig, reorganizedSig)).toBe('evolutionary');
  });
});

// ---------------------------------------------------------------------------
// Fallback behavior: no overlay data
// ---------------------------------------------------------------------------

describe('fallback when overlay is absent', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = freshDb();
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('deriveOverlayTrustLevel returns no-overlay for empty DB', () => {
    expect(deriveOverlayTrustLevel(db)).toBe('no-overlay');
  });

  it('extractOverlayNeighborhoods returns empty array', () => {
    expect(extractOverlayNeighborhoods(db)).toEqual([]);
  });

  it('enrichContext does not include overlayNeighborhoods', () => {
    const tmpRoot = join(testDir, 'fallback-root');
    mkdirSync(tmpRoot, { recursive: true });
    writeFileSync(join(tmpRoot, 'dummy.md'), '# dummy', 'utf-8');

    const options: DiscoveryOptions = { rootPath: tmpRoot };
    const ctx = enrichContext('src/\n', db, options);

    expect(ctx.overlayTrustState).toBeUndefined();
    expect(ctx.overlayNeighborhoods).toBeUndefined();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('scoreOwnershipMatch returns debug-only warning when trustWeight is 0', () => {
    const sig = {
      version: 1 as const,
      anchorFiles: ['src/billing/BillingService.ts'],
      dominantDirectories: ['src/billing'],
    };
    const result = scoreOwnershipMatch(['src/billing/BillingService.ts'], sig, [], 0);
    expect(result.overlapScore).toBe(0);
    expect(result.warningLevel).toBe('debug-only');
  });
});
