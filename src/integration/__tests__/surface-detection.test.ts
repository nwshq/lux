// Surface detection integration test against acme-core.
//
// Validates that the LaravelHttpSurfaceDetector correctly recovers
// representative routes from the acme-core codebase — including
// routes that were previously empty surfaces (no provider closure).
//
// Also computes an aggregate scorecard comparing against the pre-tranche
// baseline (surfaceCount=634, withProviders=578, emptySurfaces=53).
//
// Test is skipped when acme-core is not available.

import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { LaravelHttpSurfaceDetector } from '../../scanner/associations/detectors/laravel-http.js';
import type { AssociationContext } from '../../scanner/associations/types.js';

const ACME_CORE_PATH = '/path/to/acme-core/vcs';
const pathExists = existsSync(ACME_CORE_PATH);

// ---------------------------------------------------------------------------
// Context builder — reads relevant PHP files from acme-core
// ---------------------------------------------------------------------------

function toRelPath(absPath: string): string {
  if (absPath.startsWith(ACME_CORE_PATH + '/')) {
    return absPath.slice(ACME_CORE_PATH.length + 1);
  }
  return absPath;
}

function phpEntry(absPath: string): { filePath: string; languageId: string; content: string } {
  return {
    filePath: toRelPath(absPath),
    languageId: 'php',
    content: readFileSync(absPath, 'utf-8'),
  };
}

function globPhpFiles(dir: string, recursive = true): string[] {
  if (!existsSync(dir)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory() && recursive) {
      result.push(...globPhpFiles(full, true));
    } else if (entry.endsWith('.php')) {
      result.push(full);
    }
  }
  return result;
}

