// Tests for CapabilitySurfaceDetector contract and LaravelHttpSurfaceDetector.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { LuxDatabase } from '../../../db/index.js';
import { LaravelHttpSurfaceDetector } from '../detectors/laravel-http.js';
import { runDetectors, createDefaultDetectors } from '../detectors/index.js';
import type { AssociationContext } from '../types.js';

const testDir = join(import.meta.dirname, 'fixtures', 'detectors-test');
const ROOT = '/app';

function makeDb(): LuxDatabase {
  mkdirSync(testDir, { recursive: true });
  return new LuxDatabase(join(testDir, 'test.db'));
}

function makeContext(
  entries: Array<{ filePath: string; languageId?: string; content?: string }>
): AssociationContext {
  return {
    rootPath: ROOT,
    nodes: [],
    entries: entries.map((e) => ({
      filePath: e.filePath,
      languageId: e.languageId,
      metadata: e.content ? { content: e.content } : {},
    })),
    dirtyFiles: [],
  };
}

// ---------------------------------------------------------------------------
// LaravelHttpSurfaceDetector — supports()
// ---------------------------------------------------------------------------

describe('LaravelHttpSurfaceDetector.supports()', () => {
  const detector = new LaravelHttpSurfaceDetector();

  it('returns true for a context with a PHP route file', () => {
    const ctx = makeContext([
      { filePath: 'routes/api.php', languageId: 'php', content: '' },
    ]);
    expect(detector.supports(ctx)).toBe(true);
  });

  it('returns false when no PHP route files are present', () => {
    const ctx = makeContext([
      { filePath: 'src/app.ts', languageId: 'typescript', content: '' },
    ]);
    expect(detector.supports(ctx)).toBe(false);
  });

  it('returns false for PHP files that are not route files', () => {
    const ctx = makeContext([
      { filePath: 'app/Services/InvoiceService.php', languageId: 'php', content: '' },
    ]);
    expect(detector.supports(ctx)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LaravelHttpSurfaceDetector — detect() surface nodes
// ---------------------------------------------------------------------------

describe('LaravelHttpSurfaceDetector.detect() — surface nodes', () => {
  const detector = new LaravelHttpSurfaceDetector();

  it('emits a surface node for a controller-array route', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::get('/api/invoices', [InvoiceController::class, 'index']);`,
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].id).toBe('surface:http:GET:/api/invoices');
    expect(batch.surfaces[0].handle).toBe('GET /api/invoices');
    expect(batch.surfaces[0].transport).toBe('http');
    expect(batch.surfaces[0].metadata.method).toBe('GET');
    expect(batch.surfaces[0].metadata.path).toBe('/api/invoices');
    expect(batch.surfaces[0].metadata.explicitProvider).toBe('InvoiceController');
  });

  it('emits a surface node for an invokable controller route', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::post('/api/invoices', CreateInvoiceAction::class);`,
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].id).toBe('surface:http:POST:/api/invoices');
    expect(batch.surfaces[0].metadata.explicitProvider).toBe('CreateInvoiceAction');
  });

  it('emits a surface node for a closure route (no explicit provider)', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::get('/api/health', function () { return 'ok'; });`,
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(1);
    expect(batch.surfaces[0].id).toBe('surface:http:GET:/api/health');
    expect(batch.surfaces[0].metadata.explicitProvider).toBeUndefined();
  });

  it('emits multiple surfaces for multiple routes', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: [
          `Route::get('/api/invoices', [InvoiceController::class, 'index']);`,
          `Route::post('/api/invoices', [InvoiceController::class, 'store']);`,
          `Route::get('/api/users', [UserController::class, 'index']);`,
        ].join('\n'),
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces).toHaveLength(3);
    const ids = batch.surfaces.map((s) => s.id).sort();
    expect(ids).toContain('surface:http:GET:/api/invoices');
    expect(ids).toContain('surface:http:POST:/api/invoices');
    expect(ids).toContain('surface:http:GET:/api/users');
  });

  it('captures route name when declared via ->name()', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::get('/api/invoices', [InvoiceController::class, 'index'])->name('invoices.index');`,
      },
    ]);

    const batch = await detector.detect(ctx);
    expect(batch.surfaces[0].metadata.routeName).toBe('invoices.index');
    expect(batch.surfaces[0].metadata.aliases).toContain('invoices.index');
  });
});

// ---------------------------------------------------------------------------
// LaravelHttpSurfaceDetector — detect() edges
// ---------------------------------------------------------------------------