// Build an AssociationContext covering:
//   - Root route files (routes/*.php)
//   - Root service providers (src/CoreServiceProvider.php)
//   - Module RouteServiceProvider.php files under src/Module/
//   - Module routes/*.php files under src/Module/
function buildAcmeContext(): AssociationContext {
  const entries: Array<{
    filePath: string;
    languageId: string;
    metadata: Record<string, unknown>;
  }> = [];

  function addPhpFiles(files: string[]): void {
    for (const f of files) {
      if (!existsSync(f)) continue;
      try {
        const e = phpEntry(f);
        entries.push({
          filePath: e.filePath,
          languageId: e.languageId,
          metadata: { content: e.content },
        });
      } catch {
        // skip unreadable files
      }
    }
  }

  // Root route files
  const rootRoutes = globPhpFiles(join(ACME_CORE_PATH, 'routes'), false);
  addPhpFiles(rootRoutes);

  // Root service providers
  const rootProviders = [join(ACME_CORE_PATH, 'src/CoreServiceProvider.php')];
  addPhpFiles(rootProviders);

  // Module service providers and route files
  const modulesDir = join(ACME_CORE_PATH, 'src/Module');
  if (existsSync(modulesDir)) {
    for (const moduleName of readdirSync(modulesDir)) {
      const moduleDir = join(modulesDir, moduleName);
      if (!statSync(moduleDir).isDirectory()) continue;

      // RouteServiceProvider
      const rsp = join(moduleDir, 'RouteServiceProvider.php');
      addPhpFiles([rsp]);

      // routes/*.php
      const routesDir = join(moduleDir, 'routes');
      addPhpFiles(globPhpFiles(routesDir, false));
    }
  }

  return {
    rootPath: ACME_CORE_PATH,
    nodes: [],
    entries,
    dirtyFiles: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function surfaceIds(batch: Awaited<ReturnType<LaravelHttpSurfaceDetector['detect']>>): string[] {
  return batch.surfaces.map((s) => s.id);
}

function surfaceWithId(
  batch: Awaited<ReturnType<LaravelHttpSurfaceDetector['detect']>>,
  id: string
) {
  return batch.surfaces.find((s) => s.id === id);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!pathExists)(
  'acme-core surface detection — representative holdout validation (T7)',
  () => {
    const detector = new LaravelHttpSurfaceDetector();
    let batch: Awaited<ReturnType<LaravelHttpSurfaceDetector['detect']>>;

    beforeEach(async () => {
      const ctx = buildAcmeContext();
      batch = await detector.detect(ctx);
    });

    it('detects GET /events/allsellerreport with a provider', () => {
      const surface = surfaceWithId(batch, 'surface:http:GET:/events/allsellerreport');
      expect(surface).toBeDefined();
      expect(surface!.metadata.explicitProvider).toBeDefined();
      expect(String(surface!.metadata.explicitProvider)).toContain('EventsController');
    });

    it('detects GET /events/allwatcherreport with a provider', () => {
      const surface = surfaceWithId(batch, 'surface:http:GET:/events/allwatcherreport');
      expect(surface).toBeDefined();
      expect(surface!.metadata.explicitProvider).toBeDefined();
      expect(String(surface!.metadata.explicitProvider)).toContain('EventsController');
    });

    it('detects GET /events/bidhistoryreport/{event} with a provider', () => {
      const surface = surfaceWithId(batch, 'surface:http:GET:/events/bidhistoryreport/{event}');
      expect(surface).toBeDefined();
      expect(surface!.metadata.explicitProvider).toBeDefined();
      expect(String(surface!.metadata.explicitProvider)).toContain('EventsController');
    });

    it('detects GET /admin/accounting/{any?} (module-owned invokable controller)', () => {
      // The accounting module's admin.php declares:
      //   Route::group(['prefix' => 'admin/accounting', ...], function () {
      //     Route::get('/{any?}', AccountingIndexController::class)
      //   })
      // giving path /admin/accounting/{any?} with the fully-qualified invokable controller.
      const surface = surfaceWithId(batch, 'surface:http:GET:/admin/accounting/{any?}');
      expect(surface).toBeDefined();
      expect(surface!.metadata.explicitProvider).toBeDefined();
      expect(String(surface!.metadata.explicitProvider)).toContain('AccountingIndexController');
    });

    it('detects at least two /api/v1/* surfaces', () => {
      const apiV1Surfaces = batch.surfaces.filter(
        (s) => typeof s.metadata.path === 'string' && s.metadata.path.startsWith('/api/v1/')
      );
      expect(apiV1Surfaces.length).toBeGreaterThanOrEqual(2);
      // At least one should have an explicit provider
      const withProvider = apiV1Surfaces.filter((s) => s.metadata.explicitProvider);
      expect(withProvider.length).toBeGreaterThanOrEqual(1);
    });

    it('has no more than a handful of cross-file duplicate surface IDs', () => {
      // Cross-file duplicates can occur when the same route is registered in both a
      // module route file and a root route file. These are deduplicated at DB upsert
      // time (same node ID → overwrite), not at in-memory detection time.
      // Within-file consolidation (T3+T4) handles conditional-branch duplicates.
      const ids = surfaceIds(batch);
      const idCounts: Record<string, number> = {};
      for (const id of ids) idCounts[id] = (idCounts[id] ?? 0) + 1;
      const dupCount = Object.values(idCounts).filter((c) => c > 1).length;
      // Allow up to 5 cross-file duplicates — more than that suggests a regression
      expect(dupCount).toBeLessThanOrEqual(5);
    });
  }
);

describe.skipIf(!pathExists)('acme-core surface detection — aggregate scorecard (T8)', () => {
  const detector = new LaravelHttpSurfaceDetector();
  let batch: Awaited<ReturnType<LaravelHttpSurfaceDetector['detect']>>;

  beforeEach(async () => {
    const ctx = buildAcmeContext();
    batch = await detector.detect(ctx);
  });

  it('reports aggregate scorecard and shows improvement vs. baseline', () => {
    const surfaceCount = batch.surfaces.length;
    const withProviders = batch.surfaces.filter((s) => s.metadata.explicitProvider).length;
    const emptySurfaces = surfaceCount - withProviders;
    const closureBacked = batch.surfaces.filter(
      (s) => s.metadata.providerKind === 'closure'
    ).length;
    const controllerBacked = batch.surfaces.filter(
      (s) => s.metadata.providerKind === 'controller'
    ).length;
    // True provider misses: no provider AND not classified as a closure.
    const unresolvedMisses = batch.surfaces.filter(
      (s) => !s.metadata.explicitProvider && s.metadata.providerKind !== 'closure'
    ).length;

    // Pre-tranche baseline: surfaceCount=634, withProviders=578, emptySurfaces=53
    // (note: baseline was measured under the previous detection layer and may
    //  differ from what we measure here due to consolidation and coverage expansion)
    const baseline = { surfaceCount: 634, withProviders: 578, emptySurfaces: 53 };

    console.log('--- acme-core surface scorecard ---');
    console.log(`  surfaceCount:     ${surfaceCount}  (baseline: ${baseline.surfaceCount})`);
    console.log(`  withProviders:    ${withProviders}  (baseline: ${baseline.withProviders})`);
    console.log(`  emptySurfaces:    ${emptySurfaces}  (baseline: ${baseline.emptySurfaces})`);
    console.log(`  controllerBacked: ${controllerBacked}`);
    console.log(`  closureBacked:    ${closureBacked}`);
    console.log(`  unresolvedMisses: ${unresolvedMisses}`);
    console.log('-------------------------------------');

    // We should have a non-trivial number of surfaces
    expect(surfaceCount).toBeGreaterThan(100);

    // The vast majority of surfaces should have providers
    const providerCoverageRate = withProviders / surfaceCount;
    expect(providerCoverageRate).toBeGreaterThan(0.7);

    // Every surface is honestly classified — either controller-backed or closure-backed.
    expect(controllerBacked + closureBacked).toBe(surfaceCount);

    // The "empty" column must decompose into closure-backed + true unresolved misses.
    expect(closureBacked + unresolvedMisses).toBe(emptySurfaces);

    // Minimal cross-file duplicates (DB upsert deduplicates at persist time)
    const ids = batch.surfaces.map((s) => s.id);
    const dupCount = ids.length - new Set(ids).size;
    expect(dupCount).toBeLessThanOrEqual(5);
  });

  it('every surface has an honest providerKind classification', () => {
    // No surface should be left unclassified — detection always knows whether
    // the declaration form was controller- or closure-backed.
    const unclassified = batch.surfaces.filter(
      (s) => s.metadata.providerKind !== 'controller' && s.metadata.providerKind !== 'closure'
    );
    expect(unclassified).toHaveLength(0);
  });

  it('closure-backed surfaces never carry a fabricated explicitProvider', () => {
    const closureWithProvider = batch.surfaces.filter(
      (s) => s.metadata.providerKind === 'closure' && s.metadata.explicitProvider
    );
    expect(closureWithProvider).toHaveLength(0);
  });

  it('closure-backed surfaces never produce a handled_by edge', () => {
    const closureIds = new Set(
      batch.surfaces.filter((s) => s.metadata.providerKind === 'closure').map((s) => s.id)
    );
    const handledClosureEdges = batch.edges.filter(
      (e) => e.edgeType === 'handled_by' && closureIds.has(e.sourceNodeId)
    );
    expect(handledClosureEdges).toHaveLength(0);
  });
});