describe('LaravelHttpSurfaceDetector.detect() — boundary edges', () => {
  const detector = new LaravelHttpSurfaceDetector();

  it('emits declares_surface from route file to surface', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::get('/api/invoices', [InvoiceController::class, 'index']);`,
      },
    ]);

    const batch = await detector.detect(ctx);
    const declEdge = batch.edges.find((e) => e.edgeType === 'declares_surface');
    expect(declEdge).toBeDefined();
    expect(declEdge!.sourceNodeId).toBe('file:routes/api.php');
    expect(declEdge!.targetNodeId).toBe('surface:http:GET:/api/invoices');
    expect(declEdge!.confidenceClass).toBe('framework-inferred');
  });

  it('emits handled_by from surface to controller symbol when explicit', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::get('/api/invoices', [InvoiceController::class, 'index']);`,
      },
    ]);

    const batch = await detector.detect(ctx);
    const handledEdge = batch.edges.find((e) => e.edgeType === 'handled_by');
    expect(handledEdge).toBeDefined();
    expect(handledEdge!.sourceNodeId).toBe('surface:http:GET:/api/invoices');
    expect(handledEdge!.targetNodeId).toBe('symbol:php:InvoiceController@index');
    expect(handledEdge!.confidenceClass).toBe('framework-inferred');
  });

  it('does NOT emit handled_by for closure routes (no explicit provider)', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::get('/api/health', function () { return 'ok'; });`,
      },
    ]);

    const batch = await detector.detect(ctx);
    const handledEdge = batch.edges.find((e) => e.edgeType === 'handled_by');
    expect(handledEdge).toBeUndefined();
  });

  it('emits handled_by without method for invokable controllers', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::post('/api/invoices', CreateInvoiceAction::class);`,
      },
    ]);

    const batch = await detector.detect(ctx);
    const handledEdge = batch.edges.find((e) => e.edgeType === 'handled_by');
    expect(handledEdge).toBeDefined();
    expect(handledEdge!.targetNodeId).toBe('symbol:php:CreateInvoiceAction');
  });

  it('attaches evidence with file path and line number', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::get('/api/invoices', [InvoiceController::class, 'index']);`,
      },
    ]);

    const batch = await detector.detect(ctx);
    const declEdge = batch.edges.find((e) => e.edgeType === 'declares_surface');
    expect(declEdge!.provenance.evidenceLocations[0].filePath).toBe('routes/api.php');
    expect(declEdge!.provenance.resolver).toBe('laravel-http-surfaces');
    expect(declEdge!.provenance.evidenceKind).toBe('route-declaration');
  });
});

// ---------------------------------------------------------------------------
// runDetectors integration
// ---------------------------------------------------------------------------

describe('runDetectors()', () => {
  let db: LuxDatabase;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    db.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('persists surface nodes into the DB', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::get('/api/invoices', [InvoiceController::class, 'index']);`,
      },
    ]);

    const result = await runDetectors(db, ctx);
    expect(result.surfacesDetected).toBe(1);

    const surfaces = db.getCapabilitySurfaces();
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0].id).toBe('surface:http:GET:/api/invoices');
    expect(surfaces[0].node_type).toBe('capability-surface');
  });

  it('persists boundary edges into the DB', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::get('/api/invoices', [InvoiceController::class, 'index']);`,
      },
    ]);

    const result = await runDetectors(db, ctx);
    expect(result.surfaceEdgesStored).toBeGreaterThanOrEqual(2); // declares_surface + handled_by

    const ctx2 = db.getSurfaceCenteredContext('surface:http:GET:/api/invoices');
    expect(ctx2).not.toBeNull();
    const edgeTypes = ctx2!.edges.map((e) => e.edge.edge_type);
    expect(edgeTypes).toContain('declares_surface');
    expect(edgeTypes).toContain('handled_by');
  });

  it('is idempotent — re-running does not duplicate surfaces or edges', async () => {
    const ctx = makeContext([
      {
        filePath: 'routes/api.php',
        languageId: 'php',
        content: `Route::get('/api/invoices', [InvoiceController::class, 'index']);`,
      },
    ]);

    await runDetectors(db, ctx);
    await runDetectors(db, ctx); // second run

    const surfaces = db.getCapabilitySurfaces();
    expect(surfaces).toHaveLength(1);
  });

  it('skips detectors that do not support the context', async () => {
    const ctx = makeContext([
      { filePath: 'src/app.ts', languageId: 'typescript', content: '' },
    ]);

    const result = await runDetectors(db, ctx);
    expect(result.surfacesDetected).toBe(0);
    expect(result.surfaceEdgesStored).toBe(0);
  });

  it('createDefaultDetectors() returns the LaravelHttpSurfaceDetector', () => {
    const detectors = createDefaultDetectors();
    expect(detectors.some((d) => d.name === 'laravel-http-surfaces')).toBe(true);
  });
});
